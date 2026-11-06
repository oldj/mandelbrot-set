import test from 'node:test';
import assert from 'node:assert/strict';
import { TileStage } from '../src/tile-stage.ts';

function tile(x, y, width, height, step, value, clip = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  new Uint32Array(pixels.buffer).fill(value);
  return { x, y, width, height, step, pixels, ...clip };
}
const word = (stage, x, y) => new Uint32Array(stage.pixels.buffer)[y * stage.width + x];

test('fine tiles are copied exactly and coarse samples expand to their blocks', () => {
  const stage = new TileStage(20, 12), quality = new Uint8Array(20 * 12).fill(255);
  const coarse = tile(0, 0, 3, 2, 4, 0, { clipWidth: 10, clipHeight: 7 });
  new Uint32Array(coarse.pixels.buffer).set([1, 2, 3, 4, 5, 6]);
  stage.add(coarse, quality);
  assert.equal(word(stage, 0, 0), 1); assert.equal(word(stage, 3, 3), 1);
  assert.equal(word(stage, 4, 0), 2); assert.equal(word(stage, 9, 6), 6);
  assert.equal(word(stage, 10, 0), 0, 'clip width is respected');
  assert.equal(word(stage, 0, 7), 0, 'clip height is respected');
  assert.deepEqual(stage.pending(), { x: 0, y: 0, width: 10, height: 7 });
  stage.add(tile(12, 8, 8, 4, 1, 9), quality);
  assert.equal(word(stage, 12, 8), 9); assert.equal(word(stage, 19, 11), 9);
  assert.deepEqual(stage.pending(), { x: 0, y: 0, width: 20, height: 12 });
});

test('late coarse tiles never replace staged or uploaded fine pixels', () => {
  const stage = new TileStage(16, 16), quality = new Uint8Array(16 * 16).fill(255);
  stage.add(tile(0, 0, 8, 8, 1, 7), quality);
  stage.clear(stage.pending());
  assert.equal(stage.dirty, false);
  assert.equal(word(stage, 0, 0), 0, 'uploaded pixels leave the stage transparent');
  stage.add(tile(0, 0, 2, 2, 8, 3), quality);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    assert.equal(word(stage, x, y), x < 8 && y < 8 ? 0 : 3, `${x},${y}`);
    assert.equal(quality[y * 16 + x], x < 8 && y < 8 ? 1 : 8);
  }
});

test('tiles past the surface edge are ignored', () => {
  const stage = new TileStage(8, 8), quality = new Uint8Array(64).fill(255);
  assert.deepEqual(stage.add(tile(8, 0, 4, 4, 1, 1), quality), []);
  assert.equal(stage.dirty, false);
});

test('every coarse step expands identically to per-pixel expansion, also around claimed pixels', () => {
  for (const step of [2, 4, 8]) {
    const stage = new TileStage(37, 29), quality = new Uint8Array(37 * 29).fill(255);
    // A finer pixel block already landed inside the tile: it must be skipped.
    stage.add(tile(8, 8, 5, 5, 1, 0xfeed), quality);
    const columns = Math.ceil(32 / step), coarse = tile(0, 0, columns, columns, step, 0, { clipWidth: 32, clipHeight: 29 });
    const words = new Uint32Array(coarse.pixels.buffer);
    words.forEach((_, i) => { words[i] = 1000 + i; });
    stage.add(coarse, quality);
    for (let y = 0; y < 29; y++) for (let x = 0; x < 37; x++) {
      const fine = x >= 8 && x < 13 && y >= 8 && y < 13;
      const expected = x >= 32 ? 0 : fine ? 0xfeed : 1000 + Math.floor(y / step) * columns + Math.floor(x / step);
      assert.equal(word(stage, x, y), expected, `step ${step} at ${x},${y}`);
    }
  }
});
