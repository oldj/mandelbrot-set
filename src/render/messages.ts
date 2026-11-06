/**
 * The protocol between the main thread and the render workers: render
 * requests (with the regions to compute and the shared reference plan),
 * reference orbits passed around, finished tiles and pass progress.
 */
import type { View } from '../math/precision.ts';
import type { OrbitData, ReferenceSpec } from '../fractal/reference.ts';

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

export type RenderCommand = RenderRequest | ReferenceDelivery | { type: 'cancel'; id: number };

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
  /** After the final pass or a deepening: this worker's final pixels still unresolved. */
  pending?: number;
  /** Progress of a `deepen` request rather than of a pass. */
  deepen?: boolean;
}

/** Worker -> main thread: the orbit a `build` plan produced. */
export interface ReferenceBuilt { type: 'reference'; key: number; orbit: OrbitData }

export type RenderMessage = ReferenceBuilt | RenderTiles | RenderProgress | { type: 'error'; id: number; message: string };
