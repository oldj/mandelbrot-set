export interface RenderRequest {
  width: number;
  height: number;
}

export interface RenderStrip {
  y: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  done: boolean;
}
