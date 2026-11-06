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

test('each fixed 128-iteration window retains a full palette at every deep count', () => {
  assert.equal(COLOR_PERIOD, 128);
  for (const base of [512, 999.25, 16384, 65536, 2 ** 30, 2 ** 40]) {
    assert.deepEqual(rgb(base + COLOR_PERIOD), rgb(base));
    // Deliberately use a fixed-size local window rather than scaling the test
    // window to COLOR_PERIOD: the previous 8576-period mapping hid this bug.
    const colors = Array.from({ length: 256 }, (_, i) => rgb(base + i / 2));
    assert.ok(new Set(colors.map(c => c.join(','))).size > 200);
    assert.ok(colors.some(c => c.every(channel => channel > 225)));
    assert.ok(colors.some(([r, g, b]) => r < 40 && g < 90 && b > 120));
    assert.ok(colors.some(([r, g, b]) => r > 230 && g > 150 && b < 100));
    const luminance = colors.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b).sort((a, b) => a - b);
    assert.ok(luminance[243] - luminance[12] > 160);
  }
  assert.deepEqual(rgb(INTERIOR), [0, 0, 0]);
});

test('smooth escape colors stay continuous across the cycle seam', () => {
  // Includes the nonlinear-to-linear transition, all colour stops and wraps.
  for (let value = 0.001; value < 512 + 2 * COLOR_PERIOD; value += 0.5) {
    const before = rgb(value - 0.001), after = rgb(value + 0.001);
    assert.ok(before.every((channel, i) => Math.abs(channel - after[i]) <= 1));
  }
});

test('low-iteration hues match measured smooth areas in the supplied GIF', () => {
  // Medians from frames 0–80. Tolerance covers GIF quantization, supersampling
  // and small differences in viewport alignment; this is not a pixel clone.
  for (const [value, expected] of [
    [2, [14, 51, 149]], [8, [14, 63, 168]], [36, [74, 150, 218]],
    [64, [132, 205, 244]], [100, [195, 235, 249]], [140, [240, 242, 233]],
  ]) assert.ok(rgb(value).every((channel, i) => Math.abs(channel - expected[i]) <= 18));
});

test('golden palette retains neutral highlights and saturated warm bands', () => {
  assert.deepEqual(rgb(140), [249, 253, 239]);
  const cycle = Array.from({ length: 1024 }, (_, i) => rgb(512 + i / 8));
  for (const expected of [[249, 229, 96], [249, 181, 15], [134, 32, 13], [14, 3, 65]]) {
    assert.ok(cycle.some(pixel => pixel.every((channel, i) => Math.abs(channel - expected[i]) <= 3)));
  }
});

test('negative smooth escape counts outside the set are not painted as interior', () => {
  assert.deepEqual(rgb(-2), rgb(0));
  assert.deepEqual(rgb(-0.25), rgb(0));
  assert.notDeepEqual(rgb(0), rgb(INTERIOR));
});

test('transition joins do not introduce abrupt color jumps', () => {
  for (const boundary of [144, 512]) {
    const left = rgb(boundary - 0.0001), right = rgb(boundary + 0.0001);
    assert.ok(left.every((channel, i) => Math.abs(channel - right[i]) <= 1));
  }
});

test('reported 1.50e47 view spans bright, blue and golden bands rather than one hue', async () => {
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
  const luminance = colors.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b).sort((a, b) => a - b);
  assert.ok(luminance.at(-1) - luminance[0] > 180);
  assert.ok(luminance[Math.floor(luminance.length * 0.9)] - luminance[Math.floor(luminance.length * 0.1)] > 100);
  assert.ok(colors.some(c => c.every(channel => channel > 200)));
  assert.ok(colors.some(([r, g, b]) => r < 70 && b > 120));
  assert.ok(colors.some(([r, g, b]) => r > 220 && g > 150 && b < 120));
});
