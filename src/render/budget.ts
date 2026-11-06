/**
 * Adapting the iteration budget to what a region actually needs: raised when
 * too many coarse samples run out of iterations, remembered while zooming
 * nearby, and forgotten after zooming far out.
 */
import { iterationBudget } from '../fractal/index.ts';

/** The most a region may raise its budget to: 64x the depth formula, within [2^16, 2^20]. */
export function maxIterations(logScale: number): number {
  return Math.min(2 ** 20, Math.max(2 ** 16, iterationBudget(logScale) * 64));
}
/** Raise the budget when more than this share of coarse samples ran out of iterations. */
const RAISE_FRACTION = 0.01;
const RAISE_FACTOR = 4;
/** A raise that leaves this share of the unresolved samples is not paying for itself. */
const DIMINISHING = 0.7;

/**
 * A budget learned from how a region actually behaves. The depth formula is
 * only a floor: some regions (seahorse valley, say) need many times more
 * iterations, and too small a budget renders exterior detail as solid black.
 */
export interface BudgetMemory {
  iterations: number;
  /** Where the learned budget was last used; zooming far out of it forgets it. */
  logScale: number;
  /** Unresolved share at the budget this one was raised from. */
  previousFraction: number;
  /** Raising stopped helping here; try again only after zooming deeper. */
  saturatedAt?: number;
}

export function chooseBudget(memory: BudgetMemory | undefined, logScale: number): number {
  const formula = iterationBudget(logScale);
  if (!memory || logScale > memory.logScale + 8) return formula;
  return Math.max(formula, memory.iterations);
}

/** Keep a learned budget alive while it is in use near where it was learned. */
export function rememberUse(memory: BudgetMemory | undefined, logScale: number): BudgetMemory | undefined {
  if (!memory || logScale > memory.logScale + 8) return undefined;
  return { ...memory, logScale: Math.min(memory.logScale, logScale) };
}

/**
 * After a render's coarse pass at `iterations`: the memory to use next and
 * whether to re-render with its larger budget now. Colours depend only on the
 * escape count, so a larger budget only changes samples that ran out.
 */
export function adaptBudget(memory: BudgetMemory | undefined, logScale: number, iterations: number,
  samples: number, unresolved: number): { memory: BudgetMemory | undefined; raise: boolean } {
  const fraction = samples ? unresolved / samples : 0;
  const max = maxIterations(logScale);
  if (samples < 64 || fraction <= RAISE_FRACTION || iterations >= max) return { memory, raise: false };
  if (memory?.saturatedAt !== undefined && logScale > memory.saturatedAt - 4) return { memory, raise: false };
  // A raise may not resolve much yet when samples need just a little more; only
  // give up once far above the depth formula and the share is barely falling.
  if (memory && memory.iterations === iterations && memory.saturatedAt === undefined
    && iterations >= iterationBudget(logScale) * 16 && fraction > memory.previousFraction * DIMINISHING) {
    return { memory: { ...memory, saturatedAt: logScale }, raise: false };
  }
  const next = Math.min(max, iterations * RAISE_FACTOR);
  return { memory: { iterations: next, logScale, previousFraction: fraction }, raise: true };
}
