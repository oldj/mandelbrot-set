import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampler, directDouble, directFixed, iterationBudget, lastDistance, directRow, INTERIOR } from '../src/fractal/index.ts';
import { ensurePrecision, scaledFixed, toFixed, transformView } from '../src/math/precision.ts';

const noop = async () => {};
function viewAt(re, im, logScale) {
  const view = ensurePrecision({ re: 0n, im: 0n, bits: 128, logScale });
  view.re = toFixed(re, view.bits); view.im = toFixed(im, view.bits);
  return view;
}
function oracle(view, x, y, limit) {
  // Extra 64 bits make this independent of the renderer's working precision.
  const bits = view.bits + 64;
  return directFixed((view.re << 64n) + scaledFixed(x, view.logScale, bits),
    (view.im << 64n) - scaledFixed(y, view.logScale, bits), bits, limit);
}
function close(actual, expected, tolerance = 0.001) {
  assert.equal(actual < 0, expected < 0, `classification: ${actual} vs ${expected}`);
  assert.ok(Math.abs(actual - expected) < tolerance, `escape value: ${actual} vs ${expected}`);
}

test('known interior/exterior points and conjugate symmetry', () => {
  for (const [r, i] of [[0, 0], [-1, 0], [0.2, 0]]) assert.equal(directDouble(r, i, 1024), -1);
  for (const [r, i] of [[1, 0], [-2.1, 0], [0, 2], [-0.75, 0.2]]) {
    assert.ok(directDouble(r, i, 1024) > 0);
    assert.equal(directDouble(r, i, 1024), directDouble(r, -i, 1024));
  }
});

for (const depth of [-45, -100, -400, -800, -899, -1100, -2000]) {
  test(`perturbation at 2^${depth} agrees with BigInt and resolves adjacent pixels`, async () => {
    const view = viewAt(-2, 0, depth), limit = 2048;
    const sampler = await createSampler(view, 32, 24, limit, noop);
    for (const x of [-15, -4, -0.5, 0.5, 4, 15]) {
      for (const y of [-10, -0.5, 0, 0.5, 10]) close(sampler.sample(x, y), oracle(view, x, y, limit), 1e-6);
    }
    assert.notEqual(sampler.sample(-4, 0.5), sampler.sample(-5, 0.5));
    if (depth < -100) assert.ok(sampler.stats.skipped > 0);
  });
}

test('non-real, high-iteration seahorse boundary matches high precision', async () => {
  // Here the exact escape count itself changes by tens to hundreds of
  // iterations within 1e-3 pixel, so a sample must match the oracle to 1e-3
  // or lie within the oracle's own variation across a 1e-3 pixel shift.
  for (const depth of [-42, -60]) {
    const view = viewAt(-0.743643887037151, 0.13182590420533, depth);
    const sampler = await createSampler(view, 100, 100, 5000, noop);
    for (let j = 0; j < 50; j++) {
      const x = (j * 73 % 100) - 50, y = (j * 37 % 100) - 50;
      const expected = oracle(view, x, y, 5000), actual = sampler.sample(x, y);
      const shifted = [[1e-3, 0], [-1e-3, 0], [0, 1e-3], [0, -1e-3]].map(([dx, dy]) => oracle(view, x + dx, y + dy, 5000));
      const spread = Math.max(1e-3, ...shifted.map(value => (value < 0) === (expected < 0) ? Math.abs(value - expected) : Infinity));
      close(actual, expected, spread);
    }
  }
});

test('extreme depth near a non-real periodic reference', async () => {
  const view = viewAt(0, 1, -1200);
  const sampler = await createSampler(view, 32, 24, 3000, noop);
  for (const x of [-7, -0.5, 0.5, 7]) for (const y of [-3, 0, 3]) close(sampler.sample(x, y), oracle(view, x, y, 3000), 1e-5);
});

