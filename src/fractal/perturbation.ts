/**
 * Perturbation kernels: a pixel's orbit as z = Z + δ around the shared
 * reference orbit Z, with BLA skipping, rebasing to the reference start when
 * |z| < |δ|, glitch fallback to BigInt, the distance estimate, and the
 * interior proofs of ./interior.ts. perturbNative covers views down to 2^-900;
 * perturbExtended carries a separate exponent below that, and runs in doubles
 * wherever δ (and a proof's radii) are back inside double range.
 */
import { add, addAt, extended, linearAt, logAdd, logMagnitude, magnitude, perturbStepAt, ZERO } from '../math/extended.ts';
import type { Extended } from '../math/extended.ts';
import { escapeDistance, INTERIOR, lastSample, smooth } from './escape.ts';
import {
  attractingCycle, attractingCycleExtended, LOG_ROUNDING, LOG_SLACK, NEWTON_BAND, NEWTON_COST, NEWTON_PASSES, NEWTON_RETURN_SQUARED, PROOF_START,
  provedExtendedCycle, ROUNDING, SQRT2, TINY_SQUARE, TRAP_BAND, TRAP_RETURN_SQUARED,
} from './interior.ts';
import { EXTENDED_FIELDS, lookupExtended, lookupNative, NATIVE_FIELDS } from './orbit.ts';
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

/** NEWTON_BAND and NEWTON_RETURN_SQUARED as log2 of magnitudes: |z| within (3/4, 5/4) of |base| in squares, and within |base| / 2. */
const LOG_NEWTON_LOW = 0.5 * Math.log2(1 - NEWTON_BAND), LOG_NEWTON_HIGH = 0.5 * Math.log2(1 + NEWTON_BAND);
const LOG_NEWTON_RETURN = 0.5 * Math.log2(NEWTON_RETURN_SQUARED);
/** log2 |base| below which proofs get the larger allowance (see perturbExtended). */
const SMALL_BASE = -10;
/** perturbExtended's fast path keeps |δ| and |z| at least 2^-500 (squares at least FAST_SQUARED), far from double underflow. */
const FAST_LOG = -500, FAST_SQUARED = 2 ** -1000;
/**
 * dc is scaled by 2^DC_SHIFT for the fast path's BLA blocks: at the depths it serves (|dc| ~ 2^-900
 * and below) B dc 2^DC_SHIFT stays far from overflow, and a block where it would not is left to the
 * general path.
 */
const DC_SHIFT = 600, DC_UNSHIFT = 2 ** -DC_SHIFT;
/** Proof steps run in doubles while every radius lies within [FAST_RADIUS, 1 / FAST_RADIUS], each update rounded up by UP. */
const FAST_RADIUS_LOG = -900, FAST_RADIUS = 2 ** FAST_RADIUS_LOG, UP = 1 + 2 ** -48;

/**
 * Extended-exponent perturbation, with the interior proofs of perturbNative
 * (a close return's disk check in the loop, attractingCycleExtended on rough
 * returns); radii are tracked as log2 so they cannot underflow. A proof leaves
 * its start in provedExtendedCycle for the next pixel.
 */
