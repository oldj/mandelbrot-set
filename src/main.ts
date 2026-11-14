/**
 * The application: the canvas and its views, input (wheel, pointer and touch
 * gestures, Home, the URL hash), and render scheduling. Each render gets a
 * fresh off-screen surface, previewed by projecting the previous one; workers
 * (render/worker.ts) fill it with tiles in passes of 8, 4, 2 and 1 pixels,
 * staged and uploaded once per frame (render/tile-stage.ts). The info panel,
 * the view dialog and the zoom buttons live in ui/hud.ts.
 */
import { fixedToNumber, initialView, transformView, viewOffset } from './math/precision.ts';
import type { Point, View } from './math/precision.ts';
import { FINAL_RAISE_FRACTION, adaptBudget, chooseBudget, rememberUse } from './render/budget.ts';
import type { BudgetMemory } from './render/budget.ts';
import { gesture, wheelAnchor, wheelLogFactor } from './ui/gestures.ts';
import { createHud } from './ui/hud.ts';
import { missingRegions, panRaster, shiftInPlace, shiftQuality } from './render/raster-cache.ts';
import { decodeDistance, encodeDistance } from './render/samples.ts';
import { GPU_TILE, GpuRenderer, INSIDE, SUSPECT, UNRESOLVED, yieldToEvents } from './render/gpu-render.ts';
import type { GpuJob } from './render/gpu-render.ts';
import { computeOrbit } from './fractal/orbit.ts';
import type { Reference } from './fractal/orbit.ts';
import { insideDouble } from './fractal/direct.ts';
import { stageSamples, TileStage } from './render/tile-stage.ts';
import { formatViewHash, parseViewHash, viewHashPalette } from './ui/url-state.ts';
import { isPalette } from './render/palette-names.ts';
import type { Palette } from './render/palette-names.ts';
import { centreFirst, dealRuns, renderWorkerCount, workerCapacity } from './render/worker-policy.ts';
import { DEEP_LOG_SCALE, needsReference, referenceOffset, referenceSpec, viewLogRadius } from './fractal/reference.ts';
import type { OrbitData, ReferenceSpec } from './fractal/reference.ts';
import type { PixelRequest, PixelSamples, ReferencePlan, RenderMessage, RenderRegion, RenderRequest, TileData } from './render/messages.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#mandelbrot')!;
const context = canvas.getContext('2d', { alpha: false });
if (!context) throw new Error('This browser can’t create a 2D canvas context.');
const ctx = context;
canvas.tabIndex = 0;
let cssWidth = 1, cssHeight = 1;
let view: View;
let frame = 0;
let generation = 0;
let lastRender = -Infinity;
let renderTimer: ReturnType<typeof setTimeout>;
let coarseReady = false;
const passCounts = new Map<number, number>();
/** Learned iteration budget, and the coarse-pass tally that adapts it. */
let budgetMemory: BudgetMemory | undefined;
let coarseSamples = 0, coarseUnresolved = 0, coarseMs = 0, coarseUnresolvedMs = 0;
/**
 * A render first finishes at its budget, a full-resolution draft; pixels
 * that ran out of iterations are then deepened at a raised budget, only
 * those, as often as adaptBudget asks. Until then they are black
 * placeholders. The budget instead rises right after the coarse pass, before
 * any full-resolution work, when more than DRAFT_LIMIT of the coarse samples
 * ran out (the draft would be mostly placeholders), or when they took at most
 * CHEAP_RAISE of the pass's sampling time: they are cheap (BLA skips most of
 * their iterations, say), so at 4x the budget they add at most ~30% to the
 * passes, and the placeholders would only make people wait for the whole
 * draft. Draft-first pays where they are dear, as near parabolic points.
 */
const DRAFT_LIMIT = 0.25, CHEAP_RAISE = 0.1;
/**
 * Unresolved final pixels of the current draft or deepening: how many, and which (lists of indices
 * y width + x, as the workers' final passes report them).
 */
let pendingPixels = 0;
let pendingLists: Uint32Array[] = [];
/** The budget the running deepening samples at (0: none). */
let deepenIterations = 0;
let renderBase: Omit<RenderRequest, 'workerIndex' | 'reference'> | undefined;
let renderPixelCount = 0;
/** The finest pass every worker has finished for the current surface (255: none yet). */
let completedStep = 255;
const workers: Worker[] = [];
const workerLimit = workerCapacity(navigator.hardwareConcurrency);
let activeWorkerCount = 1;

/** The colour scheme: from the link if it names one, else the last one chosen here, else classic. */
const PALETTE_KEY = 'mandelbrot-palette';
function storedPalette(): Palette | undefined {
  try { const name = localStorage.getItem(PALETTE_KEY); return isPalette(name) ? name : undefined; } catch { return undefined; }
}
let palette: Palette = viewHashPalette(location.hash) ?? storedPalette() ?? 'classic';

/**
 * The one reference orbit deep renders share; worker 0 builds it, the rest receive copies. On a
 * cross-origin isolated page worker 0 also builds its BLA tables, once, in shared memory, and the
 * rest receive that copy (`tables`) rather than each building and holding their own.
 */
interface SharedOrbit { key: number; spec: ReferenceSpec; orbit?: OrbitData; tables?: Reference }
let sharedOrbit: SharedOrbit | undefined;
let referenceKeys = 0;
const shareTables = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
/** The orbit and table keys each worker already holds, so each is sent at most once per worker. */
const workerOrbitKeys: (number | undefined)[] = [];
const workerTableKeys: (number | undefined)[] = [];

function planReference(target: View, iterations: number): SharedOrbit | undefined {
  if (!needsReference(target, cssWidth, cssHeight)) return undefined;
  if (!sharedOrbit || !referenceOffset(sharedOrbit.spec, target, viewLogRadius(target, cssWidth, cssHeight), iterations)) {
    sharedOrbit = { key: ++referenceKeys, spec: referenceSpec(target, cssWidth, cssHeight, iterations) };
  }
  return sharedOrbit;
}

function referencePlan(shared: SharedOrbit, workerIndex: number): ReferencePlan {
  const plan: ReferencePlan = { key: shared.key, spec: shared.spec };
  if (shareTables) {
    if (workerTableKeys[workerIndex] === shared.key) return plan;
    if (shared.tables) {
      workerTableKeys[workerIndex] = shared.key;
      return { ...plan, tables: shared.tables };
    }
    // Others wait for worker 0's tables; it builds them from its orbit, or from this one, or computes one first.
    if (workerIndex !== 0) return { ...plan, share: true };
    if (workerOrbitKeys[0] === shared.key || !shared.orbit) return { ...plan, share: true, build: true };
    workerOrbitKeys[0] = shared.key;
    return { ...plan, share: true, build: true, orbit: shared.orbit };
  }
  if (workerOrbitKeys[workerIndex] === shared.key) return plan;
  if (shared.orbit) {
    workerOrbitKeys[workerIndex] = shared.key;
    return { ...plan, orbit: shared.orbit };
  }
  // Worker 0 is always active. Others wait; the orbit is forwarded once it exists.
  return workerIndex === 0 ? { ...plan, build: true } : plan;
}

interface Surface { canvas: HTMLCanvasElement; view: View; cssWidth: number; cssHeight: number; iterations: number; palette: Palette }
let surface: Surface | undefined;
let quality = new Uint8Array();
let stage: TileStage | undefined;
let stageImage: ImageData | undefined;
/**
 * Each painted pixel's smooth escape count and outline distance level, as its
 * tile brought them (see render/samples.ts), spread like its colour; NaN
 * counts where this surface has painted nothing (a projected preview, or not
 * yet). A palette switch recolours from them instead of computing anything.
 * 5 bytes a pixel, allocated with the first tile; pans shift them in place.
 */
let samples: { counts: Float32Array; distances: Uint8Array } | undefined;

/** Keep a tile's samples for the pixels it painted. */
function keepSamples(tile: TileData, regions: RenderRegion[]): void {
  if (!tile.counts || !stage) return;
  samples ??= { counts: new Float32Array(stage.width * stage.height).fill(NaN), distances: new Uint8Array(stage.width * stage.height) };
  stageSamples(tile, regions, samples.counts, samples.distances, stage.width);
}

