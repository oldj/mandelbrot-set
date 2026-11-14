/**
 * Complex numbers as a double mantissa pair with a separate integer binary
 * exponent ("floatexp"), for deltas and BLA coefficients below 2^-1022 or
 * above 2^1023, and log2 helpers for bounds that would under- or overflow.
 */

/** Complex floating point with an independent binary exponent. */
export interface Extended { re: number; im: number; exp: number }
export const ZERO: Extended = { re: 0, im: 0, exp: 0 };
export const ONE: Extended = { re: 1, im: 0, exp: 0 };

export function extended(re: number, im = 0, exp = 0): Extended {
  const magnitude = Math.max(Math.abs(re), Math.abs(im));
  if (magnitude === 0) return ZERO;
  // Already normalized (common after adding values of similar size): the general path would scale by
  // exactly 1. It returns exp + 0, which turns a -0 exponent into +0; so does this.
  if (magnitude >= 1 && magnitude < 2) return { re, im, exp: exp + 0 };
  const shift = Math.floor(Math.log2(magnitude));
  // Split scaling to handle subnormal doubles too: 2^-shift alone overflows
  // to Infinity once shift < -1023, so never form a factor above 2^1023.
  const factor = 2 ** Math.min(1023, -shift);
  const rest = 2 ** (-shift - Math.min(1023, -shift));
  return { re: re * factor * rest, im: im * factor * rest, exp: exp + shift };
}

export function add(a: Extended, b: Extended): Extended {
  if (a.re === 0 && a.im === 0) return b;
  if (b.re === 0 && b.im === 0) return a;
  const exp = Math.max(a.exp, b.exp);
  return extended(a.re * 2 ** (a.exp - exp) + b.re * 2 ** (b.exp - exp),
    a.im * 2 ** (a.exp - exp) + b.im * 2 ** (b.exp - exp), exp);
}

/** A list of Extended values as three arrays (mantissa re, im and exponent), as reference orbits are kept. */
export interface ExtendedArrays { re: Float64Array; im: Float64Array; exp: Float64Array }

/** add with a = values[i]. */
export function addAt(values: ExtendedArrays, i: number, b: Extended): Extended {
  const ar = values.re[i], ai = values.im[i], ae = values.exp[i];
  if (ar === 0 && ai === 0) return b;
  if (b.re === 0 && b.im === 0) return { re: ar, im: ai, exp: ae };
  const exp = Math.max(ae, b.exp);
  return extended(ar * 2 ** (ae - exp) + b.re * 2 ** (b.exp - exp), ai * 2 ** (ae - exp) + b.im * 2 ** (b.exp - exp), exp);
}

export function multiply(a: Extended, b: Extended): Extended {
  return extended(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re, a.exp + b.exp);
}

/** Fused operations normalize once instead of allocating each intermediate product. */
export function linear(a: Extended, z: Extended, b: Extended, c: Extended): Extended {
  return linearParts(a.re, a.im, a.exp, z, b.re, b.im, b.exp, c);
}

/** a z + b c with a and b read from `table` at `offset`: a (re, im, exp), then b (re, im, exp). */
export function linearAt(table: Float64Array, offset: number, z: Extended, c: Extended): Extended {
  return linearParts(table[offset], table[offset + 1], table[offset + 2], z, table[offset + 3], table[offset + 4], table[offset + 5], c);
}

function linearParts(ar: number, ai: number, ae: number, z: Extended, br: number, bi: number, be: number, c: Extended): Extended {
  if ((ar === 0 && ai === 0) || (z.re === 0 && z.im === 0)) return extended(br * c.re - bi * c.im, br * c.im + bi * c.re, be + c.exp);
  if ((br === 0 && bi === 0) || (c.re === 0 && c.im === 0)) return extended(ar * z.re - ai * z.im, ar * z.im + ai * z.re, ae + z.exp);
  const az = ae + z.exp, bc = be + c.exp;
  const exp = Math.max(az, bc);
  const s = 2 ** (az - exp), t = 2 ** (bc - exp);
  return extended((ar * z.re - ai * z.im) * s + (br * c.re - bi * c.im) * t,
    (ar * z.im + ai * z.re) * s + (br * c.im + bi * c.re) * t, exp);
}

export function perturbStep(reference: Extended, delta: Extended, dc: Extended): Extended {
  return perturbParts(reference.re, reference.im, reference.exp, delta, dc);
}

/** perturbStep with the reference point orbit[i]. */
export function perturbStepAt(orbit: ExtendedArrays, i: number, delta: Extended, dc: Extended): Extended {
  return perturbParts(orbit.re[i], orbit.im[i], orbit.exp[i], delta, dc);
}

function perturbParts(zr: number, zi: number, ze: number, delta: Extended, dc: Extended): Extended {
  if (delta.re === 0 && delta.im === 0) return dc;
  const a = zr === 0 && zi === 0 ? -Infinity : ze + delta.exp + 1;
  const b = 2 * delta.exp;
  const c = dc.re === 0 && dc.im === 0 ? -Infinity : dc.exp;
  const exp = Math.max(a, b, c);
  const sa = 2 ** (a - exp), sb = 2 ** (b - exp), sc = 2 ** (c - exp);
  return extended((zr * delta.re - zi * delta.im) * sa
    + (delta.re * delta.re - delta.im * delta.im) * sb + dc.re * sc,
  (zr * delta.im + zi * delta.re) * sa
    + 2 * delta.re * delta.im * sb + dc.im * sc, exp);
}

export function logMagnitude(a: Extended): number {
  return Math.log2(Math.hypot(a.re, a.im)) + a.exp;
}

export function fromFixed(re: bigint, im: bigint, bits: number): Extended {
  const ar = re < 0n ? -re : re;
  const ai = im < 0n ? -im : im;
  const larger = ar > ai ? ar : ai;
  // Bit length without printing thousands of binary digits: shift magnitudes
  // near 1 down to ~64 bits first; only tiny values need the full string.
  const guess = bits - 64, high = guess > 0 ? larger >> BigInt(guess) : 0n;
  const size = high > 0n ? guess + high.toString(2).length : larger.toString(2).length;
  const shift = Math.max(0, size - 53);
  return extended(Number(ar >> BigInt(shift)) * (re < 0n ? -1 : 1),
    Number(ai >> BigInt(shift)) * (im < 0n ? -1 : 1), shift - bits);
}

/** log2(2^a - 2^b), conservatively rounded down for BLA validity radii. */
export function logDifference(a: number, b: number): number {
  if (b >= a) return -Infinity;
  return a + Math.log2(1 - 2 ** (b - a)) - 1e-12;
}

/** log2(2^a + 2^b) without overflow or underflow. */
export function logAdd(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return Math.max(a, b) + Math.log2(1 + 2 ** -Math.abs(a - b));
}

/**
 * |x + iy|: a plain square root where the squares stay well inside double
 * range, else Math.hypot, which is exact about under- and overflow but an
 * order of magnitude slower in V8. Hot bounds in the interior proofs use this.
 */
export function magnitude(x: number, y: number): number {
  const squared = x * x + y * y;
  return squared >= 1e-280 && squared <= 1e280 ? Math.sqrt(squared) : Math.hypot(x, y);
}
