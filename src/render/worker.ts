/**
 * A render worker. It owns fixed 32-pixel tiles of each request and samples
 * them in passes of 8, 4, 2 and 1 pixels, reusing every coarser sample and
 * shading each pixel by its escape count and distance estimate. Deep views
 * share one reference orbit: worker 0 computes it, the main thread forwards it.
 * Work yields every ~8 ms, so newer requests cancel older ones promptly.
 *
 * Pixels that reach the budget unresolved are remembered per tile. A later
 * `deepen` request for the same render resamples just those at a larger
 * budget, so the main thread can show the finished draft first and raise the
 * budget only where it is needed.
 */
import { computeOrbit, createSampler, EXTENDED_LOG_SCALE, lastDistance, lastUnresolved, referenceFromOrbit } from '../fractal/index.ts';
import { paletteShader } from './palette.ts';
import { decodeDistance, encodeDistance } from './samples.ts';
import type { ReferenceCache, ReferenceEntry } from '../fractal/index.ts';
import type { OrbitData, ReferenceSpec } from '../fractal/reference.ts';
import type { PixelRequest, PixelSamples, ReferencePlan, RenderCommand, RenderMessage, RenderRequest, TileData } from './messages.ts';
import type { Palette } from './palette-names.ts';

let generation = 0;
/** A palette switch for a render under way (or finished, for its deepening): tiles started after it use it. */
let switched: { id: number; palette: Palette } | undefined;
const referenceCache: ReferenceCache = {};
const CANCELLED = Symbol('cancelled');
/** Batch finished tiles; each main-thread message and canvas upload has a fixed cost. */
const FLUSH_MS = 16;
/** Spatial tile size in physical pixels; a multiple of the coarsest step (8). */
const TILE_SIZE = 32;
interface OwnTile {
  x: number; y: number; width: number; height: number; edgeRight: boolean; edgeBottom: boolean;
  /** The previous pass's colours, escape counts and outline distances (physical pixels), which the next pass inherits. */
  previous?: Uint32Array; previousCounts?: Float32Array; previousDistances?: Uint8Array; previousColumns: number;
  /** The palette its colours (previous, final) are in. */
  palette?: Palette;
  /** 1 for final pixels that reached the budget unresolved (allocated on the first one), and the tile's final samples. */
  pending?: Uint8Array; final?: Uint32Array; finalCounts?: Float32Array; finalDistances?: Uint8Array;
}
/** The last finished render: its request and the tiles that still have unresolved pixels. */
let finished: { request: RenderRequest; tiles: OwnTile[] } | undefined;
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
  if ('type' in data && data.type === 'palette') {
    switched = { id: data.id, palette: data.palette };
    return;
  }
  if ('type' in data && data.type === 'reference') {
    orbit = { key: data.key, spec: data.spec, data: data.orbit };
    if (waiting?.key === data.key) { waiting.resolve(); waiting = undefined; }
    return;
  }
  generation = data.id;
  wantedKey = 'type' in data && data.type !== 'pixels' ? undefined : data.reference?.key;
  if (waiting && waiting.key !== wantedKey) { waiting.reject(CANCELLED); waiting = undefined; }
  if ('type' in data && data.type === 'pixels') {
    void samplePixels(data).catch(error => { if (error !== CANCELLED) send({ type: 'error', id: data.id, message: String(error) }); });
    return;
  }
  if ('type' in data) return;
  void (data.deepen ? deepen(data) : render(data)).catch(error => {
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
  const palette = () => switched?.id === id ? switched.palette : request.palette ?? 'classic';
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
  // Nearest the canvas centre first, in every pass: what people look at sharpens first. Each
  // worker still owns tiles spread over the whole canvas, so they share the centre's work too.
  const centreX = width / 2, centreY = height / 2;
  const distance = (tile: OwnTile) => (tile.x + tile.width / 2 - centreX) ** 2 + (tile.y + tile.height / 2 - centreY) ** 2;
  tiles.sort((a, b) => distance(a) - distance(b));
  const toCss = (pixel: number, size: number, css: number) => (pixel + 0.5) / size * css - css / 2;
  const xs = new Float64Array(TILE_SIZE), values = new Float64Array(TILE_SIZE), distances = new Float64Array(TILE_SIZE);
  const targets = new Int32Array(TILE_SIZE), unresolved = new Uint8Array(TILE_SIZE);
  if (finished?.request.id !== id) finished = undefined;
  // Distance estimates come in CSS pixels; outlines are measured in physical
  // ones, the same in every pass, so coarse previews match the final image.
  const physical = width / cssWidth;
  for (const step of [8, 4, 2, 1]) {
    let samples = 0;
    const unresolvedBefore = sampler?.stats.unresolved ?? 0;
    // Time spent sampling in this pass, and the part of it that went into samples left unresolved:
    // the main thread raises the budget at once when that part is small (see main.ts).
    let sampleMs = 0, unresolvedMs = 0;
    for (const tile of tiles) {
      await checkpoint();
      const columns = Math.ceil(tile.width / step), rows = Math.ceil(tile.height / step);
      // The palette at the tile's start colours all of it, and the tile says which it was.
      const tilePalette = palette(), shade = paletteShader(tilePalette);
      const pixels = new Uint8ClampedArray(columns * rows * 4), words = new Uint32Array(pixels.buffer);
      // Each sample's escape count and distance too: final tiles carry them, so the main thread can recolour.
      const counts = new Float32Array(columns * rows), edges = new Uint8Array(columns * rows);
      const previous = tile.previous, previousColumns = tile.previousColumns, samePalette = tile.palette === tilePalette;
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
          // Inherited samples are shaded again: the previous pass may have used another palette.
          for (let col = 0; col < columns; col += 2) {
            const from = (row >> 1) * previousColumns + (col >> 1), to = row * columns + col;
            counts[to] = tile.previousCounts![from]; edges[to] = tile.previousDistances![from];
            words[to] = samePalette ? previous[from] : shade(counts[to], decodeDistance(edges[to]));
          }
        }
        if (count) {
          if (sampler!.row) {
            const before = performance.now();
            sampler!.row(xs, count, y, values, distances, unresolved);
            const rowMs = performance.now() - before;
            // A row is sampled in one call: share its time out by iterations (an unresolved sample ran them all).
            let all = 0, left = 0;
            for (let k = 0; k < count; k++) { const work = unresolved[k] ? iterations : Math.max(1, values[k]); all += work; if (unresolved[k]) left += work; }
            sampleMs += rowMs; unresolvedMs += rowMs * left / all;
          } else {
            for (let k = 0; k < count; k++) {
              const before = performance.now();
              values[k] = sampler!.sample(xs[k], y); distances[k] = lastDistance(); unresolved[k] = lastUnresolved() ? 1 : 0;
              const sampleTime = performance.now() - before;
              sampleMs += sampleTime;
              if (unresolved[k]) unresolvedMs += sampleTime;
            }
          }
          for (let k = 0; k < count; k++) {
            // Shaded from the kept values (see samples.ts), so recolouring them later gives exactly these colours.
            const at = row * columns + targets[k];
            counts[at] = values[k]; edges[at] = encodeDistance(distances[k] * physical);
            words[at] = shade(counts[at], decodeDistance(edges[at]));
            if (unresolved[k]) (tile.pending ??= new Uint8Array(tile.width * tile.height))[row * step * tile.width + targets[k] * step] = 1;
          }
        }
        samples += count;
        await checkpoint();
      }
      // The pixel buffer is transferred below; keep a copy for the next pass, or for deepening.
      tile.previous = step > 1 ? words.slice() : undefined;
      tile.previousCounts = step > 1 ? counts : undefined;
      tile.previousDistances = step > 1 ? edges : undefined;
      if (step === 1 && tile.pending) { tile.final = words.slice(); tile.finalCounts = counts.slice(); tile.finalDistances = edges.slice(); }
      tile.previousColumns = columns;
      tile.palette = tilePalette;
      batch.push({ x: tile.x, y: tile.y, width: columns, height: rows, clipWidth: tile.width, clipHeight: tile.height,
        edgeRight: tile.edgeRight, edgeBottom: tile.edgeBottom, step, pixels, palette: tilePalette,
        // Coarse passes keep theirs for the next pass: send copies.
        counts: step === 1 ? counts : counts.slice(), distances: step === 1 ? edges : edges.slice() });
      transfer.push(pixels.buffer);
      transfer.push(batch.at(-1)!.counts!.buffer, batch.at(-1)!.distances!.buffer);
      if (performance.now() - lastFlush >= FLUSH_MS) flush();
    }
    await checkpoint();
    flush();
    if (step === 1) finished = { request, tiles: tiles.filter(tile => tile.pending) };
    send({ type: 'pass', id, step, elapsed: performance.now() - started, fallbacks: sampler?.stats.fallbacks ?? 0,
      samples, unresolved: (sampler?.stats.unresolved ?? 0) - unresolvedBefore, sampleMs, unresolvedMs,
      pending: step === 1 ? countPending(finished!.tiles) : undefined });
  }
}

