/**
 * Interior proofs. Interior points never escape, so without a shortcut every
 * one of them would run the whole iteration budget. These tests only ever
 * conclude "interior", and only with a rigorous inclusion argument (a disk
 * that f^P maps into itself, with rounding bounds), so escaping samples are
 * never affected. perturbNative tracks returns of its orbit and decides when
 * to try them; directRow does the same for shallow views.
 */
import { magnitude } from '../math/extended.ts';
import type { Reference } from './orbit.ts';

/**
 * The disk bounds per step need upper bounds, not exact moduli, and must
 * survive squares that underflow at extreme depths. Where a modulus only
 * scales the rounding term, √2 max(|x|, |y|) bounds it (within √2). For |z|,
 * which multiplies the radius, √(x² + y² + TINY_SQUARE) is exact above
 * 10^-140 and above |z| below it. Both avoid a Math.hypot fallback, whose mere
 * presence in the loop slows it by a third in V8.
 */
export const TINY_SQUARE = 1e-280, SQRT2 = Math.SQRT2;

/** A return within 2^-10 of the base point (in squared terms) starts an interior proof attempt. */
export const TRAP_RETURN_SQUARED = 2 ** -20;
/** |z|² must be this close (relatively) to |base|² for such a return to be possible. */
export const TRAP_BAND = 2 ** -8;
/**
 * Interior orbits need far longer than this to settle; earlier returns are
 * transients. Periods 1 and 2 are skipped too: their attracting cycles lie only
 * in the main cardioid and period-2 bulb, which exact tests already settle.
 */
export const PROOF_START = 128;
/**
 * Generous bound on the relative rounding of one double operation chain. A
 * perturbation step computes δ' = (2Z + δ) δ + dc: with u = 2Z + δ, its
 * rounding stays within a few units of 2^-53 (|u||δ| + |dc|), and
 * |u||δ| <= 2|Z||δ| + |δ|², well inside ROUNDING (4|Z||δ| + |δ|²) + ROUNDING |dc|.
 */
export const ROUNDING = 2 ** -50;
/**
 * attractingCycle is tried on looser returns than the in-loop proof: within
 * 2^-2 of |base| (squared terms), with |z|² within 2^-2 of |base|². An attempt
 * needs 3P unspent steps (proof work stays within ~the steps executed), takes
 * at most NEWTON_PASSES laps, and the k-th failed one waits 4P 2^k before the
 * next: escaping orbits keep passing near repelling cycles.
 */
export const NEWTON_RETURN_SQUARED = 2 ** -2, NEWTON_BAND = 2 ** -2, NEWTON_COST = 3, NEWTON_PASSES = 10;
/**
 * The cycle point of the last successful attractingCycle proof. Neighbouring
 * interior pixels share the component, so its period, and a cycle point that
 * moves continuously with c: the next pixel tries the proof from there first
 * (at most HINT_PASSES laps) before iterating at all. Any start point gives a
 * valid proof, and a failure leaves the pixel to the usual path, so results
 * do not depend on the order pixels are sampled in.
 */
export const provedCycle = { found: false, m: 0, sr: 0, si: 0, period: 0 };
export const HINT_PASSES = 4;
/** ROUNDING as a log2, for the extended-exponent proofs. */
export const LOG_ROUNDING = Math.log2(ROUNDING);

/**
 * Interior proof for a double-precision orbit at z with candidate period P:
 * iterate P steps while bounding the image of the disk D(z, r0); if it lands
 * inside D, f^P maps D into itself and the orbit can never escape.
 * |f(w) - f(z)| <= r (2|z| + r), plus a rounding bound for z^2 + c.
 */
export function trappedDouble(cr: number, ci: number, zr: number, zi: number, period: number, distance: number): boolean {
  const cMagnitude = Math.hypot(cr, ci);
  // Several disk sizes at once: small ones suit weakly contracting cycles,
  // large ones keep rounding bounds negligible near super-attracting ones.
  const radius0 = 8 * (distance + ROUNDING * Math.hypot(zr, zi));
  let ra = radius0, rb = radius0 * 2 ** 8, rc = radius0 * 2 ** 16, rd = radius0 * 2 ** 24;
  let re = zr, im = zi, r2 = zr * zr, i2 = zi * zi;
  for (let k = 0; k < period; k++) {
    const twice = 2 * Math.sqrt(r2 + i2 + TINY_SQUARE), rounding = ROUNDING * (r2 + i2 + cMagnitude);
    ra = ra * (twice + ra) + rounding; rb = rb * (twice + rb) + rounding;
    rc = rc * (twice + rc) + rounding; rd = rd * (twice + rd) + rounding;
    im = 2 * re * im + ci; re = r2 - i2 + cr; r2 = re * re; i2 = im * im;
    if (r2 + i2 > 256 || !(ra < 1)) return false;
  }
  const gap = Math.hypot(re - zr, im - zi) + ROUNDING * (Math.hypot(re, im) + Math.hypot(zr, zi));
  return gap + ra <= radius0 || gap + rb <= radius0 * 2 ** 8 || gap + rc <= radius0 * 2 ** 16 || gap + rd <= radius0 * 2 ** 24;
}

