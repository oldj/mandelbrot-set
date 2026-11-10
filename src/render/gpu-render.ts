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
 * with dz/dc settled and the orbit contracting, or, in the kernel with the
 * early test, near an attracting cycle a Newton step locates: very likely
 * interior, for the workers to prove);
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
/**
 * And at least this many samples: a batch takes about as long as its slowest pixel's iterations until
 * it fills the GPU, so fewer leave it mostly idle. At 98304 iterations a coarse batch of one tile (256
 * samples) took 80-99 ms, of 16 tiles 120 ms; shrinking to one tile left a mostly interior coarse pass
 * at 1874x1516 a minute long, against 6 s. A fine tile alone (4096 samples) about fills it.
 */
const MIN_BATCH_SAMPLES = 4096;
/**
 * With a mask, batches count the samples to compute, not the tiles: a sparse pass (after a pan, the
 * pixels exposed) takes up to this many tiles a batch. Counted as tiles, a rerun of 21 thousand
 * pixels at 131072 iterations in seahorse valley at 1e7, about 180 a tile, went one tile a batch
 * (63 ms each): 7.5 s. Such reruns are lists now (see GpuPass.list).
 */
const MAX_MASKED_TILES = 64;
/** Samples per batch slot (see GpuJob.pass). */
const SLOT_SAMPLES = MAX_MASKED_TILES * GPU_TILE * GPU_TILE;
/** At most this many pixels per batch of a list. */
const MAX_LIST = 65536;

/**
 * A failed Newton attempt (see EARLY): back to the orbit where it was, with a new base point there, the
 * next attempt BACKOFF P 2^k steps on (a failed hint at n = 0 only falls back).
 */
const fail = /* wgsl */ `
        if (n > 0u) { retry = n + BACKOFF * period * (1u << min(fails, 16u)); fails++; }
        period = 0u;
        dr = keepR;
        di = keepI;
        m = keepM;
        zr = keepZ.x;
        zi = keepZ.y;
        base = keepZ;
        baseN = n;
        lambda = vec2f(1.0, 0.0);`;
/** Where tracking for the early test starts, and the test itself (see EARLY). */
const TRACK = 128, EARLY = 256;

