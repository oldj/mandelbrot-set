import { claimTile } from './raster-cache.ts';
import type { RenderRegion, TileData } from './types';

/**
 * CPU staging for finished worker tiles. Every canvas upload has a large fixed
 * cost (tens of microseconds), so fast shallow passes, which finish thousands of
 * small tiles a second, are composed here and uploaded once per frame.
 *
 * Unclaimed staging pixels stay fully transparent, so compositing the dirty
 * rectangle over the surface preserves the projected preview underneath.
 */
export class TileStage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  private readonly words: Uint32Array;
  private left = Infinity;
  private top = Infinity;
  private right = -Infinity;
  private bottom = -Infinity;

  // Plain fields: Node's type stripping (used by the tests) rejects parameter properties.
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.words = new Uint32Array(this.pixels.buffer);
  }

  get dirty(): boolean { return this.right > this.left; }

  /**
   * Claim quality for a tile, then stage only the claimed pixels.
   *
   * A coarse sample is taken at the top-left pixel of its block (so finer
   * passes can reuse it exactly), but painted centred on that pixel:
   * sample k covers [x + k step - step/2, x + (k + 1) step - step/2). Painting
   * it over its own block instead would shift each preview by up to half a
   * block, so the image would visibly move at every refinement. The last
   * samples of a region stretch to its right and bottom edges.
   */
  add(tile: TileData, quality: Uint8Array): RenderRegion[] {
    const { step } = tile;
    const clipWidth = tile.clipWidth ?? tile.width * step, clipHeight = tile.clipHeight ?? tile.height * step;
    const half = step >> 1;
    const edgeRight = tile.edgeRight ?? (tile.x + clipWidth >= this.width || clipWidth < tile.width * step);
    const edgeBottom = tile.edgeBottom ?? (tile.y + clipHeight >= this.height || clipHeight < tile.height * step);
    const left = Math.max(0, tile.x - half), top = Math.max(0, tile.y - half);
    const right = Math.min(this.width, edgeRight ? tile.x + clipWidth : tile.x - half + tile.width * step);
    const bottom = Math.min(this.height, edgeBottom ? tile.y + clipHeight : tile.y - half + tile.height * step);
    if (right <= left || bottom <= top) return [];
    const source = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.width * tile.height);
    const regions = claimTile(quality, this.width, { x: left, y: top, width: right - left, height: bottom - top }, step);
    const words = this.words, lastColumn = tile.width - 1, lastRow = tile.height - 1;
    const sampleRowAt = (y: number) => Math.min(lastRow, Math.floor((y - tile.y + half) / step));
    for (const region of regions) {
      const start = region.x, end = region.x + region.width;
      for (let y = region.y; y < region.y + region.height; y++) {
        const sampleRow = sampleRowAt(y), row = sampleRow * tile.width, out = y * this.width;
        if (step === 1) { words.set(source.subarray(row + start - tile.x, row + end - tile.x), out + start); continue; }
        // Rows painted from the same sample row are identical: copy the row above.
        if (y > region.y && sampleRowAt(y - 1) === sampleRow) {
          words.copyWithin(out + start, out - this.width + start, out - this.width + end);
          continue;
        }
        if (step === 2) {
          // Two-pixel runs: a direct loop beats fill(). Sample k paints x = x0 + 2k - 1 and x0 + 2k.
          for (let x = start; x < end; x++) words[out + x] = source[row + Math.min(lastColumn, (x - tile.x + 1) >> 1)];
          continue;
        }
        let x = start;
        while (x < end) {
          const sample = Math.min(lastColumn, Math.floor((x - tile.x + half) / step));
          const stop = sample === lastColumn ? end : Math.min(end, tile.x - half + (sample + 1) * step);
          // fill() costs more than it saves for two-pixel runs.
          if (stop - x <= 2) for (let i = x; i < stop; i++) words[out + i] = source[row + sample];
          else words.fill(source[row + sample], out + x, out + stop);
          x = stop;
        }
      }
      this.left = Math.min(this.left, region.x);
      this.top = Math.min(this.top, region.y);
      this.right = Math.max(this.right, region.x + region.width);
      this.bottom = Math.max(this.bottom, region.y + region.height);
    }
    return regions;
  }

  /** The staged rectangle to upload, or undefined when nothing is pending. */
  pending(): RenderRegion | undefined {
    if (!this.dirty) return undefined;
    return { x: this.left, y: this.top, width: this.right - this.left, height: this.bottom - this.top };
  }

  /** Forget the uploaded rectangle; its pixels are on the surface canvas now. */
  clear(region: RenderRegion): void {
    for (let y = region.y; y < region.y + region.height; y++) {
      this.words.fill(0, y * this.width + region.x, y * this.width + region.x + region.width);
    }
    this.left = this.top = Infinity;
    this.right = this.bottom = -Infinity;
  }
}
