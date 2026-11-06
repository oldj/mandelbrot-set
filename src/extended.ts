/** Complex floating point with an independent binary exponent. */
export interface Extended { re: number; im: number; exp: number }
export const ZERO: Extended = { re: 0, im: 0, exp: 0 };
export const ONE: Extended = { re: 1, im: 0, exp: 0 };

export function extended(re: number, im = 0, exp = 0): Extended {
  const magnitude = Math.max(Math.abs(re), Math.abs(im));
  if (magnitude === 0) return ZERO;
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

export function multiply(a: Extended, b: Extended): Extended {
  return extended(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re, a.exp + b.exp);
}

/** Fused operations normalize once instead of allocating each intermediate product. */
export function linear(a: Extended, z: Extended, b: Extended, c: Extended): Extended {
  if ((a.re === 0 && a.im === 0) || (z.re === 0 && z.im === 0)) return multiply(b, c);
  if ((b.re === 0 && b.im === 0) || (c.re === 0 && c.im === 0)) return multiply(a, z);
  const az = a.exp + z.exp, bc = b.exp + c.exp;
  const exp = Math.max(az, bc);
  const s = 2 ** (az - exp), t = 2 ** (bc - exp);
  return extended((a.re * z.re - a.im * z.im) * s + (b.re * c.re - b.im * c.im) * t,
    (a.re * z.im + a.im * z.re) * s + (b.re * c.im + b.im * c.re) * t, exp);
}

export function perturbStep(reference: Extended, delta: Extended, dc: Extended): Extended {
  if (delta.re === 0 && delta.im === 0) return dc;
  const a = reference.re === 0 && reference.im === 0 ? -Infinity : reference.exp + delta.exp + 1;
  const b = 2 * delta.exp;
  const c = dc.re === 0 && dc.im === 0 ? -Infinity : dc.exp;
  const exp = Math.max(a, b, c);
  const sa = 2 ** (a - exp), sb = 2 ** (b - exp), sc = 2 ** (c - exp);
  return extended((reference.re * delta.re - reference.im * delta.im) * sa
    + (delta.re * delta.re - delta.im * delta.im) * sb + dc.re * sc,
  (reference.re * delta.im + reference.im * delta.re) * sa
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