test('reference reuse across pan/zoom preserves coordinates; precision change invalidates it', async () => {
  const view = viewAt(-2, 0, -1200), cache = {};
  await createSampler(view, 80, 60, 2048, noop, cache);
  const reference = cache.entry.reference;
  const moved = transformView(view, { x: 0, y: 0 }, { x: 4, y: -7 }, -0.5);
  const sampler = await createSampler(moved, 80, 60, 2048, noop, cache);
  assert.equal(cache.entry.reference, reference);
  for (const x of [-20, 0, 20]) close(sampler.sample(x, 3), oracle(moved, x, 3, 2048), 1e-5);
  const deeper = transformView(moved, { x: 0, y: 0 }, { x: 0, y: 0 }, -100);
  await createSampler(deeper, 80, 60, 2048, noop, cache);
  assert.notEqual(cache.entry.reference, reference);
});

test('reference generation cooperates with cancellation', async () => {
  const cancelled = new Error('cancelled');
  let calls = 0;
  await assert.rejects(createSampler(viewAt(-2, 0, -1000), 80, 60, 10000, async () => {
    if (++calls === 3) throw cancelled;
  }), error => error === cancelled);
  assert.equal(calls, 3);
});

test('iteration budget increases with depth', () => {
  assert.ok(iterationBudget(-1000) > iterationBudget(-100));
  assert.ok(iterationBudget(-100) > iterationBudget(-10));
});

test('exact periodicity shortcut agrees with BigInt around a period-three bulb', () => {
  for (const dx of [-0.03, -0.01, 0, 0.01, 0.03]) for (const dy of [-0.03, 0, 0.03]) {
    const re = -0.122561166876 + dx, im = 0.744861766619 + dy;
    close(directDouble(re, im, 8192), directFixed(toFixed(re, 256), toFixed(im, 256), 256, 8192), 1e-4);
  }
});

test('zooming far into an off-centre point rebuilds a reference even when precision bits are unchanged', async () => {
  // Bits never shrink after zooming out, so a shallow reference must not be
  // reused at a much finer scale where pixel deltas vanish beside its offset.
  for (const depth of [-40, -300]) {
    const view = ensurePrecision({ re: 0n, im: 0n, bits: 640, logScale: -45 });
    view.re = toFixed(-2, view.bits) + scaledFixed(40, -45, view.bits);
    const cache = {};
    await createSampler(view, 100, 100, 3000, noop, cache);
    const reference = cache.entry.reference;
    const zoomed = transformView(view, { x: -40, y: 0 }, { x: -40, y: 0 }, depth);
    assert.equal(zoomed.bits, view.bits);
    const sampler = await createSampler(zoomed, 100, 100, 3000, noop, cache);
    assert.notEqual(cache.entry.reference, reference);
    for (let j = 0; j < 20; j++) {
      const x = (j * 73 % 100) - 50, y = (j * 37 % 100) - 50;
      close(sampler.sample(x, y), oracle(zoomed, x, y, 3000), 1e-6);
    }
  }
});


/** Nucleus of the period-p component near c, by Newton's method in fixed point. */
/** A minibrot's centre by Newton on f^period(0) = 0, from a seed given as a double or as fixed point. */
function nucleus(re, im, period, bits, steps = 64) {
  const B = BigInt(bits), one = 1n << B;
  let cr = typeof re === 'bigint' ? re : toFixed(re, bits), ci = typeof im === 'bigint' ? im : toFixed(im, bits);
  for (let step = 0; step < steps; step++) {
    let zr = 0n, zi = 0n, dr = 0n, di = 0n;
    for (let n = 0; n < period; n++) {
      const ndr = ((2n * (zr * dr - zi * di)) >> B) + one, ndi = (2n * (zr * di + zi * dr)) >> B;
      const r2 = (zr * zr) >> B, i2 = (zi * zi) >> B;
      zi = ((2n * zr * zi) >> B) + ci; zr = r2 - i2 + cr; dr = ndr; di = ndi;
    }
    const den = (dr * dr + di * di) >> B;
    const sr = (((zr * dr + zi * di) >> B) << B) / den, si = (((zi * dr - zr * di) >> B) << B) / den;
    cr -= sr; ci -= si;
    if (sr === 0n && si === 0n) break;
  }
  return { re: cr, im: ci };
}