export function perturbExtended(reference: Reference, dc: Extended, limit: number, fallback: () => number, stats: SampleStats, logPixel: number): number {
  const orbit = reference.points, orbitLog = reference.orbitLog!;
  const logDc = logMagnitude(dc);
  // logDelta is always logMagnitude(delta), kept alongside it rather than recomputed at each use.
  let delta = ZERO, logDelta = -Infinity, m = 0, n = 0;
  // z' (dz/dc times the pixel size) as (er, ei) 2^eExp, with lift = pixel / 2^eExp; zr, zi hold z itself (|z| <= 16).
  const pixelExponent = Math.floor(logPixel), pixel = extended(2 ** (logPixel - pixelExponent), 0, pixelExponent);
  let er = 0, ei = 0, eExp = pixel.exp, lift = pixel.re, zr = 0, zi = 0;
  let base: Extended | undefined, baseLog = Infinity, baseN = 0, reset = 64, collapsedBase = false, retry = 0;
  // log2 |base| of the last failed proof: the retry backoff holds only for bases not far below it.
  let failedLog = Infinity, startLog = Infinity, newtonRetry = 0, newtonFails = 0;
  // The largest |log2 r| of the running proof, for its final margin (see LOG_SLACK).
  let largest = 0;
  // The proof's start as orbit state (index and δ), for the next pixel's hint.
  let verify = 0, spent = 0, steps = 0, start = ZERO, startM = 0, startDelta = ZERO, startPeriod = 0, startError = -Infinity, logRadius0 = -Infinity;
  const logRadii = [-Infinity, -Infinity, -Infinity, -Infinity];
  const real = reference.real, imag = reference.imag, skip = reference.skipRadiusSquared, end = real.length - 1;
  // Steps may drop dc when it is below 2^-64 of any δ the fast path keeps (see below).
  const fast = logDc < 0.5 * Math.log2(FAST_SQUARED) - 64;
  // dc 2^DC_SHIFT in doubles, for BLA blocks' B dc (0 only where B dc is far below any δ kept).
  const dcShifted = 2 ** (dc.exp + DC_SHIFT), dcr = dc.re * dcShifted, dci = dc.im * dcShifted;
  while (n < limit) {
    // Fast path: the loop in doubles while δ and z are well inside double
    // range, as perturbNative. Only dc lies outside it. Single steps need not
    // add it: |dc| < 2^-64 |δ'| here, so dc changes δ' by less than its
    // rounding. BLA blocks add B dc, formed as B (dc 2^DC_SHIFT) 2^-DC_SHIFT
    // (exact scalings; with |B| < 2^1024, a term lost to underflow there is
    // below 2^-640). A step or block whose δ' would leave the range, or
    // whose results overflow, is left to the general path below. Single
    // steps are taken exactly, and blocks only from two steps up, as in
    // perturbNative. After each step or block the loop leaves wherever the
    // general path would do anything but iterate on: z escapes, nears the
    // glitch bound or leaves the range, the base resets, or the step is one
    // the proof bookkeeping acts on (its tests as in perturbNative, with
    // margins for the log2 tests the general path makes). Proofs (verify)
    // always run the general path.
    let stepped = false;
    if (fast && !verify && logDelta > FAST_LOG && logDelta < 8) {
      let dr = delta.re * 2 ** delta.exp, di = delta.im * 2 ** delta.exp, deltaSquared = dr * dr + di * di;
      // The base in doubles: 0 where |base|² underflows, and then no z this path keeps comes near it.
      const baseSquared = base ? 2 ** (2 * baseLog) : Infinity, far = baseSquared * (1 + 2 * NEWTON_BAND) * (1 + 1e-9);
      const baseRe = base ? base.re * 2 ** base.exp : 0, baseIm = base ? base.im * 2 ** base.exp : 0;
      while (n < limit) {
        const quick = skip[m];
        const level = (quick >= 1e-280 ? deltaSquared < quick : quick > 0) ? lookupNative(reference, m, dr, di, limit - n) : -1;
        let nextRe: number, nextIm: number, nextEr: number, nextEi: number, length = 1;
        if (level >= 1) {
          const table = reference.native[level], o = ((m - 1) >> level) * NATIVE_FIELDS;
          const ar = table[o], ai = table[o + 1], br = table[o + 2], bi = table[o + 3];
          nextRe = ar * dr - ai * di + (br * dcr - bi * dci) * DC_UNSHIFT;
          nextIm = ar * di + ai * dr + (br * dci + bi * dcr) * DC_UNSHIFT;
          nextEr = ar * er - ai * ei + br * lift;
          nextEi = ar * ei + ai * er + bi * lift;
          length = 1 << level;
        } else {
          const ur = real[m] + zr, ui = imag[m] + zi;
          nextRe = ur * dr - ui * di; nextIm = ur * di + ui * dr;
          nextEr = 2 * (zr * er - zi * ei) + lift; nextEi = 2 * (zr * ei + zi * er);
        }
        const nextSquared = nextRe * nextRe + nextIm * nextIm;
        if (!(nextSquared >= FAST_SQUARED && nextSquared <= 2 ** 16) || !Number.isFinite(nextEr + nextEi)) break;
        steps++;
        er = nextEr; ei = nextEi;
        if (Math.abs(er) + Math.abs(ei) > 2 ** 256) { er *= 2 ** -256; ei *= 2 ** -256; lift *= 2 ** -256; eExp += 256; }
        dr = nextRe; di = nextIm; deltaSquared = nextSquared;
        m += length; n += length; stats.skipped += length - 1;
        const Zr = real[m], Zi = imag[m], totalRe = Zr + dr, totalIm = Zi + di, squared = totalRe * totalRe + totalIm * totalIm;
        zr = totalRe; zi = totalIm;
        if (!(squared <= 256 && squared >= FAST_SQUARED) || squared * 2 ** 47 < Zr * Zr + Zi * Zi || n >= reset) {
          stepped = true;
          break;
        }
        if (squared <= far) {
          const relative = squared - baseSquared, period = n - baseN;
          // A new smallest |z| (or a collapse) moves the base.
          if (relative < baseSquared * 1e-9) { stepped = true; break; }
          // A return close enough for attractingCycleExtended or an in-loop proof, with allowance for either.
          if (n >= PROOF_START && period > 2 && relative < NEWTON_BAND * 1.001 * baseSquared) {
            const ex = totalRe - baseRe, ey = totalIm - baseIm, allowance = baseLog < SMALL_BASE ? Math.max(steps, n / 8) : steps;
            if (ex * ex + ey * ey < NEWTON_RETURN_SQUARED * 1.001 * baseSquared
              && ((n >= newtonRetry && spent + NEWTON_COST * period <= allowance)
                || ((n >= retry || baseLog < failedLog - 10) && spent + period <= allowance))) { stepped = true; break; }
          }
        }
        if (squared < deltaSquared || m === end) { dr = totalRe; di = totalIm; deltaSquared = squared; m = 0; }
      }
      delta = extended(dr, di);
      logDelta = logMagnitude(delta);
      if (!stepped && n >= limit) break;
    } else if (fast && verify > 1 && logDelta > FAST_LOG && logDelta < 8 && logRadii[0] > FAST_RADIUS_LOG) {
      // A proof's steps in doubles while its radii are well inside double
      // range too, with perturbNative's bounds: each step's rounding, plus
      // |dc| for the dc the step leaves out (dcBound, at least 2^-1000, far
      // below any radius kept), and each radius rounded up by UP. A radius
      // already past the final comparison's bound and at least 1 (it never
      // shrinks again, as in the general path) is carried as Infinity; when
      // all four are, the proof has failed. The last step, with the final
      // comparison, is the general path's.
      let dr = delta.re * 2 ** delta.exp, di = delta.im * 2 ** delta.exp, deltaSquared = dr * dr + di * di;
      const bound0 = 2 ** logRadius0 * (1 + 2 ** -40), bound1 = bound0 * 2 ** 8, bound2 = bound0 * 2 ** 16, bound3 = bound0 * 2 ** 24;
      const radius = (logRadius: number, bound: number) => {
        const r = 2 ** logRadius * UP;
        return r >= 1 && r > bound ? Infinity : r;
      };
      let ra = radius(logRadii[0], bound0), rb = radius(logRadii[1], bound1), rc = radius(logRadii[2], bound2), rd = radius(logRadii[3], bound3);
      const dcBound = Math.max(2 ** (logDc + 1), 2 ** -1000);
      while (verify > 1 && n < limit && ra >= FAST_RADIUS && (rd <= 1 / FAST_RADIUS || rd === Infinity)) {
        const Zr = real[m], Zi = imag[m], ur = Zr + zr, ui = Zi + zi, nextRe = ur * dr - ui * di, nextIm = ur * di + ui * dr;
        const nextSquared = nextRe * nextRe + nextIm * nextIm;
        if (!(nextSquared >= FAST_SQUARED && nextSquared <= 2 ** 16)) break;
        steps++;
        const reference = SQRT2 * Math.max(Math.abs(Zr), Math.abs(Zi)), deltaBound = SQRT2 * Math.max(Math.abs(dr), Math.abs(di));
        const twice = 2 * Math.sqrt(zr * zr + zi * zi + TINY_SQUARE), rounding = ROUNDING * (4 * reference * deltaBound + deltaBound * deltaBound) + dcBound;
        ra = (ra * (twice + ra) + rounding) * UP; rb = (rb * (twice + rb) + rounding) * UP;
        rc = (rc * (twice + rc) + rounding) * UP; rd = (rd * (twice + rd) + rounding) * UP;
        if (ra >= 1 && ra > bound0) ra = Infinity;
        if (rb >= 1 && rb > bound1) rb = Infinity;
        if (rc >= 1 && rc > bound2) rc = Infinity;
        if (rd >= 1 && rd > bound3) rd = Infinity;
        if (ra === Infinity) {
          // Every radius is past its bound (they keep their order): the step is left to the general path, without the proof.
          verify = 0; base = undefined; baseLog = Infinity; collapsedBase = false; retry = 2 * n; failedLog = startLog;
          break;
        }
        const nextEr = 2 * (zr * er - zi * ei) + lift;
        ei = 2 * (zr * ei + zi * er); er = nextEr;
        if (Math.abs(er) + Math.abs(ei) > 2 ** 256) { er *= 2 ** -256; ei *= 2 ** -256; lift *= 2 ** -256; eExp += 256; }
        dr = nextRe; di = nextIm; deltaSquared = nextSquared;
        m++; n++;
        const Yr = real[m], Yi = imag[m], totalRe = Yr + dr, totalIm = Yi + di, squared = totalRe * totalRe + totalIm * totalIm;
        zr = totalRe; zi = totalIm;
        if (!(squared <= 256 && squared >= FAST_SQUARED) || squared * 2 ** 47 < Yr * Yr + Yi * Yi) { stepped = true; break; }
        verify--;
        if (squared < deltaSquared || m === end) {
          // Representing z as Z + δ rounds once more; rebasing makes that the new state.
          const error = ROUNDING * SQRT2 * (Math.max(Math.abs(Yr), Math.abs(Yi)) + Math.max(Math.abs(dr), Math.abs(di)));
          ra += error; rb += error; rc += error; rd += error;
          dr = totalRe; di = totalIm; deltaSquared = squared; m = 0;
        }
      }
      // Back to log2 radii, rounded up.
      logRadii[0] = Math.log2(ra) + 1e-9; logRadii[1] = Math.log2(rb) + 1e-9;
      logRadii[2] = Math.log2(rc) + 1e-9; logRadii[3] = Math.log2(rd) + 1e-9;
      for (const logRadius of logRadii) if (logRadius < Infinity) largest = Math.max(largest, Math.abs(logRadius));
      delta = extended(dr, di);
      logDelta = logMagnitude(delta);
      if (!stepped && n >= limit) break;
    }
    if (!stepped) {
      steps++;
      const level = verify ? -1 : lookupExtended(reference, m, logDelta, limit - n);
      if (level >= 0) {
        const table = reference.levels![level], o = ((m - 1) >> level) * EXTENDED_FIELDS, length = 1 << level;
        const derivative = linearAt(table, o, { re: er, im: ei, exp: eExp }, pixel);
        er = derivative.re; ei = derivative.im; eExp = derivative.exp; lift = 2 ** (logPixel - eExp);
        delta = linearAt(table, o, delta, dc);
        m += length; n += length; stats.skipped += length - 1;
      } else {
        if (verify) {
          const logZ = logMagnitude(addAt(orbit, m, delta)), logReference = orbitLog[m];
          const rounding = LOG_ROUNDING + logAdd(logAdd(2 + logReference + logDelta, 2 * logDelta), logDc);
          for (let i = 0; i < 4; i++) {
            logRadii[i] = logAdd(logRadii[i] + logAdd(1 + logZ, logRadii[i]), rounding);
            largest = Math.max(largest, Math.abs(logRadii[i]));
          }
          // A radius of 1 or more never shrinks again (r (2|z| + r) >= r², and rebasing only
          // adds): once every radius is past what the final comparison allows, the proof has
          // failed, and the rest of its period need not run (escaping orbits that pass a
          // return fail this way, often with radii past 2^1000 within a few dozen steps).
          if (logRadii[0] >= 0 && logRadii[0] > logRadius0 && logRadii[1] > logRadius0 + 8
            && logRadii[2] > logRadius0 + 16 && logRadii[3] > logRadius0 + 24) {
            verify = 0; base = undefined; baseLog = Infinity; collapsedBase = false; retry = 2 * n; failedLog = startLog;
          }
        }
        const nextEr = 2 * (zr * er - zi * ei) + lift;
        ei = 2 * (zr * ei + zi * er); er = nextEr;
        if (Math.abs(er) + Math.abs(ei) > 2 ** 256) { er *= 2 ** -256; ei *= 2 ** -256; lift *= 2 ** -256; eExp += 256; }
        delta = perturbStepAt(orbit, m, delta, dc);
        m++; n++;
      }
    }
    logDelta = logMagnitude(delta);
    const logReference = orbitLog[m];
    const total = addAt(orbit, m, delta);
    const logTotal = logMagnitude(total);
    if (logTotal > 4) {
      lastSample.distance = 2 ** (logTotal - Math.log2(Math.hypot(er, ei)) - eExp) * logTotal * Math.LN2;
      return smooth(n, logTotal);
    }
    const unit = 2 ** total.exp;
    zr = total.re * unit; zi = total.im * unit;
    if (logTotal < logReference - 24 || Number.isNaN(logTotal)) return fallback();
    const rebase = logTotal < logDelta || m === end;
    if (verify) {
      const error = LOG_ROUNDING + logAdd(logReference, logDelta);
      if (--verify === 0) {
        const distance = logAdd(logMagnitude(add(total, negate(start))), logAdd(startError, error));
        // The log2 bookkeeping rounds too (see LOG_SLACK).
        const slack = startPeriod * (largest + 64) * LOG_SLACK;
        if (logRadii.some((logRadius, i) => logAdd(distance, logRadius) <= logRadius0 + 8 * i - slack)) {
          provedExtendedCycle.found = true; provedExtendedCycle.m = startM; provedExtendedCycle.s = startDelta;
          provedExtendedCycle.period = startPeriod;
          return INTERIOR;
        }
        base = undefined; baseLog = Infinity; collapsedBase = false; retry = 2 * n; failedLog = startLog;
      } else if (rebase) for (let i = 0; i < 4; i++) logRadii[i] = logAdd(logRadii[i], error);
    } else if (base) {
      // Unlike perturbNative, track BLA steps too: deep in a minibrot the
      // reference orbit itself returns close to 0 every period, and with δ far
      // below Z there, blocks skip right over the returns. Any start gives a
      // valid proof, so a start after a block is as sound as one after a step.
      // A return within 2^-10 needs |z| within ~2^-10 of |base|; test that and
      // the cheap eligibility conditions before subtracting extended values.
      const period = n - baseN, collapse = logTotal < baseLog - 10;
      // Proof work stays within the loop steps executed, as in perturbNative. Around a
      // return close to 0 (a minibrot's mark), it may also reach an eighth of the
      // iterations: BLA skips most of each lap there, and steps alone would hold
      // proofs off for dozens of laps. Returns near repelling cycles (|z| ~ 1–2,
      // where escaping orbits linger) keep the strict bound. A quarter proved a
      // few more minibrot edge pixels but made views where proofs keep failing
      // (cusps, bulb roots) up to 3x slower.
      const allowance = baseLog < SMALL_BASE ? Math.max(steps, n / 8) : steps;
      // A rough return first tries attractingCycleExtended (within |base| / 2, |z| within
      // NEWTON_BAND of |base| in squares), as perturbNative does, with the same backoff.
      // It gets only the laps the allowance has left: each extended step costs as much
      // as a loop step, and ten failing laps of a long period would dwarf the pixel's work.
      if (logTotal - baseLog > LOG_NEWTON_LOW && logTotal - baseLog < LOG_NEWTON_HIGH && n >= newtonRetry
        && n >= PROOF_START && period > 2 && spent + NEWTON_COST * period <= allowance
        && logMagnitude(add(total, negate(base))) < baseLog + LOG_NEWTON_RETURN) {
        const passes = Math.min(NEWTON_PASSES, Math.floor((allowance - spent) / period));
        const used = attractingCycleExtended(reference, m, delta, dc, logDc, period, passes);
        if (used < 0) return INTERIOR;
        spent += used; newtonRetry = n + 4 * period * 2 ** ++newtonFails;
      }
      // A failure near a repelling cycle (often where the orbit lingers, |z| ~ 2 near c = -2)
      // must not hold off a proof around a far smaller |z|, such as a minibrot's returns to 0.
      const eligible = (n >= retry || baseLog < failedLog - 10) && n >= PROOF_START && period > 2 && spent + period <= allowance;
      const near = eligible && Math.abs(logTotal - baseLog) < 0.002;
      // A collapse starts from its distance to the base too (as in perturbNative): an
      // infinite one would make every radius infinite and the final check vacuous.
      const logDistance = near || (eligible && collapse && collapsedBase) ? logMagnitude(add(total, negate(base))) : Infinity;
      if (eligible && (logDistance < baseLog - 10 || (collapse && collapsedBase))) {
        verify = period; spent += period; start = total; startLog = baseLog; startM = m; startDelta = delta; startPeriod = period;
        startError = LOG_ROUNDING + logAdd(logReference, logDelta);
        logRadius0 = 3 + logAdd(logDistance, startError);
        for (let i = 0; i < 4; i++) logRadii[i] = logRadius0 + 8 * i;
        largest = Math.max(Math.abs(logRadii[0]), Math.abs(logRadii[3]));
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
