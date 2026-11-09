/**
 * Rendering on the GPU (WebGPU), wherever the browser has a GPU that passes
 * the self-test (see probeCounts) and the page URL has no `?cpu`: the view in
 * double-single precision, tile by tile from the centre out, with the
 * workers computing exactly only the pixels it cannot settle (see main.ts).
 *
 * Precision. WGSL has no 64-bit floats, so numbers are f32 pairs (hi + lo,
 * about 48 significant bits). Their rounding-error terms are formed with fma
 * against a 1 read at run time (`p.one`): written as the usual (a + b) - a
 * the Metal shader compiler folds them to 0, and an fma it cannot simplify.
 * Against exact (CPU) counts, 96-98% of escaping pixels agree to 1e-3
 * iterations and 0.1-0.8% get visibly different colours, in filament-rich
 * views; plain f32 left 6-7% visibly different.
 *
 * The kernel is perturbNative's step without BLA: z = Z + δ around a
 * reference orbit (the workers' shared one, or one at the view centre for
 * shallow views), δ' = (2Z + δ) δ + dc, rebasing to the reference start
 * when |z| < |δ|, dz/dc in f32 with a separate exponent for the distance
 * estimate. f32 exponents end at 2^-126, so it serves views down to
 * MIN_LOG_SCALE.
 *
 * Work comes in passes over GPU_TILE-pixel tiles, each sampling every
 * `step`-th pixel of its tiles, dispatched a few tiles at a time (batches of
 * about BATCH_MS of GPU time, so the compositor keeps getting the GPU) and
 * read back per batch, so results can be shown as they come. Each sample is
 * one of: a smooth count (escaped, final); INSIDE (back at an earlier point,
 * with dz/dc settled and the orbit contracting: very likely interior, for the
 * workers to prove);
 * SUSPECT (bounded at the budget after returning near an earlier point:
 * probably inside, for the workers too); UNRESOLVED (bounded at the budget
 * otherwise: a larger budget may help); GLITCH (|z| fell far below |Z|,
 * where δ has lost too many bits: for the workers, which fall back to BigInt
 * there).
 */
import type { OrbitData } from '../fractal/reference.ts';
import type { View } from '../math/precision.ts';

/** The deepest view served: pixel deltas near 2^-90 leave f32 exponents room for their products. */
export const MIN_LOG_SCALE = -90;
export const INSIDE = -1, UNRESOLVED = -2, GLITCH = -3, SUSPECT = -4;
/** Tile size in physical pixels, a multiple of every pass step times 8 (the workgroup side). */
export const GPU_TILE = 64;
/** Target GPU time per batch: long enough to amortise a readback, short enough not to starve compositing. */
const BATCH_MS = 12;
/** Batches queued on the GPU at once. */
const IN_FLIGHT = 3;
/** At most this many pixels' worth of tiles per batch (coarse samples paint blocks): the main thread stages each batch in one go. */
const MAX_BATCH_TILES = Math.max(1, 65536 / (GPU_TILE * GPU_TILE));

