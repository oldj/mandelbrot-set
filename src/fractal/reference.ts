/**
 * Planning reference orbits on the main thread and in workers: which views
 * need one, where a new one goes (the view centre, padded so small pans and
 * zoom-outs can reuse it), and whether an existing one still serves a view.
 * Computing the orbit itself is in ./orbit.ts.
 */
import { fromFixed, logMagnitude } from '../math/extended.ts';
import type { Extended } from '../math/extended.ts';
import { fixedToNumber } from '../math/precision.ts';
import type { View } from '../math/precision.ts';

/**
 * Views at or below this scale use a perturbation reference instead of plain
 * doubles. Plain doubles round z itself, at |z| ~ 1; perturbation rounds δ,
 * far smaller. Against BigInt for every pixel of filament-rich views, plain
 * doubles left 3-5x as many samples off by more than half an iteration as
 * perturbation at 2^-22, 7-10x at 2^-26, 10-30x at 2^-30 (up to 5.6% of the
 * view), and from 2^-34 some came out inside instead of escaping; at 2^-14
 * the two were alike. Perturbation from 2^-24 makes renders between here and
 * 2^-38 1.3-2.2x slower than plain doubles were.
 */
export const DEEP_LOG_SCALE = -24;
/** A reused reference may be at most 2^24 CSS pixels from the view centre. */
const MAX_REFERENCE_OFFSET_BITS = 24;

/** Compact, transferable orbit: normalized mantissas with independent binary exponents. */
export interface OrbitData { re: Float64Array<ArrayBuffer>; im: Float64Array<ArrayBuffer>; exp: Float64Array<ArrayBuffer> }

/** Where and how deep a reference orbit was computed, and the delta radius its BLA table covers. */
export interface ReferenceSpec { view: View; limit: number; logRadius: number }

/** log2 of the largest pixel distance from the view centre, in complex units. */
export function viewLogRadius(view: View, cssWidth: number, cssHeight: number): number {
  return view.logScale + Math.log2(Math.hypot(cssWidth, cssHeight) / 2 + 1);
}

/** A fresh reference at the view centre, padded so small zoom-outs and pans can reuse it. */
export function referenceSpec(view: View, cssWidth: number, cssHeight: number, limit: number): ReferenceSpec {
  return { view: { ...view }, limit, logRadius: viewLogRadius(view, cssWidth, cssHeight) + 2 };
}

/** Cardioid/bulb classification of the whole view, with a conservative margin. */
export function interiorStatus(view: View, logRadius: number): 'inside' | 'near' | 'outside' {
  const centreRe = fixedToNumber(view.re, view.bits), centreIm = fixedToNumber(view.im, view.bits);
  const q = (centreRe - 0.25) ** 2 + centreIm ** 2;
  const cardioid = q * (q + centreRe - 0.25) - centreIm ** 2 / 4;
  const bulb = (centreRe + 1) ** 2 + centreIm ** 2 - 1 / 16;
  // A conservative derivative/rounding bound over [-4,4]^2. Away from the
  // boundary, avoid doing multi-precision cardioid tests for every pixel.
  const margin = 8192 * (Number.EPSILON + 2 ** logRadius);
  const nearby = Math.abs(centreRe) < 4 && Math.abs(centreIm) < 4;
  if (nearby && (cardioid < -margin || bulb < -margin)) return 'inside';
  return nearby && (cardioid <= margin || bulb <= margin) ? 'near' : 'outside';
}

/** Whether rendering this view samples through a reference orbit at all. */
export function needsReference(view: View, cssWidth: number, cssHeight: number): boolean {
  return view.logScale <= DEEP_LOG_SCALE && interiorStatus(view, viewLogRadius(view, cssWidth, cssHeight)) !== 'inside';
}

/**
 * The view centre relative to the reference, or undefined when the reference
 * cannot serve this view: too shallow a precision or budget, a BLA table that
 * does not cover every pixel delta, or too far away for 53-bit pixel deltas.
 */
export function referenceOffset(spec: ReferenceSpec, view: View, logRadius: number, limit: number): Extended | undefined {
  if (spec.view.bits < view.bits || spec.limit < limit) return undefined;
  const shift = BigInt(spec.view.bits - view.bits);
  const offset = fromFixed((view.re << shift) - spec.view.re, (view.im << shift) - spec.view.im, spec.view.bits);
  const logOffset = logMagnitude(offset);
  const maxLog = Math.max(logOffset, logRadius);
  const bound = maxLog + Math.log2(2 ** (logOffset - maxLog) + 2 ** (logRadius - maxLog));
  // Precision bits never shrink after zooming out, so `bits` alone does not
  // stop a shallow reference from being stretched over a much finer view.
  if (bound > spec.logRadius || logOffset - view.logScale > MAX_REFERENCE_OFFSET_BITS) return undefined;
  return offset;
}