/** The kernel; with `early`, the early interior test as well (see EARLY). */
const shader = (early: boolean) => /* wgsl */ `
struct Params {
  width: u32, height: u32, limit: u32, orbitLength: u32,
  scale: vec2f, one: f32, logScale: f32,
  offsetRe: vec2f, offsetIm: vec2f,
  step: u32, side: u32, first: u32, useMask: u32,
  slotBase: u32, hintWidth: u32, listLength: u32, pad2: u32,
}
@group(0) @binding(0) var<storage, read> orbit: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> result: array<vec2f>;
@group(0) @binding(2) var<uniform> p: Params;
@group(0) @binding(3) var<storage, read> xs: array<vec2f>;
@group(0) @binding(4) var<storage, read> ys: array<vec2f>;
// Four pixels a word, a byte each.
@group(0) @binding(5) var<storage, read> mask: array<u32>;
// Tile origins, or with step 0 the pixels of a list (see GpuPass.list).
@group(0) @binding(6) var<storage, read> tiles: array<vec2u>;
${early ? /* wgsl */ `// Per 4x4 block, the cycle its top-left sample's Newton found: (w, period), period 0 for none.
@group(0) @binding(7) var<storage, read_write> hints: array<vec4f>;` : ''}

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
// The early interior test (see the README), as the workers' attractingCycle without its proof: from
// step EARLY on, a return to the base point b (the smallest |z| since the last one) after P steps,
// with |z|² within BAND of |b|² and |z - b|² below RETURN |b|², starts Newton's method on
// f^P(w) = w from w = z, a lap of P steps (from w, rebased to the reference start) per Newton step,
// the true orbit kept aside. Converged (a step below CONVERGED |w|², squared) on a cycle with
// |λ|² < ATTRACTING, λ = (f^P)'(w): INSIDE, for the workers to prove. Otherwise the orbit goes on
// where it was. An attempt takes at most LAPS laps, and the k-th failed one waits BACKOFF P 2^k
// steps. All of a pixel's laps stay within 1/SHARE of the budget: a batch takes as long as its
// slowest pixel, often one that runs the whole budget, and returns P steps apart can mean P in the
// tens of thousands (the base point moves at powers of two), so unbounded laps had a pixel at
// 131072 iterations spend 250 thousand more.
const EARLY = ${EARLY}u;
// Tracking (λ, the base point) starts here.
const TRACK = ${TRACK}u;
const BAND = 0.25;
const RETURN = 0.25;
const CONVERGED = 5.9604645e-8;
// Below this (squared) while not attracting: a repelling cycle (wrong period, or c outside).
const HOPELESS = 1.5258789e-5;
// 1 - 2^-10: f32 rounding of λ must not make a parabolic cycle (the self-test's) attracting.
const ATTRACTING = 0.9990234;
const SHARE = 4u;
const LAPS = 10u;
const BACKOFF = 4u;
// Fine samples first try Newton from their 4x4 block's coarse sample's cycle point (see hints), for at
// most HINT_LAPS laps, when the next blocks right and down found a cycle of the same period.
const HINT_LAPS = 3u;

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
  var px: u32;
  var py: u32;
  if (p.step == 0u) {
    // A list: 64 pixels a workgroup.
    let entry = (p.first + id.z) * 64u + id.y * 8u + id.x;
    if (entry >= p.listLength) { return; }
    px = tiles[entry].x;
    py = tiles[entry].y;
  } else {
    let origin = tiles[p.first + id.z];
    px = origin.x + id.x * p.step;
    py = origin.y + id.y * p.step;
  }
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
${early ? /* wgsl */ `
  // The early test's base point (far off until tracking starts) and its step, and λ: dz/dz_b, or
  // in a Newton lap (f^lap)'(w).
  var base = vec2f(1e15);
  var baseN = 0u;
  var lambda = vec2f(1.0, 0.0);
  // Newton: the period (0: not running), steps into the lap, laps done and allowed, the lap's start w
  // and the last step's size², and the orbit to go back to (δ, m, z). Steps spent, and the next step
  // n an attempt may start at.
  var period = 0u;
  var lap = 0u;
  var laps = 0u;
  var maxLaps = LAPS;
  var wr = vec2f(0.0);
  var wi = vec2f(0.0);
  var lastStep = 0.0;
  var keepR = vec2f(0.0);
  var keepI = vec2f(0.0);
  var keepM = 0u;
  var keepZ = vec2f(0.0);
  var spent = 0u;
  var retry = 0u;
  var fails = 0u;
  if (p.step == 1u && ((px | py) & 3u) != 0u) {
    let hx = px >> 2u;
    let hy = py >> 2u;
    let h = hints[hy * p.hintWidth + hx];
    var same = h.z > 0.0;
    if (hx + 1u < p.hintWidth) { same = same && hints[hy * p.hintWidth + hx + 1u].z == h.z; }
    if (4u * (hy + 1u) < p.height) { same = same && hints[(hy + 1u) * p.hintWidth + hx].z == h.z; }
    if (same && u32(h.z) <= p.limit / SHARE) {
      period = u32(h.z);
      maxLaps = min(HINT_LAPS, p.limit / SHARE / period);
      wr = vec2f(h.x, 0.0);
      wi = vec2f(h.y, 0.0);
      dr = wr;
      di = wi;
      zr = h.x;
      zi = h.y;
    }
  }