/**
 * GPU rendering, wherever WebGPU gives a GPU that passes the self-test, unless
 * the page URL has `?cpu` (see render/gpu-render.ts), in tiles from the centre
 * out, staged batch by batch as they are read back:
 *
 * 1. A coarse pass (every 4th pixel each way), painted as the workers' coarse
 *    tiles are. As the workers' coarse pass does for cheap unresolved samples,
 *    the budget rises at once whenever adaptBudget calls for it, counting the
 *    unsettled samples (UNRESOLVED or SUSPECT); each raise computes only those.
 * 2. Every other pixel. Escaped ones are final; the rest are painted black
 *    (quality 2) for now.
 * 3. The workers compute exactly the pixels left (taken as inside, suspected,
 *    unresolved, or where z cancelled against the reference), by tile from the
 *    centre out: they prove the interior ones, and report which stayed
 *    unresolved.
 * 4. Those decide the budget as after a workers' draft (adaptBudget): on a
 *    raise the GPU computes them again, and the workers take whatever it still
 *    leaves. So the budget follows the same rule as the workers' renders: the
 *    GPU alone cannot tell interior pixels near the boundary from orbits that
 *    need more iterations, the workers' proofs can.
 *
 * The orbit is the workers' shared one (worker 0 builds it, off the main
 * thread), so the workers need none of their own afterwards; shallow views,
 * which have none, get one at the view centre here. Without a usable GPU,
 * after it fails (from then on), or below MIN_LOG_SCALE, renders are the
 * workers' alone.
 */
let gpu: GpuRenderer | undefined;
/**
 * Renders wait (at most 2 s) for the GPU while it starts, rather than start on the workers and be thrown
 * away. Browsers without WebGPU start on the workers at once. (`?gpu`, once needed, is still accepted.)
 */
let gpuStarting = !new URLSearchParams(location.search).has('cpu') && !!navigator.gpu;
if (gpuStarting) {
  const ready = (renderer?: GpuRenderer) => {
    if (!gpuStarting) return;
    gpuStarting = false;
    gpu = renderer;
    if (view) startRender();
  };
  // Ready after the wait: used from the next render on.
  void GpuRenderer.create().then(renderer => { if (gpuStarting) ready(renderer); else gpu ??= renderer; });
  setTimeout(() => ready(), 2000);
}
/** The handler for the workers' samples (a GPU render's, or a deepening's), and how to release it when a newer render starts. */
let gpuFix: ((message: PixelSamples) => void) | undefined;
let gpuFixRelease: (() => void) | undefined;
/** GPU renders waiting for the shared orbit with this key (all released when a new render starts). */
let orbitWaiters: { key: number; resolve: () => void }[] = [];
/** A pixel the workers proved interior (final, black). */
const PROVEN = -5;
/** Rounds of pixel requests so far: a round counts only its own workers' reports. */
let gpuRounds = 0;
/** Set when the GPU failed: the next render covers the view again on the workers, even if nothing moved. */
let renderAgain = false;

/** The GPU failed during the current render: stop using it, and finish the view on the workers. */
function gpuFailed(reason: unknown): void {
  console.warn('GPU rendering failed; rendering on the workers from now on:', reason);
  gpu = undefined;
  renderAgain = true;
  startRender();
}

const usesGpu = (target: View) => !!gpu?.usable && GpuRenderer.serves(target);

/**
 * Which pixels lie in the main cardioid or the period-2 bulb, by the workers' own test (insideDouble)
 * at each pixel's c in doubles; undefined where none do, or below BULB_LOG_SCALE. The GPU cannot tell
 * them: near the parabolic points (-0.75, 0.25, -1.25) their cycles attract so slowly (|λ| close to 1)
 * that it took them for unsettled, raised the budget to 24576 where the workers stay at 1536, and its
 * fine pass ran 8 s where the workers alone take 0.3 s. A wrong guess costs only time: the workers
 * compute every pixel they are given exactly.
 */
async function bulbPixels(target: Surface, width: number, height: number, current: () => boolean): Promise<Uint8Array | undefined> {
  const { view, cssWidth, cssHeight } = target;
  if (view.logScale < BULB_LOG_SCALE) return undefined;
  const scale = 2 ** view.logScale, re = fixedToNumber(view.re, view.bits), im = fixedToNumber(view.im, view.bits);
  const halfWidth = cssWidth / 2 * scale, halfHeight = cssHeight / 2 * scale;
  // The bulbs lie within -1.25 <= re <= 0.25, |im| <= 0.65.
  if (re + halfWidth < -1.25 || re - halfWidth > 0.25 || Math.abs(im) - halfHeight > 0.65) return undefined;
  // As the workers map pixels to c (see worker.ts's toCss and createSampler).
  const toCss = (pixel: number, size: number, css: number) => (pixel + 0.5) / size * css - css / 2;
  const xs = new Float64Array(width);
  for (let x = 0; x < width; x++) xs[x] = re + toCss(x, width, cssWidth) * scale;
  // The coarse samples' pixels first (a sixteenth of the work): a view just outside the bulbs (seahorse
  // valley at 1000x) stops there. A sliver they all miss is left to the GPU, as before.
  let near = false;
  for (let y = 0; y < height && !near; y += 4) {
    const ci = im - toCss(y, height, cssHeight) * scale;
    if (Math.abs(ci) <= 0.65) for (let x = 0; x < width; x += 4) if (insideDouble(xs[x], ci)) { near = true; break; }
  }
  if (!near) return undefined;
  const inside = new Uint8Array(width * height);
  let any = false, lastYield = performance.now();
  for (let y = 0; y < height; y++) {
    const ci = im - toCss(y, height, cssHeight) * scale;
    if (Math.abs(ci) <= 0.65) for (let x = 0, i = y * width; x < width; x++, i++) if (insideDouble(xs[x], ci)) { inside[i] = 1; any = true; }
    if (performance.now() - lastYield > MAIN_SLICE_MS) {
      await yieldToEvents();
      if (!current()) return undefined;
      lastYield = performance.now();
    }
  }
  return any ? inside : undefined;
}

/**
 * Give the job the orbit for `iterations`: the shared one (built by worker 0), or one at the view centre
 * for shallow views, computed here to `centre` iterations (a preview's capped budget: it is not kept).
 */
async function gpuOrbit(job: GpuJob, id: number, target: Surface, iterations: number, centre = iterations): Promise<boolean> {
  const { view } = target, width = target.canvas.width, height = target.canvas.height;
  const shared = planReference(view, iterations);
  if (!shared) {
    let lastYield = performance.now();
    const stale = new Error('stale');
    const data = await computeOrbit(view, centre, async () => {
      if (performance.now() - lastYield < 8) return;
      await yieldToEvents();
      lastYield = performance.now();
      if (generation !== id) throw stale;
    }).catch(error => { if (error === stale) return undefined; throw error; });
    if (!data || generation !== id) return false;
    job.setOrbit(data, 0, 0);
    return true;
  }
  canvas.dataset.referenceKey = String(shared.key);
  if (!shared.orbit) {
    if (!workers.length) createWorker();
    // Worker 0 builds it (a request with no pixels of its own); the 'reference' message releases us.
    if (workerOrbitKeys[0] !== shared.key) {
      workers[0].postMessage({ type: 'pixels', id, view, width, height, cssWidth: target.cssWidth, cssHeight: target.cssHeight,
        iterations, reference: referencePlan(shared, 0), pixels: new Uint32Array(0), round: 0, orbitOnly: true } satisfies PixelRequest);
    }
    await new Promise<void>(resolve => orbitWaiters.push({ key: shared.key, resolve }));
    if (generation !== id || !shared.orbit) return false;
  }
  const offset = referenceOffset(shared.spec, view, viewLogRadius(view, target.cssWidth, target.cssHeight), iterations);
  if (!offset) return false;
  job.setOrbit(shared.orbit, offset.re * 2 ** offset.exp, offset.im * 2 ** offset.exp);
  return true;
}