test('three-lane rows are bit-identical to directDouble, including proven interiors', () => {
  const views = [[-0.6, 0, 3.4 / 256, 1024], [-0.122561166876, 0.744861766619, 2 ** -12, 1024], [-0.7436438870371587, 0.13182590420531197, 2 ** -30, 4096],
    [-1.25, 0, 2 ** -12, 4096], [-0.75, 0.05, 2 ** -14, 4096], [0.25, 0, 2 ** -16, 4096]];
  for (const [cx, cy, scale, limit] of views) {
    // Cycles proved in one row seed the next ones; results must not depend on that.
    const hint = { found: false, re: 0, im: 0, period: 0, successes: 0, failures: 0, skipped: 0 };
    const xs = new Float64Array(97), out = new Float64Array(97);
    for (let j = 0; j < 24; j++) {
      const ci = cy + (j - 12) * scale * 5;
      for (let i = 0; i < xs.length; i++) xs[i] = cx + (i - 48) * scale;
      const distances = new Float64Array(97);
      directRow(xs, ci, xs.length, limit, out, distances, scale, hint);
      for (let i = 0; i < xs.length; i++) {
        const value = directDouble(xs[i], ci, limit, scale), distance = value === INTERIOR ? NaN : lastDistance();
        assert.ok(Object.is(out[i], value), `${cx},${cy} row ${j} col ${i}`);
        assert.ok(Object.is(distances[i], distance), `distance ${cx},${cy} row ${j} col ${i}: ${distances[i]} vs ${distance}`);
      }
    }
  }
});

test('interior proofs are sound against a four times larger BigInt budget', async () => {
  const p3 = nucleus(-1.7548776662466927, 0, 3, 1216);
  const cases = [
    [ensurePrecision({ re: p3.re, im: p3.im, bits: 1216, logScale: -60 }), 2560],
    [ensurePrecision({ re: p3.re, im: p3.im, bits: 1216, logScale: -1000 }), 32768],
    [viewAt(-0.75, 0, -40), 8192], [viewAt(-1.25, 0, -40), 8192],
  ];
  for (const [view, limit] of cases) {
    const sampler = await createSampler(view, 64, 48, limit, noop);
    let proven = 0;
    for (let k = 0; k < 16; k++) {
      const x = (k * 37 % 64) - 32 + 0.31, y = (k * 23 % 48) - 24 + 0.17;
      const before = sampler.stats.unresolved;
      const value = sampler.sample(x, y);
      if (value === INTERIOR && sampler.stats.unresolved === before) {
        proven++;
        assert.equal(oracle(view, x, y, limit * 4), INTERIOR, `proof at ${x},${y}`);
      }
    }
    assert.ok(proven > 0, 'some interior samples are proved');
  }
});

test('deep minibrot interiors are proved instead of iterating the whole budget', async () => {
  const p3 = nucleus(-1.7548776662466927, 0, 3, 1216);
  const view = ensurePrecision({ re: p3.re, im: p3.im, bits: 1216, logScale: -1000 });
  const sampler = await createSampler(view, 64, 48, 32768, noop);
  const started = performance.now();
  for (let k = 0; k < 24; k++) assert.equal(sampler.sample((k % 6) * 10 - 25, Math.floor(k / 6) * 10 - 15), INTERIOR);
  assert.equal(sampler.stats.unresolved, 0);
  assert.ok(performance.now() - started < 1000, 'running 32768 extended iterations per sample would take far longer');
});

