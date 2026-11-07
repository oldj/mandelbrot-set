/**
 * Perturbation kernels: a pixel's orbit as z = Z + δ around the shared
 * reference orbit Z, with BLA skipping, rebasing to the reference start when
 * |z| < |δ|, glitch fallback to BigInt, the distance estimate, and the
 * interior proofs of ./interior.ts. perturbNative covers views down to 2^-900;
 * perturbExtended carries a separate exponent below that.
 */
import { add, extended, linear, logAdd, logMagnitude, magnitude, perturbStep, ZERO } from '../math/extended.ts';
import type { Extended } from '../math/extended.ts';
import { escapeDistance, INTERIOR, lastSample, smooth } from './escape.ts';
import {
  attractingCycle, LOG_ROUNDING, NEWTON_BAND, NEWTON_COST, NEWTON_RETURN_SQUARED, PROOF_START, ROUNDING, SQRT2, TINY_SQUARE,
  TRAP_BAND, TRAP_RETURN_SQUARED,
} from './interior.ts';
import { lookupExtended, lookupNative, NATIVE_FIELDS } from './orbit.ts';
import type { Reference } from './orbit.ts';

/** Per-sampler counters: BigInt fallbacks, iterations skipped by BLA, samples left unresolved at the budget. */
export interface SampleStats { fallbacks: number; skipped: number; unresolved: number }

/**
 * Perturbation with BLA skipping and an interior proof.
 *
 * Interior pixels never escape, so without a shortcut they always run the
 * whole iteration budget. When the orbit returns close to its earlier
 * near-zero point after P iterations, the next P iterations are run without
 * BLA while tracking a radius r_k that bounds the image of the disk
 * D(z_start, r_0): |f(w) - f(z_k)| <= r_k (2|z_k| + r_k), plus a rounding
 * bound for every operation. If the image of the disk after P steps lies
 * inside the disk, f^P maps it into itself and the orbit can never escape.
 * Escaping pixels are unaffected (the check can only ever return INTERIOR),
 * and attempts are capped so they never more than double a pixel's work.
 */