async function gpuRender(id: number, target: Surface, reused: Uint8Array, pan: boolean, preview: boolean): Promise<void> {
  const width = target.canvas.width, height = target.canvas.height, pixels = width * height;
  const current = () => generation === id && surface === target;
  shaders ??= await import('./render/palette.ts');
  if (!current() || !stage) return;
  const job = gpu!.job({ view: target.view, width, height, cssWidth: target.cssWidth, cssHeight: target.cssHeight, current });
  const started = performance.now(), logScale = target.view.logScale, physical = width / target.cssWidth;
  // Shallow views (plain doubles on the workers, see createSampler): the workers settle bounded pixels
  // cheaply there, proving interiors row by row (directRow), so the GPU leaves them every pixel its
  // fine pass does not settle soon (see SHALLOW_DEFER_FROM), and every pixel they leave unresolved.
  const shallow = logScale > DEEP_LOG_SCALE;
  // Pixels in the main cardioid or the period-2 bulb (see bulbPixels), for the workers straight away.
  let bulbs: Uint8Array | undefined;
  const T = GPU_TILE;
  // Every tile, nearest the centre first.
  const tiles: [number, number][] = [];
  for (let y = 0; y < height; y += T) for (let x = 0; x < width; x += T) tiles.push([x, y]);
  const centre = ([x, y]: readonly [number, number]) => (x + T / 2 - width / 2) ** 2 + (y + T / 2 - height / 2) ** 2;
  tiles.sort((a, b) => centre(a) - centre(b));
  const within = (mask: Uint8Array, [x0, y0]: readonly [number, number], step: number) => {
    for (let y = y0; y < Math.min(height, y0 + T); y += step) for (let x = x0; x < Math.min(width, x0 + T); x += step) if (mask[y * width + x]) return true;
    return false;
  };
  // Per pixel: the GPU's result, or the workers' once they have one (PROVEN for interior); NaN: not computed.
  // How many are computed, and how many of those unsettled (UNRESOLVED or SUSPECT).
  const counts = new Float32Array(pixels).fill(NaN), distances = new Float32Array(pixels);
  let computed = 0, unsettled = 0;
  const isUnsettled = (count: number) => count === UNRESOLVED || count === SUSPECT;
  const level = (i: number) => counts[i] >= 0 && distances[i] >= 0 ? encodeDistance(distances[i] * physical) : 255;
  const shade = () => shaders!.paletteShader(palette);
  const stageCoarse = ([x, y]: readonly [number, number]) => {
    const step = 4, clipWidth = Math.min(T, width - x), clipHeight = Math.min(T, height - y);
    const columns = Math.ceil(clipWidth / step), rows = Math.ceil(clipHeight / step), colour = shade();
    const words = new Uint32Array(columns * rows), tileCounts = new Float32Array(columns * rows), levels = new Uint8Array(columns * rows);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const i = (y + row * step) * width + x + column * step, k = row * columns + column;
      // Samples the GPU left unsettled (unresolved, suspect, glitched) are not interior, only not settled
      // yet: left transparent (their kept samples unknown), so the projected old image shows through until
      // a later pass or the workers settle them. Painted black, they blacked out the canvas while zooming
      // in deep views: previews stop at 4096 steps (0.80-1.00 of it at -0.5807+0.6518i, 6e23, where pixels
      // escape after up to 57344 steps; spirals at 1.9e10 the same).
      if (counts[i] < 0 && counts[i] !== INSIDE && counts[i] !== PROVEN) { tileCounts[k] = NaN; levels[k] = 255; continue; }
      tileCounts[k] = counts[i] >= 0 ? counts[i] : -1; levels[k] = level(i);
      words[k] = colour(tileCounts[k], decodeDistance(levels[k]));
    }
    const tile: TileData = { x, y, width: columns, height: rows, step, clipWidth, clipHeight, edgeRight: x + T >= width, edgeBottom: y + T >= height,
      pixels: new Uint8ClampedArray(words.buffer), counts: tileCounts, distances: levels, palette };
    keepSamples(tile, stage!.add(tile, quality));
  };
  // Final pixels (escaped, or proved) at quality 1; those left to the workers that the GPU took for interior
  // black at quality 2, and the others (unsettled) not at all until the workers' results.
  // The pixels left to the workers, row by row per tile as each tile is staged, until sent (see cpuRound).
  let left: Uint32Array[] = [], lefts = 0;
  // While a fine pass runs at a capped budget (see DEFER_SHARE): its unsettled pixels, for a list pass at the full one.
  let deferred: number[] | undefined;
  const stageFine = ([x, y]: readonly [number, number]) => {
    const w = Math.min(T, width - x), h = Math.min(T, height - y), colour = shade();
    const words = new Uint32Array(w * h), levels = new Uint8Array(w * h), claims = new Uint8Array(w * h);
    const tileLeft = new Uint32Array(w * h);
    let tileLefts = 0;
    for (let row = 0; row < h; row++) for (let column = 0; column < w; column++) {
      const i = (y + row) * width + x + column, k = row * w + column, count = counts[i];
      if (reused[i] || Number.isNaN(count)) continue;
      levels[k] = level(i);
      words[k] = colour(count >= 0 ? count : -1, decodeDistance(levels[k]));
      // Unsettled pixels (see stageCoarse) are not painted: what is under them stays until the workers' result.
      const final = count >= 0 || count === PROVEN;
      claims[k] = final ? 1 : count === INSIDE ? 2 : 0;
      if (!final) {
        if (deferred && isUnsettled(count)) deferred.push(i);
        else tileLeft[tileLefts++] = i;
      }
    }
    if (tileLefts) { left.push(tileLeft.slice(0, tileLefts)); lefts += tileLefts; }
    const painted = stage!.addBlock(x, y, w, h, words, claims, quality);
    samples ??= { counts: new Float32Array(pixels).fill(NaN), distances: new Uint8Array(pixels) };
    for (let row = 0; row < h; row++) for (let column = 0; column < w; column++) {
      const k = row * w + column, i = (y + row) * width + x + column;
      if (painted[k]) { samples.counts[i] = counts[i] >= 0 ? counts[i] : -1; samples.distances[i] = levels[k]; }
    }
  };
  const store = (index: number, value: number, distance: number) => {
    const was = counts[index];
    if (Number.isNaN(was)) computed++;
    else if (isUnsettled(was)) unsettled--;
    if (isUnsettled(value)) unsettled++;
    counts[index] = value; distances[index] = distance;
  };
  // The workers start on what the GPU left while it goes on.
  const sendLeft = () => { if (open && lefts >= LEFT_CHUNK * activeWorkerCount) open.send(takeLeft()); };
  // Run a pass, storing its samples and staging each tile as its batch arrives.
  const run = async (iterations: number, step: number, list: readonly (readonly [number, number])[], mask: Uint8Array | undefined,
    stageTile: (tile: readonly [number, number]) => void, early = false) => job.pass({ iterations, step, tiles: list, mask, early, onBatch: ({ first, count, side, values }) => {
    for (let t = 0; t < count; t++) {
      const [x0, y0] = list[first + t];
      for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
        const x = x0 + i * step, y = y0 + j * step, index = y * width + x;
        if (x >= width || y >= height || (mask && !mask[index])) continue;
        const at = 2 * ((t * side + j) * side + i);
        store(index, values[at], values[at + 1]);
      }
      stageTile(list[first + t]);
    }
    sendLeft();
    scheduleDraw();
  } });
  // Run a list pass (see GpuPass.list) over these pixels, staging each batch's with stagePixels.
  const runList = (iterations: number, pixels: Uint32Array, early: boolean, stagePixels: (indices: Uint32Array) => void) =>
    job.pass({ iterations, step: 0, tiles: [], list: pixels, early, onBatch: ({ first, count, values }) => {
      for (let k = 0; k < count; k++) store(pixels[first + k], values[2 * k], values[2 * k + 1]);
      stagePixels(pixels.subarray(first, first + count));
      sendLeft();
      scheduleDraw();
    } });
  // The pixels (by tile, nearest the centre first) that pass a test, every step-th of each tile.
  const collect = (step: number, test: (index: number) => boolean) => {
    const found: number[] = [];
    for (const [x0, y0] of tiles) for (let y = y0; y < Math.min(height, y0 + T); y += step) for (let x = x0; x < Math.min(width, x0 + T); x += step) {
      if (test(y * width + x)) found.push(y * width + x);
    }
    return Uint32Array.from(found);
  };
  // Coarse samples from a list pass: their tiles staged again.
  const stageCoarseOf = (indices: Uint32Array) => {
    const seen = new Set<number>();
    for (const index of indices) {
      const x = index % width, y = (index - x) / width, tx = x - x % T, ty = y - y % T, key = ty * width + tx;
      if (!seen.has(key)) { seen.add(key); stageCoarse([tx, ty]); }
    }
  };
  // Pixels from a list pass: escaped ones final, the rest for the workers.
  const stageList = (indices: Uint32Array) => {
    const colour = shade(), done: number[] = [], words: number[] = [], rest: number[] = [];
    samples ??= { counts: new Float32Array(pixels).fill(NaN), distances: new Uint8Array(pixels) };
    for (const index of indices) {
      const count = counts[index];
      if (count < 0) { rest.push(index); continue; }
      const distance = level(index);
      done.push(index); words.push(colour(count, decodeDistance(distance)));
      samples.counts[index] = count; samples.distances[index] = distance;
    }
    if (done.length) stage!.addPixels(Uint32Array.from(done), Uint32Array.from(words), quality);
    if (rest.length) { left.push(Uint32Array.from(rest)); lefts += rest.length; }
  };
  const takeLeft = () => {
    const all = new Uint32Array(lefts);
    let at = 0;
    for (const part of left) { all.set(part, at); at += part.length; }
    left = []; lefts = 0;
    return all;
  };
  /**
   * A round of exact samples on the workers, for the pixels a fine pass leaves them: sent in chunks
   * as its batches arrive (`send`), so the workers prove interiors while the GPU goes on. After
   * `close` (nothing more to come), `result` resolves with the pixels the workers left unresolved,
   * or undefined once stale. `expected`: how many pixels the pass may leave at most (it sizes the
   * worker count).
   */
  const cpuRound = (expected: number) => {
    // These are the costly pixels (proofs, budget-long orbits): counted as blocks of 32 when deep, so
    // even a few thousand get every worker the reference memory allows, and of 2048 when shallow (no
    // reference to copy), so even a few hundred get every worker: a final raise's 423 pixels at 65536
    // once ran on 2 of 8 workers.
    activeWorkerCount = renderWorkerCount(workerLimit, expected * (shallow ? 2048 : 32), logScale, iterations, shareTables);
    canvas.dataset.workers = String(activeWorkerCount);
    while (workers.length < activeWorkerCount) createWorker();
    const unresolved: number[] = [], round = ++gpuRounds, shared = planReference(target.view, iterations);
    let requests = 0, reports = 0, closed = false, finish!: (value: number[] | undefined) => void;
    const result = new Promise<number[] | undefined>(resolve => { finish = resolve; });
    const settled = () => {
      if (!closed || reports < requests) return;
      gpuFix = gpuFixRelease = undefined;
      finish(unresolved);
    };
    gpuFixRelease = () => finish(undefined);
    gpuFix = message => {
      if (message.round !== round || !current() || !stage || !shaders) return;
      const colour = shade(), words = new Uint32Array(message.indices.length);
      samples ??= { counts: new Float32Array(pixels).fill(NaN), distances: new Uint8Array(pixels) };
      for (let k = 0; k < words.length; k++) {
        const i = message.indices[k], count = message.counts[k], distance = decodeDistance(message.distances[k]);
        words[k] = colour(count, distance);
        samples.counts[i] = count; samples.distances[i] = message.distances[k];
        if (message.unresolved[k]) { unresolved.push(i); counts[i] = UNRESOLVED; } else counts[i] = count >= 0 ? count : PROVEN;
        distances[i] = Number.isFinite(distance) ? distance / physical : -1;
      }
      stage.addPixels(message.indices, words, quality);
      scheduleDraw();
      if (message.done) { reports++; settled(); }
    };
    return {
      result,
      // A stale render must not send the workers requests (each one makes a worker drop what it is doing for its id).
      send(list: Uint32Array) {
        if (!list.length || !current()) return;
        cpuPixels += list.length;
        canvas.dataset.cpuPixels = String(cpuPixels);
        // Dealt round-robin in runs (the list runs from the centre out), so every worker starts near the
        // centre, with neighbouring pixels together (see DEAL_RUN).
        dealRuns(list, activeWorkerCount, DEAL_RUN).forEach((share, workerIndex) => {
          if (!share.length) return;
          requests++;
          workers[workerIndex].postMessage({ type: 'pixels', id, view: target.view, width, height, cssWidth: target.cssWidth, cssHeight: target.cssHeight,
            iterations, reference: shared && referencePlan(shared, workerIndex), pixels: share, round } satisfies PixelRequest, [share.buffer]);
        });
      },
      close() { closed = true; settled(); },
    };
  };
  let open: ReturnType<typeof cpuRound> | undefined;
  let iterations = target.iterations, runs = 0, cpuPixels = 0;
  // A pass or orbit that stops while this render is still current means the GPU failed (or the orbit could not serve).
  const failed = () => { if (current()) gpuFailed('a GPU pass stopped'); };
  try {
    if (preview) {
      // While the view keeps changing (see changed()): only the coarse pass (after a pan, the exposed
      // pixels), at a budget capped at PREVIEW_ITERATIONS, with no raises and nothing for the workers.
      // A batch takes about as long as its slowest pixel's iterations, so at a full budget of 98304 a
      // single tile took 99 ms, and a mostly interior view never finished a coarse pass while zooming.
      const limit = Math.min(iterations, PREVIEW_ITERATIONS);
      if (!await gpuOrbit(job, id, target, iterations, limit)) return failed();
      const mask = pan ? new Uint8Array(pixels) : undefined;
      if (mask) for (let i = 0; i < pixels; i++) mask[i] = 1 - reused[i];
      runs++;
      if (!await run(limit, pan ? 1 : 4, mask ? tiles.filter(tile => within(mask, tile, 1)) : tiles, mask, pan ? stageFine : stageCoarse)) return failed();
      canvas.dataset.gpuFirstMs = String(Math.round(performance.now() - started));
      // The next change may start the next preview; the full render waits for the changes to stop.
      coarseReady = true;
      completedStep = pan ? 1 : 4;
      return;
    }
    if (!await gpuOrbit(job, id, target, iterations)) return failed();
    bulbs = await bulbPixels(target, width, height, current);
    if (!current()) return;
    // 1. Coarse pass (whole renders only: after a pan most of the view is there already). Its unsettled
    // samples are cheap to compute again here, so the budget rises as the workers' coarse pass raises it
    // for cheap ones: whenever adaptBudget calls for it.
    if (!pan) {
      runs++;
      // Coarse samples in the bulbs are interior already (the workers prove them at once): staged as
      // such, they do not raise the budget either.
      let coarseMask: Uint8Array | undefined;
      if (bulbs) {
        coarseMask = new Uint8Array(pixels);
        for (let y = 0; y < height; y += 4) for (let x = 0, i = y * width; x < width; x += 4, i += 4) {
          if (bulbs[i]) store(i, INSIDE, 0); else coarseMask[i] = 1;
        }
      }
      if (!await run(iterations, 4, tiles, coarseMask, stageCoarse)) return failed();
      canvas.dataset.gpuFirstMs = String(Math.round(performance.now() - started));
      coarseReady = true;
      completedStep = 4;
      // A raise's samples are the ones still bounded, so the first runs the early interior test; the
      // next ones only while it keeps finding interior (in spirals at 1.9e10 every sample escaped, a
      // little more slowly with it: see GpuPass.early).
      let early = true;
      while (computed && unsettled) {
        const adapted = adaptBudget(budgetMemory, logScale, iterations, computed, unsettled);
        // Only a raise is taken from these samples. The GPU cannot tell interior pixels near the boundary
        // (often SUSPECT) from late escapers, so their share may barely fall over raises where the view
        // is mostly interior; adaptBudget would then mark the budget saturated, and that would block
        // the raise the workers' proofs call for below (0.3231+0.5529i at 4.7e6 stopped at 24576, with
        // 8% of its pixels unresolved, where the workers alone go on to 98304).
        if (!adapted.raise) break;
        budgetMemory = adapted.memory;
        iterations = adapted.memory!.iterations;
        target.iterations = iterations;
        canvas.dataset.iterations = String(iterations);
        if (!await gpuOrbit(job, id, target, iterations)) return failed();
        // A list: the samples left are sparse, and each of them runs long.
        const again = collect(4, i => isUnsettled(counts[i]));
        runs++;
        if (!await runList(iterations, again, early, stageCoarseOf)) return failed();
        if (early) {
          let inside = 0;
          for (const i of again) if (counts[i] === INSIDE) inside++;
          early = inside > EARLY_SHARE * again.length;
        }
      }
    }
    // 2. Every other pixel (the coarse samples are done, at this budget).
    const mask = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) mask[i] = reused[i] || !Number.isNaN(counts[i]) ? 0 : 1;
    await yieldToEvents();
    if (!current()) return;
    runs++;
    // 3. The workers' share, sent as the pass leaves it. How many pixels it will be, for the worker
    // count, is estimated from the share of coarse samples left to them, or, after a pan, every one.
    let fresh = 0;
    for (let i = 0; i < pixels; i++) fresh += 1 - reused[i];
    let expected = fresh, insideSamples = 0;
    if (!pan) {
      // Coarse samples in the bulbs were not the GPU's: they stay out of its fine pass's statistics.
      let bounded = 0, left = 0, own = 0;
      for (let i = 0; i < pixels; i++) {
        if (counts[i] < 0) left++;
        if (Number.isNaN(counts[i]) || bulbs?.[i]) continue;
        own++;
        if (counts[i] === INSIDE) insideSamples++;
        if (counts[i] === INSIDE || isUnsettled(counts[i])) bounded++;
      }
      // The early interior test where enough coarse samples stayed bounded (after a pan: as the last whole render did).
      gpuEarly = bounded > EARLY_SHARE * own;
      // The fine pass's cap (see DEFER_SHARE): what all but the slowest coarse samples took, escaped or not.
      gpuCap = 1;
      if (own && iterations >= (shallow ? SHALLOW_DEFER_FROM : DEFER_FROM)) {
        const steps = new Float32Array(own);
        let at = 0;
        for (let i = 0; i < pixels; i++) if (!Number.isNaN(counts[i]) && !bulbs?.[i]) steps[at++] = counts[i] >= 0 ? counts[i] : distances[i];
        steps.sort();
        const cap = Math.max(steps[Math.floor((1 - DEFER_SHARE) * (at - 1))] ?? iterations, iterations / 8);
        if (cap <= iterations / 2) gpuCap = cap / iterations;
      }
      expected = Math.ceil(fresh * left / Math.max(1, computed));
    }
    open = cpuRound(expected);
    // The workers get some pixels before the fine pass, which leaves them out: those in the bulbs, and
    // interior blocks, whose four corner coarse samples the GPU found INSIDE. The workers prove such
    // pixels anyway (INSIDE is only the GPU's guess), and colour exactly any that escape after all. At
    // 0.3231+0.5529i (4.7e6) the render took 12 s instead of 13.5 s. Sent tile by tile in chunks, with
    // turns for the page between them: in one piece (2.3 million pixels near the period-3 bulb) it held
    // the main thread for 66 ms.
    // Neither (a view of escaping pixels): no scan at all.
    if (bulbs || insideSamples) {
      const inside = (x: number, y: number) => x >= width || y >= height || counts[y * width + x] === INSIDE;
      let chunk: number[] = [], lastYield = performance.now();
      for (const [x0, y0] of tiles) {
        for (let y = y0; y < Math.min(height, y0 + T); y++) for (let x = x0; x < Math.min(width, x0 + T); x++) {
          const i = y * width + x;
          if (!mask[i]) continue;
          const bx = x & ~3, by = y & ~3;
          if (bulbs?.[i] || (!pan && inside(bx, by) && inside(bx + 4, by) && inside(bx, by + 4) && inside(bx + 4, by + 4))) {
            mask[i] = 0;
            chunk.push(i);
          }
        }
        if (chunk.length >= DIRECT_CHUNK) { open.send(Uint32Array.from(chunk)); chunk = []; }
        if (performance.now() - lastYield > MAIN_SLICE_MS) {
          await yieldToEvents();
          if (!current()) return;
          lastYield = performance.now();
        }
      }
      if (chunk.length) open.send(Uint32Array.from(chunk));
    }
    // Every tile of a whole render is staged here, even one with only coarse samples left (the 1x1 corner
    // tile when both sides are 64n + 1): staging makes its samples final or leaves them to the workers.
    // After a pan only the tiles with pixels to compute (there was no coarse pass).
    // At a large budget, a capped one first (see DEFER_SHARE), then the pixels it left unsettled as a list.
    const capped = Math.ceil(iterations * gpuCap);
    // Shallow: what the capped pass leaves unsettled goes to the workers with the rest (deferred unset).
    deferred = capped < iterations && !shallow ? [] : undefined;
    if (!await run(capped, 1, pan ? tiles.filter(tile => within(mask, tile, 1)) : tiles, mask, stageFine, gpuEarly)) return failed();
    const rest = deferred && Uint32Array.from(deferred);
    deferred = undefined;
    if (rest?.length) {
      runs++;
      if (!await runList(iterations, rest, gpuEarly, stageList)) return failed();
    }
    canvas.dataset.gpuFirstMs ??= String(Math.round(performance.now() - started));
    coarseReady = true;
    completedStep = 1;
    // 4. Raises as the workers' results call for. A stale render must not mark the view finished.
    for (;;) {
      if (!current()) return;
      open.send(takeLeft());
      open.close();
      const unresolved = await open.result;
      if (!unresolved || !current()) return;
      canvas.dataset.cpuUnresolved = String(unresolved.length);
      const adapted = adaptBudget(budgetMemory, logScale, iterations, fresh, unresolved.length, FINAL_RAISE_FRACTION);
      budgetMemory = adapted.memory;
      if (!adapted.raise) break;
      // After a pan the reused pixels keep the old budget: render the whole view at the new one instead.
      if (pan) { startRender(); return; }
      // The surface keeps the old budget until every pixel is final at the new one (as a workers'
      // deepening does): the pixels left unresolved are final at quality 1 now, black, so a pan
      // meanwhile must render the view afresh rather than reuse them.
      iterations = adapted.memory!.iterations;
      canvas.dataset.iterations = String(iterations);
      if (!await gpuOrbit(job, id, target, iterations)) return failed();
      runs++;
      open = cpuRound(unresolved.length);
      if (shallow) { left.push(Uint32Array.from(unresolved)); lefts += unresolved.length; }
      else if (!await runList(iterations, Uint32Array.from(unresolved), true, stageList)) return failed();
    }
    if (!current()) return;
    target.iterations = iterations;
    canvas.dataset.gpuMs = String(Math.round(performance.now() - started));
    canvas.dataset.gpuRuns = String(runs);
    finishRender();
  } finally {
    job.dispose();
  }
}

