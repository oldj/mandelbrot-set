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

test('each pass samples the tiles nearest the canvas centre first, and reports what unresolved samples cost', async t => {
  const width = 300, height = 200, cssWidth = 300, cssHeight = 200;
  const view = ensurePrecision({ ...initialView(cssWidth, cssHeight), logScale: initialView(cssWidth, cssHeight).logScale - 1 });
  const worker = startWorker(t), passes = [];
  worker.on('message', message => { if (message.type === 'pass') passes.push(message); });
  const tiles = await collect(worker, { id: 1, view, width, height, cssWidth, cssHeight, iterations: 256, workerIndex: 0, workerCount: 1 });
  const distance = tile => Math.hypot(tile.x + tile.clipWidth / 2 - width / 2, tile.y + tile.clipHeight / 2 - height / 2);
  for (const step of [8, 4, 2, 1]) {
    const order = tiles.filter(tile => tile.step === step).map(distance);
    assert.ok(order.every((d, i) => i === 0 || d >= order[i - 1] - 1e-9), `step ${step}: centre outwards`);
  }
  for (const pass of passes) {
    assert.ok(pass.sampleMs > 0, `step ${pass.step} timed`);
    assert.ok(pass.unresolvedMs >= 0 && pass.unresolvedMs <= pass.sampleMs);
  }
  assert.ok(passes.some(pass => pass.unresolved > 0 && pass.unresolvedMs > 0), 'the full view at a low budget leaves some unresolved');
});

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

test('with shared tables one worker builds them in shared memory; the others wait for that copy', async t => {
  const builder = startWorker(t), waiter = startWorker(t), given = startWorker(t), local = startWorker(t);
  const base = deepRequest(1);
  const spec = referenceSpec(base.view, base.cssWidth, base.cssHeight, base.iterations);
  const posted = [];
  const tablesBuilt = new Promise(resolve => builder.on('message', m => {
    if (m.type === 'reference' || m.type === 'tables') posted.push(m.type);
    if (m.type === 'tables') resolve(m);
  }));
  const waiterMessages = [];
  waiter.on('message', m => waiterMessages.push(m));
  const pending = collect(waiter, { ...base, reference: { key: 7, spec, share: true } });
  const own = await collect(builder, { ...base, reference: { key: 7, spec, share: true, build: true } });
  const { key, reference } = await tablesBuilt;
  assert.equal(key, 7);
  assert.deepEqual(posted, ['reference', 'tables'], 'the orbit first (for the GPU), then the tables');
  // Every array, extended tables included (-1200), lives in shared memory: passing it on copies nothing.
  const arrays = [reference.real, reference.imag, reference.firstRadiusSquared, reference.skipRadiusSquared, reference.glitch,
    reference.orbitLog, reference.points.re, reference.points.im, reference.points.exp, ...reference.native, ...reference.levels];
  assert.ok(reference.levels.length > 0);
  assert.ok(arrays.every(array => array.buffer instanceof SharedArrayBuffer));
  // A worker without them waits, even when it holds the orbit; it builds no copy of its own.
  waiter.postMessage({ type: 'reference', key: 7, spec, orbit: reference.points });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!waiterMessages.some(m => m.type === 'tiles' || m.type === 'tables'), 'the waiter waits for the tables');
  waiter.postMessage({ type: 'tables', key: 7, reference });
  const waited = await pending;
  const handed = await collect(given, { ...base, reference: { key: 7, spec, tables: reference } });
  const standalone = await collect(local, base);
  assert.deepEqual(step1(own), step1(standalone));
  assert.deepEqual(step1(waited), step1(standalone));
  assert.deepEqual(step1(handed), step1(standalone));
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
  const { decodeDistance, encodeDistance } = await import('../src/render/samples.ts');
  const sampler = await createSampler(view, cssWidth, cssHeight, request.iterations, async () => {});
  let shaded = 0, checked = 0;
  for (const tile of tiles.filter(tile => tile.step === 1)) {
    const words = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.width * tile.height);
    for (let row = 0; row < tile.height; row++) for (let col = 0; col < tile.width; col++) {
      const x = tile.x + col, y = tile.y + row;
      const value = sampler.sample((x + 0.5) / width * cssWidth - cssWidth / 2, (y + 0.5) / height * cssHeight - cssHeight / 2);
      // Physical pixels are 2/3 of a CSS pixel here. Pixels keep their count in single precision and
      // their distance as a level (render/samples.ts), and are shaded from those.
      const expected = shadedWord(Math.fround(value), decodeDistance(encodeDistance(lastDistance() * 1.5)));
      assert.equal(words[row * tile.width + col], expected, `${x},${y}`);
      if (expected !== colorWord(value)) shaded++;
      checked++;
    }
  }
  assert.equal(checked, width * height);
  assert.ok(shaded > checked / 10, `outlines change part of this view (${shaded} of ${checked})`);
});

