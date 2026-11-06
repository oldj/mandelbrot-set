import type { View } from './precision';

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
}

export interface RenderTile {
  type: 'tile';
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  step: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

export interface RenderProgress {
  type: 'pass';
  id: number;
  step: number;
  elapsed: number;
  fallbacks: number;
}

export type RenderMessage = RenderTile | RenderProgress | { type: 'error'; id: number; message: string };
