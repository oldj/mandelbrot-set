/** Formatting a view for people: coordinates to sub-pixel precision, abbreviated to fit, and the magnification. */
import { digitScale } from '../math/precision.ts';
import type { View } from '../math/precision.ts';

/** Presentation only: keep the beginning and the changing tail, never alter the source. */
export function compactCoordinate(value: string, maxCharacters = 23): string {
  const budget = Math.max(5, Math.min(23, Math.floor(maxCharacters)));
  if (value.length <= budget) return value;
  const tail = Math.max(2, Math.min(8, Math.floor((budget - 1) * 0.4)));
  return `${value.slice(0, budget - tail - 1)}…${value.slice(-tail)}`;
}

/** Decimal places that resolve a thousandth of a CSS pixel at this scale (at least 8). */
export function coordinatePlaces(logScale: number): number {
  return Math.max(8, Math.ceil(-logScale * Math.LOG10E * Math.LN2) + 3);
}

/**
 * The scale whose coordinates have `places` decimals: a depth for coordinates
 * given as text (a link, the view dialog), so writing them again gives the
 * same number of digits.
 */
export function depthOfPlaces(places: number): number {
  // Just short of the boundary, so that rounding cannot add a digit on the way back.
  return -(Math.max(5, places) - 3 - 1e-9) / (Math.LOG10E * Math.LN2);
}

/** Round in integer arithmetic, retaining decimal places finer than a screen pixel. */
export function formatCoordinate(value: bigint, bits: number, logScale: number): string {
  const places = coordinatePlaces(logScale);
  const magnitude = value < 0n ? -value : value;
  const rounded = (magnitude * 10n ** BigInt(places) + (1n << BigInt(bits - 1))) >> BigInt(bits);
  const digits = rounded.toString().padStart(places + 1, '0');
  return `${value < 0n && rounded !== 0n ? '-' : ''}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

/** Format in log space so extreme zooms never become Infinity or zero. */
export function formatZoom(logZoom: number): string {
  const log10 = logZoom * Math.LOG10E * Math.LN2;
  if (log10 >= -2 && log10 < 6) return `${(2 ** logZoom).toFixed(2)}×`;
  let exponent = Math.floor(log10);
  let mantissa = (10 ** (log10 - exponent)).toFixed(2);
  if (mantissa === '10.00') { mantissa = '1.00'; exponent++; }
  // No spaces around × so the zoom stays compact enough to show in full.
  return `${mantissa}×10^${exponent}`;
}

/** The centre and magnification as shown in the info panel (magnification relative to the window's initial view). */
export function viewInfo(view: View, initialLogScale: number): { real: string; imaginary: string; zoom: string } {
  return {
    real: formatCoordinate(view.re, view.bits, digitScale(view)),
    imaginary: formatCoordinate(view.im, view.bits, digitScale(view)),
    zoom: formatZoom(initialLogScale - view.logScale),
  };
}

/** The text the copy button puts on the clipboard. */
export function viewClipboardText(view: View, initialLogScale: number): string {
  const info = viewInfo(view, initialLogScale);
  return `Mandelbrot set\nCenter (Re): ${info.real}\nCenter (Im): ${info.imaginary}\nZoom: ${info.zoom}`;
}