export function perturbNative(reference: Reference, dcRe: number, dcIm: number, limit: number, fallback: () => number, stats: SampleStats, pixel: number): number {
  const real = reference.real, imag = reference.imag, first = reference.firstRadiusSquared, glitch = reference.glitch;
  const skip = reference.skipRadiusSquared;
  const end = real.length - 1;
  // zr, zi always hold Z_m; deltaSquared holds |δ|² for the current δ.
  let dr = 0, di = 0, m = 0, n = 0, zr = real[0], zi = imag[0], deltaSquared = 0;
  // dz/dc times the pixel size; unaffected by rebasing (z itself is unchanged). A BLA block maps it as δ: A z' + B pixel.
  let er = 0, ei = 0;
  // Interior proof state: the base is the smallest |z| since the last reset.
  // Above `far`, |z|² is certainly outside the band around |base|²: nothing to track.
  let baseRe = 0, baseIm = 0, baseSquared = Infinity, far = Infinity, baseN = 0, reset = 64, collapsedBase = false, retry = 0;
  // Proof state; ra..rd bound the disk images for four starting radii (radius0 x 1, 2^8, 2^16, 2^24).
  let verify = 0, spent = 0, steps = 0, startRe = 0, startIm = 0, startError = 0, radius0 = 0;
  let ra = 0, rb = 0, rc = 0, rd = 0, newtonRetry = 0, newtonFails = 0;
  const dcError = ROUNDING * Math.hypot(dcRe, dcIm);
  while (n < limit) {
    // Fast path: plain single steps, while no BLA block may apply and the step
    // needs none of the bookkeeping below (escape, glitch, tiny |z|, a return
    // the proofs track, a reset). Operations are those of the general path,
    // so results are bit-identical; it just keeps the common step short.
    let stepped = false;
    if (!verify) {
      while (n < limit) {
        // A block of 2 or more steps may apply (its radius is at most level 0's).
        const quick = skip[m];
        if (quick >= 1e-280 ? deltaSquared < quick : quick > 0) break;
        steps++;
        const tr = zr + dr, ti = zi + di, nextEr = 2 * (tr * er - ti * ei) + pixel;
        ei = 2 * (tr * ei + ti * er); er = nextEr;
        const ur = zr + tr, ui = zi + ti, nextRe = ur * dr - ui * di + dcRe;
        di = ur * di + ui * dr + dcIm;
        dr = nextRe;
        m++; n++;
        zr = real[m]; zi = imag[m];
        const totalRe = zr + dr, totalIm = zi + di, squared = totalRe * totalRe + totalIm * totalIm;
        deltaSquared = dr * dr + di * di;
        if (!(squared <= 256 && squared >= 1e-280) || squared < glitch[m] || n >= reset) {
          stepped = true;
          break;
        }
        // Within the tracked band, only steps the bookkeeping below acts on
        // leave: a new minimum (it moves the base), an attractingCycle attempt,
        // or an in-loop proof start. Orbits lingering near a parabolic or
        // repelling point stay in the band for thousands of steps that change
        // nothing. The tests are the bookkeeping's own, in the same order.
        if (squared <= far) {
          const relative = squared - baseSquared, period = n - baseN;
          if (relative < 0) { stepped = true; break; }
          if (n >= PROOF_START && period > 2) {
            const ex = totalRe - baseRe, ey = totalIm - baseIm, distanceSquared = ex * ex + ey * ey;
            if (relative < NEWTON_BAND * baseSquared && n >= newtonRetry && spent + NEWTON_COST * period <= steps
              && distanceSquared < NEWTON_RETURN_SQUARED * baseSquared) { stepped = true; break; }
            if (relative < TRAP_BAND * baseSquared && n >= retry && spent + period <= steps
              && distanceSquared < TRAP_RETURN_SQUARED * baseSquared) { stepped = true; break; }
          }
        }
        if (squared < deltaSquared || m === end) {
          dr = totalRe; di = totalIm; m = 0; zr = real[0]; zi = imag[0];
          deltaSquared = squared;
        }
      }
      if (!stepped && n >= limit) break;
    }
    let skipped = false;
    if (!stepped) {
      steps++;
      // Level 0 has the largest radius at m; >= also rejects squared deltas that underflow to 0.
      const quick = first[m];
      const level = verify || !(quick >= 1e-280 ? deltaSquared < quick : quick > 0)
        ? -1 : lookupNative(reference, m, dr, di, limit - n);
      skipped = level >= 0;
      if (skipped) {
        const table = reference.native[level], o = ((m - 1) >> level) * NATIVE_FIELDS, length = 1 << level;
        const ar = table[o], ai = table[o + 1], br = table[o + 2], bi = table[o + 3];
        const nextEr = ar * er - ai * ei + br * pixel;
        ei = ar * ei + ai * er + bi * pixel; er = nextEr;
        const nextRe = ar * dr - ai * di + br * dcRe - bi * dcIm;
        di = ar * di + ai * dr + br * dcIm + bi * dcRe;
        dr = nextRe;
        m += length; n += length; stats.skipped += length - 1;
      } else {
        if (verify) {
          const reference = SQRT2 * Math.max(Math.abs(zr), Math.abs(zi)), delta = SQRT2 * Math.max(Math.abs(dr), Math.abs(di));
          const tr = zr + dr, ti = zi + di, twice = 2 * Math.sqrt(tr * tr + ti * ti + TINY_SQUARE), rounding = ROUNDING * (4 * reference * delta + delta * delta) + dcError;
          ra = ra * (twice + ra) + rounding; rb = rb * (twice + rb) + rounding;
          rc = rc * (twice + rc) + rounding; rd = rd * (twice + rd) + rounding;
        }
        const tr = zr + dr, ti = zi + di, nextEr = 2 * (tr * er - ti * ei) + pixel;
        ei = 2 * (tr * ei + ti * er); er = nextEr;
        const ur = zr + tr, ui = zi + ti, nextRe = ur * dr - ui * di + dcRe;
        di = ur * di + ui * dr + dcIm;
        dr = nextRe;
        m++; n++;
      }
    }
    zr = real[m]; zi = imag[m];
    const totalRe = zr + dr, totalIm = zi + di;
    const squared = totalRe * totalRe + totalIm * totalIm;
    if (!(squared <= 256)) {
      if (!Number.isFinite(squared)) return fallback();
      lastSample.distance = escapeDistance(squared, er, ei);
      return smooth(n, 0.5 * Math.log2(squared));
    }
    deltaSquared = dr * dr + di * di;
    let rebase: boolean;
    if (squared >= 1e-280) {
      if (squared < glitch[m]) return fallback();
      rebase = squared < deltaSquared;
    } else {
      const radius = Math.hypot(totalRe, totalIm);
      if (radius < Math.hypot(zr, zi) * 1e-7) return fallback();
      rebase = radius < Math.hypot(dr, di);
    }
    if (verify) {
      // Representing z as Z + δ rounds once more; rebasing makes that the new state.
      const error = ROUNDING * (magnitude(zr, zi) + magnitude(dr, di));
      if (--verify === 0) {
        const distance = magnitude(totalRe - startRe, totalIm - startIm) + startError + error;
        if (distance + ra <= radius0 || distance + rb <= radius0 * 2 ** 8
          || distance + rc <= radius0 * 2 ** 16 || distance + rd <= radius0 * 2 ** 24) return INTERIOR;
        // Failed: relearn the base from scratch, and back off so orbits that
        // linger near a repelling cycle cannot keep switching BLA off.
        baseSquared = far = Infinity; collapsedBase = false; retry = 2 * n;
      } else if (rebase) { ra += error; rb += error; rc += error; rd += error; }
    } else if (!skipped && squared >= 1e-280 && (squared <= far || n >= reset)) {
      // Returns and collapses happen near z = 0, where BLA cannot apply: track
      // single steps only. Any return attractingCycle tries needs |z|² within
      // 2^-2 of |base|², so most steps stop at the `far` test above. A rough
      // return first tries attractingCycle; the in-loop proof starts on a
      // close return (within 2^-10), or on a second consecutive collapse
      // of |z| far below the base (super-attracting cycles shrink faster than
      // any fixed gap; two collapses in a row measure a true period). Proof
      // steps run without BLA, so they are capped by the steps executed.
      const relative = squared - baseSquared;
      const near = relative < TRAP_BAND * baseSquared && relative > -TRAP_BAND * baseSquared;
      const collapse = !near && squared < TRAP_RETURN_SQUARED * baseSquared;
      let start = false, distanceSquared = 0;
      const period = n - baseN;
      if (relative < NEWTON_BAND * baseSquared && relative > -NEWTON_BAND * baseSquared && n >= newtonRetry
        && n >= PROOF_START && period > 2 && spent + NEWTON_COST * period <= steps) {
        const ex = totalRe - baseRe, ey = totalIm - baseIm;
        if (ex * ex + ey * ey < NEWTON_RETURN_SQUARED * baseSquared) {
          const used = attractingCycle(reference, m, dr, di, dcRe, dcIm, period, dcError);
          if (used < 0) return INTERIOR;
          spent += used; newtonRetry = n + 4 * period * 2 ** ++newtonFails;
        }
      }
      if ((near || (collapse && collapsedBase)) && n >= retry && n >= PROOF_START && n - baseN > 2 && spent + n - baseN <= steps) {
        const ex = totalRe - baseRe, ey = totalIm - baseIm;
        distanceSquared = ex * ex + ey * ey;
        start = !near || distanceSquared < TRAP_RETURN_SQUARED * baseSquared;
      }
      if (start) {
        verify = n - baseN; spent += verify;
        startRe = totalRe; startIm = totalIm;
        startError = ROUNDING * (Math.hypot(zr, zi) + Math.hypot(dr, di));
        radius0 = 8 * (Math.sqrt(distanceSquared) + startError);
        ra = radius0; rb = radius0 * 2 ** 8; rc = radius0 * 2 ** 16; rd = radius0 * 2 ** 24;
      } else if (relative < 0 || n >= reset) {
        // Forget the base periodically, so a transient close pass cannot hide the cycle.
        if (n >= reset) reset *= 2;
        collapsedBase = collapse;
        baseRe = totalRe; baseIm = totalIm; baseSquared = squared; baseN = n;
        // Strictly beyond both bands even after rounding.
        far = squared * (1 + 2 * NEWTON_BAND);
      }
    }
    if (rebase || m === end) {
      dr = totalRe; di = totalIm; m = 0; zr = real[0]; zi = imag[0];
      deltaSquared = squared;
    }
  }
  stats.unresolved++;
  lastSample.unresolved = true;
  return INTERIOR;
}