/** The palette shaders, loaded on the main thread at the first palette switch (they build colour tables). */
let shaders: typeof import('./render/palette.ts') | undefined;

// Transparent where nothing is staged, so the upload composites over the preview.
const uploadCanvas = document.createElement('canvas');
const uploadContext = uploadCanvas.getContext('2d')!;

/** Upload all tiles staged since the last frame with one putImageData and one drawImage. */
function flushTiles(): void {
  const region = stage?.pending();
  if (!region || !stage || !stageImage || !surface) return;
  uploadContext.putImageData(stageImage, 0, 0, region.x, region.y, region.width, region.height);
  const destination = surface.canvas.getContext('2d')!;
  destination.setTransform(1, 0, 0, 1, 0, 0);
  destination.imageSmoothingEnabled = false;
  destination.drawImage(uploadCanvas, region.x, region.y, region.width, region.height,
    region.x, region.y, region.width, region.height);
  stage.clear(region);
}

/** Reproject the last pixels immediately; high precision differences keep deep pans stable. */
function project(target: CanvasRenderingContext2D, source: Surface, destination: View, width: number, height: number): void {
  const ratio = 2 ** (source.view.logScale - destination.logScale);
  const offset = viewOffset(source.view, destination);
  const x = width / 2 + offset.x - source.cssWidth * ratio / 2;
  const y = height / 2 + offset.y - source.cssHeight * ratio / 2;
  if (![ratio, x, y].every(Number.isFinite) || ratio < 1e-6 || ratio > 1e6) return;
  target.drawImage(source.canvas, x, y, source.cssWidth * ratio, source.cssHeight * ratio);
}

