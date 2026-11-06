/** Leave a logical core available for input, compositing and the rest of the page. */
export function workerCapacity(hardwareConcurrency: number | undefined): number {
  const cores = hardwareConcurrency && Number.isFinite(hardwareConcurrency) ? Math.floor(hardwareConcurrency) : 4;
  return Math.max(1, Math.min(8, cores - 1));
}

export function renderWorkerCount(capacity: number, pixels: number, logScale: number, iterations: number): number {
  const deep = logScale <= -38;
  const workload = Math.ceil(pixels / (deep ? 8192 : 65536));
  // Each deep worker owns an orbit and BLA tree. This is a conservative planning
  // estimate (not a hard memory bound), so very long references don't multiply
  // unchecked just because a device advertises many cores.
  const referenceLimit = deep ? Math.floor(128 * 1024 * 1024 / (iterations * 768)) : capacity;
  return Math.max(1, Math.min(capacity, workload, referenceLimit));
}
