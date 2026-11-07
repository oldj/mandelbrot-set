import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampler, INTERIOR, iterationBudget, lastDistance } from '../src/fractal/index.ts';
import { color, colorWord, lapsOf, LAPS_PER_E_FOLD, shadedWord } from '../src/render/palette.ts';
import { parseViewHash } from '../src/ui/url-state.ts';
import { ensurePrecision, initialView } from '../src/math/precision.ts';

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

const bytes = word => [...new Uint8Array(new Uint32Array([word]).buffer).slice(0, 3)];
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('boundary shading darkens only within half a pixel of the set, keeps the hue, and spares the first lap', () => {
  for (const value of [3, 97, 400, 1019, 5000, 80000]) {
    for (const distance of [NaN, 0.5, 3, Infinity]) assert.equal(shadedWord(value, distance), colorWord(value));
  }
  // The first lap stays the animation's colouring whatever the distance.
  for (const value of [10, 300, 900]) assert.equal(shadedWord(value, 0), colorWord(value));
  assert.equal(shadedWord(INTERIOR, 0), colorWord(INTERIOR));
  for (const value of [3000, 7700, 60000]) {
    const flat = bytes(colorWord(value));
    let previous = luma(flat);
    for (const distance of [0.4, 0.2, 0.05, 0.01, 0]) {
      const shaded = bytes(shadedWord(value, distance));
      assert.ok(luma(shaded) <= previous, `${value}: darker closer to the boundary`);
      previous = luma(shaded);
      // All channels scale together: the hue is kept.
      const keep = 1 - 0.65 * (1 - Math.sqrt(distance / 0.5));
      shaded.forEach((channel, i) => assert.ok(Math.abs(channel - flat[i] * keep) <= 1, `${value} at ${distance}: ${shaded} vs ${flat} x ${keep}`));
    }
  }
  // Outlines fade in over the second lap: no jump where the first ends.
  const end = bytes(shadedWord(1020 - 1e-6, 0)), next = bytes(shadedWord(1020 + 1e-6, 0));
  assert.ok(end.every((channel, i) => Math.abs(channel - next[i]) <= 1), `${end} vs ${next}`);
});

test('reported 1.18e119 view, nearly white in flat colour, gets clear outlines from distance shading', async () => {
  const width = 1280, height = 800;
  const view = parseViewHash('#re=-0.74665527911170207118468285365617560786145123877730509618240731381329753779532187234596071794312920600729523984412969804261881&im=0.14835731640608019892777532866594623137495516228504355790577996795450012138625629814703902723256411237557027409935715426305866&zoom=1.18101464e119',
    initialView(width, height).logScale);
  const sampler = await createSampler(view, width, height, iterationBudget(view.logScale), async () => {});
  const flat = [], shaded = [];
  for (let y = -398; y < 400; y += 7) for (let x = -638; x < 640; x += 7) {
    const value = sampler.sample(x, y);
    assert.ok(value > 0);
    flat.push(luma(bytes(colorWord(value))));
    shaded.push(luma(bytes(shadedWord(value, lastDistance()))));
  }
  const spread = values => {
    const mean = values.reduce((a, b) => a + b) / values.length;
    return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
  };
  const share = (values, test) => values.filter(test).length / values.length;
  assert.ok(share(flat, v => v < 200) < 0.05, 'flat colour is almost all near-white');
  assert.ok(spread(shaded) > 2 * spread(flat), `contrast ${spread(shaded)} vs ${spread(flat)}`);
  assert.ok(share(shaded, v => v < 170) > 0.05, `outlined structure (${share(shaded, v => v < 170)})`);
});

