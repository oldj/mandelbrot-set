/**
 * Direct iteration of z -> z² + c without a reference orbit: plain doubles for
 * shallow views (one pixel, or a row three lanes at a time), and BigInt fixed
 * point as the slow path for perturbation glitches and as the test oracle.
 */
import { fromFixed, logMagnitude } from '../math/extended.ts';
import { escapeDistance, INTERIOR, lastSample, smooth } from './escape.ts';
import { TRAP_RETURN_SQUARED, trappedDouble } from './interior.ts';

/** Main cardioid or period-2 bulb, exactly, in fixed point. */
export function insideFixed(cr: bigint, ci: bigint, bits: number): boolean {
  const unit = 1n << BigInt(bits);
  const y2 = ci * ci;
  if ((cr + unit) ** 2n + y2 <= unit * unit / 16n) return true;
  const x = cr - unit / 4n;
  const q = x * x + y2;
  return q * (q + x * unit) <= y2 * unit * unit / 4n;
}

/** Sets lastDistance() on escape, in units of `pixel` (the distance from c to c + 1 pixel). */
export function directDouble(cr: number, ci: number, limit: number, pixel = 1): number {
  const q = (cr - 0.25) ** 2 + ci * ci;
  if (q * (q + cr - 0.25) <= 0.25 * ci * ci || (cr + 1) ** 2 + ci * ci <= 1 / 16) return INTERIOR;
  let re = 0, im = 0, r2 = 0, i2 = 0, dr = 0, di = 0;
  let savedRe = 0, savedIm = 0, checkpoint = 32;
  for (let n = 1; n <= limit; n++) {
    const next = 2 * (re * dr - im * di) + pixel;
    di = 2 * (re * di + im * dr); dr = next;
    im = 2 * re * im + ci;
    re = r2 - i2 + cr;
    r2 = re * re;
    i2 = im * im;
    if (r2 + i2 > 256) {
      lastSample.distance = escapeDistance(r2 + i2, dr, di);
      return smooth(n, Math.log2(Math.hypot(re, im)));
    }
    // Exact repeated states cannot escape later. Check sparsely to keep the
    // common, quickly escaping path cheap; no approximate interior threshold.
    if ((n & 31) === 0) {
      if (re === savedRe && im === savedIm) return INTERIOR;
      if (n === checkpoint) { savedRe = re; savedIm = im; checkpoint *= 2; }
    }
  }
  return INTERIOR;
}

/** Main cardioid or period-2 bulb, exactly as directDouble tests it. */
function insideDouble(cr: number, ci: number): boolean {
  const q = (cr - 0.25) ** 2 + ci * ci;
  return q * (q + cr - 0.25) <= 0.25 * ci * ci || (cr + 1) ** 2 + ci * ci <= 1 / 16;
}

/** directRow advances its lanes this many iterations between escape-free checks. */
const LANE_CHUNK = 32;

/**
 * directDouble for a row of pixels sharing one imaginary part, three orbits
 * at a time. A single orbit is latency-bound (each iteration waits on the
 * previous one); interleaving independent orbits keeps the FPU busy and is
 * about 2x faster. Each lane performs exactly directDouble's operations, so
 * escapes are found at the same iteration with the same value.
 *
 * Chunks are a fixed 32 iterations (shorter only near the budget), escapes
 * are handled inline, and saved states are compared on chunk boundaries: an
 * exactly repeated state can never escape (as in directDouble), and a near
 * return starts an interior proof (trappedDouble) on a copy of the orbit.
 * Distance estimates (as directDouble's) go to `distances`, NaN for interiors.
 * Returns how many samples reached the budget unresolved.
 */