/** All messages of one request up to its final pass (or deepening): the tiles and that pass. */
function run(worker, request) {
  return new Promise((resolve, reject) => {
    const tiles = [];
    const receive = message => {
      if (message.id !== request.id) return;
      if (message.type === 'error') reject(new Error(message.message));
      if (message.type === 'tiles') tiles.push(...message.tiles);
      if (message.type === 'pass' && message.step === 1 && Boolean(message.deepen) === Boolean(request.deepen)) {
        worker.off('message', receive);
        resolve({ tiles, pass: message });
      }
    };
    worker.on('message', receive);
    worker.postMessage(request);
  });
}
/** Paint final (step 1) tiles in arrival order into one image of packed RGBA words. */
function paint(image, width, tiles) {
  for (const tile of tiles.filter(tile => tile.step === 1)) {
    const words = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.width * tile.height);
    for (let row = 0; row < tile.height; row++) image.set(words.subarray(row * tile.width, (row + 1) * tile.width), (tile.y + row) * width + tile.x);
  }
  return image;
}

test('every tile carries its samples\' counts and distances, from which its palette gives exactly its colours; a switch mid-render takes over', async t => {
  const { parseViewHash } = await import('../src/ui/url-state.ts');
  const { paletteShader } = await import('../src/render/palette.ts');
  const { decodeDistance } = await import('../src/render/samples.ts');
  const cssWidth = 48, cssHeight = 32, width = 96, height = 64;
  const view = parseViewHash('#re=-0.730883269553203772&im=0.247817380961806007&zoom=1.827554774e12', initialView(cssWidth, cssHeight).logScale);
  const base = { view, width, height, cssWidth, cssHeight, workerIndex: 0, workerCount: 1 };
  const worker = startWorker(t);
  const check = tiles => {
    let pixels = 0;
    for (const tile of tiles) {
      assert.equal(tile.counts.length, tile.width * tile.height);
      const shade = paletteShader(tile.palette), words = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.width * tile.height);
      for (let i = 0; i < words.length; i++) assert.equal(shade(tile.counts[i], decodeDistance(tile.distances[i])), words[i], `${tile.step}: ${tile.x},${tile.y} #${i}`);
      if (tile.step === 1) pixels += words.length;
    }
    return pixels;
  };
  for (const palette of ['classic', 'vivid']) {
    // Including pixels inherited from coarser passes, and those a deepening sends again.
    const draft = await run(worker, { ...base, id: palette === 'vivid' ? 3 : 1, iterations: 2560, palette });
    assert.ok(draft.tiles.every(tile => tile.palette === palette));
    assert.equal(check(draft.tiles), width * height);
    assert.ok(draft.pass.pending > 0, 'some pixels to deepen');
    const deepened = await run(worker, { ...base, id: palette === 'vivid' ? 3 : 1, iterations: 10240, palette, deepen: true });
    assert.ok(check(deepened.tiles) > 0);
  }
  // Switched after the coarse pass: later tiles (inherited samples too) are in the new palette, and so is a later deepening.
  // The worker holds at its first yield after the coarse pass (see the host) while the switch is sent,
  // so it lands mid-render however late this thread gets to it (it used to race the render under load).
  // Four times the pixels: the yield comes well before the final pass on any machine.
  const wide = { ...base, width: width * 2, height: height * 2 };
  const tiles = [];
  const done = new Promise(resolve => {
    const receive = message => {
      if (message.id !== 5) return;
      if (message.type === 'tiles') tiles.push(...message.tiles);
      if (message.type === 'pass' && message.step === 8) {
        worker.postMessage({ type: 'palette', id: 5, palette: 'vivid' });
        worker.postMessage({ type: 'test-release' });
      }
      if (message.type === 'pass' && message.step === 1) { worker.off('message', receive); resolve(); }
    };
    worker.on('message', receive);
  });
  worker.postMessage({ type: 'test-hold', step: 8 });
  worker.postMessage({ ...wide, id: 5, iterations: 2560, palette: 'classic' });
  await done;
  check(tiles);
  const switched = tiles.findIndex(tile => tile.palette === 'vivid');
  assert.ok(switched > 0, 'the coarse pass was classic, and the switch took effect');
  assert.ok(tiles.slice(switched).every(tile => tile.palette === 'vivid'), 'every tile after the switch is vivid');
  assert.ok(tiles.filter(tile => tile.step === 1).every(tile => tile.palette === 'vivid'), 'the final pass is vivid');
  const deepened = await run(worker, { ...wide, id: 5, iterations: 10240, palette: 'classic', deepen: true });
  assert.ok(deepened.tiles.length && deepened.tiles.every(tile => tile.palette === 'vivid'));
  check(deepened.tiles);
});