` : ''}
  loop {
    if (confirmUntil != 0u && n >= confirmUntil) { count = ${INSIDE}.0; break; }
    if (n >= p.limit) {
      // Bounded at the budget after returning near an earlier point: probably inside, near the
      // boundary, where the tests below are cautious. A larger budget is no help there.
      if (returned) { count = ${SUSPECT}.0; }
      break;
    }
    let Z = orbit[m];
    ${early ? 'if (period == 0u) {' : '{'}
      e = 2.0 * vec2f(zr * e.x - zi * e.y, zr * e.y + zi * e.x) + vec2f(one, 0.0);
      if (max(abs(e.x), abs(e.y)) > BIG) { e *= SHRINK; one *= SHRINK; k += 60.0; }
      dsq *= 4.0 * (zr * zr + zi * zi);
      if (dsq > BIG) { dsq *= SHRINK; dexp += 60.0; } else if (dsq < SHRINK) { dsq *= BIG; dexp -= 60.0; }
    }
${early ? /* wgsl */ `
    // In a Newton lap: expanding this much is no attracting cycle either.
    var lost = false;
    if (n >= TRACK || period != 0u) {
      lambda = 2.0 * vec2f(zr * lambda.x - zi * lambda.y, zr * lambda.y + zi * lambda.x);
      // Expanding this much: no attracting cycle through here. A new base point follows.
      if (max(abs(lambda.x), abs(lambda.y)) > BIG) { lambda = vec2f(1.0, 0.0); base = vec2f(1e15); lost = true; }
    }
` : ''}
    // δ' = (2Z + δ) δ + dc
    let ur = add(add(Z.xy, Z.xy), dr);
    let ui = add(add(Z.zw, Z.zw), di);
    let nr = add(add(mul(ur, dr), -mul(ui, di)), cr);
    di = add(add(mul(ur, di), mul(ui, dr)), ci);
    dr = nr;
    m++;
    ${early ? 'if (period != 0u) { lap++; spent++; } else { n++; }' : 'n++;'}
    let Y = orbit[m];
    let tr = add(Y.xy, dr);
    let ti = add(Y.zw, di);
    zr = tr.x;
    zi = ti.x;
    let squared = zr * zr + zi * zi;
${early ? /* wgsl */ `
    if (period != 0u && (lost || squared > 256.0 || squared < (Y.x * Y.x + Y.z * Y.z) * GLITCH_SQUARED)) { ${fail} continue; }
` : ''}
    if (squared > 256.0) {
      count = f32(n) + 1.0 - log2(0.5 * log2(squared));
      // |z| ln|z| / |dz/dc|, in CSS pixels.
      let logDistance = log2(sqrt(squared) * 0.5 * log(squared)) - log2(length(e)) - k - p.logScale;
      distance = exp2(min(logDistance, 60.0));
      break;
    }
    if (squared < (Y.x * Y.x + Y.z * Y.z) * GLITCH_SQUARED) { count = ${GLITCH}.0; break; }
    if (squared < dr.x * dr.x + di.x * di.x || m == end) { dr = tr; di = ti; m = 0u; }
${early ? /* wgsl */ `
    if (period != 0u) {
      if (lap == period) {
        // Newton for g(w) = f^P(w) - w: w -= g / (λ - 1).
        let g = vec2f(add(tr, -wr).x, add(ti, -wi).x);
        let a = lambda - vec2f(1.0, 0.0);
        let s = vec2f(g.x * a.x + g.y * a.y, g.y * a.x - g.x * a.y) / max(dot(a, a), 1e-30);
        let size = wr.x * wr.x + wi.x * wi.x;
        let stepSquared = dot(s, s);
        let attracting = dot(lambda, lambda) < ATTRACTING;
        if (stepSquared < CONVERGED * size && attracting) {
          count = ${INSIDE}.0;
          if (((px | py) & 3u) == 0u) { hints[(py >> 2u) * p.hintWidth + (px >> 2u)] = vec4f(wr.x - s.x, wi.x - s.y, f32(period), 0.0); }
          break;
        }
        if (stepSquared < CONVERGED * size || (!attracting && stepSquared < HOPELESS * size)
          || (laps > 2u && stepSquared >= lastStep) || laps + 1u >= maxLaps) { ${fail} continue; }
        wr = add(wr, vec2f(-s.x, 0.0));
        wi = add(wi, vec2f(-s.y, 0.0));
        lastStep = stepSquared;
        laps++;
        lap = 0u;
        dr = wr;
        di = wi;
        m = 0u;
        zr = wr.x;
        zi = wi.x;
        lambda = vec2f(1.0, 0.0);
      }
      continue;
    }
    let baseSquared = dot(base, base);
    let relative = squared - baseSquared;
    // A new base point at a new smallest |z|, and at every power of two regardless.
    var rebase = n > TRACK && (relative < 0.0 || (n & (n - 1u)) == 0u);
    if (n >= EARLY && n - baseN >= 3u && abs(relative) < BAND * baseSquared) {
      let x = vec2f(zr, zi) - base;
      if (dot(x, x) < RETURN * baseSquared) {
        rebase = true;
        let candidate = n - baseN;
        let allowed = min(LAPS, (p.limit / SHARE - spent) / candidate);
        if (n >= retry && allowed >= 2u) {
          // Newton from w = z (as a double-single sum), rebased to the reference start.
          keepR = dr;
          keepI = di;
          keepM = m;
          keepZ = vec2f(zr, zi);
          wr = add(orbit[m].xy, dr);
          wi = add(orbit[m].zw, di);
          dr = wr;
          di = wi;
          m = 0u;
          period = candidate;
          lap = 0u;
          laps = 0u;
          maxLaps = allowed;
        }
      }
    }
    if (rebase) {
      base = vec2f(zr, zi);
      baseN = n;
      lambda = vec2f(1.0, 0.0);
    }
    if (period != 0u) { continue; }
