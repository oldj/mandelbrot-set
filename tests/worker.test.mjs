import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { initialView, ensurePrecision, toFixed } from '../src/precision.ts';
import { color, directDouble, iterationBudget } from '../src/fractal.ts';
import { missingRegions, panRaster, shiftQuality } from '../src/raster-cache.ts';
import { transformView } from '../src/precision.ts';

function startWorker(t) {
  const worker = new Worker(new URL('./fixtures/worker-host.mjs', import.meta.url));
  t.after(() => worker.terminate());
  return worker;
}
function collect(worker, request) {
  return new Promise((resolve, reject) => {
    const tiles = [];
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.id !== request.id) return;
      if (message.type === 'error') reject(new Error(message.message));
      if (message.type === 'tile') tiles.push(message);
      if (message.type === 'pass' && message.step === 1) resolve(tiles);
    });
    worker.postMessage(request);
  });
}

test('real workers cover all physical pixels at each pass, including non-multiple edges', async t => {
  const width = 73, height = 51, cssWidth = 60, cssHeight = 43;
  const view = initialView(cssWidth, cssHeight);
  const request = { id: 1, view, width, height, cssWidth, cssHeight, iterations: 1024, workerCount: 2 };
  const groups = await Promise.all([0, 1].map(workerIndex => collect(startWorker(t), { ...request, workerIndex })));
  const tiles = groups.flat();
  for (const step of [8, 4, 2, 1]) {
    const coverage = new Uint8Array(width * height);
    for (const tile of tiles.filter(tile => tile.step === step)) {
      for (let y = tile.y; y < Math.min(height, tile.y + tile.height * step); y++) {
        for (let x = tile.x; x < Math.min(width, tile.x + tile.width * step); x++) coverage[y * width + x]++;
      }
    }
    assert.ok(coverage.every(count => count === 1), `coverage at step ${step}`);
  }
  for (const tile of tiles.filter(tile => tile.step === 1)) {
    for (let row = 0; row < tile.height; row++) for (let col = 0; col < tile.width; col++) {
      const cr = -0.6 + ((tile.x + col + 0.5) / width * cssWidth - cssWidth / 2) * 2 ** view.logScale;
      const ci = -((tile.y + row + 0.5) / height * cssHeight - cssHeight / 2) * 2 ** view.logScale;
      const expected = new Uint8ClampedArray(4);
      color(directDouble(cr, ci, request.iterations), expected, 0);
      const offset = (row * tile.width + col) * 4;
      assert.deepEqual(tile.pixels.slice(offset, offset + 4), expected);
    }
  }
});

test('a new request cancels a costly reference job instead of waiting for its frame', async t => {
  const worker = startWorker(t);
  const view = ensurePrecision({ ...initialView(32, 24), logScale: -4000 });
  view.re = toFixed(-2, view.bits);
  const request = { id: 1, view, width: 32, height: 24, cssWidth: 32, cssHeight: 24,
    iterations: iterationBudget(view.logScale), workerIndex: 0, workerCount: 1 };
  const messages = [];
  worker.on('message', message => messages.push(message));
  worker.postMessage(request);
  const tiles = await collect(worker, { ...request, id: 2, view: initialView(32, 24), iterations: 1024 });
  assert.ok(tiles.length > 0);
  assert.ok(messages.filter(message => message.type === 'tile').every(message => message.id === 2));
});

test('partial worker passes cover only exposed pixels and reconstruct a full fresh render', async t => {
  const width = 73, height = 51, cssWidth = 58.4, cssHeight = 40.8;
  const view = initialView(cssWidth, cssHeight);
  view.im = toFixed(0.125, view.bits);
  const worker = startWorker(t);
  const base = { id: 1, view, width, height, cssWidth, cssHeight, iterations: 1024, workerCount: 1, workerIndex: 0 };
  function assemble(tiles, target = new Uint8ClampedArray(width * height * 4)) {
    for (const tile of tiles.filter(t => t.step === 1)) for (let y = 0; y < tile.height; y++) {
      target.set(tile.pixels.subarray(y * tile.width * 4, (y + 1) * tile.width * 4), ((tile.y + y) * width + tile.x) * 4);
    }
    return target;
  }
  const original = assemble(await collect(worker, base));
  const desired = transformView(view, { x: 0, y: 0 }, { x: 5.6, y: -2.4 }, 0);
  const pan = panRaster(view, desired, width, height, cssWidth, cssHeight);
  const regions = missingRegions(shiftQuality(new Uint8Array(width * height).fill(1), width, height, pan.dx, pan.dy), width, height);
  const results = await Promise.all([0, 1, 2, 3].map(workerIndex => collect(startWorker(t),
    { ...base, id: 2, view: pan.view, regions, workerIndex, workerCount: 4 })));
  const tiles = results.flat();
  const exposed = width * height - (width - Math.abs(pan.dx)) * (height - Math.abs(pan.dy));
  for (const step of [8, 4, 2, 1]) {
    const coverage = new Uint8Array(width * height);
    for (const tile of tiles.filter(t => t.step === step)) {
      for (let y = tile.y; y < tile.y + tile.clipHeight; y++) for (let x = tile.x; x < tile.x + tile.clipWidth; x++) coverage[y * width + x]++;
    }
    assert.equal(coverage.reduce((a, b) => a + b, 0), exposed);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const reused = x - pan.dx >= 0 && x - pan.dx < width && y - pan.dy >= 0 && y - pan.dy < height;
      assert.equal(coverage[y * width + x], reused ? 0 : 1);
    }
  }
  const reused = new Uint8ClampedArray(original.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = x - pan.dx, sy = y - pan.dy;
    if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
      reused.set(original.subarray((sy * width + sx) * 4, (sy * width + sx + 1) * 4), (y * width + x) * 4);
    }
  }
  const fresh = assemble(await collect(worker, { ...base, id: 3, view: pan.view }));
  // Recentring the double-precision oracle changes arithmetic order; allow one
  // RGB quantization level, but no missing pixels, misalignment or alpha changes.
  const combined = assemble(tiles, reused);
  assert.ok(combined.every((value, i) => Math.abs(value - fresh[i]) <= (i % 4 === 3 ? 0 : 1)));
  assert.equal(tiles.filter(t => t.step === 1).reduce((n, t) => n + t.width * t.height, 0), exposed);
  assert.ok(exposed < width * height / 5);
});
