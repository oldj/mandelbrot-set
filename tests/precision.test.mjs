import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePrecision, fixedToNumber, initialView, isInitialView, scaledFixed, toFixed, transformView, viewOffset } from '../src/precision.ts';
import { gesture, wheelAnchor, wheelLogFactor } from '../src/gestures.ts';
import { add, extended, linear, logMagnitude, perturbStep, ZERO } from '../src/extended.ts';

const abs = n => n < 0n ? -n : n;
function point(view, anchor, bits = view.bits) {
  return {
    re: (view.re << BigInt(bits - view.bits)) + scaledFixed(anchor.x, view.logScale, bits),
    im: (view.im << BigInt(bits - view.bits)) - scaledFixed(anchor.y, view.logScale, bits),
  };
}
function samePoint(a, b, tolerance = 2n) {
  assert.ok(abs(a.re - b.re) <= tolerance, 'real anchor drift');
  assert.ok(abs(a.im - b.im) <= tolerance, 'imaginary anchor drift');
}

test('exact binary conversion, including scales far below double underflow', () => {
  for (const value of [-2, -0.6, 0, 0.1, Math.PI, 1e-100]) assert.equal(fixedToNumber(toFixed(value, 1024), 1024), value);
  assert.notEqual(scaledFixed(1, -5000, 5200), 0n);
  assert.equal(fixedToNumber(scaledFixed(3.5, -5000, 5200), 5200, -5000), 3.5);
  assert.equal(fixedToNumber(toFixed(Number.MIN_VALUE, 1200), 1200), Number.MIN_VALUE);
});

test('pointer remains fixed through 3000 repeated zooms and precision increases', () => {
  let view = initialView(1200, 800);
  const anchor = { x: 137.25, y: -219.75 };
  for (let i = 0; i < 3000; i++) {
    const next = transformView(view, anchor, anchor, -0.75);
    samePoint(point(view, anchor, next.bits), point(next, anchor));
    view = next;
  }
  assert.ok(view.logScale < -2250);
  assert.ok(view.bits > 2300);
  assert.notEqual(point(view, anchor).re, point(view, { ...anchor, x: anchor.x + 1 }).re);
});

test('deep dragging translates by the requested screen distance without losing the centre', () => {
  let view = ensurePrecision({ ...initialView(800, 600), logScale: -4000 });
  const before = { x: -23.25, y: 41.5 }, after = { x: 97.5, y: -20.25 };
  const next = transformView(view, before, after, 0);
  samePoint(point(view, before), point(next, after));
  const offset = viewOffset(view, next);
  assert.ok(Math.abs(offset.x - (after.x - before.x)) < 1e-10);
  assert.ok(Math.abs(offset.y - (after.y - before.y)) < 1e-10);
});

test('wheel anchors to pointer within canvas and centre outside; delta units agree', () => {
  const rect = { left: 10, top: 20, right: 810, bottom: 620, width: 800, height: 600 };
  assert.deepEqual(wheelAnchor(710, 220, rect), { x: 300, y: -100 });
  for (const [x, y] of [[0, 100], [100, 0], [900, 100], [100, 700]]) assert.deepEqual(wheelAnchor(x, y, rect), { x: 0, y: 0 });
  const view = initialView(800, 600), anchor = wheelAnchor(-1, -1, rect);
  const next = transformView(view, anchor, anchor, -1);
  samePoint(point(view, anchor, next.bits), point(next, anchor));
  assert.equal(wheelLogFactor(16, 0, 600), wheelLogFactor(1, 1, 600));
  assert.equal(wheelLogFactor(300, 0, 600), wheelLogFactor(0.5, 2, 600));
});

test('two-finger pinch and simultaneous pan keep both fingers over their original points', () => {
  const view = ensurePrecision({ ...initialView(800, 600), logScale: -1500 });
  const oldPoints = [{ x: -100, y: -30 }, { x: 100, y: 30 }];
  const newPoints = oldPoints.map(p => ({ x: p.x * 2 + 23, y: p.y * 2 - 47 }));
  const a = gesture(oldPoints), b = gesture(newPoints);
  const next = transformView(view, a.centre, b.centre, Math.log2(a.distance / b.distance));
  for (let i = 0; i < 2; i++) samePoint(point(view, oldPoints[i], next.bits), point(next, newPoints[i]));
  const single = gesture([newPoints[1]]);
  const dragged = transformView(next, single.centre, { x: single.centre.x + 10, y: single.centre.y }, 0);
  samePoint(point(next, single.centre, dragged.bits), point(dragged, { x: single.centre.x + 10, y: single.centre.y }));
  assert.equal(gesture([]), undefined);
});

test('extended exponent preserves perturbations below 1e-1000', () => {
  const delta = extended(1, 0.5, -4000);
  assert.ok(Math.abs(logMagnitude(delta) + 4000 - Math.log2(Math.hypot(1, 0.5))) < 1e-10);
  const result = perturbStep(extended(2), delta, delta);
  const expected = extended(5, 2.5, -4000);
  assert.ok(Math.abs(logMagnitude(result) - logMagnitude(expected)) < 1e-10);
  assert.equal(add(delta, extended(-1, -0.5, -4000)).re, 0);
  assert.equal(logMagnitude(linear(extended(1), delta, ZERO, extended(1))), logMagnitude(delta));
});

test('extended normalization keeps subnormal doubles finite', () => {
  assert.deepEqual(extended(Number.MIN_VALUE), { re: 1, im: 0, exp: -1074 });
  assert.deepEqual(extended(3 * 2 ** -1070, -(2 ** -1072)), { re: 1.5, im: -0.125, exp: -1069 });
  assert.deepEqual(add({ re: 1, im: 0, exp: -1000 }, { re: -(1 - 2 ** -52), im: 0, exp: -1000 }), { re: 1, im: 0, exp: -1052 });
});

test('the default view is recognised exactly, even at higher stored precision', () => {
  const view = initialView(800, 600);
  assert.ok(isInitialView(view, 800, 600));
  assert.ok(isInitialView({ ...view, re: view.re << 448n, im: view.im << 448n, bits: 640 }, 800, 600));
  assert.ok(!isInitialView(transformView(view, { x: 0, y: 0 }, { x: 0.01, y: 0 }, 0), 800, 600), 'a tiny pan counts');
  assert.ok(!isInitialView(transformView(view, { x: 0, y: 0 }, { x: 0, y: 0 }, -0.01), 800, 600), 'a tiny zoom counts');
  assert.ok(!isInitialView(view, 800, 700), 'a window with another fitting scale has a different default');
});
