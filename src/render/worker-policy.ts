/**
 * How many render workers to run: up to one fewer than the logical cores (at
 * most 8), fewer for small regions, and fewer when long reference orbits would
 * multiply memory across workers.
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
 * Per worker and orbit step: native BLA tables in typed arrays plus the
 * orbit (~160 B); below 2^-800 the extended-exponent object tables (~768 B).
 */
export function referenceBytesPerIteration(logScale: number): number {
  return logScale <= -800 ? 768 : 160;
}

export function renderWorkerCount(capacity: number, pixels: number, logScale: number, iterations: number): number {
  const deep = logScale <= DEEP_LOG_SCALE;
  const workload = Math.ceil(pixels / (deep ? 8192 : 65536));
  // Each deep worker owns a copy of the reference tables. This is a conservative
  // planning estimate (not a hard memory bound), so very long references don't
  // multiply unchecked just because a device advertises many cores.
  const referenceLimit = deep ? Math.floor(REFERENCE_MEMORY / (iterations * referenceBytesPerIteration(logScale))) : capacity;
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