test('long-period minibrot interiors below 2^-900 are proved, and proved samples never escape', async () => {
  // A period-250 minibrot near c = -2, about 2^-994 across. At its nucleus
  // the reference orbit itself returns to |z| ~ 2^-700 every lap, and with δ
  // far smaller still, BLA blocks step right over those returns: proofs must
  // look at the end of blocks too, or every interior sample runs its budget.
  const bits = 1408, one = 1n << BigInt(bits);
  const centre = nucleus(-2n * one + (one >> 500n), 0n, 250, bits, 400);
  const inside = ensurePrecision({ ...centre, bits, logScale: -1204 });
  const limit = iterationBudget(inside.logScale);
  let sampler = await createSampler(inside, 64, 48, limit, noop);
  for (let k = 0; k < 24; k++) assert.equal(sampler.sample((k % 6) * 10 - 25, Math.floor(k / 6) * 10 - 15), INTERIOR);
  assert.equal(sampler.stats.unresolved, 0, 'all proved, none left at the budget');
  // The whole minibrot: near its edge orbits settle slowly (Newton on rough returns), and
  // neighbours seed each other's proofs. Proved samples stay bounded for four times the budget.
  const whole = ensurePrecision({ ...centre, bits, logScale: -998 });
  sampler = await createSampler(whole, 64, 48, iterationBudget(whole.logScale), noop);
  let proved = 0, escaped = 0;
  const edge = [];
  for (let y = -6.5; y < 7; y += 1.5) for (let x = -12.25; x < 12; x += 1.5) {
    const before = sampler.stats.unresolved, value = sampler.sample(x, y);
    if (value !== INTERIOR) { escaped++; continue; }
    if (sampler.stats.unresolved === before) { proved++; if (Math.abs(x) > 3 || Math.abs(y) > 3) edge.push([x, y]); }
  }
  assert.ok(proved > 20 && escaped > 50, `samples on both sides (${proved} proved, ${escaped} escaped)`);
  for (const [x, y] of edge.slice(0, 3)) assert.equal(oracle(whole, x, y, iterationBudget(whole.logScale) * 4), INTERIOR, `proof at ${x},${y}`);
});

test('below 2^-900, proofs whose radii fit doubles run in doubles, and stay sound', async () => {
  // A period-226 minibrot near c = -2, about 2^-898 across, seen whole at 2^-905. Its edge samples'
  // deltas and proof radii lie well inside double range (unlike a nucleus 2^-994 across, whose
  // returns come within 2^-1000 of 0), so their steps and proofs run in perturbExtended's double
  // paths: thousands of proof steps here, and dozens of hopeless proofs given up early.
  const bits = 1408, one = 1n << BigInt(bits);
  const view = ensurePrecision({ ...nucleus(-2n * one + (one >> 452n), 0n, 226, bits, 400), bits, logScale: -905 });
  const limit = iterationBudget(view.logScale), sampler = await createSampler(view, 32, 24, limit, noop);
  const values = new Map(), proved = new Set();
  for (let j = 0; j < 24; j++) for (let i = 0; i < 32; i++) {
    const before = sampler.stats.unresolved, value = sampler.sample((i - 16) * 8, (j - 12) * 8);
    values.set(`${i},${j}`, value);
    if (value === INTERIOR && sampler.stats.unresolved === before) proved.add(`${i},${j}`);
  }
  const escaped = [...values.values()].filter(value => value !== INTERIOR).length;
  assert.ok(proved.size > 200 && escaped > 300, `samples on both sides (${proved.size} proved, ${escaped} escaped)`);
  // Proved samples beside an escaping one stay bounded for four times the budget.
  const edge = [...proved].filter(key => {
    const [i, j] = key.split(',').map(Number);
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => (values.get(`${i + di},${j + dj}`) ?? INTERIOR) !== INTERIOR);
  });
  assert.ok(edge.length > 20);
  for (const key of edge.filter((_, k) => k % 10 === 0)) {
    const [i, j] = key.split(',').map(Number);
    assert.equal(oracle(view, (i - 16) * 8, (j - 12) * 8, limit * 4), INTERIOR, `proof at ${key}`);
  }
  // Escaping samples agree with BigInt.
  for (const [i, j] of [[0, 0], [3, 20], [28, 5], [31, 23]]) {
    assert.notEqual(values.get(`${i},${j}`), INTERIOR);
    close(values.get(`${i},${j}`), oracle(view, (i - 16) * 8, (j - 12) * 8, limit), 1e-6);
  }
});

