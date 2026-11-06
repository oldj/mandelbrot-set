import { color, createSampler } from './fractal.ts';
import type { ReferenceCache } from './fractal';
import type { RenderMessage, RenderRequest } from './types';

let generation = 0;
const referenceCache: ReferenceCache = {};
const CANCELLED = Symbol('cancelled');
const send = (message: RenderMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer });

self.onmessage = ({ data }: MessageEvent<RenderRequest>) => {
  generation = data.id;
  void render(data).catch(error => {
    if (error !== CANCELLED) send({ type: 'error', id: data.id, message: String(error) });
  });
};

async function render(request: RenderRequest): Promise<void> {
  const started = performance.now();
  let lastYield = started;
  const checkpoint = async () => {
    if (generation !== request.id) throw CANCELLED;
    if (performance.now() - lastYield < 8) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    lastYield = performance.now();
    if (generation !== request.id) throw CANCELLED;
  };
  const { id, view, width, height, cssWidth, cssHeight, workerIndex, workerCount, iterations } = request;
  const sampler = await createSampler(view, cssWidth, cssHeight, iterations, checkpoint, referenceCache);
  // All passes sample the same world rectangle. Coarse pixels are replaced, not stretched forever.
  for (const step of [8, 4, 2, 1]) {
    const columns = Math.ceil(width / step), rows = Math.ceil(height / step);
    const tileSize = 32;
    const tilesX = Math.ceil(columns / tileSize), tilesY = Math.ceil(rows / tileSize);
    for (let tile = workerIndex; tile < tilesX * tilesY; tile += workerCount) {
      await checkpoint();
      const tx = (tile % tilesX) * tileSize, ty = Math.floor(tile / tilesX) * tileSize;
      const w = Math.min(tileSize, columns - tx), h = Math.min(tileSize, rows - ty);
      const pixels = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const x = Math.min(width - 0.5, (tx + col + 0.5) * step) / width * cssWidth - cssWidth / 2;
          const y = Math.min(height - 0.5, (ty + row + 0.5) * step) / height * cssHeight - cssHeight / 2;
          color(sampler.sample(x, y), pixels, (row * w + col) * 4);
        }
        await checkpoint();
      }
      send({ type: 'tile', id, x: tx * step, y: ty * step, width: w, height: h, step, pixels }, [pixels.buffer]);
    }
    send({ type: 'pass', id, step, elapsed: performance.now() - started, fallbacks: sampler.stats.fallbacks });
  }
}