/**
 * The cycle of the last attractingCycleDouble proof, as a hint for the next
 * pixel of a row (see provedCycle; the same argument makes it order-free).
 */
export const provedDoubleCycle = { found: false, re: 0, im: 0, period: 0, hopeless: false };
/** directRow tries attractingCycleDouble on returns within 2^-5 of the saved point (2^-10 in squared terms). */
export const DIRECT_NEWTON_RETURN_SQUARED = 2 ** -10;

/**
 * The least period of the cycle through w (a refined cycle point), among the
 * divisors of `period`, which returns often only detect as a multiple (rows
 * compare states 32 steps apart). Hints then cost 4 laps of the true cycle.
 */
function cyclePeriod(cr: number, ci: number, wr: number, wi: number, period: number): number {
  const tolerance = 2 ** -30 * (Math.abs(wr) + Math.abs(wi)) + 1e-300;
  let re = wr, im = wi;
  for (let k = 1; k < period; k++) {
    const next = re * re - im * im + cr;
    im = 2 * re * im + ci; re = next;
    if (period % k === 0 && Math.abs(re - wr) + Math.abs(im - wi) < tolerance) return k;
  }
  return period;
}

/**
 * attractingCycle for plain doubles (shallow views): Newton's method on
 * f^P(w) = w from w, then the disk check of trappedDouble around the refined
 * point, for four radii. A disk that f^P maps into itself contains an
 * attracting cycle, which attracts the critical point 0 (Fatou), so c is
 * interior. Returns the steps spent, negated when the proof succeeded;
 * provedDoubleCycle.hopeless tells when Newton settled on a cycle that gave no
 * proof: one with |λ| >= 1, or one too weakly attracting for the disk check.
 */
export function attractingCycleDouble(cr: number, ci: number, wr: number, wi: number, period: number,
  passes = NEWTON_PASSES): number {
  const cMagnitude = Math.hypot(cr, ci);
  provedDoubleCycle.hopeless = false;
  let spent = 0, radius0 = 0, previousStep = Infinity;
  for (let pass = 0; pass < passes; pass++) {
    // One lap from w: f^P(w), its derivative D = (f^P)'(w) and, after the first
    // pass, bounds ra..rd on the images of D(w, r), as in trappedDouble.
    const check = pass > 0;
    let ra = radius0, rb = radius0 * 16, rc = radius0 * 256, rd = radius0 * 4096;
    let re = wr, im = wi, Dr = 1, Di = 0;
    for (let k = 0; k < period; k++) {
      const r2 = re * re, i2 = im * im;
      if (check) {
        const twice = 2 * Math.sqrt(r2 + i2 + TINY_SQUARE), rounding = ROUNDING * (r2 + i2 + cMagnitude);
        ra = ra * (twice + ra) + rounding; rb = rb * (twice + rb) + rounding;
        rc = rc * (twice + rc) + rounding; rd = rd * (twice + rd) + rounding;
      }
      const nextD = 2 * (re * Dr - im * Di);
      Di = 2 * (re * Di + im * Dr); Dr = nextD;
      im = 2 * re * im + ci; re = r2 - i2 + cr;
      if (!(re * re + im * im <= 256)) return spent + k;
    }
    spent += period;
    const gr = re - wr, gi = im - wi, lambda = magnitude(Dr, Di);
    if (check) {
      const gap = magnitude(gr, gi) + ROUNDING * (magnitude(re, im) + magnitude(wr, wi));
      if (gap + ra < radius0 || gap + rb < radius0 * 16 || gap + rc < radius0 * 256 || gap + rd < radius0 * 4096) {
        provedDoubleCycle.found = true; provedDoubleCycle.re = wr; provedDoubleCycle.im = wi;
        provedDoubleCycle.period = cyclePeriod(cr, ci, wr, wi, period);
        return -spent;
      }
    }
    // Newton for g(w) = f^P(w) - w, stopping as attractingCycle does.
    const ar = Dr - 1, ai = Di, den = ar * ar + ai * ai;
    const stepRe = (gr * ar + gi * ai) / den, stepIm = (gi * ar - gr * ai) / den;
    const step = magnitude(stepRe, stepIm), size = magnitude(wr, wi);
    // Settled on a cycle that does not attract (|λ| >= 1), or steps stopped shrinking: retrying this orbit is futile.
    if (!(lambda < 1) && !(step > 2 ** -8 * size)) { provedDoubleCycle.hopeless = true; break; }
    if (!(step < previousStep) && pass > 2) { provedDoubleCycle.hopeless = true; break; }
    wr -= stepRe; wi -= stepIm;
    previousStep = step;
    radius0 = lambda < 1 ? 4 * (step + ROUNDING * size + Number.MIN_VALUE) / (1 - lambda) : 0;
    if (pass === passes - 1) provedDoubleCycle.hopeless = true;
  }
  return spent;
}