const SHADER = /* wgsl */ `
struct Params {
  width: u32, height: u32, limit: u32, orbitLength: u32,
  scale: vec2f, one: f32, logScale: f32,
  offsetRe: vec2f, offsetIm: vec2f,
  step: u32, side: u32, first: u32, useMask: u32,
  slotBase: u32, pad0: u32, pad1: u32, pad2: u32,
}
@group(0) @binding(0) var<storage, read> orbit: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> result: array<vec2f>;
@group(0) @binding(2) var<uniform> p: Params;
@group(0) @binding(3) var<storage, read> xs: array<vec2f>;
@group(0) @binding(4) var<storage, read> ys: array<vec2f>;
// Four pixels a word, a byte each.
@group(0) @binding(5) var<storage, read> mask: array<u32>;
@group(0) @binding(6) var<storage, read> tiles: array<vec2u>;

// 2^-60 and 2^60 (exact in f32): dz/dc is rescaled whenever it grows past 2^60.
const SHRINK = 8.673617379884035e-19;
const BIG = 1.152921504606847e18;
// A return within |Δz|² < CYCLE of the position at the last power of two is taken as inside when
// log2 |dz/dc| has grown by less than SETTLED since, and the orbit has contracted by more than
// 2^CONTRACTED since (|d z_n / d z_checkpoint|, the product of |2z| along it): see the README.
const CYCLE = 1e-14;
const SETTLED = 0.01;
const CONTRACTED = -3.0;
// Orbits just off the real axis follow an attracting cycle of a nearby real parameter for a while,
// passing every test above, then drift off and escape: near c = -1.854 + 7e-18 i at 1.4e16 they
// were detected at ~990 steps and escaped after 1.6-2.6 times as many.
const CONFIRM = 4u;
// |z|² below |Z|² GLITCH_SQUARED: z = Z + δ has cancelled about 18 of δ's 48 bits.
const GLITCH_SQUARED = 1e-11;

// Double-single arithmetic; every error term through an fma against p.one (see gpu-render.ts).
fn two_sum(a: f32, b: f32) -> vec2f {
  let s = a + b;
  let bb = fma(s, p.one, -a);
  let aa = fma(-bb, p.one, s);
  return vec2f(s, fma(a, p.one, -aa) + fma(b, p.one, -bb));
}
fn quick(a: f32, b: f32) -> vec2f {
  let s = a + b;
  return vec2f(s, fma(b, p.one, fma(a, p.one, -s)));
}
fn add(a: vec2f, b: vec2f) -> vec2f {
  let s = two_sum(a.x, b.x);
  let t = two_sum(a.y, b.y);
  let u = quick(s.x, s.y + t.x);
  return quick(u.x, u.y + t.y);
}
fn mul(a: vec2f, b: vec2f) -> vec2f {
  let q = a.x * b.x;
  return quick(q, fma(a.x, b.x, -q) + (a.x * b.y + a.y * b.x));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.side || id.y >= p.side) { return; }
  let tile = p.first + id.z;
  let origin = tiles[tile];
  let px = origin.x + id.x * p.step;
  let py = origin.y + id.y * p.step;
  if (px >= p.width || py >= p.height) { return; }
  let index = py * p.width + px;
  if (p.useMask != 0u && ((mask[index >> 2u] >> ((index & 3u) * 8u)) & 255u) == 0u) { return; }
  // dc: the pixel centre in CSS pixels (as the workers sample it) times the CSS pixel size, plus the
  // view centre's offset from the reference.
  let cr = add(p.offsetRe, mul(xs[px], p.scale));
  let ci = add(p.offsetIm, -mul(ys[py], p.scale));
  let end = p.orbitLength - 1u;
  var dr = vec2f(0.0);
  var di = vec2f(0.0);
  // dz/dc as e 2^k; the +1 of each step is 2^-k in those units.
  var e = vec2f(0.0);
  var k = 0.0;
  var one = 1.0;
  var zr = 0.0;
  var zi = 0.0;
  var m = 0u;
  var n = 0u;
  var count = ${UNRESOLVED}.0;
  var distance = -1.0;
  var saved = vec2f(1e30, 1e30);
  var savedLog = 0.0;
  var checkpoint = 16u;
  // |d z_n / d z_checkpoint|² as dsq 2^dexp.
  var dsq = 1.0;
  var dexp = 0.0;
  var returned = false;
  // Once the tests below pass at step n, the orbit must stay bounded through CONFIRM n before the
  // pixel is taken as inside (0: no candidate yet).
  var confirmUntil = 0u;
  loop {
    if (confirmUntil != 0u && n >= confirmUntil) { count = ${INSIDE}.0; break; }
    if (n >= p.limit) {
      // Bounded at the budget after returning near an earlier point: probably inside, near the
      // boundary, where the tests below are cautious. A larger budget is no help there.
      if (returned) { count = ${SUSPECT}.0; }
      break;
    }
    let Z = orbit[m];
    e = 2.0 * vec2f(zr * e.x - zi * e.y, zr * e.y + zi * e.x) + vec2f(one, 0.0);
    if (max(abs(e.x), abs(e.y)) > BIG) { e *= SHRINK; one *= SHRINK; k += 60.0; }
    dsq *= 4.0 * (zr * zr + zi * zi);
    if (dsq > BIG) { dsq *= SHRINK; dexp += 60.0; } else if (dsq < SHRINK) { dsq *= BIG; dexp -= 60.0; }
    // δ' = (2Z + δ) δ + dc
    let ur = add(add(Z.xy, Z.xy), dr);
    let ui = add(add(Z.zw, Z.zw), di);
    let nr = add(add(mul(ur, dr), -mul(ui, di)), cr);
    di = add(add(mul(ur, di), mul(ui, dr)), ci);
    dr = nr;
    m++;
    n++;
    let Y = orbit[m];
    let tr = add(Y.xy, dr);
    let ti = add(Y.zw, di);
    zr = tr.x;
    zi = ti.x;
    let squared = zr * zr + zi * zi;
    if (squared > 256.0) {
      count = f32(n) + 1.0 - log2(0.5 * log2(squared));
      // |z| ln|z| / |dz/dc|, in CSS pixels.
      let logDistance = log2(sqrt(squared) * 0.5 * log(squared)) - log2(length(e)) - k - p.logScale;
      distance = exp2(min(logDistance, 60.0));
      break;
    }
    if (squared < (Y.x * Y.x + Y.z * Y.z) * GLITCH_SQUARED) { count = ${GLITCH}.0; break; }
    if (squared < dr.x * dr.x + di.x * di.x || m == end) { dr = tr; di = ti; m = 0u; }
    // Every 16th step only: each step cost escaping-heavy views 40-80% more time.
    if (confirmUntil == 0u && (n & 15u) == 0u) {
      let gap = vec2f(zr, zi) - saved;
      if (dot(gap, gap) < CYCLE) {
        returned = true;
        if (log2(length(e)) + k < savedLog + SETTLED && 0.5 * (log2(dsq) + dexp) < CONTRACTED) { confirmUntil = n * CONFIRM; }
      }
      if (n == checkpoint) { saved = vec2f(zr, zi); savedLog = log2(length(e)) + k; checkpoint *= 2u; dsq = 1.0; dexp = 0.0; }
    }
  }
  // The batch's slot in the ring of in-flight batches (see GpuJob.pass).
  result[(p.slotBase + id.z) * p.side * p.side + id.y * p.side + id.x] = vec2f(count, distance);
}
`;