test('deepening resamples only unresolved pixels and ends identical to rendering at the deeper budget', async t => {
  const { parseViewHash } = await import('../src/ui/url-state.ts');
  for (const [hash, low, high] of [
    ['#re=-0.62665817544438&im=0.39074560013374&zoom=1.835504281e8', 8192, 32768], // shallow, near the 13/30 root
    ['#re=-0.730883269553203772&im=0.247817380961806007&zoom=1.827554774e12', 2560, 10240], // perturbation
  ]) {
    const width = 40, height = 25, view = parseViewHash(hash, initialView(width, height).logScale);
    const base = { view, width, height, cssWidth: width, cssHeight: height, workerIndex: 0, workerCount: 1 };
    const worker = startWorker(t), fresh = startWorker(t);
    const draft = await run(worker, { ...base, id: 1, iterations: low });
    assert.ok(draft.pass.pending > 0, 'the draft leaves pixels unresolved');
    const deepened = await run(worker, { ...base, id: 1, iterations: high, deepen: true });
    assert.equal(deepened.pass.samples, draft.pass.pending, 'only the unresolved pixels are sampled again');
    assert.ok(deepened.pass.pending < draft.pass.pending, `${deepened.pass.pending} of ${draft.pass.pending} still unresolved`);
    const image = paint(paint(new Uint32Array(width * height), width, draft.tiles), width, deepened.tiles);
    const direct = paint(new Uint32Array(width * height), width, (await run(fresh, { ...base, id: 1, iterations: high })).tiles);
    assert.deepEqual(image, direct);
    // A deepening for a render that is no longer the latest does nothing.
    await run(worker, { ...base, id: 2, iterations: low });
    const stale = await run(worker, { ...base, id: 1, iterations: high, deepen: true });
    assert.equal(stale.pass.samples, 0);
    assert.equal(stale.tiles.length, 0);
  }
});

test('a pixel job samples listed pixels exactly as a render does, and flags those left unresolved', async t => {
  // GPU renders hand the workers single pixels (main.ts); their samples must be the render's own.
  const width = 96, height = 64, cssWidth = 96, cssHeight = 64;
  const view = ensurePrecision({ ...initialView(cssWidth, cssHeight), logScale: initialView(cssWidth, cssHeight).logScale - 3 });
  view.re = toFixed(-0.75, view.bits); view.im = toFixed(0.1, view.bits);
  const iterations = 400;
  const tiles = (await collect(startWorker(t), { id: 1, view, width, height, cssWidth, cssHeight, iterations, workerIndex: 0, workerCount: 1 }))
    .filter(tile => tile.step === 1);
  const expected = new Float32Array(width * height), levels = new Uint8Array(width * height);
  for (const tile of tiles) for (let row = 0; row < tile.height; row++) for (let col = 0; col < tile.width; col++) {
    expected[(tile.y + row) * width + tile.x + col] = tile.counts[row * tile.width + col];
    levels[(tile.y + row) * width + tile.x + col] = tile.distances[row * tile.width + col];
  }
  const pixels = Uint32Array.from({ length: 300 }, (_, k) => (k * 7919) % (width * height));
  const worker = startWorker(t), got = new Map();
  let done;
  await new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.id !== 2 || message.type !== 'samples') return;
      assert.equal(message.round, 7, 'samples carry their request\'s round');
      message.indices.forEach((i, k) => got.set(i, [message.counts[k], message.distances[k], message.unresolved[k]]));
      if (message.done) { done = message.done; resolve(); }
    });
    worker.postMessage({ type: 'pixels', id: 2, view, width, height, cssWidth, cssHeight, iterations, pixels, round: 7 });
  });
  assert.equal(got.size, new Set(pixels).size);
  let flagged = 0;
  for (const [i, [count, level, unresolved]] of got) {
    assert.equal(count, expected[i], `count at ${i}`);
    assert.equal(level, levels[i], `distance at ${i}`);
    if (unresolved) { flagged++; assert.equal(count, -1); }
  }
  assert.equal(done.samples, pixels.length);
  assert.equal(done.unresolved, [...pixels].filter(i => got.get(i)[2]).length);
  assert.ok(flagged > 0 && flagged < got.size, `some pixels left unresolved at this budget (${flagged})`);
});

