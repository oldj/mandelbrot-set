/**
 * The protocol between the main thread and the render workers: render
 * requests (with the regions to compute and the shared reference plan),
 * reference orbits passed around, finished tiles and pass progress.
 */
import type { View } from '../math/precision.ts';
import type { OrbitData, ReferenceSpec } from '../fractal/reference.ts';
import type { Palette } from './palette-names.ts';

export interface RenderRegion { x: number; y: number; width: number; height: number }

/**
 * Deep views share one reference orbit. Worker 0 builds it (`build`) and posts
 * it to the main thread, which forwards it; other workers receive `orbit` up
 * front when the main thread already has it, otherwise they wait for it.
 */
export interface ReferencePlan {
  key: number;
  spec: ReferenceSpec;
  build?: boolean;
  orbit?: OrbitData;
}

/** Main thread -> worker: a shared orbit, delivered whenever it becomes available. */
export interface ReferenceDelivery { type: 'reference'; key: number; spec: ReferenceSpec; orbit: OrbitData }

/**
 * Main thread -> worker: render `id` (under way, or finished and perhaps to be
 * deepened) continues in another palette; tiles started from now on use it.
 */
export interface PaletteSwitch { type: 'palette'; id: number; palette: Palette }

/**
 * Main thread -> worker: sample exactly the listed pixels (indices y width + x
 * into the surface) of render `id`, the ones GPU rendering left to the CPU.
 */
export interface PixelRequest {
  type: 'pixels';
  id: number;
  view: View;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  iterations: number;
  reference?: ReferencePlan;
  pixels: Uint32Array<ArrayBuffer>;
  /** Echoed in the samples, so a render tells its rounds of requests apart. */
  round: number;
  /**
   * Only build the shared orbit (and its tables), for the GPU: no pixels, and
   * no samples message, which a round under way could take for one of its own.
   */
  orbitOnly?: boolean;
}

export type RenderCommand = RenderRequest | PixelRequest | ReferenceDelivery | PaletteSwitch | { type: 'cancel'; id: number };

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
  reference?: ReferencePlan;
  /** The colour scheme (classic when absent). */
  palette?: Palette;
  /**
   * Resample only the pixels the finished render `id` left unresolved, at
   * `iterations` (more than before), and send their tiles again.
   */
  deepen?: boolean;
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
  /** Whether the tile ends at its region's right / bottom edge (its last samples stretch to it). */
  edgeRight?: boolean;
  edgeBottom?: boolean;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  /**
   * Each sample's smooth escape count (INTERIOR for interior) and outline
   * distance as a level (see samples.ts), from which any palette gives its
   * colour: kept so a palette switch need not compute anything again.
   */
  counts?: Float32Array<ArrayBuffer>;
  distances?: Uint8Array<ArrayBuffer>;
  /** The palette `pixels` are in. */
  palette?: Palette;
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
  /** Samples this worker computed in the pass, and how many reached the budget unresolved. */
  samples: number;
  unresolved: number;
  /** Time spent sampling in the pass, and the part of it spent on the unresolved samples (ms). */
  sampleMs?: number;
  unresolvedMs?: number;
  /** After the final pass or a deepening: this worker's final pixels still unresolved. */
  pending?: number;
  /** Progress of a `deepen` request rather than of a pass. */
  deepen?: boolean;
}

/** Worker -> main thread: the orbit a `build` plan produced. */
export interface ReferenceBuilt { type: 'reference'; key: number; orbit: OrbitData }

/**
 * Worker -> main thread: exact samples of a PixelRequest's pixels, batched;
 * `done` on the last batch, with how many reached the budget unresolved.
 */
export interface PixelSamples {
  type: 'samples';
  id: number;
  /** The request's round. */
  round: number;
  indices: Uint32Array<ArrayBuffer>;
  /** Smooth escape counts (INTERIOR for interior) and outline distance levels (see samples.ts). */
  counts: Float32Array<ArrayBuffer>;
  distances: Uint8Array<ArrayBuffer>;
  /** 1 where the sample reached the budget neither escaped nor proved interior. */
  unresolved: Uint8Array<ArrayBuffer>;
  done?: { samples: number; unresolved: number; fallbacks: number };
}

export type RenderMessage = ReferenceBuilt | RenderTiles | RenderProgress | PixelSamples | { type: 'error'; id: number; message: string };