test('a collapsing orbit below 2^-900 never proves an escaping sample interior', async () => {
  // Near c = -2, a real minibrot centre of period 649 whose critical orbit dives below 2^-13 at
  // step 624 and reaches 0 at 649. View B reuses view A's reference (2^14 shallower), as the app's
  // cache allows; there its pixels see two consecutive collapses of |z| as single steps. A proof
  // started on a collapse once took its distance to the base as infinite, so every radius was
  // infinite and the final check passed vacuously: these escaping samples came back INTERIOR.
  const bits = 1408;
  const a = { re: -(2n << BigInt(bits)) + 0x5eb852308d51b6c7b300bbe3d570c567c9549aca6cb39dbeccdn, im: 0n, bits, logScale: -1263.0000847945885 };
  const b = { ...a, re: a.re - 22835963083295358096932575511191922182123945984n, logScale: -1277.0000847945885 };
  const limit = 41472, cache = {};
  await createSampler(a, 960, 600, limit, noop, cache);
  const reference = cache.entry;
  const sampler = await createSampler(b, 960, 600, limit, noop, cache);
  assert.equal(cache.entry, reference, 'the reference is reused');
  for (const [x, y] of [[3, 0.5], [-2, -6], [7.5, 2]]) close(sampler.sample(x, y), oracle(b, x, y, limit), 1e-6);
});

test('extended-exponent proofs seeded by a neighbour do not depend on the order pixels are sampled in', async () => {
  const bits = 1408, one = 1n << BigInt(bits);
  const view = ensurePrecision({ ...nucleus(-2n * one + (one >> 500n), 0n, 250, bits, 400), bits, logScale: -998 });
  const xs = Array.from({ length: 40 }, (_, i) => -19.7 + i * 1.01);
  const run = async order => {
    const sampler = await createSampler(view, 64, 48, iterationBudget(view.logScale), noop);
    const results = new Map();
    for (const x of order) results.set(x, [sampler.sample(x, 0.35), lastDistance()]);
    return xs.map(x => results.get(x));
  };
  const forwards = await run(xs), backwards = await run([...xs].reverse());
  forwards.forEach((result, i) => {
    assert.ok(Object.is(result[0], backwards[i][0]) && Object.is(result[1], backwards[i][1]), `x = ${xs[i]}`);
  });
  const interior = forwards.filter(([value]) => value === INTERIOR).length;
  assert.ok(interior > 5 && interior < xs.length - 5, `both sides of the boundary (${interior} interior)`);
});

/**
 * Distance estimate |z| ln|z| / |dz/dc| in pixels, with z in fixed point and
 * dz/dc in doubles with a separate exponent (it reaches 2^2000 here).
 */
function oracleDistance(view, x, y, limit) {
  const bits = view.bits + 64, B = BigInt(bits);
  const cr = (view.re << 64n) + scaledFixed(x, view.logScale, bits), ci = (view.im << 64n) - scaledFixed(y, view.logScale, bits);
  const number = v => Number(v >> (B - 60n)) / 2 ** 60;
  let re = 0n, im = 0n, dr = 0, di = 0, exp = 0;
  for (let n = 1; n <= limit; n++) {
    const zr = number(re), zi = number(im), next = 2 * (zr * dr - zi * di) + 2 ** -exp;
    di = 2 * (zr * di + zi * dr); dr = next;
    if (Math.abs(dr) + Math.abs(di) > 2 ** 256) { dr *= 2 ** -256; di *= 2 ** -256; exp += 256; }
    const r2 = re * re, i2 = im * im;
    im = ((2n * re * im) >> B) + ci; re = ((r2 - i2) >> B) + cr;
    const magnitude = Math.hypot(number(re), number(im));
    if (magnitude > 16) return 2 ** (Math.log2(magnitude * Math.log(magnitude)) - Math.log2(Math.hypot(dr, di)) - exp - view.logScale);
  }
  return NaN;
}

