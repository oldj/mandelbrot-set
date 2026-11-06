// Run with Node 22.18+; an optional source directory allows before/after comparisons.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = resolve(process.argv[2] || 'src');
const { createSampler, iterationBudget } = await import(pathToFileURL(`${source}/fractal/index.ts`));
const { color } = await import(pathToFileURL(`${source}/render/palette.ts`));
const { initialView, ensurePrecision, toFixed } = await import(pathToFileURL(`${source}/math/precision.ts`));
const width = 160, height = 100, cssWidth = 1280, cssHeight = 800;
const xs = new Float64Array(width), values = new Float64Array(width), distances = new Float64Array(width);
const decimal = (text, bits) => {
  const [whole, fraction] = text.split('.');
  return BigInt(whole + fraction) * (1n << BigInt(bits)) / 10n ** BigInt(fraction.length);
};
function viewAt(re, im, scale) {
  const view = ensurePrecision({ ...initialView(cssWidth, cssHeight), logScale: scale });
  view.re = typeof re === 'string' ? decimal(re, view.bits) : toFixed(re, view.bits);
  view.im = typeof im === 'string' ? decimal(im, view.bits) : toFixed(im, view.bits);
  return view;
}
const scenes = [
  ['initial', initialView(cssWidth, cssHeight)],
  ['period-3 interior', viewAt(-0.122561166876, 0.744861766619, -17)],
  ['seahorse', viewAt(-0.743643887037151, 0.13182590420533, -50)],
  ['reported 1.5e47', viewAt('-0.69378820112974505918001981502679506278690352790793731',
    '-0.34952527748216184476632029598345669714154984468763950', initialView(cssWidth, cssHeight).logScale - Math.log2(1.5e47))],
  ['extended 2^-1200', viewAt(-2, 0, -1200)],
];
const output = [];
for (const [scene, view] of scenes) {
  const start = performance.now();
  const sampler = await createSampler(view, cssWidth, cssHeight, iterationBudget(view.logScale), async () => {});
  const setupMs = performance.now() - start;
  const times = [], pixel = new Uint8ClampedArray(4);
  let checksum = 0;
  for (let pass = 0; pass < 4; pass++) {
    const begin = performance.now();
    checksum = 0;
    for (let y = 0; y < height; y++) {
      // Use the row path where the sampler has one, as the workers do.
      for (let x = 0; x < width; x++) xs[x] = (x + 0.5) / width * cssWidth - cssWidth / 2;
      const cy = (y + 0.5) / height * cssHeight - cssHeight / 2;
      if (sampler.row) sampler.row(xs, width, cy, values, distances);
      else for (let x = 0; x < width; x++) values[x] = sampler.sample(xs[x], cy);
      for (let x = 0; x < width; x++) {
        color(values[x], pixel, 0);
        checksum += pixel[0] + pixel[1] + pixel[2];
      }
    }
    if (pass > 0) times.push(performance.now() - begin);
  }
  times.sort((a, b) => a - b);
  output.push({ scene, pixels: width * height, setupMs: +setupMs.toFixed(2), medianMs: +times[1].toFixed(2), checksum, fallbacks: sampler.stats.fallbacks });
}
console.log(JSON.stringify(output, null, 2));