/**
 * Quality for a new surface whose preview is the projected old one. Zoomed in
 * by a factor F, a surface finished to step s looks like samples F s pixels
 * apart: coarser passes than that would replace the preview with a blockier
 * image, then sharpen it again, so the grain would grow and shrink while
 * zooming (sharp, blurry, sharp). Those
 * passes still run (their statistics drive the budget); they just are not
 * painted over the better preview. The final pass always paints.
 */
function projectedQuality(source: Surface | undefined, completed: number, width: number, height: number, previous: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(width * height).fill(255);
  if (!source || source.cssWidth !== cssWidth || source.cssHeight !== cssHeight
    || source.canvas.width !== width || source.canvas.height !== height) return result;
  const ratio = 2 ** (source.view.logScale - view.logScale);
  // The same view again (a raised budget): each pixel keeps the quality it had, so passes no
  // finer than what is shown (the GPU preview, a finished 2-pixel pass) do not blur it again.
  const offset = viewOffset(source.view, view);
  if (ratio === 1 && offset.x === 0 && offset.y === 0 && previous.length === result.length) {
    for (let i = 0; i < result.length; i++) result[i] = Math.max(2, previous[i]);
    return result;
  }
  // At least 2: quality 1 means finished, which a pan would reuse as is. Zoomed
  // out, the preview is sharper still but leaves the borders to the coarse passes.
  const effective = Math.max(2, Math.floor(ratio * completed));
  if (!Number.isFinite(ratio) || effective >= 255) return result;
  // Where the projected old image lands, in physical pixels (inset by a pixel for its soft edge).
  const scaleX = width / cssWidth, scaleY = height / cssHeight;
  const left = Math.max(0, Math.ceil((cssWidth / 2 + offset.x - source.cssWidth * ratio / 2) * scaleX) + 1);
  const top = Math.max(0, Math.ceil((cssHeight / 2 + offset.y - source.cssHeight * ratio / 2) * scaleY) + 1);
  const right = Math.min(width, Math.floor((cssWidth / 2 + offset.x + source.cssWidth * ratio / 2) * scaleX) - 1);
  const bottom = Math.min(height, Math.floor((cssHeight / 2 + offset.y + source.cssHeight * ratio / 2) * scaleY) - 1);
  for (let y = top; y < bottom; y++) result.fill(effective, y * width + left, y * width + right);
  return result;
}

function draw(): void {
  frame = 0;
  // The label observer can fire before the canvas has a size (e.g. a hidden page).
  if (!view) return;
  flushTiles();
  hud.update(view, cssWidth, cssHeight);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#050914';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (surface && surface.view.logScale === view.logScale
    && surface.cssWidth === cssWidth && surface.cssHeight === cssHeight
    && surface.canvas.width === canvas.width && surface.canvas.height === canvas.height) {
    // Pure pans use integer physical pixels, never repeatedly resample the cache.
    const offset = viewOffset(surface.view, view);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(surface.canvas, Math.round(offset.x * canvas.width / cssWidth), Math.round(offset.y * canvas.height / cssHeight));
    return;
  }
  ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (surface) project(ctx, surface, view, cssWidth, cssHeight);
}

