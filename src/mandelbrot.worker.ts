import { computeOrbit, createSampler, EXTENDED_LOG_SCALE, lastDistance, referenceFromOrbit, shadedWord } from './fractal.ts';
import type { ReferenceCache, ReferenceEntry } from './fractal';
import type { OrbitData, ReferenceSpec } from './reference';
import type { ReferencePlan, RenderCommand, RenderMessage, RenderRequest, TileData } from './types';

let generation = 0;
const referenceCache: ReferenceCache = {};
const CANCELLED = Symbol('cancelled');
/** Batch finished tiles; each main-thread message and canvas upload has a fixed cost. */
const FLUSH_MS = 16;
/** Spatial tile size in physical pixels; a multiple of the coarsest step (8). */
const TILE_SIZE = 32;
interface OwnTile { x: number; y: number; width: number; height: number; edgeRight: boolean; edgeBottom: boolean; previous?: Uint32Array; previousColumns: number }
const send = (message: RenderMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer });

/**
 * Let queued messages (new requests, cancels, orbits) run. setTimeout(0) is
 * clamped to >= 4 ms once nested, which left workers idle for a third of the
 * time between 8 ms work slices; a self-posted message has no such clamp.
 */
const yieldChannel = new MessageChannel();
const yieldWaiters: (() => void)[] = [];
yieldChannel.port1.onmessage = () => yieldWaiters.shift()?.();
const yieldToEvents = () => new Promise<void>(resolve => {
  yieldWaiters.push(resolve);
  yieldChannel.port2.postMessage(0);
});

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
    await yieldToEvents();
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
    const reference = await referenceFromOrbit(data, plan.spec.logRadius, referenceCheckpoint(plan.key),
      plan.spec.view.logScale <= EXTENDED_LOG_SCALE + 100);
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
    await yieldToEvents();
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
  // Each worker owns fixed spatial tiles through every pass. A block is sampled
  // at its top-left pixel centre, so every coarse sample is exactly a final
  // pixel: finer passes copy those (a quarter of their samples) instead of
  // recomputing them, and the finished image is identical to sampling every
  // pixel once (about 25% less work than independent passes).
  const tiles: OwnTile[] = [];
  let tileOffset = 0;
  for (const region of regions) {
    const tilesX = Math.ceil(region.width / TILE_SIZE), tilesY = Math.ceil(region.height / TILE_SIZE);
    for (let tile = (workerIndex - tileOffset % workerCount + workerCount) % workerCount; tile < tilesX * tilesY; tile += workerCount) {
      const tx = (tile % tilesX) * TILE_SIZE, ty = Math.floor(tile / tilesX) * TILE_SIZE;
      tiles.push({ x: region.x + tx, y: region.y + ty, width: Math.min(TILE_SIZE, region.width - tx),
        height: Math.min(TILE_SIZE, region.height - ty), previousColumns: 0,
        edgeRight: tx + TILE_SIZE >= region.width, edgeBottom: ty + TILE_SIZE >= region.height });
    }
    tileOffset += tilesX * tilesY;
  }
  const toCss = (pixel: number, size: number, css: number) => (pixel + 0.5) / size * css - css / 2;
  const xs = new Float64Array(TILE_SIZE), values = new Float64Array(TILE_SIZE), distances = new Float64Array(TILE_SIZE);
  const targets = new Int32Array(TILE_SIZE);
  // Distance estimates come in CSS pixels; outlines are measured in physical
  // ones, the same in every pass, so coarse previews match the final image.
  const physical = width / cssWidth;
  for (const step of [8, 4, 2, 1]) {
    let samples = 0;
    const unresolvedBefore = sampler?.stats.unresolved ?? 0;
    for (const tile of tiles) {
      await checkpoint();
      const columns = Math.ceil(tile.width / step), rows = Math.ceil(tile.height / step);
      const pixels = new Uint8ClampedArray(columns * rows * 4), words = new Uint32Array(pixels.buffer);
      const previous = tile.previous, previousColumns = tile.previousColumns;
      for (let row = 0; row < rows; row++) {
        const y = toCss(tile.y + row * step, height, cssHeight);
        // Even rows and columns coincide with the previous (twice as coarse) pass.
        const inherit = previous !== undefined && (row & 1) === 0;
        let count = 0;
        for (let col = inherit ? 1 : 0; col < columns; col += inherit ? 2 : 1) {
          targets[count] = col;
          xs[count++] = toCss(tile.x + col * step, width, cssWidth);
        }
        if (inherit) {
          for (let col = 0; col < columns; col += 2) words[row * columns + col] = previous[(row >> 1) * previousColumns + (col >> 1)];
        }
        if (count) {
          if (sampler!.row) sampler!.row(xs, count, y, values, distances);
          else for (let k = 0; k < count; k++) { values[k] = sampler!.sample(xs[k], y); distances[k] = lastDistance(); }
          for (let k = 0; k < count; k++) words[row * columns + targets[k]] = shadedWord(values[k], distances[k] * physical);
        }
        samples += count;
        await checkpoint();
      }
      // The pixel buffer is transferred below; keep a copy for the next pass.
      tile.previous = step > 1 ? words.slice() : undefined;
      tile.previousColumns = columns;
      batch.push({ x: tile.x, y: tile.y, width: columns, height: rows, clipWidth: tile.width, clipHeight: tile.height,
        edgeRight: tile.edgeRight, edgeBottom: tile.edgeBottom, step, pixels });
      transfer.push(pixels.buffer);
      if (performance.now() - lastFlush >= FLUSH_MS) flush();
    }
    await checkpoint();
    flush();
    send({ type: 'pass', id, step, elapsed: performance.now() - started, fallbacks: sampler?.stats.fallbacks ?? 0,
      samples, unresolved: (sampler?.stats.unresolved ?? 0) - unresolvedBefore });
  }
}
