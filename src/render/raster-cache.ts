/**
 * Reusing rendered pixels. A quality map records, per physical pixel, the
 * sample spacing it was rendered at (1 = final, 255 = nothing yet); pans
 * shift pixels and quality together, and only regions still missing or
 * unfinished are computed again. Late coarse tiles never replace finer pixels.
 */
import { transformView, viewOffset } from '../math/precision.ts';
import type { View } from '../math/precision.ts';
import type { RenderRegion } from './messages.ts';

/** Keep the sampling grid stable; the exact interaction view retains subpixel motion. */
export function panRaster(from: View, to: View, width: number, height: number, cssWidth: number, cssHeight: number) {
  if (from.logScale !== to.logScale) return undefined;
  const offset = viewOffset(from, to);
  const dx = Math.round(offset.x * width / cssWidth), dy = Math.round(offset.y * height / cssHeight);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) >= width || Math.abs(dy) >= height) return undefined;
  return { dx, dy, view: transformView(from, { x: 0, y: 0 }, { x: dx * cssWidth / width, y: dy * cssHeight / height }, 0) };
}

/** Shift quality with the pixels, including unfinished progressive passes. */
export function shiftQuality(source: Uint8Array, width: number, height: number, dx: number, dy: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(width * height).fill(255);
  shiftInto(source, result, width, height, dx, dy);
  return result;
}

/** Copy a per-pixel array into `result` moved by (dx, dy), as pans move the pixels; what scrolls in keeps result's contents. */
function shiftInto(source: Uint8Array, result: Uint8Array, width: number, height: number, dx: number, dy: number): void {
  const left = Math.max(0, dx), right = Math.min(width, width + dx);
  for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y++) {
    result.set(source.subarray((y - dy) * width + left - dx, (y - dy) * width + right - dx), y * width + left);
  }
}

/**
 * Move a per-pixel array by (dx, dy) in place, as pans move the pixels; what
 * scrolls in is set to `fill`. Rows are visited so that none is overwritten
 * before it has moved.
 */
export function shiftInPlace(array: Uint8Array | Float32Array, width: number, height: number, dx: number, dy: number, fill: number): void {
  const left = Math.max(0, dx), right = Math.min(width, width + dx);
  const first = Math.max(0, dy), last = Math.min(height, height + dy) - 1;
  for (let k = 0; k <= last - first; k++) {
    const y = dy > 0 ? last - k : first + k;
    array.copyWithin(y * width + left, (y - dy) * width + left - dx, (y - dy) * width + right - dx);
    array.fill(fill, y * width, y * width + left);
    array.fill(fill, y * width + right, (y + 1) * width);
  }
  array.fill(fill, 0, first * width);
  array.fill(fill, (last + 1) * width, height * width);
}

/**
 * Merge matching horizontal runs into rectangles, without including valid
 * neighbours. `skip(index, end)`, if given, returns the first index from
 * `index` (before `end`) whose value `accepts`, faster than testing each one.
 */
function regionsWhere(quality: Uint8Array, stride: number, bounds: RenderRegion, accepts: (value: number) => boolean,
  skip?: (index: number, end: number) => number): RenderRegion[] {
  const result: RenderRegion[] = [];
  let previous = new Map<string, RenderRegion>();
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    const current = new Map<string, RenderRegion>();
    const end = bounds.x + bounds.width, row = y * stride;
    for (let x = bounds.x; x < end;) {
      if (!accepts(quality[row + x])) { x = skip ? skip(row + x, row + end) - row : x + 1; continue; }
      const start = x++;
      while (x < end && accepts(quality[y * stride + x])) x++;
      const key = `${start}:${x - start}`;
      const existing = previous.get(key);
      const region = existing || { x: start, y, width: x - start, height: 0 };
      region.height++;
      if (!existing) result.push(region);
      current.set(key, region);
    }
    previous = current;
  }
  return result;
}

/** Four finished pixels (quality 1) read as one 32-bit word, in either byte order. */
const FINISHED_WORD = 0x01010101;

/**
 * Regions not yet final. After a pan nearly every pixel is final, and a
 * high-DPI surface has millions: they are skipped four at a time, which keeps
 * the scan to a fraction of a frame on the main thread.
 */
export function missingRegions(quality: Uint8Array, width: number, height: number): RenderRegion[] {
  const words = quality.byteOffset % 4 === 0 ? new Uint32Array(quality.buffer, quality.byteOffset, quality.length >> 2) : undefined;
  const skip = (index: number, end: number) => {
    while (index < end && quality[index] === 1) {
      if (words && (index & 3) === 0) {
        while (index + 4 <= end && words[index >> 2] === FINISHED_WORD) index += 4;
        if (index >= end || quality[index] !== 1) break;
      }
      index++;
    }
    return index;
  };
  return regionsWhere(quality, width, { x: 0, y: 0, width, height }, value => value !== 1, skip);
}

/** Whether every pixel of the bounds has a quality value of at least `step`. */
function allAtLeast(quality: Uint8Array, stride: number, bounds: RenderRegion, step: number): boolean {
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    for (let i = y * stride + bounds.x, end = i + bounds.width; i < end; i++) if (quality[i] < step) return false;
  }
  return true;
}

/** Clip late coarse results around both reused and newly completed fine pixels. */
export function claimTile(quality: Uint8Array, stride: number, bounds: RenderRegion, step: number): RenderRegion[] {
  // Usually nothing finer has landed yet: claim the whole tile without merging runs.
  const regions = step === 1 || allAtLeast(quality, stride, bounds, step) ? [bounds]
    : regionsWhere(quality, stride, bounds, value => value >= step);
  for (const region of regions) for (let y = region.y; y < region.y + region.height; y++) {
    quality.fill(step, y * stride + region.x, y * stride + region.x + region.width);
  }
  return regions;
}