function scheduleDraw(): void {
  if (!frame) frame = requestAnimationFrame(draw);
}

const hud = createHud({
  canvas, measure: ctx, requestDraw: scheduleDraw, onReset: () => resetView(), palette,
  onPalette: next => setPalette(next),
  shareLink: () => shareLink(),
  current: () => view && { view, cssWidth, cssHeight },
  onApply: next => { goTo(next); writeHash(); },
  onZoom: logFactor => {
    if (!view) return;
    view = transformView(view, { x: 0, y: 0 }, { x: 0, y: 0 }, logFactor);
    changed();
  },
});

/**
 * Render the view. A `preview` (while it keeps changing, see changed()) is on the GPU only a coarse pass
 * at a capped budget; elsewhere it is a full render, as the workers' passes show progress anyway.
 */
function startRender(preview = false): void {
  clearTimeout(renderTimer);
  if (gpuStarting) { scheduleDraw(); return; }
  const iterations = chooseBudget(budgetMemory, view.logScale);
  budgetMemory = rememberUse(budgetMemory, view.logScale);
  // A full render after a whole-view preview of the same view starts over (with its coarse pass and early
  // raises), rather than going on from the preview's pixels as a pan would.
  const afterPreview = previewing !== false && !preview;
  // Reused pixels must come from the same budget: a larger one may resolve black pixels.
  // So must they come from the same palette.
  const pan = previewing !== 'whole' || preview ? surface && surface.cssWidth === cssWidth && surface.cssHeight === cssHeight && surface.iterations === iterations
    && surface.palette === palette && surface.canvas.width === canvas.width && surface.canvas.height === canvas.height
    ? panRaster(surface.view, view, canvas.width, canvas.height, cssWidth, cssHeight) : undefined : undefined;
  // A release or subpixel movement need not cancel useful work already in flight (unless that is a preview).
  if (pan && pan.dx === 0 && pan.dy === 0 && canvas.dataset.rendered !== 'error' && !renderAgain && !afterPreview) {
    scheduleDraw();
    return;
  }
  renderAgain = false;
  // Staged pixels belong to the outgoing surface and are part of the next preview.
  flushTiles();
  const image = document.createElement('canvas');
  image.width = canvas.width; image.height = canvas.height;
  if (stage?.width !== image.width || stage.height !== image.height) {
    stage = new TileStage(image.width, image.height);
    stageImage = new ImageData(stage.pixels, image.width, image.height);
    samples = undefined;
    uploadCanvas.width = image.width; uploadCanvas.height = image.height;
  }
  const imageContext = image.getContext('2d', { alpha: false })!;
  imageContext.fillStyle = '#050914';
  imageContext.fillRect(0, 0, image.width, image.height);
  if (pan && surface) {
    imageContext.imageSmoothingEnabled = false;
    imageContext.drawImage(surface.canvas, pan.dx, pan.dy);
    quality = shiftQuality(quality, image.width, image.height, pan.dx, pan.dy);
    if (samples) {
      shiftInPlace(samples.counts, image.width, image.height, pan.dx, pan.dy, NaN);
      shiftInPlace(samples.distances, image.width, image.height, pan.dx, pan.dy, 0);
    }
  } else {
    imageContext.setTransform(image.width / cssWidth, 0, 0, image.height / cssHeight, 0, 0);
    if (surface) project(imageContext, surface, view, cssWidth, cssHeight);
    samples?.counts.fill(NaN);
    // Another palette's preview is only a placeholder: every pass paints over it.
    quality = projectedQuality(surface?.palette === palette ? surface : undefined, completedStep, image.width, image.height, quality);
  }
  const regions = pan ? missingRegions(quality, image.width, image.height)
    : [{ x: 0, y: 0, width: image.width, height: image.height }];
  surface = { canvas: image, view: pan?.view ?? { ...view }, cssWidth, cssHeight, iterations, palette };
  completedStep = 255;
  generation++;
  lastRender = performance.now();
  coarseReady = false;
  passCounts.clear();
  coarseSamples = coarseUnresolved = coarseMs = coarseUnresolvedMs = 0;
  pendingPixels = deepenIterations = 0;
  pendingLists = [];
  canvas.dataset.rendered = 'false';
  canvas.setAttribute('aria-busy', 'true');
  canvas.dataset.precisionBits = String(view.bits);
  canvas.dataset.logScale = String(view.logScale);
  canvas.dataset.iterations = String(iterations);
  canvas.dataset.palette = palette;
  const renderPixels = regions.reduce((sum, region) => sum + region.width * region.height, 0);
  canvas.dataset.reusedPixels = String(image.width * image.height - renderPixels);
  canvas.dataset.computePixels = String(renderPixels);
  renderPixelCount = renderPixels;
  activeWorkerCount = renderWorkerCount(workerLimit, renderPixels, view.logScale, iterations, shareTables);
  canvas.dataset.workers = String(activeWorkerCount);
  while (workers.length < activeWorkerCount) createWorker();
  const shared = renderPixels ? planReference(surface.view, iterations) : undefined;
  canvas.dataset.referenceKey = shared ? String(shared.key) : '';
  renderBase = { id: generation, view: surface.view, width: image.width, height: image.height,
    cssWidth, cssHeight, workerCount: activeWorkerCount, iterations, regions, palette };
  // A new render releases GPU renders still waiting for an orbit (they then find themselves stale).
  for (const waiter of orbitWaiters) waiter.resolve();
  orbitWaiters = [];
  gpuFixRelease?.();
  gpuFix = gpuFixRelease = undefined;
  if (renderPixels && usesGpu(surface.view)) {
    // The GPU renders; workers drop what they were doing and get the pixels it leaves them.
    workers.forEach(worker => worker.postMessage({ type: 'cancel', id: generation }));
    canvas.dataset.gpu = 'true';
    canvas.dataset.referenceKey = '';
    delete canvas.dataset.gpuFirstMs;
    // Only a pan reuses final pixels (quality 1); otherwise none are.
    const reused = new Uint8Array(quality.length);
    if (pan) for (let i = 0; i < quality.length; i++) if (quality[i] === 1) reused[i] = 1;
    const id = generation;
    previewing = preview ? pan ? 'pan' : 'whole' : false;
    void gpuRender(id, surface, reused, !!pan, preview).catch(error => { if (generation === id) gpuFailed(error); });
    scheduleDraw();
    return;
  }
  canvas.dataset.gpu = '';
  previewing = false;
  workers.forEach((worker, workerIndex) => {
    if (workerIndex >= activeWorkerCount) {
      worker.postMessage({ type: 'cancel', id: generation });
      return;
    }
    worker.postMessage({ ...renderBase!, workerIndex,
      reference: shared && referencePlan(shared, workerIndex) } satisfies RenderRequest);
  });
  scheduleDraw();
}

/** Mirror the view in the URL hash (replaceState: zooming must not flood the history). */
let hashTimer: ReturnType<typeof setTimeout>;
function writeHash(): void {
  clearTimeout(hashTimer);
  if (!view) return;
  // The palette rides along when it isn't the default, so a link shows the same colours.
  const hash = [formatViewHash(view, cssWidth, cssHeight, initialView(cssWidth, cssHeight).logScale),
    palette === 'classic' ? '' : `palette=${palette}`].filter(Boolean).join('&');
  const url = location.pathname + location.search + (hash ? `#${hash}` : '');
  if (url !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', url);
}
/**
 * The address of the view as shown now, for sharing (the hash is otherwise written a moment after a
 * change). The query is left out: it holds only local switches such as ?cpu, which would force the
 * recipient's rendering mode, or tracking parameters the page arrived with.
 */
function shareLink(): string | undefined {
  if (!view) return undefined;
  writeHash();
  return location.origin + location.pathname + location.hash;
}
function scheduleHash(): void {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 250);
}

/** A change after this long without one starts rendering at once (a wheel notch, the start of a drag). */
const IDLE_MS = 250;
/** During a stream of changes, restart at most this often, once the last render has shown its coarse pass. */
const RESTART_MS = 180;
/**
 * And render fully this soon after the last change of a stream, or after twice the gap between its last
 * two changes when they come slower (at most SETTLE_MAX_MS): a busy GPU holds frames back, and with
 * them a held zoom's changes, which were taken for the end of the stream and restarted the render at
 * every frame, so that no pass finished while zooming.
 */
const SETTLE_MS = 60, SETTLE_MAX_MS = 500;
/**
 * The GPU's budget for previews while the view changes: about 4 ms a batch (a batch takes about a
 * microsecond per iteration of its slowest pixel), so previews keep coming and frames keep flowing.
 */
const PREVIEW_ITERATIONS = 4096;
/**
 * A GPU fine pass sends the workers what it leaves them once this many pixels per worker have
 * gathered (and the rest when it ends).
 */
