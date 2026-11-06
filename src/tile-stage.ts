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

  /** Claim quality for a tile, then stage only the claimed pixels (coarse samples are expanded). */
  add(tile: TileData, quality: Uint8Array): RenderRegion[] {
    const width = Math.min(this.width - tile.x, tile.clipWidth ?? tile.width * tile.step);
    const height = Math.min(this.height - tile.y, tile.clipHeight ?? tile.height * tile.step);
    if (width <= 0 || height <= 0) return [];
    const source = new Uint32Array(tile.pixels.buffer, tile.pixels.byteOffset, tile.width * tile.height);
    const { step } = tile;
    const regions = claimTile(quality, this.width, { x: tile.x, y: tile.y, width, height }, step);
    for (const region of regions) {
      const start = region.x - tile.x, end = start + region.width;
      for (let y = region.y; y < region.y + region.height; y++) {
        const row = Math.floor((y - tile.y) / step) * tile.width, out = y * this.width + tile.x;
        if (step === 1) this.words.set(source.subarray(row + start, row + end), out + start);
        else for (let x = start; x < end; x++) this.words[out + x] = source[row + Math.floor(x / step)];
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