test('the vivid palette: a fixed, continuous function of the count, repeating past the measured range', async () => {
  const { vividWord, VIVID_END, VIVID_PERIOD, VIVID_REPEAT_FROM, paletteShader } = await import('../src/render/palette.ts');
  const vivid = (value, distance = NaN) => bytes(vividWord(value, distance));
  assert.equal(paletteShader('vivid'), vividWord);
  assert.equal(paletteShader('classic'), shadedWord);
  assert.equal(paletteShader(undefined), shadedWord);
  assert.deepEqual(vivid(INTERIOR), [0, 0, 0]);
  // Continuous: neighbouring counts get neighbouring colours, also across the repeat's seam. (The video's
  // steepest edges change a few levels per quarter count, the table's spacing.)
  for (let value = 0.01; value < 2e6; value += value < 3e4 ? 0.25 : value * 0.0007) {
    const before = vivid(value - value * 1e-7 - 0.0005), after = vivid(value + value * 1e-7 + 0.0005);
    assert.ok(before.every((channel, i) => Math.abs(channel - after[i]) <= 6), `continuous at ${value}`);
  }
  // Past the measured end, the stretch from VIVID_REPEAT_FROM repeats with a fixed period in the count.
  assert.ok(VIVID_REPEAT_FROM < VIVID_END && VIVID_PERIOD > 5000);
  for (let value = VIVID_END; value < 1e6; value += 977.3) assert.deepEqual(vivid(value + VIVID_PERIOD), vivid(value));
  assert.deepEqual(vivid(VIVID_END + 0.5), vivid(VIVID_REPEAT_FROM + 0.5));
  // At any depth a spread of 300 counts holds a dark band and a light one: no view of a few hundred counts
  // is one flat colour, however deep (the classic palette's log-rate cycle gives such views one hue).
  for (let start = 400; start < 2e6; start = start * 1.07 + 37) {
    const colours = Array.from({ length: 100 }, (_, i) => vivid(start + 300 * i / 99));
    assert.ok(colours.some(c => luma(c) < 70) && colours.some(c => luma(c) > 170), `bands in [${start}, ${start + 300}]`);
  }
  // No outlines: the distance to the boundary never changes the colour, as in the video.
  for (const value of [3, 60, 200, 400, 2000, 9000, 50000]) for (const distance of [0, 0.2, 3, Infinity])
    assert.deepEqual(vivid(value, distance), vivid(value));
});

test('every palette has a shader, a name and a menu swatch taken from its own colours', async () => {
  const { PALETTES, PALETTE_INFO } = await import('../src/render/palette-names.ts');
  const { paletteShader } = await import('../src/render/palette.ts');
  const hex = channels => '#' + channels.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  for (const palette of PALETTES) {
    assert.equal(typeof paletteShader(palette), 'function');
    assert.ok(PALETTE_INFO[palette].name && PALETTE_INFO[palette].note);
    assert.ok(PALETTE_INFO[palette].swatch.every(colour => /^#[0-9a-f]{6}$/.test(colour)));
  }
  // Classic: the generator's ten stops, which the first lap passes through.
  assert.deepEqual(PALETTE_INFO.classic.swatch, Array.from({ length: 10 }, (_, i) => hex(rgb((32 * i / 10) ** 2 - 4))));
  // Vivid: from the full view through its first bands, at these counts.
  const { vividWord } = await import('../src/render/palette.ts');
  const word = w => hex([...new Uint8Array(new Uint32Array([w]).buffer).slice(0, 3)]);
  assert.deepEqual(PALETTE_INFO.vivid.swatch, [2, 30, 70, 120, 175, 240, 340, 380, 470, 560, 640, 720, 800, 935, 1050, 1230].map(n => word(vividWord(n, NaN))));
});

test('the vivid colours are the video\'s own, from the full view to n ≈ 13900', async () => {
  const { vividWord } = await import('../src/render/palette.ts');
  const vivid = n => bytes(vividWord(n, NaN));
  // Medians of flat pixels in the video's frames, each frame registered to the plane, against this renderer's
  // counts: the opening's (0.5-29 s, 3% bins), then deeper frames' (to 240 s, 0.5% bins seen in 4+ frames).
  for (const [n, expected] of [
    [1.08, [113, 134, 203]], [3.25, [118, 141, 207]], [6.33, [127, 151, 216]], [10.73, [137, 162, 227]], [17, [155, 184, 244]],
    [25.94, [190, 209, 246]], [38.69, [208, 223, 246]], [56.87, [232, 238, 247]],
    [126, [66, 137, 157]], [142.6, [34, 83, 98]], [199.7, [49, 23, 22]], [261.4, [210, 183, 179]], [336.5, [103, 236, 244]],
    [513.7, [223, 230, 232]], [719.1, [158, 129, 77]], [933.2, [145, 2, 22]], [1501.3, [231, 233, 239]], [2206, [229, 233, 250]],
    [3406.7, [243, 230, 243]], [4978.7, [20, 35, 30]], [7496.4, [222, 238, 239]], [10736.9, [39, 44, 11]], [12532.9, [231, 238, 245]],
  ]) assert.ok(vivid(n).every((channel, i) => Math.abs(channel - expected[i]) <= 4), `${n}: ${vivid(n)} vs ${expected}`);
  // The full view's background is that soft periwinkle.
  for (const n of [0, 0.5, 2, 5]) { const [r, g, b] = vivid(n); assert.ok(b > r + 40 && b > g + 30, `${n}: ${vivid(n)}`); }
});
