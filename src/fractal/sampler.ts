/**
 * Choosing how to sample a view, and the per-view state that goes with it.
 */
import { add, extended, ZERO } from '../math/extended.ts';
import { fixedToNumber, scaledFixed } from '../math/precision.ts';
import type { View } from '../math/precision.ts';
import { directDouble, directFixed, directRow, insideFixed } from './direct.ts';
import type { CycleHint } from './direct.ts';
import { INTERIOR, lastSample } from './escape.ts';
import { attractingCycle, HINT_PASSES, provedCycle, ROUNDING } from './interior.ts';
import { buildReference, EXTENDED_LOG_SCALE } from './orbit.ts';
import type { Checkpoint, Reference } from './orbit.ts';
import { perturbExtended, perturbNative } from './perturbation.ts';
import type { SampleStats } from './perturbation.ts';
import { DEEP_LOG_SCALE, interiorStatus, referenceOffset, referenceSpec, viewLogRadius } from './reference.ts';
import type { ReferenceSpec } from './reference.ts';

/** Samples one view at CSS-pixel offsets from its centre; lastDistance() holds each sample's distance estimate. */
export interface Sampler {
  sample(x: number, y: number): number;
  /** Optional faster path for a row of samples sharing one y (CSS offsets from the centre), with distance estimates. */
  row?(xs: Float64Array, count: number, y: number, out: Float64Array, distances: Float64Array): void;
  stats: SampleStats;
}

export interface ReferenceEntry extends ReferenceSpec { reference: Reference }

export interface ReferenceCache { entry?: ReferenceEntry }

/** Supplies a shared reference chosen by the main thread instead of building one locally. */
export type ReferenceSource = () => Promise<ReferenceEntry>;

/**
 * A sampler for a view: plain doubles above 2^-38, otherwise perturbation
 * around a reference (the cached or supplied one when it still covers the
 * view, see referenceOffset, else a new one), native down to 2^-900 and
 * extended-exponent below. Deep native samples first try the neighbouring
 * pixel's attracting cycle (see provedCycle).
 */
export async function createSampler(view: View, cssWidth: number, cssHeight: number, limit: number, checkpoint: Checkpoint,
  cache: ReferenceCache = {}, source?: ReferenceSource): Promise<Sampler> {
  const stats: SampleStats = { fallbacks: 0, skipped: 0, unresolved: 0 };
  if (view.logScale > DEEP_LOG_SCALE) {
    const cr = fixedToNumber(view.re, view.bits), ci = fixedToNumber(view.im, view.bits);
    const scale = 2 ** view.logScale;
    let row = new Float64Array(0);
    // Carried across rows: neighbouring rows usually share their interior components.
    const hint: CycleHint = { found: false, re: 0, im: 0, period: 0, successes: 0, failures: 0, skipped: 0 };
    return { stats,
      sample(x, y) { lastSample.distance = NaN; return directDouble(cr + x * scale, ci - y * scale, limit, scale); },
      row(xs, count, y, out, distances) {
        if (row.length < count) row = new Float64Array(count);
        for (let i = 0; i < count; i++) row[i] = cr + xs[i] * scale;
        stats.unresolved += directRow(row, ci - y * scale, count, limit, out, distances, scale, hint);
      } };
  }
  const logRadius = viewLogRadius(view, cssWidth, cssHeight);
  const interior = interiorStatus(view, logRadius);
  if (interior === 'inside') return { stats, sample: () => { lastSample.distance = NaN; return INTERIOR; } };
  const exactInterior = interior === 'near';

  const native = view.logScale > EXTENDED_LOG_SCALE;
  let entry = source ? await source() : cache.entry;
  let offset = entry && referenceOffset(entry, view, logRadius, limit);
  // A shallower reference may lack the extended tables a deeper view needs.
  if (!entry || !offset || (!native && !entry.reference.levels)) {
    const spec = referenceSpec(view, cssWidth, cssHeight, limit);
    entry = { ...spec, reference: await buildReference(view, limit, spec.logRadius, checkpoint) };
    cache.entry = entry;
    offset = ZERO;
  }
  const reference = entry.reference;
  const exponent = Math.floor(view.logScale);
  const mantissa = 2 ** (view.logScale - exponent);
  const scale = 2 ** view.logScale;
  const offsetRe = offset.re * 2 ** offset.exp, offsetIm = offset.im * 2 ** offset.exp;
  let hint: { m: number; sr: number; si: number; period: number } | undefined;
  return { stats, sample(x, y) {
    // Fixed-point is only used per pixel for exact interior tests or detected glitches.
    lastSample.distance = NaN;
    let cr: bigint | undefined, ci: bigint | undefined;
    const coordinates = () => {
      cr ??= view.re + scaledFixed(x, view.logScale, view.bits);
      ci ??= view.im - scaledFixed(y, view.logScale, view.bits);
    };
    if (exactInterior) {
      coordinates();
      if (insideFixed(cr!, ci!, view.bits)) return INTERIOR;
    }
    const fallback = () => {
      coordinates(); stats.fallbacks++;
      return directFixed(cr!, ci!, view.bits, limit);
    };
    if (!native) return perturbExtended(reference, add(offset, extended(x * mantissa, -y * mantissa, exponent)), limit, fallback, stats, view.logScale);
    const dcRe = offsetRe + x * scale, dcIm = offsetIm - y * scale;
    provedCycle.found = false;
    if (hint) {
      // The neighbour's attracting cycle, refined for this c: interior without iterating the orbit.
      if (attractingCycle(reference, hint.m, hint.sr, hint.si, dcRe, dcIm, hint.period, ROUNDING * Math.hypot(dcRe, dcIm), HINT_PASSES) < 0) {
        hint = { ...provedCycle };
        return INTERIOR;
      }
      hint = undefined;
    }
    const value = perturbNative(reference, dcRe, dcIm, limit, fallback, stats, scale);
    if (value === INTERIOR && provedCycle.found) hint = { ...provedCycle };
    return value;
  } };
}
