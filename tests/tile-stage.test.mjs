import test from 'node:test';
import assert from 'node:assert/strict';
import { TileStage } from '../src/tile-stage.ts';

function tile(x, y, width, height, step, value, clip = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  new Uint32Array(pixels.buffer).fill(value);
  return { x, y, width, height, step, pixels, ...clip };
}
const word = (stage, x, y) => new Uint32Array(stage.pixels.buffer)[y * stage.width + x];

/** Independent model: which sample paints pixel (x, y), or -1 outside the footprint. */
function painter(t, x, y, canvasWidth, canvasHeight) {
  const half = t.step >> 1, clipWidth = t.clipWidth ?? t.width * t.step, clipHeight = t.clipHeight ?? t.height * t.step;
  const right = Math.min(canvasWidth, t.edgeRight ? t.x + clipWidth : t.x - half + t.width * t.step);
  const bottom = Math.min(canvasHeight, t.edgeBottom ? t.y + clipHeight : t.y - half + t.height * t.step);
  if (x < Math.max(0, t.x - half) || x >= right || y < Math.max(0, t.y - half) || y >= bottom) return -1;
  // Nearest sample (samples sit at top-left block pixels), clamped to the last one.
  const column = Math.min(t.width - 1, Math.floor((x - t.x + half) / t.step));
  const row = Math.min(t.height - 1, Math.floor((y - t.y + half) / t.step));
  return row * t.width + column;
}

test('fine tiles are copied exactly and coarse samples are painted centred on their pixel', () => {
  const stage = new TileStage(20, 12), quality = new Uint8Array(20 * 12).fill(255);
  const coarse = tile(4, 4, 3, 2, 4, 0, { clipWidth: 10, clipHeight: 7, edgeRight: true, edgeBottom: true });
  new Uint32Array(coarse.pixels.buffer).set([1, 2, 3, 4, 5, 6]);
  stage.add(coarse, quality);
  // The sample at pixel (4, 4) covers (2..5, 2..5); the next column starts at x = 6.
  assert.equal(word(stage, 2, 2), 1); assert.equal(word(stage, 5, 5), 1);
  assert.equal(word(stage, 6, 2), 2); assert.equal(word(stage, 1, 2), 0);
  assert.equal(word(stage, 13, 10), 6, 'the last samples stretch to the region edge');
  assert.equal(word(stage, 14, 4), 0, 'nothing past the clip width');
  assert.equal(word(stage, 4, 11), 0, 'nothing past the clip height');
  assert.deepEqual(stage.pending(), { x: 2, y: 2, width: 12, height: 9 });
  stage.add(tile(12, 8, 8, 4, 1, 9), quality);
  assert.equal(word(stage, 12, 8), 9); assert.equal(word(stage, 19, 11), 9);
  assert.equal(word(stage, 13, 10), 9, 'finer pixels replace coarse ones');
});

test('adjacent coarse tiles paint every pixel exactly once, without gaps at region edges', () => {
  const W = 70, H = 45;
  for (const step of [2, 4, 8]) {
    const stage = new TileStage(W, H), quality = new Uint8Array(W * H).fill(255), owners = new Int32Array(W * H).fill(-1);
    const tiles = [];
    for (let y = 0; y < H; y += 32) for (let x = 0; x < W; x += 32) {
      const clipWidth = Math.min(32, W - x), clipHeight = Math.min(32, H - y);
      tiles.push(tile(x, y, Math.ceil(clipWidth / step), Math.ceil(clipHeight / step), step, tiles.length + 1,
        { clipWidth, clipHeight, edgeRight: x + 32 >= W, edgeBottom: y + 32 >= H }));
    }
    for (const t of tiles) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (painter(t, x, y, W, H) >= 0) {
        assert.equal(owners[y * W + x], -1, `step ${step}: pixel ${x},${y} painted twice`);
        owners[y * W + x] = t.pixels[0];
      }
      stage.add(t, quality);
    }
    for (let i = 0; i < W * H; i++) assert.equal(new Uint32Array(stage.pixels.buffer)[i], owners[i] < 0 ? 0 : new Uint32Array(tiles[owners[i] - 1].pixels.buffer)[0], `step ${step} pixel ${i}`);
    assert.ok(owners.every(owner => owner >= 0), `step ${step}: no gaps`);
  }
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

test('every coarse step paints like the per-pixel model, also around claimed pixels', () => {
  for (const step of [2, 4, 8]) {
    const stage = new TileStage(37, 29), quality = new Uint8Array(37 * 29).fill(255);
    // A finer pixel block already landed inside the tile: it must be skipped.
    stage.add(tile(8, 8, 5, 5, 1, 0xfeed), quality);
    const columns = Math.ceil(32 / step), rows = Math.ceil(29 / step);
    const coarse = tile(0, 0, columns, rows, step, 0, { clipWidth: 32, clipHeight: 29, edgeRight: false, edgeBottom: true });
    const words = new Uint32Array(coarse.pixels.buffer);
    words.forEach((_, i) => { words[i] = 1000 + i; });
    stage.add(coarse, quality);
    for (let y = 0; y < 29; y++) for (let x = 0; x < 37; x++) {
      const fine = x >= 8 && x < 13 && y >= 8 && y < 13, sample = painter(coarse, x, y, 37, 29);
      const expected = fine ? 0xfeed : sample < 0 ? 0 : 1000 + sample;
      assert.equal(word(stage, x, y), expected, `step ${step} at ${x},${y}`);
    }
  }
});