test('distance estimates agree with a high-precision derivative at every depth, through BLA skips', async () => {
  const cases = [[viewAt(-0.743643887037151, 0.13182590420533, -30), 5000], [viewAt(-0.743643887037151, 0.13182590420533, -60), 5000],
    ...[-100, -400, -899, -1100, -2000].map(depth => [viewAt(-2, 0, depth), 2048])];
  for (const [view, limit] of cases) {
    const sampler = await createSampler(view, 32, 24, limit, noop);
    let checked = 0;
    for (const x of [-15, -4, -0.5, 0.5, 4, 15]) for (const y of [-10, -0.5, 0.5, 10]) {
      const value = sampler.sample(x, y), distance = lastDistance();
      if (value === INTERIOR) { assert.ok(Number.isNaN(distance)); continue; }
      // Within ~1e-3 pixel of the boundary the orbit is too sensitive for any
      // double-precision z to follow; all such pixels get the full outline anyway.
      const expected = oracleDistance(view, x, y, limit);
      if (expected < 1e-3) assert.ok(distance < 1e-2, `2^${view.logScale} at ${x},${y}: ${distance} vs ${expected}`);
      else assert.ok(Math.abs(distance / expected - 1) < 1e-3, `2^${view.logScale} at ${x},${y}: ${distance} vs ${expected}`);
      checked++;
    }
    assert.ok(checked > 12, `escaping samples at 2^${view.logScale}`);
    if (view.logScale < -100) assert.ok(sampler.stats.skipped > 0);
  }
});

test('slowly settling interiors are proved by their attracting cycle, soundly, near the component boundary', async () => {
  // A period-844 component near a period-211 minibrot at 4.17e13: each lap
  // brings orbits only ~12% closer to the cycle, so close returns take
  // 35 000-140 000 iterations. Newton on f^P finds the cycle point first.
  const { parseViewHash } = await import('../src/ui/url-state.ts');
  const { initialView } = await import('../src/math/precision.ts');
  const view = parseViewHash('#re=-0.73088326955313741591&im=0.24781738096196057252&zoom=4.171992716e13', initialView(1280, 800).logScale);
  const limit = 20000, sampler = await createSampler(view, 1280, 800, limit, noop);
  for (const [x, y] of [[-360, -216], [-552, -312], [-632, -392], [-88, -40]]) {
    assert.equal(sampler.sample(x, y), INTERIOR, `${x},${y}`);
  }
  assert.equal(sampler.stats.unresolved, 0, 'proved well within a budget their orbits need many times over');
  // Across the component and its boundary, every proved sample stays bounded for four times the budget.
  let proven = 0, escaped = 0;
  for (let k = 0; k < 40; k++) {
    const x = (k * 37 % 40) * 32 - 620 + 0.29, y = (k * 23 % 25) * 32 - 390 + 0.41;
    const before = sampler.stats.unresolved, value = sampler.sample(x, y);
    if (value !== INTERIOR) { escaped++; continue; }
    if (sampler.stats.unresolved !== before) continue;
    if (proven++ < 6) assert.equal(oracle(view, x, y, limit * 4), INTERIOR, `proof at ${x},${y}`);
  }
  assert.ok(proven > 10 && escaped >= 4, `samples on both sides (${proven} proved, ${escaped} escaped)`);
});

