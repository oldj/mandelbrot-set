import { ensurePrecision, isInitialView } from './precision.ts';
import type { View } from './precision.ts';
import { formatCoordinate } from './view-info.ts';
import type { ColorMapping } from './palette.ts';

/**
 * The view as a shareable URL hash: `re=…&im=…&zoom=…`.
 *
 * Coordinates are the full decimal centre shown in the information panel
 * (three digits beyond one screen pixel), so a link restores the position to
 * ~1/1000 pixel at any depth. Zoom is relative to the window's initial view,
 * like the displayed magnification: a link opened in a differently sized
 * window shows the same framing rather than a different area. It is written
 * in scientific notation so depths like 10^1204 survive as text.
 */
export function formatViewHash(view: View, width: number, height: number, initialLogScale: number, mapping?: ColorMapping): string {
  const boosted = mapping !== undefined && mapping.stretch !== 1;
  if (!boosted && isInitialView(view, width, height)) return '';
  const re = formatCoordinate(view.re, view.bits, view.logScale);
  const im = formatCoordinate(view.im, view.bits, view.logScale);
  // A locked colour boost travels with the link (shortest round-trip number text, so it is exact).
  const color = boosted ? `&color=${mapping.stretch}:${mapping.anchor}` : '';
  return `re=${re}&im=${im}&zoom=${formatZoomText(initialLogScale - view.logScale)}${color}`;
}

/** The locked colour boost a hash carries (`color=stretch:anchor`), if any and valid. */
export function parseColorHash(hash: string): ColorMapping | undefined {
  const text = new URLSearchParams(hash.replace(/^#/, '')).get('color');
  const match = text === null ? null : /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return undefined;
  const stretch = Number(match[1]), anchor = Number(match[2]);
  if (!(stretch > 1 && stretch <= 64) || !Number.isFinite(anchor) || anchor > 1e9) return undefined;
  return { stretch, anchor };
}

/** Magnification as plain text: 10 significant digits (edges land within ~1e-6 px), `e` notation from 10^6 or below 10^-2. */
export function formatZoomText(logZoom: number): string {
  const log10 = logZoom * Math.LOG10E * Math.LN2;
  if (log10 >= -2 && log10 < 6) return String(Number((2 ** logZoom).toPrecision(10)));
  let exponent = Math.floor(log10);
  let mantissa = Number((10 ** (log10 - exponent)).toFixed(9));
  if (mantissa >= 10) { mantissa = 1; exponent++; }
  return `${mantissa}e${exponent}`;
}

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?$/;
const ZOOM = /^(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d{1,9}))?$/i;
/** Generous for 2^-40000-deep coordinates, small enough to keep parsing cheap. */
const MAX_DIGITS = 20000;

/** log2 of a positive decimal magnification such as `3.5`, `4.31e15` or `1e-2`. */
export function parseZoomText(text: string): number | undefined {
  const match = ZOOM.exec(text.trim());
  if (!match) return undefined;
  const mantissa = Number(match[1]);
  if (!(mantissa > 0) || !Number.isFinite(mantissa)) return undefined;
  const logZoom = Math.log2(mantissa) + Number(match[2] ?? 0) * Math.log2(10);
  return Number.isFinite(logZoom) ? logZoom : undefined;
}

/** A decimal as binary fixed point with `bits` fractional bits, rounded to nearest. */
export function parseDecimal(text: string, bits: number): bigint | undefined {
  const match = DECIMAL.exec(text.trim());
  if (!match || match[2].length + (match[3]?.length ?? 0) > MAX_DIGITS) return undefined;
  const fraction = match[3] ?? '';
  const scale = 10n ** BigInt(fraction.length);
  const magnitude = ((BigInt(match[2] + fraction) << BigInt(bits)) * 2n + scale) / (2n * scale);
  return match[1] === '-' ? -magnitude : magnitude;
}

/** The view a hash describes, for a window whose initial view has `initialLogScale`; undefined if absent or invalid. */
export function parseViewHash(hash: string, initialLogScale: number): View | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const re = params.get('re'), im = params.get('im'), zoom = params.get('zoom');
  if (re === null || im === null || zoom === null) return undefined;
  const logZoom = parseZoomText(zoom);
  if (logZoom === undefined) return undefined;
  // The same zoom-out limit as interactive zooming.
  const logScale = Math.min(2, initialLogScale - logZoom);
  const view = ensurePrecision({ re: 0n, im: 0n, bits: 128, logScale });
  const fixedRe = parseDecimal(re, view.bits), fixedIm = parseDecimal(im, view.bits);
  if (fixedRe === undefined || fixedIm === undefined) return undefined;
  // Keep the centre inside the region where the set lives.
  const limit = 4n << BigInt(view.bits);
  if (fixedRe > limit || fixedRe < -limit || fixedIm > limit || fixedIm < -limit) return undefined;
  return { ...view, re: fixedRe, im: fixedIm };
}