export interface GpuView {
  view: View;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  /** False once a newer render has started: work then stops early. */
  current: () => boolean;
}

/** A pass's results for `count` tiles from `first` (in the pass's tile order): (count, distance) pairs, side² per tile. */
export interface GpuBatch { first: number; count: number; side: number; values: Float32Array }

export interface GpuPass {
  iterations: number;
  /** Sample every step-th pixel of each tile (its top-left pixel first), as the workers' passes do. */
  step: number;
  /** Tile origins (multiples of GPU_TILE), in the order to compute them. */
  tiles: readonly (readonly [number, number])[];
  /** Per pixel: compute only where 1 (undefined: every sample). */
  mask?: Uint8Array;
  onBatch: (batch: GpuBatch) => void;
}

/** Main-thread work between turns given back to the page. */
const YIELD_MS = 8;
/** A turn of the event loop (a message, not setTimeout: background pages clamp timers to about a second). */
export const yieldToEvents = () => new Promise<void>(resolve => {
  const { port1, port2 } = new MessageChannel();
  // Closed once used: an open port keeps a Node process (the tests) alive.
  port1.onmessage = () => { port1.close(); resolve(); };
  port2.postMessage(0);
});

/** f32 pair (hi, lo) of a double. */
const split = (value: number, out: Float32Array, at: number) => { out[at] = value; out[at + 1] = value - out[at]; };

