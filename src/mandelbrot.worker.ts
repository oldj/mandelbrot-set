import { color, computeOrbit, createSampler, referenceFromOrbit } from './fractal.ts';
import type { ReferenceCache, ReferenceEntry } from './fractal';
import type { OrbitData, ReferenceSpec } from './reference';
import type { ReferencePlan, RenderCommand, RenderMessage, RenderRequest, TileData } from './types';

let generation = 0;
const referenceCache: ReferenceCache = {};
const CANCELLED = Symbol('cancelled');
/** Batch finished tiles; each main-thread message and canvas upload has a fixed cost. */
const FLUSH_MS = 16;
const send = (message: RenderMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer });

// Shared reference state. Work on a reference is tied to its key, not to one
// render: a newer request for the same key continues it instead of restarting.
let wantedKey: number | undefined;
let orbit: { key: number; spec: ReferenceSpec; data: OrbitData } | undefined;
let shared: { key: number; promise: Promise<ReferenceEntry> } | undefined;
let waiting: { key: number; resolve: () => void; reject: (reason: unknown) => void } | undefined;

self.onmessage = ({ data }: MessageEvent<RenderCommand>) => {
  if ('type' in data && data.type === 'reference') {
    orbit = { key: data.key, spec: data.spec, data: data.orbit };
    if (waiting?.key === data.key) { waiting.resolve(); waiting = undefined; }
    return;
  }
  generation = data.id;
  wantedKey = 'type' in data ? undefined : data.reference?.key;
  if (waiting && waiting.key !== wantedKey) { waiting.reject(CANCELLED); waiting = undefined; }
  if ('type' in data) return;
  void render(data).catch(error => {
    if (error !== CANCELLED) send({ type: 'error', id: data.id, message: String(error) });
  });
};

/** Yield regularly, and stop once no request needs this reference any more. */
function referenceCheckpoint(key: number) {
  let lastYield = performance.now();
  return async () => {
    if (wantedKey !== key) throw CANCELLED;
    if (performance.now() - lastYield < 8) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    lastYield = performance.now();
    if (wantedKey !== key) throw CANCELLED;
  };
}

async function receiveOrbit(plan: ReferencePlan): Promise<OrbitData> {
  if (orbit?.key === plan.key) return orbit.data;
  if (plan.orbit) {
    orbit = { key: plan.key, spec: plan.spec, data: plan.orbit };
    return plan.orbit;
  }
  const checkpoint = referenceCheckpoint(plan.key);
  if (plan.build) {
    const data = await computeOrbit(plan.spec.view, plan.spec.limit, checkpoint);
    orbit = { key: plan.key, spec: plan.spec, data };
    send({ type: 'reference', key: plan.key, orbit: data });
    return data;
  }
  waiting?.reject(CANCELLED);
  await new Promise<void>((resolve, reject) => { waiting = { key: plan.key, resolve, reject }; });
  return orbit!.data;
}

/** One reference (orbit plus BLA table) per key, however many renders ask for it. */
function sharedReference(plan: ReferencePlan): Promise<ReferenceEntry> {
  if (shared?.key === plan.key) return shared.promise;
  const promise = (async () => {
    const data = await receiveOrbit(plan);
    const reference = await referenceFromOrbit(data, plan.spec.logRadius, referenceCheckpoint(plan.key));
    return { ...plan.spec, reference };
  })();
  const current = { key: plan.key, promise };
  shared = current;
  // A cancelled build may be requested again later; keep the received orbit, drop the promise.
  promise.catch(() => { if (shared === current) shared = undefined; });
  return promise;
}

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
  let batch: TileData[] = [], transfer: ArrayBuffer[] = [], lastFlush = started;
  const flush = () => {
    if (batch.length) send({ type: 'tiles', id, tiles: batch }, transfer);
    batch = []; transfer = []; lastFlush = performance.now();
  };
  const { reference } = request;
  const source = reference && (() => sharedReference(reference));
  const sampler = regions.length ? await createSampler(view, cssWidth, cssHeight, iterations, checkpoint, referenceCache, source) : undefined;
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
        batch.push({ x: region.x + tx * step, y: region.y + ty * step, width: w, height: h,
          clipWidth: Math.min(region.width - tx * step, w * step), clipHeight: Math.min(region.height - ty * step, h * step),
          step, pixels });
        transfer.push(pixels.buffer);
        if (performance.now() - lastFlush >= FLUSH_MS) flush();
      }
      tileOffset += tilesX * tilesY;
    }
    await checkpoint();
    flush();
    send({ type: 'pass', id, step, elapsed: performance.now() - started, fallbacks: sampler?.stats.fallbacks ?? 0 });
  }
}