function countPending(tiles: OwnTile[]): number {
  let total = 0;
  for (const tile of tiles) for (const flag of tile.pending!) total += flag;
  return total;
}

/**
 * Resample the unresolved pixels of the finished render `request.id` at the
 * larger `request.iterations`, and send each changed tile again (at step 1,
 * so it replaces the old one). Samples are exactly those of a fresh render at
 * that budget, so the result matches rendering it directly.
 */
async function deepen(request: RenderRequest): Promise<void> {
  const started = performance.now();
  let lastYield = started;
  const checkpoint = async () => {
    if (generation !== request.id) throw CANCELLED;
    if (performance.now() - lastYield < 8) return;
    await yieldToEvents();
    lastYield = performance.now();
    if (generation !== request.id) throw CANCELLED;
  };
  const { id, view, width, height, cssWidth, cssHeight, iterations, reference } = request;
  const palette = () => switched?.id === id ? switched.palette : request.palette ?? 'classic';
  const tiles = finished?.request.id === id ? finished.tiles : [];
  const source = reference && (() => sharedReference(reference));
  // Worker 0 builds a longer shared orbit even without pixels of its own to deepen: the others wait for it.
  const sampler = tiles.length || reference?.build
    ? await createSampler(view, cssWidth, cssHeight, iterations, checkpoint, referenceCache, source) : undefined;
  const toCss = (pixel: number, size: number, css: number) => (pixel + 0.5) / size * css - css / 2;
  const xs = new Float64Array(TILE_SIZE), values = new Float64Array(TILE_SIZE), distances = new Float64Array(TILE_SIZE);
  const targets = new Int32Array(TILE_SIZE), unresolved = new Uint8Array(TILE_SIZE), physical = width / cssWidth;
  let batch: TileData[] = [], transfer: ArrayBuffer[] = [], lastFlush = started, samples = 0;
  const flush = () => {
    if (batch.length) send({ type: 'tiles', id, tiles: batch }, transfer);
    batch = []; transfer = []; lastFlush = performance.now();
  };
  for (const tile of tiles) {
    await checkpoint();
    const pending = tile.pending!, words = tile.final!, counts = tile.finalCounts!, edges = tile.finalDistances!;
    const tilePalette = palette(), shade = paletteShader(tilePalette);
    // Its kept final colours may be in another palette: shade them all again.
    if (tile.palette !== tilePalette) for (let i = 0; i < words.length; i++) words[i] = shade(counts[i], decodeDistance(edges[i]));
    tile.palette = tilePalette;
    for (let row = 0; row < tile.height; row++) {
      let count = 0;
      for (let col = 0; col < tile.width; col++) {
        if (!pending[row * tile.width + col]) continue;
        targets[count] = col;
        xs[count++] = toCss(tile.x + col, width, cssWidth);
      }
      if (!count) continue;
      const y = toCss(tile.y + row, height, cssHeight);
      if (sampler!.row) sampler!.row(xs, count, y, values, distances, unresolved);
      else for (let k = 0; k < count; k++) { values[k] = sampler!.sample(xs[k], y); distances[k] = lastDistance(); unresolved[k] = lastUnresolved() ? 1 : 0; }
      for (let k = 0; k < count; k++) {
        const at = row * tile.width + targets[k];
        counts[at] = values[k]; edges[at] = encodeDistance(distances[k] * physical);
        words[at] = shade(counts[at], decodeDistance(edges[at]));
        pending[at] = unresolved[k];
      }
      samples += count;
      await checkpoint();
    }
    const pixels = new Uint8ClampedArray(words.slice().buffer), sentCounts = counts.slice(), sentDistances = edges.slice();
    batch.push({ x: tile.x, y: tile.y, width: tile.width, height: tile.height, clipWidth: tile.width, clipHeight: tile.height,
      edgeRight: tile.edgeRight, edgeBottom: tile.edgeBottom, step: 1, pixels, palette: tilePalette, counts: sentCounts, distances: sentDistances });
    transfer.push(pixels.buffer, sentCounts.buffer, sentDistances.buffer);
    if (performance.now() - lastFlush >= FLUSH_MS) flush();
  }
  await checkpoint();
  flush();
  const left = tiles.filter(tile => tile.pending!.some(flag => flag));
  if (finished?.request.id === id) finished = { request: { ...request, deepen: undefined }, tiles: left };
  send({ type: 'pass', id, step: 1, deepen: true, elapsed: performance.now() - started, fallbacks: sampler?.stats.fallbacks ?? 0,
    samples, unresolved: sampler?.stats.unresolved ?? 0, pending: countPending(left) });
}