/**
 * The self-test a GPU must pass before it renders: the kernel on PROBE_WIDTH
 * points c = 1/4 + (k + 8.5) 2^-28 on the real axis, just beyond the cusp,
 * around the reference c = 0 (whose orbit stays 0, so it iterates z itself).
 * They escape after 10-18 thousand steps, and only at the right step if every
 * error term survives: f32 alone holds neither c's low bits nor z's slow drift
 * past 1/2. A shader compiler that folds the error terms (as Metal's did,
 * written plainly) gets them wrong by thousands of steps or never escapes.
 */
const PROBE_WIDTH = 16, PROBE_LOG_SCALE = -28, PROBE_LIMIT = 40000;
/** The probe's centre: c of its pixel k is PROBE_CENTRE + (k - 7.5) 2^PROBE_LOG_SCALE. */
const PROBE_CENTRE = 0.25 + 16 * 2 ** PROBE_LOG_SCALE;

/** The probe's smooth counts, in doubles, as the kernel computes them. */
export function probeCounts(): number[] {
  return Array.from({ length: PROBE_WIDTH }, (_, k) => {
    const c = PROBE_CENTRE + (k - (PROBE_WIDTH - 1) / 2) * 2 ** PROBE_LOG_SCALE;
    let z = 0;
    for (let n = 1; n <= PROBE_LIMIT; n++) {
      z = z * z + c;
      if (z * z > 256) return n + 1 - Math.log2(0.5 * Math.log2(z * z));
    }
    return UNRESOLVED;
  });
}

/** Whether the probe's results (count, distance pairs, its pixels first) are right, to an iteration. */
export function probePasses(values: ArrayLike<number>): boolean {
  return probeCounts().every((count, k) => Math.abs(values[2 * k] - count) <= 1);
}

