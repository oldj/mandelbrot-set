/**
 * Views of the complex plane: the centre in BigInt binary fixed point, with
 * precision growing with depth, and the scale as a log2, so neither ever
 * underflows. Coordinates on screen are CSS pixels from the canvas centre,
 * with y downwards.
 */

/** Binary fixed point for positions; the scale stays logarithmic, never underflows. */
export interface View {
  re: bigint;
  im: bigint;
  bits: number;
  logScale: number; // log2(complex units per CSS pixel)
}

const buffer = new DataView(new ArrayBuffer(8));

/** Convert a double * 2^exponent to fixed point without first underflowing it. */
export function toFixed(value: number, bits: number, exponent = 0): bigint {
  if (!Number.isFinite(value)) throw new RangeError('Non-finite coordinate');
  if (value === 0) return 0n;
  buffer.setFloat64(0, value);
  const raw = buffer.getBigUint64(0);
  const e = Number((raw >> 52n) & 2047n);
  const mantissa = (raw & ((1n << 52n) - 1n)) | (e ? 1n << 52n : 0n);
  const shift = bits + exponent + (e ? e - 1075 : -1074);
  const result = shift >= 0 ? mantissa << BigInt(shift) : mantissa >> BigInt(-shift);
  return raw >> 63n ? -result : result;
}

/** value * 2^logScale (a CSS offset in complex units) in fixed point with `bits` fractional bits. */
export function scaledFixed(value: number, logScale: number, bits: number): bigint {
  const exponent = Math.floor(logScale);
  return toFixed(value * 2 ** (logScale - exponent), bits, exponent);
}

/** A fixed-point value as a double, divided by 2^logScale (so offsets come back in CSS pixels). */
export function fixedToNumber(value: bigint, bits: number, logScale = 0): number {
  if (value === 0n) return 0;
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const shift = Math.max(0, magnitude.toString(2).length - 53);
  const mantissa = Number(magnitude >> BigInt(shift));
  const normalizer = Math.floor(Math.log2(mantissa));
  return (negative ? -1 : 1) * (mantissa / 2 ** normalizer) * 2 ** (shift - bits - logScale + normalizer);
}

/** The same view with enough fractional bits for its scale (never fewer than it had). */
export function ensurePrecision(view: View, logScale = view.logScale): View {
  // 128 guard bits beyond one CSS pixel; never discard previous coordinate digits.
  const bits = Math.max(view.bits, 128, Math.ceil((-logScale + 128) / 64) * 64);
  const shift = BigInt(bits - view.bits);
  return { ...view, re: view.re << shift, im: view.im << shift, bits };
}

/** The full-set view for a window of this CSS size. */
export function initialView(width: number, height: number): View {
  return { re: -(3n << 192n) / 5n, im: 0n, bits: 192,
    logScale: Math.log2(Math.max(3.4 / width, 2.7 / height)) };
}

export interface Point { x: number; y: number }

/** Move oldAnchor to newAnchor while changing scale, relative to canvas centre. */
export function transformView(view: View, oldAnchor: Point, newAnchor: Point, logFactor: number): View {
  // Limit only zooming OUT. Zooming IN has no fixed precision/depth ceiling.
  const logScale = Math.min(2, view.logScale + logFactor);
  const next = ensurePrecision(view, logScale);
  next.re += scaledFixed(oldAnchor.x, view.logScale, next.bits) - scaledFixed(newAnchor.x, logScale, next.bits);
  next.im += scaledFixed(-oldAnchor.y, view.logScale, next.bits) - scaledFixed(-newAnchor.y, logScale, next.bits);
  next.logScale = logScale;
  return next;
}

/** Where `from`'s centre lies in `to`, in CSS pixels (y downwards). */
export function viewOffset(from: View, to: View): Point {
  const bits = Math.max(from.bits, to.bits);
  const re = (from.re << BigInt(bits - from.bits)) - (to.re << BigInt(bits - to.bits));
  const im = (from.im << BigInt(bits - from.bits)) - (to.im << BigInt(bits - to.bits));
  return { x: fixedToNumber(re, bits, to.logScale), y: -fixedToNumber(im, bits, to.logScale) };
}

/** Exactly the default view for this window size (any pan or zoom makes it differ). */
export function isInitialView(view: View, width: number, height: number): boolean {
  const initial = initialView(width, height);
  if (view.logScale !== initial.logScale) return false;
  const bits = Math.max(view.bits, initial.bits);
  const align = (value: bigint, from: number) => value << BigInt(bits - from);
  return align(view.re, view.bits) === align(initial.re, initial.bits)
    && align(view.im, view.bits) === align(initial.im, initial.bits);
}
