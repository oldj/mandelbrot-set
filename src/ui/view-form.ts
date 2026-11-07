/**
 * Reading the view dialog's fields: the centre's real and imaginary parts and
 * the zoom, as people type or paste them, into a view, or the reason a field
 * can't be used.
 */
import { ensurePrecision } from '../math/precision.ts';
import { depthOfPlaces } from './view-info.ts';
import type { View } from '../math/precision.ts';
import { MAX_DIGITS, MAX_ZOOM_EXPONENT, parseDecimal, parseZoomText } from './url-state.ts';

export interface ViewFields { re: string; im: string; zoom: string }
export interface FieldError { field: keyof ViewFields; message: string }

/** Centres beyond ±4 are as far from the set as the URL hash allows. */
const LIMIT = 4;

/** Spaces and line breaks (pasted digits often wrap) go; typographic minus signs become '-'. */
function normalise(text: string): string {
  return text.replace(/\s+/g, '').replace(/[−–‒﹣－]/g, '-');
}

const NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d{1,6}))?$/i;

/**
 * A decimal, possibly in e notation (`-1.25e-3`), as fixed point with `bits`
 * fractional bits; or why it isn't one: not a number, beyond ±4, or longer
 * than a URL could hold.
 */
/** Decimal places of a coordinate as typed (`1.25e-3` has five), 0 if it is not a number. */
export function typedPlaces(text: string): number {
  const match = NUMBER.exec(normalise(text));
  if (!match) return 0;
  const [, , , fraction = '', exponent = '0'] = match;
  return Math.max(0, fraction.length - Number(exponent));
}

export function parseCoordinateText(text: string, bits: number): bigint | 'invalid' | 'range' | 'digits' {
  const match = NUMBER.exec(normalise(text));
  if (!match) return 'invalid';
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  if (!digits) return 'invalid';
  const significant = digits.replace(/^0+/, '');
  if (!significant) return 0n;
  // Move the decimal point instead of scaling, so 1e-300 stays exact. Checked
  // first: an exponent must not build a huge string only to be rejected.
  const point = whole.length + Number(exponent);
  const integerDigits = point - (digits.length - significant.length);
  if (integerDigits > 1) return 'range';
  if (Math.max(point, digits.length) - Math.min(0, point) > MAX_DIGITS) return 'digits';
  const plain = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const value = parseDecimal(sign + plain, bits);
  if (value === undefined) return 'invalid';
  const limit = BigInt(LIMIT) << BigInt(bits);
  return value > limit || value < -limit ? 'range' : value;
}

/**
 * log2 of a magnification as people write it: `250`, `2.5e12`, `1.84×10^8`
 * (as the panel shows it), `1.84x10^8`, `10^8` or `3.5×`.
 */
export function parseZoomInput(text: string): number | undefined {
  const plain = normalise(text).toLowerCase()
    .replace(/^10\^/, '1e')
    .replace(/[×x*·]10\^/, 'e')
    .replace(/[×x]$/, '');
  return parseZoomText(plain);
}

/**
 * The view the fields describe, starting from `view` (shown in them as
 * `shown`): an unchanged field keeps its exact value, not the rounded digits
 * on display. Zooming out stops where interactive zooming does.
 */
export function readViewFields(fields: ViewFields, shown: ViewFields, view: View, initialLogScale: number):
  { view: View; changed: boolean } | { errors: FieldError[] } {
  const errors: FieldError[] = [];
  const edited = (field: keyof ViewFields) => normalise(fields[field]) !== normalise(shown[field]);

  let logScale = view.logScale;
  if (edited('zoom')) {
    const logZoom = parseZoomInput(fields.zoom);
    if (logZoom === undefined) {
      errors.push({ field: 'zoom', message: normalise(fields.zoom) ? 'Enter a positive number, such as 250 or 2.5e12.' : 'Enter a zoom.' });
    } else if (logZoom > MAX_ZOOM_EXPONENT * Math.log2(10)) {
      errors.push({ field: 'zoom', message: `Zoom goes up to 1e${MAX_ZOOM_EXPONENT}.` });
    } else {
      logScale = Math.min(2, initialLogScale - logZoom);
    }
  }

  // Every digit shown or typed counts: the view keeps them (its depth), also when zoomed out.
  // Untouched fields were shown at the view's depth, so they keep it.
  const places = Math.max(typedPlaces(fields.re), typedPlaces(fields.im));
  const depth = Math.min(logScale, depthOfPlaces(Math.min(places, MAX_DIGITS)));
  const next = ensurePrecision(view, depth);
  next.logScale = logScale;
  next.depth = depth;
  const messages = {
    invalid: 'Enter a decimal number, such as -0.75 or 1.2e-5.',
    range: `Use a value from -${LIMIT} to ${LIMIT}.`,
    digits: `Use at most ${MAX_DIGITS.toLocaleString('en')} digits.`,
  };
  for (const field of ['re', 'im'] as const) {
    if (!edited(field)) continue;
    const value = normalise(fields[field]) ? parseCoordinateText(fields[field], next.bits) : undefined;
    if (value === undefined) errors.push({ field, message: 'Enter a number.' });
    else if (typeof value === 'string') errors.push({ field, message: messages[value] });
    else next[field] = value;
  }

  if (errors.length) return { errors };
  const changed = logScale !== view.logScale || edited('re') || edited('im');
  return { view: changed ? next : view, changed };
}