const LEFT_CHUNK = 1024;
/**
 * The workers get the pixels left them in runs of this many from the list (half a GPU tile's row),
 * not one by one. A worker proves interiors fastest among neighbouring pixels (the cycle a row proved
 * is the next pixel's hint, see directRow): dealt one by one to 8 workers, each got every 8th pixel,
 * and a shallow interior pixel cost it 3-5 times as much.
 */
const DEAL_RUN = 32;
/** The workers' tile size: they report unresolved pixels tile by tile (see centreFirst). */
const DEEPEN_TILE = 32;
/** Pixels sent to the workers before a fine pass (see gpuRender) go in chunks of about this many. */
const DIRECT_CHUNK = 65536;
/** Main-thread loops over every pixel give the page a turn after this long. */
const MAIN_SLICE_MS = 8;
/**
 * Pixels are checked against the bulbs (see bulbPixels) down to this scale: below it a pixel's c in
 * doubles is too coarse to tell, and whole views would be taken for interior.
 */
const BULB_LOG_SCALE = -40;
/**
 * A whole render's fine pass runs the GPU kernel with the early interior test when more than this
 * share of its coarse samples stayed bounded (see GpuPass.early).
 */
const EARLY_SHARE = 0.01;
/**
 * From a budget of DEFER_FROM on, the fine pass runs capped at the steps all but DEFER_SHARE of the
 * coarse samples took, or an eighth of the budget if more (and not at all above half of it), and the
 * pixels it leaves unsettled run at the full budget as a list (see GpuPass.list). Among their tiles,
 * the few that run the whole budget held a SIMD group each for one busy lane: in seahorse valley at
 * 1e7, 0.9% of the pixels took 42% of the pass's iterations and most of its time. An eighth alone
 * deferred 89% of a filament view whose pixels escape after 4-8 thousand steps; a lower cap than an
 * eighth mixed more pixels that escape soon after it into the list, which ran slower for it.
 */
const DEFER_SHARE = 0.1, DEFER_FROM = 32768;
/**
 * Shallow views cap their fine pass from this budget on, and the workers get what it leaves unsettled
 * rather than a list pass: they settle it cheaply (see gpuRender's `shallow`). Uncapped, near the
 * period-3 bulb at 300x (budget 24576), the few pixels that ran the whole budget held the fine pass
 * for 650 ms while the workers waited for it.
 */
const SHALLOW_DEFER_FROM = 8192;
/** The last whole render's fine-pass cap, as a share of its budget (after a pan, used again). */
let gpuCap = 1;
/** Whether the last whole GPU render's fine pass did: a pan's does as well. */
let gpuEarly = false;
let lastChange = -Infinity;
/** What the render in flight is: a GPU preview of the whole view, or of a pan's exposed pixels, or a full render. */
let previewing: 'whole' | 'pan' | false = false;

function changed(): void {
  scheduleDraw();
  scheduleHash();
  clearTimeout(renderTimer);
  const now = performance.now(), gap = now - lastChange, idle = gap > IDLE_MS;
  lastChange = now;
  // Leading edge: an isolated change renders immediately instead of waiting
  // for more. Continue supplying new detail during a long drag or zoom; never
  // starve expensive references. On the GPU these are previews.
  if (idle || (coarseReady && now - lastRender > RESTART_MS)) startRender(true);
  // The full render once the changes stop (the same view as a workers' render in flight changes nothing).
  renderTimer = setTimeout(() => startRender(), idle ? SETTLE_MS : Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MS, 2 * gap)));
}

/**
 * The draft (or a deepening) is complete with `pendingPixels` unresolved:
 * deepen those at a raised budget if adaptBudget asks for it, else finish.
 */
function settle(): void {
  flushTiles();
  const adapted = adaptBudget(budgetMemory, surface!.view.logScale, surface!.iterations, renderPixelCount, pendingPixels, FINAL_RAISE_FRACTION);
  budgetMemory = adapted.memory;
  if (adapted.raise && renderBase) {
    // Deepening covers only the pixels this render computed. After a pan, reused
    // pixels keep the old budget's unresolved ones: render the whole surface
    // again at the raised budget instead.
    if (renderPixelCount !== surface!.canvas.width * surface!.canvas.height) { startRender(); return; }
    deepen(adapted.memory!.iterations);
    return;
  }
  finishRender();
}

/**
 * Sample the pixels the draft (or the last deepening) left unresolved again, at `iterations`. The
 * workers' lists are merged and dealt out afresh, evenly in runs from the centre out (see dealRuns),
 * not left with the workers whose tiles they fell in: interiors gather on one side of many views,
 * and a worker that owned most of them worked on for seconds after the rest (3.6 s and 7.6 s of
 * 24 s and 30 s at -0.7309+0.2478i, 4.2e13). The results come back as samples, as a GPU render's do.
 */
function deepen(iterations: number): void {
  const id = generation, base = renderBase!, { width, height, view: target } = base;
  const list = centreFirst(pendingLists, width, height, DEEPEN_TILE);
  deepenIterations = iterations;
  pendingPixels = 0;
  pendingLists = [];
  canvas.dataset.deepening = String(iterations);
  // Every worker the reference memory allows, even for a few pixels (each may run the whole budget; see cpuRound).
  const deep = target.logScale <= DEEP_LOG_SCALE;
  activeWorkerCount = renderWorkerCount(workerLimit, list.length * (deep ? 32 : 2048), target.logScale, iterations, shareTables);
  canvas.dataset.workers = String(activeWorkerCount);
  while (workers.length < activeWorkerCount) createWorker();
  const shared = planReference(target, iterations), round = ++gpuRounds, unresolved: number[] = [];
  // Colours come from the palette shaders, loaded here on first use; results wait for them in order.
  const ready = shaders ? Promise.resolve() : import('./render/palette.ts').then(module => { shaders ??= module; });
  let requests = 0, reports = 0;
  const finish = () => {
    gpuFix = gpuFixRelease = undefined;
    // The surface now holds the deeper budget's pixels throughout (resolved ones never depended on it).
    surface!.iterations = iterations;
    canvas.dataset.iterations = String(iterations);
    deepenIterations = 0;
    pendingPixels = unresolved.length;
    // In index order: centreFirst keeps each tile's pixels in the order given, row by row.
    pendingLists = [Uint32Array.from(unresolved).sort()];
    settle();
  };
  const apply = (message: PixelSamples) => {
    if (generation !== id || !stage) return;
    const shade = shaders!.paletteShader(palette), words = new Uint32Array(message.indices.length);
    samples ??= { counts: new Float32Array(stage.width * stage.height).fill(NaN), distances: new Uint8Array(stage.width * stage.height) };
    for (let k = 0; k < words.length; k++) {
      const i = message.indices[k];
      words[k] = shade(message.counts[k], decodeDistance(message.distances[k]));
      samples.counts[i] = message.counts[k]; samples.distances[i] = message.distances[k];
      if (message.unresolved[k]) unresolved.push(i);
    }
    stage.addPixels(message.indices, words, quality);
    scheduleDraw();
    if (message.done && ++reports === requests) finish();
  };
  gpuFix = message => { if (message.round === round) void ready.then(() => apply(message)); };
  dealRuns(list, activeWorkerCount, DEAL_RUN).forEach((share, workerIndex) => {
    if (!share.length) return;
    requests++;
    workers[workerIndex].postMessage({ type: 'pixels', id, view: target, width, height, cssWidth: base.cssWidth, cssHeight: base.cssHeight,
      iterations, reference: shared && referencePlan(shared, workerIndex), pixels: share, round } satisfies PixelRequest, [share.buffer]);
  });
  if (!requests) finish();
}

function finishRender(): void {
  flushTiles();
  canvas.dataset.deepening = '';
  canvas.dataset.rendered = 'true';
  canvas.dataset.renderMs = String(Math.round(performance.now() - lastRender));
  canvas.setAttribute('aria-busy', 'false');
  canvas.title = '';
}