test('a shallow pixel job proves interiors as a render\'s rows do, in any order', async t => {
  // Near the period-3 bulb, plain single samples (directDouble) leave hundreds of interior pixels unresolved at
  // this budget; rows (directRow) prove them. Which pixels a proof reaches can depend on the cycle hint a row
  // carries (so on the order), but the job must leave about as few as the render does, not ~400.
  const width = 96, height = 64, cssWidth = 96, cssHeight = 64, iterations = 4096;
  const base = initialView(cssWidth, cssHeight);
  const view = ensurePrecision({ ...base, logScale: base.logScale - 5 });
  view.re = toFixed(-0.125, view.bits); view.im = toFixed(0.6495, view.bits);
  let render;
  const tiles = await new Promise((resolve, reject) => {
    const worker = startWorker(t), all = [];
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.type === 'tiles') all.push(...message.tiles);
      if (message.type === 'pass' && message.step === 1) { render = message; resolve(all.filter(tile => tile.step === 1)); }
    });
    worker.postMessage({ id: 1, view, width, height, cssWidth, cssHeight, iterations, workerIndex: 0, workerCount: 1 });
  });
  const expected = new Float32Array(width * height);
  for (const tile of tiles) for (let row = 0; row < tile.height; row++) for (let col = 0; col < tile.width; col++) {
    expected[(tile.y + row) * width + tile.x + col] = tile.counts[row * tile.width + col];
  }
  assert.ok(render.pending > 0 && render.pending < 60, `the render leaves a few unresolved (${render.pending})`);
  const raster = Array.from({ length: width * height }, (_, k) => k);
  for (const pixels of [Uint32Array.from(raster), Uint32Array.from(raster, k => (k * 7919) % (width * height))]) {
    const worker = startWorker(t), flags = new Uint8Array(width * height);
    const done = await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', message => {
        if (message.type !== 'samples') return;
        message.indices.forEach((i, k) => {
          assert.equal(message.counts[k], expected[i], `count at ${i}`);
          flags[i] = message.unresolved[k];
          if (flags[i]) assert.equal(message.counts[k], -1, `an unresolved pixel at ${i} is unescaped`);
        });
        if (message.done) resolve(message.done);
      });
      worker.postMessage({ type: 'pixels', id: 2, view, width, height, cssWidth, cssHeight, iterations, pixels, round: 0 });
    });
    const flagged = flags.reduce((sum, flag) => sum + flag, 0);
    assert.equal(done.unresolved, flagged);
    assert.ok(flagged <= render.pending * 1.5 + 4, `${flagged} unresolved, the render ${render.pending}`);
  }
});

test('an orbit-only pixel job builds and sends the shared orbit, and no samples a round could miscount', async t => {
  // GPU renders have worker 0 build the shared orbit with an empty request. Its samples message with
  // `done` once reached the main thread while a round of real requests was under way, and was counted
  // as one of their reports: the round ended early and the rest of its samples were dropped.
  const view = ensurePrecision({ ...initialView(64, 48), logScale: -40 });
  view.re = toFixed(-0.7436438870371587, view.bits); view.im = toFixed(0.13182590420531197, view.bits);
  const iterations = 2048, spec = referenceSpec(view, 64, 48, iterations);
  const worker = startWorker(t), messages = [];
  worker.on('message', message => messages.push(message));
  worker.postMessage({ type: 'pixels', id: 3, view, width: 64, height: 48, cssWidth: 64, cssHeight: 48, iterations,
    reference: { key: 1, spec, build: true }, pixels: new Uint32Array(0), round: 0, orbitOnly: true });
  const deadline = Date.now() + 60000;
  while (!messages.some(message => message.type === 'reference') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  // Time for the tables and anything sent after them.
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(messages.some(message => message.type === 'reference' && message.key === 1), 'the orbit is sent');
  assert.equal(messages.filter(message => message.type === 'samples').length, 0, 'no samples message');
});
