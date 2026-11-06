import type { View } from './precision';

export interface RenderRegion { x: number; y: number; width: number; height: number }

export type RenderCommand = RenderRequest | { type: 'cancel'; id: number };

export interface RenderRequest {
  id: number;
  view: View;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  workerIndex: number;
  workerCount: number;
  iterations: number;
  regions?: RenderRegion[];
}

/** One finished tile; `step` is the sample spacing in physical pixels. */
export interface TileData {
  x: number;
  y: number;
  width: number;
  height: number;
  step: number;
  clipWidth?: number;
  clipHeight?: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/** Tiles are batched so fast shallow passes don't flood the main thread with messages. */
export interface RenderTiles {
  type: 'tiles';
  id: number;
  tiles: TileData[];
}

export interface RenderProgress {
  type: 'pass';
  id: number;
  step: number;
  elapsed: number;
  fallbacks: number;
}

export type RenderMessage = RenderTiles | RenderProgress | { type: 'error'; id: number; message: string };
