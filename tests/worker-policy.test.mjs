import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkerCount, workerCapacity } from '../src/worker-policy.ts';

test('worker capacity reserves a core and caps concurrency on larger devices', () => {
  for (const [cores, expected] of [[1, 1], [2, 1], [4, 3], [8, 7], [10, 8], [64, 8], [undefined, 3]]) {
    assert.equal(workerCapacity(cores), expected);
  }
});

test('small updates use fewer workers and long references limit duplicated memory', () => {
  assert.equal(renderWorkerCount(8, 1280 * 720, -8, 1024), 8);
  assert.equal(renderWorkerCount(8, 3000, -8, 1024), 1);
  assert.equal(renderWorkerCount(8, 65536, -165, 6144), 8);
  assert.equal(renderWorkerCount(8, 1280 * 720, -2000, 65536), 4);
  // Native-depth references are compact: a raised budget keeps every worker.
  assert.equal(renderWorkerCount(8, 1280 * 720, -60, 163840), 7);
  assert.equal(renderWorkerCount(8, 1280 * 720, -100, 65536), 8);
  assert.equal(renderWorkerCount(8, 0, -2000, 65536), 1);
  assert.equal(renderWorkerCount(1, 1280 * 720, -8, 1024), 1);
});
