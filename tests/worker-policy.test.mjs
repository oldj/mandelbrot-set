import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkerCount, workerCapacity } from '../src/render/worker-policy.ts';

test('worker capacity reserves a core and caps concurrency on larger devices', () => {
  for (const [cores, expected] of [[1, 1], [2, 1], [4, 3], [8, 7], [10, 8], [64, 8], [undefined, 3]]) {
    assert.equal(workerCapacity(cores), expected);
  }
});

test('small updates use fewer workers and long references limit duplicated memory', () => {
  assert.equal(renderWorkerCount(8, 1280 * 720, -8, 1024), 8);
  assert.equal(renderWorkerCount(8, 3000, -8, 1024), 1);
  assert.equal(renderWorkerCount(8, 65536, -165, 6144), 8);
  // Extended references fit 8 workers at 65536 iterations; at 4x that only 2.
  assert.equal(renderWorkerCount(8, 1280 * 720, -2000, 65536), 8);
  assert.equal(renderWorkerCount(8, 1280 * 720, -2000, 262144), 2);
  // Native-depth references are compact: a raised budget keeps every worker.
  assert.equal(renderWorkerCount(8, 1280 * 720, -60, 163840), 7);
  assert.equal(renderWorkerCount(8, 1280 * 720, -100, 65536), 8);
  assert.equal(renderWorkerCount(8, 0, -2000, 65536), 1);
  assert.equal(renderWorkerCount(1, 1280 * 720, -8, 1024), 1);
});

test('pixels are dealt in runs of neighbours, and a short list still reaches every worker', async () => {
  const { dealRuns } = await import('../src/render/worker-policy.ts');
  const list = Uint32Array.from({ length: 1000 }, (_, k) => k);
  const shares = dealRuns(list, 8, 32);
  assert.deepEqual([...shares[0].subarray(0, 33)], [...Array.from({ length: 32 }, (_, k) => k), 256]);
  assert.deepEqual([...shares[1].subarray(0, 2)], [32, 33]);
  assert.deepEqual(shares.flatMap(share => [...share]).sort((a, b) => a - b), [...list]);
  // 100 pixels for 8 workers: runs of 13, so 8 shares, not 4 runs of 32.
  const short = dealRuns(list.subarray(0, 100), 8, 32);
  assert.deepEqual(short.map(share => share.length), [13, 13, 13, 13, 13, 13, 13, 9]);
  assert.deepEqual(dealRuns(list.subarray(0, 3), 8, 32).map(share => share.length), [1, 1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(dealRuns(new Uint32Array(0), 8, 32).map(share => share.length), [0, 0, 0, 0, 0, 0, 0, 0]);
});