` : ''}
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
  // A sample that did not escape has no distance: the steps it took instead (Newton's too).
  if (count < 0.0) { distance = f32(n${early ? ' + spent' : ''}); }
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

/**
 * A pass's results for `count` tiles from `first` (in the pass's tile order): (count, distance) pairs,
 * side² per tile. For a list, for `count` pixels from `first` (side 0).
 */
export interface GpuBatch { first: number; count: number; side: number; values: Float32Array }

export interface GpuPass {
  iterations: number;
  /** Sample every step-th pixel of each tile (its top-left pixel first), as the workers' passes do. */
  step: number;
  /** Tile origins (multiples of GPU_TILE), in the order to compute them. */
  tiles: readonly (readonly [number, number])[];
  /** Per pixel: compute only where 1 (undefined: every sample). */
  mask?: Uint8Array;
  /**
   * Instead of tiles (and step and mask): these pixels (indices y width + x), packed 64 to a
   * workgroup. For sparse pixels that run long: among tiles, each kept a whole SIMD group busy for
   * its one lane (see main.ts).
   */
  list?: Uint32Array;
  /**
   * With the early interior test (see EARLY): for passes over pixels likely to stay bounded. Its
   * code alone, never firing, made escaping-heavy views 13-17% slower (spirals at 1.9e10 on an M4).
   */
  early?: boolean;
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

/** The kernel without and with the early interior test (once compiled and tested). */
interface Pipelines { plain: GPUComputePipeline; early?: GPUComputePipeline }

const compile = (device: GPUDevice, early: boolean) => device.createComputePipelineAsync({
  layout: 'auto', compute: { module: device.createShaderModule({ code: shader(early) }), entryPoint: 'main' } });

export class GpuRenderer {
  private readonly device: GPUDevice;
  readonly pipelines: Pipelines;
  private lost = false;

  private constructor(device: GPUDevice, pipelines: Pipelines) {
    this.device = device;
    this.pipelines = pipelines;
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
      const renderer = new GpuRenderer(device, { plain: await compile(device, false) });
      if (!await renderer.selfTest(renderer.pipelines.plain, false)) {
        console.warn('GPU rendering unavailable: the GPU failed its precision self-test; rendering on the workers.');
        device.destroy();
        return undefined;
      }
      // The kernel with the early interior test is ready a little later: passes use the plain one until
      // then. Compiling and testing both before the first render delayed it by about 100 ms.
      void compile(device, true).then(async early => {
        if (await renderer.selfTest(early, true)) renderer.pipelines.early = early;
        else console.warn('The GPU failed the self-test with the early interior test; rendering without it.');
      }, () => undefined);
      return renderer;
    } catch (error) {
      console.warn('GPU rendering unavailable:', error);
      return undefined;
    }
  }

  /**
   * Run the probe (see probeCounts) through a kernel, buffers and readback. Its orbits creep past a
   * parabolic point for thousands of steps, so the early test must not take them for interior either.
   */
  private async selfTest(pipeline: GPUComputePipeline, early: boolean): Promise<boolean> {
    const pipelines = early ? { plain: this.pipelines.plain, early: pipeline } : { plain: pipeline };
    const job = new GpuJob(this.device, pipelines, { view: { logScale: PROBE_LOG_SCALE } as View, width: PROBE_WIDTH, height: 1,
      cssWidth: PROBE_WIDTH, cssHeight: 1, current: () => true }, () => this.lost);
    try {
      const zeros = new Float64Array(2);
      job.setOrbit({ re: zeros, im: zeros, exp: zeros }, PROBE_CENTRE, 0);
      let values: Float32Array | undefined;
      const ok = await job.pass({ iterations: PROBE_LIMIT, step: 1, tiles: [[0, 0]], early, onBatch: batch => { values = batch.values; } });
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
    return new GpuJob(this.device, this.pipelines, target, () => this.lost);
  }
}

export class GpuJob {
  private readonly device: GPUDevice;
  private readonly pipelines: Pipelines;
  private readonly target: GpuView;
  private readonly lost: () => boolean;
  private readonly result: GPUBuffer;
  private readonly xs: GPUBuffer;
  private readonly ys: GPUBuffer;
  private readonly mask: GPUBuffer;
  /** The early kernel's cycle hints, a vec4f per 4x4 block (see HINT_LAPS); zeros (none) to start with. */
  private readonly hints: GPUBuffer;
  private readonly hintWidth: number;
  private orbit?: { buffer: GPUBuffer; length: number; offset: Float32Array };
  /** Tiles per batch, adapted to BATCH_MS for each step. */
  private readonly batchTiles = new Map<number, number>();

  constructor(device: GPUDevice, pipelines: Pipelines, target: GpuView, lost: () => boolean) {
    this.device = device;
    this.pipelines = pipelines;
    this.target = target;
    this.lost = lost;
    const { width, height, cssWidth, cssHeight } = target;
    // Results only for the batches in flight, each in its slot: their size does not grow with the canvas.
    this.result = device.createBuffer({ size: IN_FLIGHT * SLOT_SAMPLES * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.mask = device.createBuffer({ size: Math.ceil(width * height / 4) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.hintWidth = Math.ceil(width / 4);
    this.hints = device.createBuffer({ size: this.hintWidth * Math.ceil(height / 4) * 16, usage: GPUBufferUsage.STORAGE });
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
    for (const buffer of [this.result, this.xs, this.ys, this.mask, this.hints, this.orbit?.buffer]) buffer?.destroy();
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
  async pass({ iterations, step, tiles, mask, list, early = false, onBatch }: GpuPass): Promise<boolean> {
    const { width, height, view, current } = this.target, device = this.device, orbit = this.orbit!;
    const pipeline = early && this.pipelines.early || this.pipelines.plain;
    // A list runs in units of 64 pixels (a workgroup), as if tiles of side 8.
    if (list) { step = 0; mask = undefined; }
    const side = list ? 8 : GPU_TILE / step, perTile = side * side, units = list ? Math.ceil(list.length / perTile) : tiles.length;
    const most = list ? MAX_LIST / perTile : MAX_BATCH_TILES;
    if (mask) {
      // A byte a pixel, padded to whole words.
      const bytes = new Uint8Array(Math.ceil(mask.length / 4) * 4);
      bytes.set(mask);
      device.queue.writeBuffer(this.mask, 0, bytes);
    }
    const origins = new Uint32Array(Math.max(2, list ? list.length * 2 : tiles.length * 2));
    if (list) list.forEach((index, i) => { const x = index % width; origins[2 * i] = x; origins[2 * i + 1] = (index - x) / width; });
    else tiles.forEach(([x, y], i) => { origins[2 * i] = x; origins[2 * i + 1] = y; });
    const tileBuffer = device.createBuffer({ size: origins.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(tileBuffer, 0, origins);
    const scale = new Float32Array(2);
    split(2 ** view.logScale, scale, 0);
    // Up to IN_FLIGHT batches queued at once, so the GPU never waits for a readback to be processed.
    const inFlight: { first: number; count: number; read: GPUBuffer; uniform: GPUBuffer; mapped: Promise<unknown> }[] = [];
    const fewest = Math.min(most, Math.ceil(MIN_BATCH_SAMPLES / perTile));
    // With a mask, each tile's samples to compute: batches take tiles until they have batch * perTile.
    const weights = mask && tiles.map(([x0, y0]) => {
      let active = 0;
      for (let y = y0; y < Math.min(height, y0 + GPU_TILE); y += step) for (let x = x0; x < Math.min(width, x0 + GPU_TILE); x += step) active += mask[y * width + x] ? 1 : 0;
      return active;
    });
    let batch = Math.max(fewest, Math.min(this.batchTiles.get(step) ?? 1, most)), next = 0, submitted = 0, stopped = false, lastDone = performance.now(), lastYield = lastDone;
    const submit = () => {
      let count = Math.min(batch, units - next);
      if (weights) {
        let samples = 0;
        count = 0;
        while (next + count < units && count < MAX_MASKED_TILES && (!count || samples < batch * perTile)) samples += weights[next + count++];
      }
      const first = next;
      next += count;
      // Slots go round: a slot is written again only after the batch before it there was read back.
      const slotBase = (submitted++ % IN_FLIGHT) * (SLOT_SAMPLES / perTile);
      const params = new ArrayBuffer(80), words = new Uint32Array(params), floats = new Float32Array(params);
      words.set([width, height, iterations, orbit.length]);
      floats.set([scale[0], scale[1], 1, view.logScale, orbit.offset[0], orbit.offset[1], orbit.offset[2], orbit.offset[3]], 4);
      words.set([step, side, first, mask ? 1 : 0, slotBase, this.hintWidth, list?.length ?? 0], 12);
      const uniform = device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bytes = (list ? Math.min(count * perTile, list.length - first * perTile) : count * perTile) * 8;
      const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(uniform, 0, params);
      const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: orbit.buffer } }, { binding: 1, resource: { buffer: this.result } },
        { binding: 2, resource: { buffer: uniform } }, { binding: 3, resource: { buffer: this.xs } },
        { binding: 4, resource: { buffer: this.ys } }, { binding: 5, resource: { buffer: this.mask } },
        { binding: 6, resource: { buffer: tileBuffer } },
        // Only the early kernel has them: an automatic layout leaves out bindings a shader does not use.
        ...pipeline === this.pipelines.early ? [{ binding: 7, resource: { buffer: this.hints } }] : []] });
      const encoder = device.createCommandEncoder(), computePass = encoder.beginComputePass();
      computePass.setPipeline(pipeline);
      computePass.setBindGroup(0, bind);
      computePass.dispatchWorkgroups(Math.ceil(side / 8), Math.ceil(side / 8), count);
      computePass.end();
      encoder.copyBufferToBuffer(this.result, slotBase * perTile * 8, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      // Settled either way: a stale pass still waits for its maps before destroying the buffers.
      inFlight.push({ first, count, read, uniform, mapped: read.mapAsync(GPUMapMode.READ).then(() => true, () => false) });
    };
    try {
      while (next < units || inFlight.length) {
        if (!stopped && (!current() || this.lost())) stopped = true;
        while (!stopped && next < units && inFlight.length < IN_FLIGHT) submit();
        if (!inFlight.length) break;
        const done = inFlight.shift()!;
        const ok = await done.mapped;
        if (ok && !stopped && current() && !this.lost()) {
          const values = new Float32Array(done.read.getMappedRange().slice(0));
          done.read.unmap();
          if (list) onBatch({ first: done.first * perTile, count: values.length / 2, side: 0, values });
          else onBatch({ first: done.first, count: done.count, side, values });
          // Batches already done resolve as microtasks: give the page a turn now and then, or several
          // batches' staging would run as one long task with no frame between them.
          if (performance.now() - lastYield > YIELD_MS) { await yieldToEvents(); lastYield = performance.now(); }
          // Batches finishing BATCH_MS apart: long enough to amortise a readback, short enough for the compositor.
          const now = performance.now(), elapsed = now - lastDone;
          lastDone = now;
          if (elapsed < BATCH_MS / 2) batch = Math.min(batch * 2, most);
          else if (elapsed > BATCH_MS * 2 && batch > fewest) batch = Math.max(fewest, batch >> 1);
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
