/**
 * How many render workers to run: up to one fewer than the logical cores (at
 * most 8), fewer for small regions, and fewer when long reference orbits would
 * multiply memory across workers (unless the workers share one copy).
 */
import { DEEP_LOG_SCALE } from '../fractal/reference.ts';
/** Leave a logical core available for input, compositing and the rest of the page. */
export function workerCapacity(hardwareConcurrency: number | undefined): number {
  const cores = hardwareConcurrency && Number.isFinite(hardwareConcurrency) ? Math.floor(hardwareConcurrency) : 4;
  return Math.max(1, Math.min(8, cores - 1));
}

/** All workers' reference tables together should stay around this size. */
const REFERENCE_MEMORY = 192 * 1024 * 1024;

/**
 * Per worker and orbit step: native BLA tables plus the orbit (~160 B);
 * below 2^-800 also the extended-exponent tables (~280 B in all; measured in
 * Node 24). All typed arrays.
 */
export function referenceBytesPerIteration(logScale: number): number {
  return logScale <= -800 ? 280 : 160;
}

/** `shared`: the workers share one copy of the reference tables (a cross-origin isolated page). */
export function renderWorkerCount(capacity: number, pixels: number, logScale: number, iterations: number, shared = false): number {
  const deep = logScale <= DEEP_LOG_SCALE;
  const workload = Math.ceil(pixels / (deep ? 8192 : 65536));
  // Otherwise each deep worker owns a copy of the reference tables. This is a
  // conservative planning estimate (not a hard memory bound), so very long
  // references don't multiply unchecked just because a device advertises many cores.
  const referenceLimit = deep && !shared ? Math.floor(REFERENCE_MEMORY / (iterations * referenceBytesPerIteration(logScale))) : capacity;
  return Math.max(1, Math.min(capacity, workload, referenceLimit));
}

/**
 * Deal a list of pixels (nearest the centre first) to `workers` workers, round-robin in runs of up to
 * `run` neighbouring entries, so every worker starts near the centre and proves neighbours together
 * (see main.ts's DEAL_RUN). A list shorter than `run` per worker gets shorter runs, so every worker
 * still has a share: a final raise's few hundred pixels each run the whole budget.
 */
export function dealRuns(list: Uint32Array, workers: number, run: number): Uint32Array<ArrayBuffer>[] {
  const length = Math.max(1, Math.min(run, Math.ceil(list.length / workers)));
  const sizes = new Array<number>(workers).fill(0);
  for (let k = 0, w = 0; k < list.length; k += length, w = (w + 1) % workers) sizes[w] += Math.min(length, list.length - k);
  const shares = sizes.map(size => new Uint32Array(size)), filled = new Array<number>(workers).fill(0);
  for (let k = 0, w = 0; k < list.length; k += length, w = (w + 1) % workers) {
    const end = Math.min(list.length, k + length);
    shares[w].set(list.subarray(k, end), filled[w]);
    filled[w] += end - k;
  }
  return shares;
}

/**
 * Merge lists of pixels (indices y width + x), each holding whole `tile`-pixel tiles row by row (as
 * the workers' final passes report their unresolved ones), into one: tile by tile nearest the canvas
 * centre first, each tile's pixels together and in their order. So dealRuns hands every worker
 * neighbouring pixels near the centre first, as the workers' own tiles were.
 */
export function centreFirst(lists: readonly Uint32Array[], width: number, height: number, tile: number): Uint32Array<ArrayBuffer> {
  const tilesX = Math.ceil(width / tile), tilesY = Math.ceil(height / tile);
  const tileOf = (i: number) => Math.floor(Math.floor(i / width) / tile) * tilesX + Math.floor((i % width) / tile);
  const sizes = new Uint32Array(tilesX * tilesY);
  let total = 0;
  for (const list of lists) for (const i of list) { sizes[tileOf(i)]++; total++; }
  const distance = (t: number) => ((t % tilesX + 0.5) * tile - width / 2) ** 2 + ((Math.floor(t / tilesX) + 0.5) * tile - height / 2) ** 2;
  const order = Array.from(sizes.keys()).filter(t => sizes[t] > 0).sort((a, b) => distance(a) - distance(b) || a - b);
  const offsets = new Uint32Array(tilesX * tilesY);
  let at = 0;
  for (const t of order) { offsets[t] = at; at += sizes[t]; }
  const merged = new Uint32Array(total);
  for (const list of lists) for (const i of list) merged[offsets[tileOf(i)]++] = i;
  return merged;
}