export function directRow(cr: Float64Array, ci: number, count: number, limit: number, out: Float64Array,
  distances?: Float64Array, pixel = 1): number {
  let next = 0, unresolved = 0;
  const take = () => {
    while (next < count) {
      const i = next++;
      if (insideDouble(cr[i], ci)) { out[i] = INTERIOR; if (distances) distances[i] = NaN; }
      else return i;
    }
    return -1;
  };
  // Per lane: pixel, c, z and its squares, iteration at the chunk start, the
  // saved state with its iteration, the next save point and proof work spent.
  // An idle lane iterates c = 0, which stays at 0 and never escapes.
  let p0 = take(), c0 = p0 < 0 ? 0 : cr[p0], q0 = p0 < 0 ? 0 : ci;
  let p1 = take(), c1 = p1 < 0 ? 0 : cr[p1], q1 = p1 < 0 ? 0 : ci;
  let p2 = take(), c2 = p2 < 0 ? 0 : cr[p2], q2 = p2 < 0 ? 0 : ci;
  let x0 = 0, y0 = 0, a0 = 0, b0 = 0, n0 = 0, s0 = 0, t0 = 0, m0 = 0, k0 = 32, w0 = 0, u0 = 0, v0 = 0;
  let x1 = 0, y1 = 0, a1 = 0, b1 = 0, n1 = 0, s1 = 0, t1 = 0, m1 = 0, k1 = 32, w1 = 0, u1 = 0, v1 = 0;
  let x2 = 0, y2 = 0, a2 = 0, b2 = 0, n2 = 0, s2 = 0, t2 = 0, m2 = 0, k2 = 32, w2 = 0, u2 = 0, v2 = 0;
  let g = 0;
  while (p0 >= 0 || p1 >= 0 || p2 >= 0) {
    let chunk = LANE_CHUNK;
    if (p0 >= 0) chunk = Math.min(chunk, limit - n0);
    if (p1 >= 0) chunk = Math.min(chunk, limit - n1);
    if (p2 >= 0) chunk = Math.min(chunk, limit - n2);
    let step = 0;
    while (step < chunk) {
      // The hot loop stays minimal; escapes are handled outside it, then the chunk resumes.
      while (step < chunk) {
        g = 2 * (x0 * u0 - y0 * v0) + pixel; v0 = 2 * (x0 * v0 + y0 * u0); u0 = g;
        y0 = 2 * x0 * y0 + q0; x0 = a0 - b0 + c0; a0 = x0 * x0; b0 = y0 * y0;
        g = 2 * (x1 * u1 - y1 * v1) + pixel; v1 = 2 * (x1 * v1 + y1 * u1); u1 = g;
        y1 = 2 * x1 * y1 + q1; x1 = a1 - b1 + c1; a1 = x1 * x1; b1 = y1 * y1;
        g = 2 * (x2 * u2 - y2 * v2) + pixel; v2 = 2 * (x2 * v2 + y2 * u2); u2 = g;
        y2 = 2 * x2 * y2 + q2; x2 = a2 - b2 + c2; a2 = x2 * x2; b2 = y2 * y2;
        step++;
        if (a0 + b0 > 256 || a1 + b1 > 256 || a2 + b2 > 256) break;
      }
      // A reloaded lane starts mid-chunk: n counts from -step, so after the chunk it is the true
      // iteration count; its save point m stays absolute (0), so a fresh z = 0 is no repeat.
      if (a0 + b0 > 256) {
        out[p0] = smooth(n0 + step, Math.log2(Math.hypot(x0, y0)));
        if (distances) distances[p0] = escapeDistance(a0 + b0, u0, v0);
        p0 = take(); c0 = p0 < 0 ? 0 : cr[p0]; q0 = p0 < 0 ? 0 : ci;
        x0 = y0 = a0 = b0 = s0 = t0 = m0 = w0 = u0 = v0 = 0; n0 = -step; k0 = 32;
      }
      if (a1 + b1 > 256) {
        out[p1] = smooth(n1 + step, Math.log2(Math.hypot(x1, y1)));
        if (distances) distances[p1] = escapeDistance(a1 + b1, u1, v1);
        p1 = take(); c1 = p1 < 0 ? 0 : cr[p1]; q1 = p1 < 0 ? 0 : ci;
        x1 = y1 = a1 = b1 = s1 = t1 = m1 = w1 = u1 = v1 = 0; n1 = -step; k1 = 32;
      }
      if (a2 + b2 > 256) {
        out[p2] = smooth(n2 + step, Math.log2(Math.hypot(x2, y2)));
        if (distances) distances[p2] = escapeDistance(a2 + b2, u2, v2);
        p2 = take(); c2 = p2 < 0 ? 0 : cr[p2]; q2 = p2 < 0 ? 0 : ci;
        x2 = y2 = a2 = b2 = s2 = t2 = m2 = w2 = u2 = v2 = 0; n2 = -step; k2 = 32;
      }
      if (p0 < 0 && p1 < 0 && p2 < 0) break;
      // Lanes reloaded here start at n = 0; the budget is far more than one chunk away.
    }
    n0 += chunk; n1 += chunk; n2 += chunk;
    // After a short chunk, boundaries shift: re-save so compared states stay a multiple of 32 apart.
    const realign = chunk !== LANE_CHUNK;
    if (p0 >= 0) {
      let done = n0 >= limit;
      if (!done && x0 === s0 && y0 === t0 && n0 > m0) done = true;
      else if (!done && n0 > m0 && m0 > 0) {
        const dx = x0 - s0, dy = y0 - t0, distance = dx * dx + dy * dy, period = n0 - m0;
        if (distance < TRAP_RETURN_SQUARED * (s0 * s0 + t0 * t0) && w0 + period <= n0) {
          w0 += period;
          done = trappedDouble(c0, q0, x0, y0, period, Math.sqrt(distance));
        }
      }
      if (done) {
        out[p0] = INTERIOR;
        if (distances) distances[p0] = NaN;
        if (n0 >= limit && !(x0 === s0 && y0 === t0)) unresolved++;
        p0 = take(); c0 = p0 < 0 ? 0 : cr[p0]; q0 = p0 < 0 ? 0 : ci;
        x0 = y0 = a0 = b0 = n0 = s0 = t0 = m0 = w0 = u0 = v0 = 0; k0 = 32;
      } else if (n0 >= k0 || realign) {
        s0 = x0; t0 = y0; m0 = n0;
        if (n0 >= k0) k0 *= 2;
      }
    }
    if (p1 >= 0) {
      let done = n1 >= limit;
      if (!done && x1 === s1 && y1 === t1 && n1 > m1) done = true;
      else if (!done && n1 > m1 && m1 > 0) {
        const dx = x1 - s1, dy = y1 - t1, distance = dx * dx + dy * dy, period = n1 - m1;
        if (distance < TRAP_RETURN_SQUARED * (s1 * s1 + t1 * t1) && w1 + period <= n1) {
          w1 += period;
          done = trappedDouble(c1, q1, x1, y1, period, Math.sqrt(distance));
        }
      }
      if (done) {
        out[p1] = INTERIOR;
        if (distances) distances[p1] = NaN;
        if (n1 >= limit && !(x1 === s1 && y1 === t1)) unresolved++;
        p1 = take(); c1 = p1 < 0 ? 0 : cr[p1]; q1 = p1 < 0 ? 0 : ci;
        x1 = y1 = a1 = b1 = n1 = s1 = t1 = m1 = w1 = u1 = v1 = 0; k1 = 32;
      } else if (n1 >= k1 || realign) {
        s1 = x1; t1 = y1; m1 = n1;
        if (n1 >= k1) k1 *= 2;
      }
    }
    if (p2 >= 0) {
      let done = n2 >= limit;
      if (!done && x2 === s2 && y2 === t2 && n2 > m2) done = true;
      else if (!done && n2 > m2 && m2 > 0) {
        const dx = x2 - s2, dy = y2 - t2, distance = dx * dx + dy * dy, period = n2 - m2;
        if (distance < TRAP_RETURN_SQUARED * (s2 * s2 + t2 * t2) && w2 + period <= n2) {
          w2 += period;
          done = trappedDouble(c2, q2, x2, y2, period, Math.sqrt(distance));
        }
      }
      if (done) {
        out[p2] = INTERIOR;
        if (distances) distances[p2] = NaN;
        if (n2 >= limit && !(x2 === s2 && y2 === t2)) unresolved++;
        p2 = take(); c2 = p2 < 0 ? 0 : cr[p2]; q2 = p2 < 0 ? 0 : ci;
        x2 = y2 = a2 = b2 = n2 = s2 = t2 = m2 = w2 = u2 = v2 = 0; k2 = 32;
      } else if (n2 >= k2 || realign) {
        s2 = x2; t2 = y2; m2 = n2;
        if (n2 >= k2) k2 *= 2;
      }
    }
  }
  return unresolved;
}

/** Slow correctness path for perturbation glitches, also used as a test oracle. */
export function directFixed(cr: bigint, ci: bigint, bits: number, limit: number): number {
  if (insideFixed(cr, ci, bits)) return INTERIOR;
  const shift = BigInt(bits);
  const bailout = 256n << (shift * 2n);
  let re = 0n, im = 0n;
  let savedRe = 0n, savedIm = 0n, checkpoint = 1;
  for (let n = 1; n <= limit; n++) {
    const r2 = re * re, i2 = im * im;
    im = ((2n * re * im) >> shift) + ci;
    re = ((r2 - i2) >> shift) + cr;
    if (re * re + im * im > bailout) return smooth(n, logMagnitude(fromFixed(re, im, bits)));
    if (re === savedRe && im === savedIm) return INTERIOR;
    if (n === checkpoint) {
      savedRe = re; savedIm = im; checkpoint *= 2;
    }
  }
  return INTERIOR;
}
