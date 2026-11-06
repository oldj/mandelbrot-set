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
  const regions = request.regions ?? [{ x: 0, y: 0, width, height }];
  const sampler = regions.length ? await createSampler(view, cssWidth, cssHeight, iterations, checkpoint, referenceCache) : undefined;
  // All passes sample the same world rectangle. Coarse pixels are replaced, not stretched forever.
  for (const step of [8, 4, 2, 1]) {
    let tileOffset = 0;
    for (const region of regions) {
      const columns = Math.ceil(region.width / step), rows = Math.ceil(region.height / step);
      const tileSize = 32;
      const tilesX = Math.ceil(columns / tileSize), tilesY = Math.ceil(rows / tileSize);
      for (let tile = (workerIndex - tileOffset % workerCount + workerCount) % workerCount; tile < tilesX * tilesY; tile += workerCount) {
        await checkpoint();
        const tx = (tile % tilesX) * tileSize, ty = Math.floor(tile / tilesX) * tileSize;
        const w = Math.min(tileSize, columns - tx), h = Math.min(tileSize, rows - ty);
        const pixels = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const x = (region.x + Math.min(region.width - 0.5, (tx + col + 0.5) * step)) / width * cssWidth - cssWidth / 2;
            const y = (region.y + Math.min(region.height - 0.5, (ty + row + 0.5) * step)) / height * cssHeight - cssHeight / 2;
            color(sampler!.sample(x, y), pixels, (row * w + col) * 4);
          }
          await checkpoint();
        }
        send({ type: 'tile', id, x: region.x + tx * step, y: region.y + ty * step, width: w, height: h,
          clipWidth: Math.min(region.width - tx * step, w * step), clipHeight: Math.min(region.height - ty * step, h * step),
          step, pixels }, [pixels.buffer]);
      }
      tileOffset += tilesX * tilesY;
    }
    await checkpoint();
    send({ type: 'pass', id, step, elapsed: performance.now() - started, fallbacks: sampler?.stats.fallbacks ?? 0 });
  }
}