/**
 * Interior proof by an attracting cycle. The orbit of an interior point can
 * take a very long time to settle near its cycle (each lap of a period-844
 * cycle may bring it only ~12% closer), so waiting for a close return, as
 * perturbNative's own proof does, costs tens of thousands of iterations per
 * pixel. Instead, from a rough return after P steps, Newton's method on
 * f^P(w) = w finds the cycle point directly, and the disk check below proves,
 * with rounding bounds, that f^P maps a disk around it into itself. Then f^P
 * has an attracting fixed point there (Schwarz lemma), and an attracting cycle
 * of z^2 + c always attracts the critical point 0 (Fatou), so the orbit of 0
 * stays bounded: c is interior, whether or not the orbit has come close yet.
 *
 * Runs from the orbit state (m0, δ = s) without changing it; each pass is P
 * single steps. Returns the steps spent, negated when the proof succeeded.
 */
export function attractingCycle(reference: Reference, m0: number, sr: number, si: number, dcRe: number, dcIm: number,
  period: number, dcError: number, passes = NEWTON_PASSES): number {
  const real = reference.real, imag = reference.imag, end = real.length - 1;
  let spent = 0, radius0 = 0, previousStep = Infinity;
  for (let pass = 0; pass < passes; pass++) {
    // One lap from w = Z_m0 + s: f^P(w), its derivative D = (f^P)'(w), and,
    // after the first pass, bounds ra..rd on the images of D(w, r) for four
    // radii, as in perturbNative. The reference values' own rounding only
    // scales δ there (covered by the 4|Z||δ| term); it enters the totals at
    // the start, the end and on rebasing, which add it explicitly.
    const check = pass > 0;
    const startRe = real[m0] + sr, startIm = imag[m0] + si;
    const startError = ROUNDING * (magnitude(real[m0], imag[m0]) + magnitude(sr, si));
    let ra = radius0, rb = radius0 * 16, rc = radius0 * 256, rd = radius0 * 4096;
    let m = m0, dr = sr, di = si, Dr = 1, Di = 0;
    for (let k = 0; k < period; k++) {
      const zr = real[m], zi = imag[m], tr = zr + dr, ti = zi + di;
      if (check) {
        // Upper bounds without branches (see TINY_SQUARE): only the rounding uses |Z| and |δ|.
        const ref = SQRT2 * Math.max(Math.abs(zr), Math.abs(zi)), delta = SQRT2 * Math.max(Math.abs(dr), Math.abs(di));
        const twice = 2 * Math.sqrt(tr * tr + ti * ti + TINY_SQUARE), rounding = ROUNDING * (4 * ref * delta + delta * delta) + dcError;
        ra = ra * (twice + ra) + rounding; rb = rb * (twice + rb) + rounding;
        rc = rc * (twice + rc) + rounding; rd = rd * (twice + rd) + rounding;
      }
      const nextD = 2 * (tr * Dr - ti * Di);
      Di = 2 * (tr * Di + ti * Dr); Dr = nextD;
      // δ' = (2Z + δ) δ + dc: four products on a short dependency chain.
      const ur = zr + tr, ui = zi + ti, nextRe = ur * dr - ui * di + dcRe;
      di = ur * di + ui * dr + dcIm; dr = nextRe;
      m++;
      const er = real[m] + dr, ei = imag[m] + di, squared = er * er + ei * ei;
      if (!(squared <= 256)) return spent + k;
      if (squared < dr * dr + di * di || m === end) {
        if (check) {
          const error = ROUNDING * (magnitude(real[m], imag[m]) + magnitude(dr, di));
          ra += error; rb += error; rc += error; rd += error;
        }
        dr = er; di = ei; m = 0;
      }
    }
    spent += period;
    const gr = real[m] + dr - startRe, gi = imag[m] + di - startIm, lambda = magnitude(Dr, Di);
    if (check) {
      const error = ROUNDING * (magnitude(real[m], imag[m]) + magnitude(dr, di));
      const distance = magnitude(gr, gi) + startError + error;
      if (distance + ra < radius0 || distance + rb < radius0 * 16 || distance + rc < radius0 * 256
        || distance + rd < radius0 * 4096) {
        provedCycle.found = true; provedCycle.m = m0; provedCycle.sr = sr; provedCycle.si = si; provedCycle.period = period;
        return -spent;
      }
    }
    // Newton for g(w) = f^P(w) - w: w -= g / (D - 1). Stop on a nearly
    // converged repelling cycle (wrong period, or c outside; within 2^-8 the
    // derivative is that of the cycle) or once steps stop shrinking.
    const ar = Dr - 1, ai = Di, den = ar * ar + ai * ai;
    const stepRe = (gr * ar + gi * ai) / den, stepIm = (gi * ar - gr * ai) / den;
    const step = magnitude(stepRe, stepIm), size = magnitude(startRe, startIm);
    if (!(lambda < 1) && !(step > 2 ** -8 * size)) break;
    if (!(step < previousStep) && pass > 2) break;
    sr -= stepRe; si -= stepIm;
    previousStep = step;
    // Newton converges quadratically: the fixed point lies well within one
    // step of the new w, so the disks start at 4x the step, scaled for |λ|.
    radius0 = lambda < 1 ? 4 * (step + startError + Number.MIN_VALUE) / (1 - lambda) : 0;
  }
  return spent;
}
