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

test('colours follow the animation at every depth it reaches', () => {
  // Medians of flat (unblended) pixels over all 475 frames of
  // Mandelbrot_sequence_new.gif, each frame at its fitted view, paired with
  // the escape count there: from the first, shallow frame to the deepest.
  for (const [value, expected] of [
    [2.6, [14, 50, 149]], [7.8, [14, 63, 168]], [35.4, [73, 148, 217]], [62.4, [130, 203, 244]], [97, [189, 235, 254]],
    [136.9, [237, 252, 254]], [243.3, [248, 231, 108]], [390, [247, 167, 9]], [663.1, [128, 29, 14]], [882.3, [36, 3, 45]],
    [1270.9, [15, 66, 173]], [2011.7, [248, 252, 236]], [2955.2, [217, 109, 3]], [5962.2, [248, 251, 224]],
    [7922.2, [148, 43, 9]], [10939.3, [144, 212, 248]], [16937, [14, 45, 140]], [25042.1, [26, 3, 52]],
  ]) assert.ok(rgb(value).every((channel, i) => Math.abs(channel - expected[i]) <= 8), `${value}: ${rgb(value)} vs ${expected}`);
});

test('the generator\'s ten stops sit at evenly spaced laps of sqrt(n + 4) / 32', () => {
  const stops = [[14, 11, 82], [14, 60, 165], [78, 154, 220], [176, 229, 255], [249, 253, 239], [249, 229, 96],
    [249, 181, 15], [217, 108, 3], [134, 32, 13], [57, 4, 35]];
  stops.forEach((expected, i) => {
    for (const lap of [0, 1, 4]) {
      const value = (32 * (lap + i / 10)) ** 2 - 4;
      assert.ok(rgb(value).every((channel, c) => Math.abs(channel - expected[c]) <= 1), `stop ${i} lap ${lap}: ${rgb(value)}`);
    }
  });
});

test('beyond the animation, one lap repeats exactly every COLOR_PERIOD iterations', () => {
  assert.equal(COLOR_PERIOD, 10240);
  for (const base of [25596, 30000.5, 65536, 2 ** 30, 2 ** 40]) {
    assert.deepEqual(rgb(base + COLOR_PERIOD), rgb(base));
    const lap = Array.from({ length: 1024 }, (_, i) => rgb(base + i * COLOR_PERIOD / 1024));
    assert.ok(new Set(lap.map(c => c.join(','))).size > 600);
    assert.ok(lap.some(c => c.every(channel => channel > 225)));
    assert.ok(lap.some(([r, g, b]) => r < 40 && g < 90 && b > 120));
    assert.ok(lap.some(([r, g, b]) => r > 230 && g > 150 && b < 100));
  }
  assert.deepEqual(rgb(INTERIOR), [0, 0, 0]);
});

test('smooth escape colours stay continuous across laps and where the lap length is fixed', () => {
  for (let value = 0.001; value < 30000; value += value < 2000 ? 0.5 : 7.25) {
    const before = rgb(value - 0.001), after = rgb(value + 0.001);
    assert.ok(before.every((channel, i) => Math.abs(channel - after[i]) <= 1), `at ${value}`);
  }
  const left = rgb(25596 - 0.01), right = rgb(25596 + 0.01);
  assert.ok(left.every((channel, i) => Math.abs(channel - right[i]) <= 1));
});

test('negative smooth escape counts outside the set are not painted as interior', () => {
  assert.deepEqual(rgb(-10), rgb(-4), 'counts below the lap start clamp to it');
  assert.notDeepEqual(rgb(-2), rgb(INTERIOR));
  assert.notDeepEqual(rgb(0), rgb(INTERIOR));
});

test('reported 1.50e47 view follows the animation scheme: blues of its second lap', async () => {
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
  // Counts here (~1360-1490) lie early in the second lap: royal to light blue, never warm.
  assert.ok(colors.every(([r, g, b]) => b > r && b >= 150));
  assert.ok(new Set(colors.map(c => c.join(','))).size > 20);
});

test('shallow blues match flat areas of the first frame of the sequence', () => {
  // Medians of pixels whose 4x4 sub-samples agree (no blending) in the
  // 320x240 first frame, paired with escape counts at its fitted view.
  for (const [value, expected] of [
    [2.77, [14, 51, 150]], [4.47, [13, 56, 158]], [6.43, [14, 61, 165]], [8.43, [14, 64, 169]],
    [10.69, [13, 67, 173]], [12.7, [16, 72, 178]], [14.74, [21, 79, 182]],
  ]) assert.ok(rgb(value).every((channel, i) => Math.abs(channel - expected[i]) <= 5), `${value}: ${rgb(value)} vs ${expected}`);
});
