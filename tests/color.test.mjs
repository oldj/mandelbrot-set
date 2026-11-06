import test from 'node:test';
import assert from 'node:assert/strict';
import { color, createSampler, INTERIOR, iterationBudget, lapsOf, LAPS_PER_E_FOLD } from '../src/fractal.ts';
import { ensurePrecision, initialView } from '../src/precision.ts';

function rgb(value) {
  const pixel = new Uint8ClampedArray(4);
  color(value, pixel, 0);
  assert.equal(pixel[3], 255);
  return [...pixel.slice(0, 3)];
}

test('the first lap follows the animation exactly', () => {
  // Medians of flat (unblended) pixels over all 475 frames of
  // Mandelbrot_sequence_new.gif, each frame at its fitted view, paired with
  // the escape count there. The first lap (n < 1020) is the animation's own.
  for (const [value, expected] of [
    [2.6, [14, 50, 149]], [7.8, [14, 63, 168]], [35.4, [73, 148, 217]], [62.4, [130, 203, 244]], [97, [189, 235, 254]],
    [136.9, [237, 252, 254]], [243.3, [248, 231, 108]], [390, [247, 167, 9]], [663.1, [128, 29, 14]], [882.3, [36, 3, 45]],
  ]) assert.ok(rgb(value).every((channel, i) => Math.abs(channel - expected[i]) <= 8), `${value}: ${rgb(value)} vs ${expected}`);
});

test('the generator\'s ten stops sit at evenly spaced turns of the first lap', () => {
  const stops = [[14, 11, 82], [14, 60, 165], [78, 154, 220], [176, 229, 255], [249, 253, 239], [249, 229, 96],
    [249, 181, 15], [217, 108, 3], [134, 32, 13], [57, 4, 35]];
  stops.forEach((expected, i) => {
    const value = (32 * i / 10) ** 2 - 4;
    assert.ok(rgb(value).every((channel, c) => Math.abs(channel - expected[c]) <= 1), `stop ${i}: ${rgb(value)}`);
  });
});

test('beyond the first lap, colours cycle once per fixed factor of the count', () => {
  assert.equal(LAPS_PER_E_FOLD, 4);
  const factor = Math.exp(1 / LAPS_PER_E_FOLD); // ~1.284: one lap per ~28% more iterations
  for (const base of [1600, 5000, 25000, 1e5, 1e6, 3e7]) {
    const next = (base + 4) * factor - 4;
    assert.ok(Math.abs(lapsOf(next) - lapsOf(base) - 1) < 1e-9);
    assert.ok(rgb(next).every((channel, i) => Math.abs(channel - rgb(base)[i]) <= 1));
    // Every lap holds the whole gradient.
    const lap = Array.from({ length: 512 }, (_, i) => rgb((base + 4) * factor ** (i / 512) - 4));
    assert.ok(new Set(lap.map(c => c.join(','))).size > 300);
    assert.ok(lap.some(c => c.every(channel => channel > 225)));
    assert.ok(lap.some(([r, g, b]) => r < 40 && g < 90 && b > 120));
    assert.ok(lap.some(([r, g, b]) => r > 230 && g > 150 && b < 100));
  }
  assert.deepEqual(rgb(INTERIOR), [0, 0, 0]);
});

test('laps grow monotonically and colours stay continuous, also through the blend after the first lap', () => {
  let previous = -Infinity;
  for (let value = 0.001; value < 2e6; value += value < 3000 ? 0.25 : value * 0.0007) {
    const laps = lapsOf(value);
    assert.ok(laps > previous, `laps increase at ${value}`);
    previous = laps;
    const before = rgb(value - value * 1e-7 - 0.0005), after = rgb(value + value * 1e-7 + 0.0005);
    assert.ok(before.every((channel, i) => Math.abs(channel - after[i]) <= 1), `continuous at ${value}`);
  }
  // The rate itself is continuous where the blend starts and ends.
  for (const n of [1020, 1500]) {
    const h = 1e-3, left = (lapsOf(n) - lapsOf(n - h)) / h, right = (lapsOf(n + h) - lapsOf(n)) / h;
    assert.ok(Math.abs(left - right) / right < 1e-3, `rate at ${n}: ${left} vs ${right}`);
  }
});

test('negative smooth escape counts outside the set are not painted as interior', () => {
  assert.deepEqual(rgb(-10), rgb(-4), 'counts below the lap start clamp to it');
  assert.notDeepEqual(rgb(-2), rgb(INTERIOR));
  assert.notDeepEqual(rgb(0), rgb(INTERIOR));
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
  for (let y = -360; y < 400; y += 40) for (let x = -600; x < 640; x += 40) {
    const value = sampler.sample(x, y);
    assert.ok(value > 0, 'these points escape within the existing iteration budget');
    colors.push(rgb(value));
  }
  assert.ok(new Set(colors.map(c => c.join(','))).size > 100);
  const luminance = colors.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b).sort((a, b) => a - b);
  assert.ok(luminance.at(-1) - luminance[0] > 150);
  // Gold background (counts ~1360-1400), with orange/red, blue and violet bands in the filaments.
  assert.ok(colors.some(([r, g, b]) => r > 200 && g > 140 && b < 120), 'gold');
  assert.ok(colors.some(([r, g]) => r > 150 && g < 140), 'orange/red');
  assert.ok(colors.some(([r, , b]) => b > r), 'blue');
});

test('shallow blues match flat areas of the first frame of the sequence', () => {
  // Medians of pixels whose 4x4 sub-samples agree (no blending) in the
  // 320x240 first frame, paired with escape counts at its fitted view.
  for (const [value, expected] of [
    [2.77, [14, 51, 150]], [4.47, [13, 56, 158]], [6.43, [14, 61, 165]], [8.43, [14, 64, 169]],
    [10.69, [13, 67, 173]], [12.7, [16, 72, 178]], [14.74, [21, 79, 182]],
  ]) assert.ok(rgb(value).every((channel, i) => Math.abs(channel - expected[i]) <= 5), `${value}: ${rgb(value)} vs ${expected}`);
});

test('after the first lap, the dark stretch is only a short accent between red and blue', () => {
  const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const darkShare = colors => colors.filter(c => luminance(c) < 40).length / colors.length;
  const first = Array.from({ length: 2048 }, (_, i) => rgb((32 * i / 2048) ** 2 - 4));
  const factor = Math.exp(1 / LAPS_PER_E_FOLD), base = 50000;
  const later = Array.from({ length: 2048 }, (_, i) => rgb((base + 4) * factor ** (i / 2048) - 4));
  assert.ok(darkShare(first) > 0.2, `first lap keeps the animation's dark stretch (${darkShare(first)})`);
  assert.ok(darkShare(later) < darkShare(first) / 2, `later laps pass it faster (${darkShare(later)})`);
  // Still every colour, including the dark accents.
  assert.ok(later.some(([r, g, b]) => r < 70 && g < 20 && b < 60), 'violet');
  assert.ok(later.some(([r, g, b]) => r < 30 && g < 30 && b > 60), 'dark blue-violet');
  // Seamless where the first lap ends.
  const end = rgb(1020 - 1e-6), next = rgb(1020 + 1e-6);
  assert.ok(end.every((channel, i) => Math.abs(channel - next[i]) <= 1), `${end} vs ${next}`);
});
