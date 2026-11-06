import test from 'node:test';
import assert from 'node:assert/strict';
import { claimTile, missingRegions, panRaster, shiftQuality } from '../src/raster-cache.ts';
import { ensurePrecision, initialView, toFixed, transformView, viewOffset } from '../src/precision.ts';
import { createSampler } from '../src/fractal.ts';

function coverage(regions, width, height) {
  const result = new Uint8Array(width * height);
  for (const r of regions) for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) result[y * width + x]++;
  }
  return result;
}

test('panning only invalidates exposed strips, in all directions and at the edges', () => {
  const width = 73, height = 51;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 7], [0, -7], [13, -11], [-72, 50]]) {
    const shifted = shiftQuality(new Uint8Array(width * height).fill(1), width, height, dx, dy);
    const regions = missingRegions(shifted, width, height);
    const covered = coverage(regions, width, height);
    assert.equal(covered.reduce((a, b) => a + b, 0), width * height - (width - Math.abs(dx)) * (height - Math.abs(dy)));
    assert.ok(covered.every((count, i) => count === (shifted[i] === 1 ? 0 : 1)));
    assert.ok(regions.length <= 3);
  }
});

test('unfinished quality follows repeated pans; missing areas never overlap valid pixels', () => {
  const width = 79, height = 61;
  let quality = new Uint8Array(width * height).fill(255);
  claimTile(quality, width, { x: 3, y: 5, width: 32, height: 32 }, 1);
  claimTile(quality, width, { x: 40, y: 0, width: 30, height: 48 }, 4);
  for (const [dx, dy] of [[5, -3], [-9, 8], [2, 1]]) {
    const before = quality;
    quality = shiftQuality(before, width, height, dx, dy);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x - dx >= 0 && x - dx < width && y - dy >= 0 && y - dy < height;
      assert.equal(quality[y * width + x], inside ? before[(y - dy) * width + x - dx] : 255);
    }
    const covered = coverage(missingRegions(quality, width, height), width, height);
    assert.ok(covered.every((count, i) => count === (quality[i] === 1 ? 0 : 1)));
  }
  const before = quality.slice();
  const painted = coverage(claimTile(quality, width, { x: 0, y: 0, width, height }, 8), width, height);
  assert.ok(painted.every((count, i) => count === (before[i] >= 8 ? 1 : 0)));
});

test('fractional high-DPI pans accumulate without raster resampling or coordinate drift', () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    const cssWidth = 801.3, cssHeight = 601.7;
    const width = Math.round(cssWidth * dpr), height = Math.round(cssHeight * dpr);
    const start = initialView(cssWidth, cssHeight);
    let raster = start;
    for (let i = 1; i <= 1000; i++) {
      const desired = transformView(start, { x: 0, y: 0 }, { x: i * 0.13, y: -i * 0.17 }, 0);
      const pan = panRaster(raster, desired, width, height, cssWidth, cssHeight);
      assert.ok(pan);
      assert.ok(Number.isInteger(pan.dx) && Number.isInteger(pan.dy));
      raster = pan.view;
      const error = viewOffset(raster, desired);
      assert.ok(Math.abs(error.x * width / cssWidth) <= 0.50000001);
      assert.ok(Math.abs(error.y * height / cssHeight) <= 0.50000001);
    }
    assert.equal(panRaster(raster, { ...raster, logScale: raster.logScale - 1 }, width, height, cssWidth, cssHeight), undefined);
    const far = transformView(raster, { x: 0, y: 0 }, { x: cssWidth * 2, y: 0 }, 0);
    assert.equal(panRaster(raster, far, width, height, cssWidth, cssHeight), undefined);
  }
});

test('reused grid locations still sample the same fractal at extreme depth', async () => {
  const width = 80, height = 60, cssWidth = 64, cssHeight = 48;
  const from = ensurePrecision({ ...initialView(cssWidth, cssHeight), logScale: -1200 });
  from.re = toFixed(-2, from.bits); from.im = 0n;
  const desired = transformView(from, { x: 0, y: 0 }, { x: 4.2, y: -3.7 }, 0);
  const pan = panRaster(from, desired, width, height, cssWidth, cssHeight);
  const a = await createSampler(from, cssWidth, cssHeight, 2048, async () => {});
  const b = await createSampler(pan.view, cssWidth, cssHeight, 2048, async () => {});
  for (const [x, y] of [[21, 16], [43, 28], [51, 42]]) {
    const previous = a.sample((x - pan.dx + 0.5) * cssWidth / width - cssWidth / 2,
      (y - pan.dy + 0.5) * cssHeight / height - cssHeight / 2);
    const next = b.sample((x + 0.5) * cssWidth / width - cssWidth / 2, (y + 0.5) * cssHeight / height - cssHeight / 2);
    assert.ok(Math.abs(previous - next) < 1e-7);
  }
});
