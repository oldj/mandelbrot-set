import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampler, directDouble, directFixed, iterationBudget } from '../src/fractal.ts';
import { ensurePrecision, scaledFixed, toFixed, transformView } from '../src/precision.ts';

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

for (const depth of [-45, -100, -400, -1100, -2000]) {
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
  for (const depth of [-42, -60]) {
    const view = viewAt(-0.743643887037151, 0.13182590420533, depth);
    const sampler = await createSampler(view, 100, 100, 5000, noop);
    for (let j = 0; j < 50; j++) {
      const x = (j * 73 % 100) - 50, y = (j * 37 % 100) - 50;
      close(sampler.sample(x, y), oracle(view, x, y, 5000));
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