/**
 * Sample exactly the pixels a GPU render left to the CPU (see main.ts), in
 * the order given, and send their counts and distance levels in batches.
 */
async function samplePixels(request: PixelRequest): Promise<void> {
  let lastYield = performance.now();
  const checkpoint = async () => {
    if (generation !== request.id) throw CANCELLED;
    if (performance.now() - lastYield < 8) return;
    await yieldToEvents();
    lastYield = performance.now();
    if (generation !== request.id) throw CANCELLED;
  };
  const { id, round, view, width, height, cssWidth, cssHeight, iterations, reference, pixels, orbitOnly } = request;
  const source = reference && (() => sharedReference(reference));
  // Worker 0 builds the shared orbit even without pixels of its own: the others wait for it.
  const sampler = pixels.length || reference?.build
    ? await createSampler(view, cssWidth, cssHeight, iterations, checkpoint, referenceCache, source) : undefined;
  if (orbitOnly) return;
  const physical = width / cssWidth, toCss = (pixel: number, size: number, css: number) => (pixel + 0.5) / size * css - css / 2;
  let start = 0, lastFlush = performance.now(), unresolved = 0;
  const counts = new Float32Array(pixels.length), distances = new Uint8Array(pixels.length), flags = new Uint8Array(pixels.length);
  const flush = (end: number, done?: PixelSamples['done']) => {
    const indices = pixels.slice(start, end), batchCounts = counts.slice(start, end), batchDistances = distances.slice(start, end);
    const batchFlags = flags.slice(start, end);
    send({ type: 'samples', id, round, indices, counts: batchCounts, distances: batchDistances, unresolved: batchFlags, done },
      [indices.buffer, batchCounts.buffer, batchDistances.buffer, batchFlags.buffer]);
    start = end; lastFlush = performance.now();
  };
  for (let k = 0; k < pixels.length; k++) {
    const index = pixels[k], x = index % width, y = (index - x) / width;
    counts[k] = sampler!.sample(toCss(x, width, cssWidth), toCss(y, height, cssHeight));
    distances[k] = encodeDistance(lastDistance() * physical);
    if (lastUnresolved()) { unresolved++; flags[k] = 1; }
    await checkpoint();
    if (performance.now() - lastFlush >= FLUSH_MS) flush(k + 1);
  }
  flush(pixels.length, { samples: pixels.length, unresolved, fallbacks: sampler?.stats.fallbacks ?? 0 });
}
