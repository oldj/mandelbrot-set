/**
 * What a final pixel keeps besides its colour, so a palette switch can
 * recolour it: the smooth escape count (Float32, INTERIOR for interior) and
 * the outline distance. Only distances under half a pixel change a colour
 * (palette.ts EDGE_REACH), so they are kept as a byte: 0-254 over [0, 0.5),
 * 255 for farther or unknown. Workers shade from the kept values, so
 * recolouring gives exactly the colours a fresh render would.
 */
const LEVELS = 254, REACH = 0.5;

export function encodeDistance(distance: number): number {
  return distance < REACH ? Math.round(distance / REACH * LEVELS) : 255;
}

export function decodeDistance(level: number): number {
  return level === 255 ? Infinity : level / LEVELS * REACH;
}