function createWorker(): void {
  const worker = new Worker(new URL('./render/worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<RenderMessage>) => {
    if (data.type === 'reference') {
      // Still useful after newer generations when they reuse the same reference.
      if (sharedOrbit?.key !== data.key) return;
      sharedOrbit.orbit = data.orbit;
      orbitWaiters = orbitWaiters.filter(waiter => waiter.key !== data.key || (waiter.resolve(), false));
      // With shared tables the other workers need only those (tables, below), not the orbit.
      if (shareTables) { workerOrbitKeys[workers.indexOf(worker)] = data.key; return; }
      workers.forEach((other, workerIndex) => {
        if (workerOrbitKeys[workerIndex] === data.key) return;
        if (other === worker) { workerOrbitKeys[workerIndex] = data.key; return; }
        if (workerIndex >= activeWorkerCount) return;
        workerOrbitKeys[workerIndex] = data.key;
        other.postMessage({ type: 'reference', key: data.key, spec: sharedOrbit!.spec, orbit: data.orbit });
      });
      return;
    }
    if (data.type === 'tables') {
      // Shared memory: passing the tables on copies nothing.
      if (sharedOrbit?.key !== data.key) return;
      sharedOrbit.tables = data.reference;
      workers.forEach((other, workerIndex) => {
        if (workerTableKeys[workerIndex] === data.key) return;
        if (other === worker) { workerTableKeys[workerIndex] = data.key; return; }
        if (workerIndex >= activeWorkerCount) return;
        workerTableKeys[workerIndex] = data.key;
        other.postMessage({ type: 'tables', key: data.key, reference: data.reference });
      });
      return;
    }
    if (data.id !== generation || !surface) return;
    if (data.type === 'error') {
      canvas.title = `Rendering failed: ${data.message}. Press Home to try again.`;
      canvas.dataset.rendered = 'error';
      canvas.setAttribute('aria-busy', 'false');
      console.error(data.message);
      return;
    }
    if (data.type === 'samples') {
      // A request with no pixels only had worker 0 build the shared orbit.
      gpuFix?.(data);
      return;
    }
    if (data.type === 'pass') {
      const count = (passCounts.get(data.step) || 0) + 1;
      passCounts.set(data.step, count);
      if (data.step === 8) {
        coarseSamples += data.samples; coarseUnresolved += data.unresolved;
        coarseMs += data.sampleMs ?? 0; coarseUnresolvedMs += data.unresolvedMs ?? Infinity;
      }
      if (data.step === 1) {
        pendingPixels += data.pending ?? 0;
        if (data.pendingPixels) pendingLists.push(data.pendingPixels);
      }
      if (count === activeWorkerCount) {
        completedStep = data.step;
        if (data.step === 8) {
          coarseReady = true;
          const cheap = coarseMs > 0 && coarseUnresolvedMs <= CHEAP_RAISE * coarseMs;
          if (coarseSamples && (coarseUnresolved / coarseSamples > DRAFT_LIMIT || (coarseUnresolved && cheap))) {
            const adapted = adaptBudget(budgetMemory, surface.view.logScale, surface.iterations, coarseSamples, coarseUnresolved);
            budgetMemory = adapted.memory;
            if (adapted.raise) { startRender(); return; }
          }
        }
        if (data.step === 1) settle();
      }
      return;
    }
    // Workers finish passes independently. A late coarse tile must never erase finer pixels.
    for (const tile of data.tiles) {
      // Shaded before its worker heard of a palette switch: colour it from its samples instead.
      if (tile.palette && tile.palette !== palette && tile.counts && tile.distances && shaders) {
        const shade = shaders.paletteShader(palette), words = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.width * tile.height);
        for (let i = 0; i < words.length; i++) words[i] = shade(tile.counts[i], decodeDistance(tile.distances[i]));
      }
      keepSamples(tile, stage!.add(tile, quality));
    }
    scheduleDraw();
  };
  worker.onerror = event => {
    canvas.title = 'The renderer stopped unexpectedly. Reload the page to try again.';
    canvas.dataset.rendered = 'error';
    canvas.setAttribute('aria-busy', 'false');
    console.error(event.message);
  };
  workers.push(worker);
}

function localPoint(clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
}

window.addEventListener('wheel', event => {
  event.preventDefault();
  if (!view) return;
  const rect = canvas.getBoundingClientRect();
  const anchor = wheelAnchor(event.clientX, event.clientY, rect);
  view = transformView(view, anchor, anchor, wheelLogFactor(event.deltaY, event.deltaMode, cssHeight));
  changed();
}, { passive: false });

const pointers = new Map<number, Point>();
canvas.addEventListener('pointerdown', event => {
  if (!view || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  canvas.focus({ preventScroll: true });
  // Capture can fail if the pointer is already gone (released before this handler ran).
  try { canvas.setPointerCapture(event.pointerId); } catch { return; }
  pointers.set(event.pointerId, localPoint(event.clientX, event.clientY));
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  const before = gesture(pointers.values())!;
  pointers.set(event.pointerId, localPoint(event.clientX, event.clientY));
  const after = gesture(pointers.values())!;
  const logFactor = before.distance > 2 && after.distance > 2 ? Math.log2(before.distance / after.distance) : 0;
  view = transformView(view, before.centre, after.centre, logFactor);
  changed();
});

function releasePointer(event: PointerEvent): void {
  if (!pointers.delete(event.pointerId)) return;
  if (pointers.size === 0) {
    canvas.classList.remove('dragging');
    clearTimeout(renderTimer);
    renderTimer = setTimeout(startRender, 0);
  }
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('lostpointercapture', releasePointer);
window.addEventListener('blur', () => { pointers.clear(); canvas.classList.remove('dragging'); });

function resetView(): void {
  // A step or glide still under way would carry on from the new view.
  hud.stopZooming();
  pointers.clear();
  canvas.classList.remove('dragging');
  view = initialView(cssWidth, cssHeight);
  budgetMemory = undefined;
  writeHash(); // the default view has no hash
  startRender();
}

/** Jump to an unrelated view (a link, the view dialog): what was learnt about the budget no longer applies. */
function goTo(next: View): void {
  hud.stopZooming();
  pointers.clear();
  canvas.classList.remove('dragging');
  view = next;
  budgetMemory = undefined;
  startRender();
}

/**
 * Show the palette in use without computing anything again: colours depend
 * only on each pixel's count and distance. The render under way (if any)
 * carries on in it: workers shade the tiles they start from now on with it,
 * tiles they already shaded are recoloured here as they arrive, and every
 * pixel painted so far is recoloured from its kept samples. Only a projected
 * preview (no samples) stays as it is, marked missing so the passes repaint it.
 */
async function applyPalette(): Promise<void> {
  const next = palette;
  // Nothing kept to recolour from (no tile has arrived): render again.
  if (!samples) { startRender(); return; }
  // Workers can switch at once; renders requested later carry the palette themselves (a deepening's samples are coloured here).
  workers.forEach((worker, workerIndex) => { if (workerIndex < activeWorkerCount) worker.postMessage({ type: 'palette', id: generation, palette: next }); });
  if (renderBase) renderBase = { ...renderBase, palette: next };
  shaders ??= await import('./render/palette.ts');
  // Superseded meanwhile by another switch, which recolours in turn.
  if (palette !== next || !surface || !stage) return;
  flushTiles();
  const target = surface, { width, height } = stage, shade = shaders.paletteShader(next);
  if (samples) {
    const context = target.canvas.getContext('2d')!, image = context.getImageData(0, 0, width, height);
    const words = new Uint32Array(image.data.buffer), { counts, distances } = samples;
    for (let i = 0; i < words.length; i++) {
      if (Number.isNaN(counts[i])) quality[i] = 255;
      else words[i] = shade(counts[i], decodeDistance(distances[i]));
    }
    context.putImageData(image, 0, 0);
  }
  target.palette = next;
  canvas.dataset.palette = next;
  canvas.dataset.recoloured = String(generation);
  scheduleDraw();
}

/** Switch the colour scheme, and remember the choice here. */
function setPalette(next: Palette): void {
  try { localStorage.setItem(PALETTE_KEY, next); } catch { /* not remembered: still applies now */ }
  if (next === palette) return;
  palette = next;
  hud.setPalette(palette);
  if (!view) return;
  writeHash();
  void applyPalette();
}

// Edited or navigated hashes (back/forward) move the view; replaceState does not fire this.
window.addEventListener('hashchange', () => {
  if (!view) return;
  const nextPalette = viewHashPalette(location.hash) ?? 'classic';
  const paletteChanged = nextPalette !== palette;
  if (paletteChanged) { palette = nextPalette; hud.setPalette(palette); }
  // A hash without a centre (empty, or only a palette) is the full view.
  if (!new URLSearchParams(location.hash.replace(/^#/, '')).has('re')) { resetView(); return; }
  const next = parseViewHash(location.hash, initialView(cssWidth, cssHeight).logScale);
  if (next) goTo(next);
  else if (paletteChanged) void applyPalette();
});

function resize(): void {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
  if (view && width === canvas.width && height === canvas.height && cssWidth === rect.width && cssHeight === rect.height) return;
  cssWidth = rect.width; cssHeight = rect.height;
  canvas.width = width; canvas.height = height;
  // A shared link opens at its view; zoom is relative to this window's initial view.
  view ??= parseViewHash(location.hash, initialView(cssWidth, cssHeight).logScale) ?? initialView(cssWidth, cssHeight);
  pointers.clear(); canvas.classList.remove('dragging');
  scheduleHash();
  startRender();
}
new ResizeObserver(resize).observe(canvas);
resize();

function watchPixelRatio(): void {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    resize(); watchPixelRatio();
  }, { once: true });
}
watchPixelRatio();
window.addEventListener('pagehide', () => {
  clearTimeout(renderTimer);
  hud.dispose();
  writeHash();
  cancelAnimationFrame(frame);
  workers.forEach(worker => worker.terminate());
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