const negate = (a: Extended): Extended => ({ re: -a.re, im: -a.im, exp: a.exp });

/**
 * Extended-exponent perturbation, with the same interior proof as
 * perturbNative; radii are tracked as log2 so they cannot underflow.
 */
export function perturbExtended(reference: Reference, dc: Extended, limit: number, fallback: () => number, stats: SampleStats, logPixel: number): number {
  const orbit = reference.orbit!, orbitLog = reference.orbitLog!;
  const logDc = logMagnitude(dc);
  // logDelta is always logMagnitude(delta), kept alongside it rather than recomputed at each use.
  let delta = ZERO, logDelta = -Infinity, m = 0, n = 0;
  // z' (dz/dc times the pixel size) as (er, ei) 2^eExp, with lift = pixel / 2^eExp; zr, zi hold z itself (|z| <= 16).
  const pixelExponent = Math.floor(logPixel), pixel = extended(2 ** (logPixel - pixelExponent), 0, pixelExponent);
  let er = 0, ei = 0, eExp = pixel.exp, lift = pixel.re, zr = 0, zi = 0;
  let base: Extended | undefined, baseLog = Infinity, baseN = 0, reset = 64, collapsedBase = false, retry = 0;
  let verify = 0, spent = 0, steps = 0, start = ZERO, startError = -Infinity, logRadius0 = -Infinity;
  const logRadii = [-Infinity, -Infinity, -Infinity, -Infinity];
  while (n < limit) {
    steps++;
    const block = verify ? undefined : lookupExtended(reference, m, logDelta, limit - n);
    const skipped = block !== undefined;
    if (block) {
      const derivative = linear(block.a, { re: er, im: ei, exp: eExp }, block.b, pixel);
      er = derivative.re; ei = derivative.im; eExp = derivative.exp; lift = 2 ** (logPixel - eExp);
      delta = linear(block.a, delta, block.b, dc);
      m += block.length; n += block.length; stats.skipped += block.length - 1;
    } else {
      if (verify) {
        const logZ = logMagnitude(add(orbit[m], delta)), logReference = orbitLog[m];
        const rounding = LOG_ROUNDING + logAdd(logAdd(2 + logReference + logDelta, 2 * logDelta), logDc);
        for (let i = 0; i < 4; i++) logRadii[i] = logAdd(logRadii[i] + logAdd(1 + logZ, logRadii[i]), rounding);
      }
      const nextEr = 2 * (zr * er - zi * ei) + lift;
      ei = 2 * (zr * ei + zi * er); er = nextEr;
      if (Math.abs(er) + Math.abs(ei) > 2 ** 256) { er *= 2 ** -256; ei *= 2 ** -256; lift *= 2 ** -256; eExp += 256; }
      delta = perturbStep(orbit[m], delta, dc);
      m++; n++;
    }
    logDelta = logMagnitude(delta);
    const z = orbit[m], logReference = orbitLog[m];
    const total = add(z, delta);
    const logTotal = logMagnitude(total);
    if (logTotal > 4) {
      lastSample.distance = 2 ** (logTotal - Math.log2(Math.hypot(er, ei)) - eExp) * logTotal * Math.LN2;
      return smooth(n, logTotal);
    }
    const unit = 2 ** total.exp;
    zr = total.re * unit; zi = total.im * unit;
    if (logTotal < logReference - 24 || Number.isNaN(logTotal)) return fallback();
    const rebase = logTotal < logDelta || m === orbit.length - 1;
    if (verify) {
      const error = LOG_ROUNDING + logAdd(logReference, logDelta);
      if (--verify === 0) {
        const distance = logAdd(logMagnitude(add(total, negate(start))), logAdd(startError, error));
        if (logRadii.some((logRadius, i) => logAdd(distance, logRadius) <= logRadius0 + 8 * i)) return INTERIOR;
        base = undefined; baseLog = Infinity; collapsedBase = false; retry = 2 * n;
      } else if (rebase) for (let i = 0; i < 4; i++) logRadii[i] = logAdd(logRadii[i], error);
    } else if (skipped) {
      // Returns and collapses happen near z = 0, where BLA cannot apply: track single steps only.
    } else if (base) {
      // A return within 2^-10 needs |z| within ~2^-10 of |base|; test that and
      // the cheap eligibility conditions before subtracting extended values.
      const period = n - baseN, collapse = logTotal < baseLog - 10;
      const eligible = n >= retry && n >= PROOF_START && period > 2 && spent + period <= steps;
      const near = eligible && Math.abs(logTotal - baseLog) < 0.002;
      const logDistance = near ? logMagnitude(add(total, negate(base))) : Infinity;
      if (eligible && (logDistance < baseLog - 10 || (collapse && collapsedBase))) {
        verify = period; spent += period; start = total;
        startError = LOG_ROUNDING + logAdd(logReference, logDelta);
        logRadius0 = 3 + logAdd(logDistance, startError);
        for (let i = 0; i < 4; i++) logRadii[i] = logRadius0 + 8 * i;
      } else if (logTotal < baseLog || n >= reset) {
        if (n >= reset) reset *= 2;
        collapsedBase = collapse;
        base = total; baseLog = logTotal; baseN = n;
      }
    } else { base = total; baseLog = logTotal; baseN = n; }
    if (rebase) { delta = total; logDelta = logTotal; m = 0; }
  }
  stats.unresolved++;
  lastSample.unresolved = true;
  return INTERIOR;
}
