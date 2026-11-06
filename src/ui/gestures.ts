/** Turning wheel and pointer input into view changes (see transformView in math/precision.ts). */
import type { Point } from '../math/precision.ts';

export interface Bounds { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** The wheel's zoom anchor relative to the canvas centre: the pointer, or the centre when it is outside. */
export function wheelAnchor(clientX: number, clientY: number, rect: Bounds): Point {
  const inside = clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom;
  return inside ? { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 } : { x: 0, y: 0 };
}

/** log2 of the scale change for a wheel delta (lines and pages converted to pixels, large jumps capped). */
export function wheelLogFactor(delta: number, mode: number, height: number): number {
  const unit = mode === 1 ? 16 : mode === 2 ? height : 1;
  return Math.max(-600, Math.min(600, delta * unit)) * 0.002 / Math.LN2;
}

/** Centre and spread of the active pointers: pan with one, pinch-zoom about the midpoint with two. */
export function gesture(points: Iterable<Point>): { centre: Point; distance: number } | undefined {
  const [a, b] = points;
  if (!a) return undefined;
  if (!b) return { centre: a, distance: 0 };
  return { centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
}
