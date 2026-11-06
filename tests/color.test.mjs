import test from 'node:test';
import assert from 'node:assert/strict';
import { color, COLOR_PERIOD, createSampler, INTERIOR, iterationBudget } from '../src/fractal.ts';
import { ensurePrecision, initialView } from '../src/precision.ts';

function rgb(value) {
  const pixel = new Uint8ClampedArray(4);
  color(value, pixel, 0);
  assert.equal(pixel[3], 255);
  return [...pixel.slice(0, 3)];
}

test('escape colors repeat without losing local contrast at high iteration counts', () => {
  for (const base of [0, 1024, 65536, 2 ** 30]) {
    assert.deepEqual(rgb(base + 3.5), rgb(3.5));
    const colors = Array.from({ length: COLOR_PERIOD }, (_, i) => rgb(base + i));
    assert.ok(new Set(colors.map(c => c.join(','))).size >= 60);
    assert.ok(colors.some(c => c.every(channel => channel > 200)));
  }
  assert.deepEqual(rgb(INTERIOR), [0, 0, 0]);
});

test('smooth escape colors stay continuous across the cycle seam', () => {
  const before = rgb(COLOR_PERIOD - 0.0001), after = rgb(COLOR_PERIOD + 0.0001);
  assert.ok(before.every((channel, i) => Math.abs(channel - after[i]) <= 1));
});

test('reported 1.50e47 view has escaping detail and a broad range of visible colors', async () => {
  const initial = initialView(1280, 800);
  const view = ensurePrecision({ ...initial, logScale: initial.logScale - Math.log2(1.5e47) });
  // Parse the supplied decimal strings without losing digits through Number.
  const decimal = text => {
    const [whole, fraction] = text.split('.');
    return BigInt(whole + fraction) * (1n << BigInt(view.bits)) / 10n ** BigInt(fraction.length);
  };
  view.re = decimal('-0.69378820112974505918001981502679506278690352790793731');
  view.im = decimal('-0.34952527748216184476632029598345669714154984468763950');
  const sampler = await createSampler(view, 1280, 800, iterationBudget(view.logScale), async () => {});
  const colors = [];
  for (let y = -360; y < 400; y += 80) for (let x = -600; x < 640; x += 80) {
    const value = sampler.sample(x, y);
    assert.ok(value > 0, 'these points escape within the existing iteration budget');
    colors.push(rgb(value));
  }
  assert.ok(new Set(colors.map(c => c.join(','))).size > 100);
  assert.ok(colors.filter(c => c.every(channel => channel > 180)).length > 10);
});
