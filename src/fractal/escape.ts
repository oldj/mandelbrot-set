/**
 * Escape-time basics shared by every iteration kernel: the interior
 * sentinel, the depth-based iteration budget, the smooth escape count and the
 * distance estimate of the last sample.
 */

/** The value a sample takes when it did not escape (proved interior, or still bounded at the budget). */
export const INTERIOR = -1;

/** The iteration budget the depth alone calls for; render/budget.ts raises it where a region needs more. */
export function iterationBudget(logScale: number): number {
  return Math.ceil((800 + Math.max(0, -logScale - 8) * 32) / 512) * 512;
}

export function smooth(iteration: number, logRadius: number): number {
  return iteration + 1 - Math.log2(logRadius);
}

/**
 * Distance estimate of the most recent sample, in units of the pixel size
 * the iteration was given (NaN for interior, unresolved or fallback samples).
 * Kernels track z' = dz/dc times the pixel size (z'_{n+1} = 2 z_n z'_n + pixel),
 * which stays within double range at any depth, and at escape
 * |z| ln|z| / |z'| is the distance to the set within a factor of about 2.
 */
export const lastSample = { distance: NaN, unresolved: false };
export function lastDistance(): number { return lastSample.distance; }
/**
 * Whether the most recent sample is INTERIOR only because it reached the
 * budget (neither escaped nor proved interior): a larger budget may resolve it.
 */
export function lastUnresolved(): boolean { return lastSample.unresolved; }
export const escapeDistance = (squared: number, dr: number, di: number) => Math.sqrt(squared) * 0.5 * Math.log(squared) / Math.hypot(dr, di);