test('interior proofs seeded by a neighbour\'s cycle do not depend on the order pixels are sampled in', async () => {
  // Each proved pixel hands its cycle point to the next; a proof from any start is valid, and a failed
  // one falls back to iterating, so every result must be identical forwards and backwards.
  const { parseViewHash } = await import('../src/ui/url-state.ts');
  const { initialView } = await import('../src/math/precision.ts');
  const view = parseViewHash('#re=-0.73088326955313741591&im=0.24781738096196057252&zoom=4.171992716e13', initialView(1280, 800).logScale);
  const xs = Array.from({ length: 64 }, (_, i) => -630 + i * 19.9);
  const run = async order => {
    const sampler = await createSampler(view, 1280, 800, 20000, noop);
    const results = new Map();
    for (const x of order) results.set(x, [sampler.sample(x, -216), lastDistance()]);
    return { values: xs.map(x => results.get(x)), unresolved: sampler.stats.unresolved };
  };
  const forwards = await run(xs), backwards = await run([...xs].reverse());
  forwards.values.forEach((result, i) => {
    assert.ok(Object.is(result[0], backwards.values[i][0]) && Object.is(result[1], backwards.values[i][1]), `x = ${xs[i]}`);
  });
  const interior = forwards.values.filter(([value]) => value === INTERIOR).length;
  assert.ok(interior > 10 && interior < xs.length - 5, `both sides of the boundary (${interior} interior)`);
  assert.ok(forwards.unresolved < interior / 2, `most interior samples are proved (${forwards.unresolved} of ${interior} unresolved)`);
});

test('rows prove interiors near a bulb root from attracting cycles, still identical to directDouble', () => {
  // Just inside the period-3 bulb near its root on the main cardioid, orbits creep towards their cycle
  // (|λ| close to 1), so close returns, and with them disk proofs, come late or never within the budget.
  const cx = -0.125, cy = 0.649519052838329, scale = 2 ** -16, limit = 4096, n = 97;
  const xs = new Float64Array(n), out = new Float64Array(n), distances = new Float64Array(n);
  const hint = { found: false, re: 0, im: 0, period: 0, successes: 0, failures: 0, skipped: 0 };
  let unresolved = 0, interior = 0;
  for (let j = 0; j < 24; j++) {
    const ci = cy + (j - 12) * scale * 4;
    for (let i = 0; i < n; i++) xs[i] = cx + (i - 48) * scale * 4;
    unresolved += directRow(xs, ci, n, limit, out, distances, scale, hint);
    for (let i = 0; i < n; i++) {
      const value = directDouble(xs[i], ci, limit, scale);
      // A wrong proof would turn a pixel that escapes within the budget into INTERIOR.
      assert.ok(Object.is(out[i], value), `row ${j} col ${i}: ${out[i]} vs ${value}`);
      if (value === INTERIOR) interior++;
    }
  }
  assert.ok(interior > 2000, `mostly interior (${interior})`);
  // Waiting for close returns alone leaves about 1000 of these unresolved at this budget.
  assert.ok(unresolved < 150, `proved rather than unresolved (${unresolved} unresolved)`);
  assert.ok(hint.successes > 0, 'neighbouring pixels reuse proved cycles');
});

test('BLA blocks do not drift on orbits that linger near repelling cycles', async () => {
  // A seahorse valley at 1.9e12: escaping orbits linger near weakly repelling cycles for thousands of
  // steps, where every block's error is amplified. With blocks valid while |δ| < 2^-36 |2Z|, 25 of these
  // 4280 samples were wrong against BigInt (inside instead of escaping, or off by more than half an
  // iteration); at 2^-40, 3: the same 3 as with no BLA at all, double precision's own floor here.
  const { parseViewHash } = await import('../src/ui/url-state.ts');
  const { initialView } = await import('../src/math/precision.ts');
  const W = 640, H = 257, limit = 2560;
  const view = parseViewHash('re=-0.7436438870371700355&im=0.1318259042052868754&zoom=1.906544542e12', initialView(W, H).logScale);
  const sampler = await createSampler(view, W, H, limit, noop);
  let wrong = 0;
  for (let y = 60; y < 200; y += 7) for (let x = 0; x < W; x += 3) {
    const sx = x + 0.5 - W / 2, sy = y + 0.5 - H / 2, value = sampler.sample(sx, sy), exact = oracle(view, sx, sy, limit);
    if ((value < 0) !== (exact < 0) || (exact >= 0 && Math.abs(value - exact) > 0.5)) wrong++;
  }
  assert.ok(wrong <= 8, `${wrong} of 4280 samples wrong against BigInt`);
});