export class GpuRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private lost = false;

  private constructor(device: GPUDevice, pipeline: GPUComputePipeline) {
    this.device = device;
    this.pipeline = pipeline;
    void device.lost.then(() => { this.lost = true; });
    // A validation or out-of-memory error leaves zeros where results should be: never trust this device again.
    device.addEventListener('uncapturederror', event => {
      if (!this.lost) console.warn('GPU error; rendering on the workers from now on:', (event as GPUUncapturedErrorEvent).error.message);
      this.lost = true;
    });
  }

  /**
   * A renderer on this browser's GPU, or undefined (the workers render) without WebGPU, on a
   * software adapter, or when the GPU fails the self-test or any step of starting.
   */
  static async create(): Promise<GpuRenderer | undefined> {
    try {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return undefined;
      // A software implementation (no usable GPU) would be slower than the workers.
      if (adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) return undefined;
      // Large canvases need more than WebGPU's default 128 MiB bindings (the mask is a byte a pixel).
      const device = await adapter.requestDevice({ requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
      const module = device.createShaderModule({ code: SHADER });
      const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const renderer = new GpuRenderer(device, pipeline);
      if (!await renderer.selfTest()) {
        console.warn('GPU rendering unavailable: the GPU failed its precision self-test; rendering on the workers.');
        device.destroy();
        return undefined;
      }
      return renderer;
    } catch (error) {
      console.warn('GPU rendering unavailable:', error);
      return undefined;
    }
  }

  /** Run the probe (see probeCounts) through the real kernel, buffers and readback. */
  private async selfTest(): Promise<boolean> {
    const job = this.job({ view: { logScale: PROBE_LOG_SCALE } as View, width: PROBE_WIDTH, height: 1,
      cssWidth: PROBE_WIDTH, cssHeight: 1, current: () => true });
    try {
      const zeros = new Float64Array(2);
      job.setOrbit({ re: zeros, im: zeros, exp: zeros }, PROBE_CENTRE, 0);
      let values: Float32Array | undefined;
      const ok = await job.pass({ iterations: PROBE_LIMIT, step: 1, tiles: [[0, 0]], onBatch: batch => { values = batch.values; } });
      return ok && !this.lost && !!values && probePasses(values);
    } finally {
      job.dispose();
    }
  }

  static serves(view: View): boolean {
    return view.logScale > MIN_LOG_SCALE;
  }

  get usable(): boolean { return !this.lost; }

  /** Buffers for one view: give it an orbit, run passes, then dispose() it. */
  job(target: GpuView): GpuJob {
    return new GpuJob(this.device, this.pipeline, target, () => this.lost);
  }
}

export class GpuJob {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private readonly target: GpuView;
  private readonly lost: () => boolean;
  private readonly result: GPUBuffer;
  private readonly xs: GPUBuffer;
  private readonly ys: GPUBuffer;
  private readonly mask: GPUBuffer;
  private orbit?: { buffer: GPUBuffer; length: number; offset: Float32Array };
  /** Tiles per batch, adapted to BATCH_MS for each step. */
  private readonly batchTiles = new Map<number, number>();

  constructor(device: GPUDevice, pipeline: GPUComputePipeline, target: GpuView, lost: () => boolean) {
    this.device = device;
    this.pipeline = pipeline;
    this.target = target;
    this.lost = lost;
    const { width, height, cssWidth, cssHeight } = target;
    // Results only for the batches in flight, each in its slot: their size does not grow with the canvas.
    this.result = device.createBuffer({ size: IN_FLIGHT * MAX_BATCH_TILES * GPU_TILE * GPU_TILE * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.mask = device.createBuffer({ size: Math.ceil(width * height / 4) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    // Pixel centres in CSS pixels, as the workers compute them in doubles, kept to double-single.
    const column = new Float32Array(width * 2), row = new Float32Array(height * 2);
    for (let x = 0; x < width; x++) split((x + 0.5) / width * cssWidth - cssWidth / 2, column, 2 * x);
    for (let y = 0; y < height; y++) split((y + 0.5) / height * cssHeight - cssHeight / 2, row, 2 * y);
    this.xs = device.createBuffer({ size: column.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.ys = device.createBuffer({ size: row.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.xs, 0, column);
    device.queue.writeBuffer(this.ys, 0, row);
  }

  dispose(): void {
    for (const buffer of [this.result, this.xs, this.ys, this.mask, this.orbit?.buffer]) buffer?.destroy();
  }

  /** The reference orbit, and the view centre's offset from it (complex units). */
  setOrbit(data: OrbitData, offsetRe: number, offsetIm: number): void {
    const length = data.re.length, values = new Float32Array(length * 4);
    for (let i = 0; i < length; i++) {
      split(data.re[i] * 2 ** data.exp[i], values, 4 * i);
      split(data.im[i] * 2 ** data.exp[i], values, 4 * i + 2);
    }
    this.orbit?.buffer.destroy();
    const buffer = this.device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, values);
    const offset = new Float32Array(4);
    split(offsetRe, offset, 0);
    split(offsetIm, offset, 2);
    this.orbit = { buffer, length, offset };
  }

  /** Run a pass, batch by batch; false if it stopped (a newer render, or the device was lost). */
  async pass({ iterations, step, tiles, mask, onBatch }: GpuPass): Promise<boolean> {
    const { width, height, view, current } = this.target, device = this.device, orbit = this.orbit!;
    const side = GPU_TILE / step, perTile = side * side;
    if (mask) {
      // A byte a pixel, padded to whole words.
      const bytes = new Uint8Array(Math.ceil(mask.length / 4) * 4);
      bytes.set(mask);
      device.queue.writeBuffer(this.mask, 0, bytes);
    }
    const origins = new Uint32Array(Math.max(2, tiles.length * 2));
    tiles.forEach(([x, y], i) => { origins[2 * i] = x; origins[2 * i + 1] = y; });
    const tileBuffer = device.createBuffer({ size: origins.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(tileBuffer, 0, origins);
    const scale = new Float32Array(2);
    split(2 ** view.logScale, scale, 0);
    // Up to IN_FLIGHT batches queued at once, so the GPU never waits for a readback to be processed.
    const inFlight: { first: number; count: number; read: GPUBuffer; uniform: GPUBuffer; mapped: Promise<unknown> }[] = [];
    let batch = Math.min(this.batchTiles.get(step) ?? 1, MAX_BATCH_TILES), next = 0, submitted = 0, stopped = false, lastDone = performance.now(), lastYield = lastDone;
    const submit = () => {
      const count = Math.min(batch, tiles.length - next), first = next;
      next += count;
      // Slots go round: a slot is written again only after the batch before it there was read back.
      const slotBase = (submitted++ % IN_FLIGHT) * MAX_BATCH_TILES;
      const params = new ArrayBuffer(80), words = new Uint32Array(params), floats = new Float32Array(params);
      words.set([width, height, iterations, orbit.length]);
      floats.set([scale[0], scale[1], 1, view.logScale, orbit.offset[0], orbit.offset[1], orbit.offset[2], orbit.offset[3]], 4);
      words.set([step, side, first, mask ? 1 : 0, slotBase], 12);
      const uniform = device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bytes = count * perTile * 8;
      const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(uniform, 0, params);
      const bind = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: orbit.buffer } }, { binding: 1, resource: { buffer: this.result } },
        { binding: 2, resource: { buffer: uniform } }, { binding: 3, resource: { buffer: this.xs } },
        { binding: 4, resource: { buffer: this.ys } }, { binding: 5, resource: { buffer: this.mask } },
        { binding: 6, resource: { buffer: tileBuffer } }] });
      const encoder = device.createCommandEncoder(), computePass = encoder.beginComputePass();
      computePass.setPipeline(this.pipeline);
      computePass.setBindGroup(0, bind);
      computePass.dispatchWorkgroups(Math.ceil(side / 8), Math.ceil(side / 8), count);
      computePass.end();
      encoder.copyBufferToBuffer(this.result, slotBase * perTile * 8, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      // Settled either way: a stale pass still waits for its maps before destroying the buffers.
      inFlight.push({ first, count, read, uniform, mapped: read.mapAsync(GPUMapMode.READ).then(() => true, () => false) });
    };
    try {
      while (next < tiles.length || inFlight.length) {
        if (!stopped && (!current() || this.lost())) stopped = true;
        while (!stopped && next < tiles.length && inFlight.length < IN_FLIGHT) submit();
        if (!inFlight.length) break;
        const done = inFlight.shift()!;
        const ok = await done.mapped;
        if (ok && !stopped && current() && !this.lost()) {
          const values = new Float32Array(done.read.getMappedRange().slice(0));
          done.read.unmap();
          onBatch({ first: done.first, count: done.count, side, values });
          // Batches already done resolve as microtasks: give the page a turn now and then, or several
          // batches' staging would run as one long task with no frame between them.
          if (performance.now() - lastYield > YIELD_MS) { await yieldToEvents(); lastYield = performance.now(); }
          // Batches finishing BATCH_MS apart: long enough to amortise a readback, short enough for the compositor.
          const now = performance.now(), elapsed = now - lastDone;
          lastDone = now;
          if (elapsed < BATCH_MS / 2) batch = Math.min(batch * 2, MAX_BATCH_TILES);
          else if (elapsed > BATCH_MS * 2 && batch > 1) batch = Math.max(1, batch >> 1);
        } else stopped = true;
        done.read.destroy();
        done.uniform.destroy();
      }
      this.batchTiles.set(step, batch);
      // Checked again: the page had a turn after the last batch, and a newer render may have started then.
      return !stopped && current() && !this.lost();
    } finally {
      tileBuffer.destroy();
    }
  }
}
