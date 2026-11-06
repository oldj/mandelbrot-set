import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { initialView, ensurePrecision, toFixed, transformView } from '../src/math/precision.ts';
import { directDouble, iterationBudget, lastDistance } from '../src/fractal/index.ts';
import { color, colorWord, shadedWord } from '../src/render/palette.ts';
import { missingRegions, panRaster, shiftQuality } from '../src/render/raster-cache.ts';
import { referenceSpec } from '../src/fractal/reference.ts';

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
      if (message.type === 'tiles') tiles.push(...message.tiles);
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
  worker.postMessage({ type: 'cancel', id: 2 });
  const tiles = await collect(worker, { ...request, id: 3, view: initialView(32, 24), iterations: 1024 });
  assert.ok(tiles.length > 0);
  assert.ok(messages.filter(message => message.type === 'tiles').every(message => message.id === 3));
  assert.ok(!messages.some(message => message.type === 'error'));
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


function deepRequest(id, extra = {}) {
  const view = ensurePrecision({ ...initialView(40, 30), logScale: -1200 });
  view.re = toFixed(-2, view.bits);
  return { id, view, width: 40, height: 30, cssWidth: 40, cssHeight: 30,
    iterations: iterationBudget(view.logScale), workerIndex: 0, workerCount: 1, ...extra };
}
const step1 = tiles => tiles.filter(tile => tile.step === 1).map(({ x, y, pixels }) => [x, y, [...pixels]]);

test('one worker builds the shared orbit; another waits for it and renders identical pixels', async t => {
  const builder = startWorker(t), receiver = startWorker(t), local = startWorker(t);
  const base = deepRequest(1);
  const spec = referenceSpec(base.view, base.cssWidth, base.cssHeight, base.iterations);
  const built = new Promise(resolve => builder.on('message', m => { if (m.type === 'reference') resolve(m); }));
  const receiverMessages = [];
  receiver.on('message', m => receiverMessages.push(m));
  const pending = collect(receiver, { ...base, reference: { key: 7, spec } });
  const own = await collect(builder, { ...base, reference: { key: 7, spec, build: true } });
  const message = await built;
  assert.equal(message.key, 7);
  assert.equal(message.orbit.re.length, message.orbit.exp.length);
  assert.ok(!receiverMessages.some(m => m.type === 'tiles'), 'receiver cannot start before the orbit arrives');
  receiver.postMessage({ type: 'reference', key: 7, spec, orbit: message.orbit });
  const received = await pending;
  const standalone = await collect(local, base);
  assert.deepEqual(step1(own), step1(standalone));
  assert.deepEqual(step1(received), step1(standalone));
});

test('a newer request for the same key continues the build; a different key cancels it', async t => {
  const worker = startWorker(t);
  const base = deepRequest(1);
  const spec = referenceSpec(base.view, base.cssWidth, base.cssHeight, base.iterations);
  const references = [];
  worker.on('message', m => { if (m.type === 'reference') references.push(m.key); });
  worker.postMessage({ ...base, reference: { key: 1, spec, build: true } });
  const tiles = await collect(worker, { ...base, id: 2, reference: { key: 1, spec, build: true } });
  assert.ok(tiles.length > 0);
  assert.deepEqual(references, [1], 'the orbit is computed and posted once');
  // A cached orbit for the same key is reused without posting again.
  await collect(worker, { ...base, id: 3, reference: { key: 1, spec, build: true } });
  assert.deepEqual(references, [1]);
  // Switching keys abandons the stale build entirely.
  const deeper = ensurePrecision({ ...base.view, logScale: -4000 });
  const stale = referenceSpec(deeper, 40, 30, iterationBudget(-4000));
  worker.postMessage({ ...base, id: 4, view: deeper, iterations: stale.limit, reference: { key: 2, spec: stale, build: true } });
  await collect(worker, { ...base, id: 5, view: initialView(40, 30), iterations: 1024 });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(references, [1]);
});

test('reused coarse samples leave a deep render identical to sampling every pixel', async t => {
  const worker = startWorker(t);
  const request = deepRequest(1, { width: 37, height: 29, cssWidth: 37, cssHeight: 29 });
  const tiles = await collect(worker, request);
  const { createSampler } = await import('../src/fractal/index.ts');
  const sampler = await createSampler(request.view, 37, 29, request.iterations, async () => {});
  for (const tile of tiles.filter(tile => tile.step === 1)) {
    for (let row = 0; row < tile.height; row++) for (let col = 0; col < tile.width; col++) {
      const value = sampler.sample(tile.x + col + 0.5 - 18.5, tile.y + row + 0.5 - 14.5);
      const expected = new Uint8ClampedArray(new Uint32Array([shadedWord(value, lastDistance())]).buffer);
      const offset = (row * tile.width + col) * 4;
      assert.deepEqual(tile.pixels.slice(offset, offset + 4), expected);
    }
  }
  // Every pass covers every pixel, and the coarse passes sample block corners.
  for (const step of [8, 4, 2, 1]) {
    const covered = tiles.filter(tile => tile.step === step).reduce((n, tile) => n + tile.clipWidth * tile.clipHeight, 0);
    assert.equal(covered, 37 * 29);
  }
});

test('outlines use each pixel\'s distance estimate in physical pixels, the same as per-pixel sampling', async t => {
  // The reported 1.50e47 view: counts ~1350-1400, past the first lap, so outlines apply.
  const width = 75, height = 45, cssWidth = 50, cssHeight = 30;
  const initial = initialView(cssWidth, cssHeight);
  const view = ensurePrecision({ ...initial, logScale: initial.logScale - Math.log2(1.5e47) + 3 });
  const decimal = text => {
    const [whole, fraction] = text.split('.');
    return BigInt(whole + fraction) * (1n << BigInt(view.bits)) / 10n ** BigInt(fraction.length);
  };
  view.re = decimal('-0.69378820112974505918001981502679506278690352790793731');
  view.im = decimal('-0.34952527748216184476632029598345669714154984468763950');
  const request = { id: 1, view, width, height, cssWidth, cssHeight, iterations: iterationBudget(view.logScale), workerIndex: 0, workerCount: 2 };
  const [first, second] = [startWorker(t), startWorker(t)];
  const tiles = (await Promise.all([collect(first, request), collect(second, { ...request, workerIndex: 1 })])).flat();
  const { createSampler } = await import('../src/fractal/index.ts');
  const sampler = await createSampler(view, cssWidth, cssHeight, request.iterations, async () => {});
  let shaded = 0, checked = 0;
  for (const tile of tiles.filter(tile => tile.step === 1)) {
    const words = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.width * tile.height);
    for (let row = 0; row < tile.height; row++) for (let col = 0; col < tile.width; col++) {
      const x = tile.x + col, y = tile.y + row;
      const value = sampler.sample((x + 0.5) / width * cssWidth - cssWidth / 2, (y + 0.5) / height * cssHeight - cssHeight / 2);
      // Physical pixels are 2/3 of a CSS pixel here.
      const expected = shadedWord(value, lastDistance() * 1.5);
      assert.equal(words[row * tile.width + col], expected, `${x},${y}`);
      if (expected !== colorWord(value)) shaded++;
      checked++;
    }
  }
  assert.equal(checked, width * height);
  assert.ok(shaded > checked / 10, `outlines change part of this view (${shaded} of ${checked})`);
});
