import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { initialView, ensurePrecision, toFixed } from '../src/precision.ts';
import { color, directDouble, iterationBudget } from '../src/fractal.ts';

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
