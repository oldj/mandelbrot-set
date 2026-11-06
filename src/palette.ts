// The colour scheme of Mandelbrot_sequence_new.gif, recovered from all 475
// frames of the animation (each frame's view fitted, every flat pixel paired
// with its escape count). https://commons.wikimedia.org/wiki/File:Mandelbrot_sequence_new.gif
//
// The animation colours a pixel by a single function of its smooth escape
// count n, the same in every frame (frames agree to within 0–3 RGB levels):
//
//   turn = frac(sqrt(n + 4) / 32)
//
// i.e. one gradient lap per 32 in sqrt(n + 4): n < 1020, then < 4092, < 9212 …
// The gradient holds the ten "golden" stop colours of the animation's
// generator (MandelAnimator.java, linked from the image page) at evenly spaced
// turns 0, 0.1 … 0.9, joined by a periodic Hermite spline whose slopes were
// fitted to the frames. Against the 512-bin gradient measured from the GIF the
// mean difference is 1.7 RGB levels (worst 5.8), about its own quantisation.
//
// The animation's counts end with its fifth lap (sqrt(n + 4) = 160). Beyond
// that, the phase keeps the rate it has there, a fixed lap of 10240
// iterations, instead of stretching further: deeper views keep the colour
// density of the animation's deepest frames. Phase and rate are continuous.
const STOPS: readonly (readonly [number, number, number])[] = [
  [14, 11, 82],
  [14, 60, 165],
  [78, 154, 220],
  [176, 229, 255],
  [249, 253, 239],
  [249, 229, 96],
  [249, 181, 15],
  [217, 108, 3],
  [134, 32, 13],
  [57, 4, 35],
];
/** Fitted Hermite slopes at each stop, per channel, in colour levels per stop interval. */
const SLOPES: readonly (readonly [number, number, number])[] = [
  [2, 32, 72],
  [-9, 25, 54],
  [105, 138, 66],
  [108, 57, 3],
  [18, 1, -80],
  [31, -23, -120],
  [13, -58, -34],
  [-69, -74, -11],
  [-75, -44, 6],
  [-86, -14, 16],
];
/** sqrt(n + ROOT_OFFSET) advances by LAP_ROOT per gradient lap. */
const LAP_ROOT = 32;
const ROOT_OFFSET = 4;
/** Where the animation's counts end: five whole laps. */
const LAST_ROOT = 5 * LAP_ROOT;
const LAST_COUNT = LAST_ROOT * LAST_ROOT - ROOT_OFFSET;
/** Iterations per lap beyond the animation's counts: the lap rate at LAST_COUNT. */
export const COLOR_PERIOD = 2 * LAP_ROOT * LAST_ROOT;

/** Position on the gradient, in laps, in [0, 1). */
function turnOf(value: number): number {
  if (value < LAST_COUNT) {
    const turn = Math.sqrt(Math.max(0, value + ROOT_OFFSET)) / LAP_ROOT;
    return turn - Math.floor(turn);
  }
  // LAST_ROOT is a whole number of laps; reduce exactly so the lap repeats exactly.
  return ((value - LAST_COUNT) % COLOR_PERIOD) / COLOR_PERIOD;
}

function gradient(turn: number, channel: number): number {
  const x = turn * STOPS.length, i = Math.floor(x) % STOPS.length, j = (i + 1) % STOPS.length;
  const t = x - Math.floor(x), t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * STOPS[i][channel] + (t3 - 2 * t2 + t) * SLOPES[i][channel]
    + (-2 * t3 + 3 * t2) * STOPS[j][channel] + (t3 - t2) * SLOPES[j][channel];
}

// Packed RGBA words: one lookup per pixel. 16384 entries per lap keep
// neighbouring entries within about one colour level of each other.
const SIZE = 16384;
const packed = new Uint32Array(SIZE);
{
  const pixel = new Uint8ClampedArray(4), word = new Uint32Array(pixel.buffer);
  for (let i = 0; i < SIZE; i++) {
    for (let channel = 0; channel < 3; channel++) pixel[channel] = gradient(i / SIZE, channel);
    pixel[3] = 255;
    packed[i] = word[0];
  }
}
const INTERIOR_WORD = new Uint32Array(new Uint8ClampedArray([0, 0, 0, 255]).buffer)[0];
const scratch = new Uint32Array(1), scratchBytes = new Uint8Array(scratch.buffer);

/** Continuous position on the gradient, in laps (the fractional part is the turn). */
export function lapsOf(value: number): number {
  if (value < LAST_COUNT) return Math.sqrt(Math.max(0, value + ROOT_OFFSET)) / LAP_ROOT;
  return LAST_ROOT / LAP_ROOT + (value - LAST_COUNT) / COLOR_PERIOD;
}

/**
 * Colour density for one view. Deep views often span only a sliver of a lap
 * (the animation's own deep frames are nearly one hue), so such a view may
 * run through its laps `stretch` times faster, around `anchor` (in laps):
 * the view's median keeps the animation's colour, the rest spreads out.
 * stretch 1 is the animation's colouring exactly.
 */
export interface ColorMapping { stretch: number; anchor: number }
export const ANIMATION_MAPPING: ColorMapping = { stretch: 1, anchor: 0 };

/** The pixel colour as a packed RGBA word (platform byte order, as a Uint32Array view of RGBA bytes). */
export function colorWord(value: number, mapping: ColorMapping = ANIMATION_MAPPING): number {
  // Only -1 is the sampler's interior sentinel. Far-away escaping points can
  // have other negative smooth counts and must retain the exterior colour.
  if (value === -1) return INTERIOR_WORD;
  let turn: number;
  if (mapping.stretch === 1) turn = turnOf(value);
  else {
    const laps = mapping.anchor + mapping.stretch * (lapsOf(value) - mapping.anchor);
    turn = laps - Math.floor(laps);
  }
  return packed[Math.min(SIZE - 1, Math.floor(turn * SIZE))];
}

export function sameMapping(a: ColorMapping, b: ColorMapping): boolean {
  return a.stretch === b.stretch && a.anchor === b.anchor;
}

/** RMS colour distance from the mean colour (RGB levels), interior counted as black. */
const MIN_SPREAD = 48;
const MAX_STRETCH_STEPS = 10; // stretch up to 2^5 = 32, in steps of sqrt(2)
const spreadBytes = scratchBytes;
export function colorSpread(values: ArrayLike<number>, mapping: ColorMapping): number {
  let r = 0, g = 0, b = 0, r2 = 0, g2 = 0, b2 = 0;
  for (let i = 0; i < values.length; i++) {
    scratch[0] = colorWord(values[i], mapping);
    const x = spreadBytes[0], y = spreadBytes[1], z = spreadBytes[2];
    r += x; g += y; b += z; r2 += x * x; g2 += y * y; b2 += z * z;
  }
  const n = values.length || 1;
  return Math.sqrt(Math.max(0, (r2 - r * r / n + g2 - g * g / n + b2 - b * b / n) / n / 3));
}

/**
 * The colour density for a view from its coarse samples (escape counts, -1
 * for interior). Views already varied enough keep the animation's colouring;
 * flatter ones get the smallest stretch that reaches MIN_SPREAD, anchored on
 * their median. Quantised (stretch in sqrt(2) steps, the anchor so it moves
 * colours by at most ~0.025 laps), so a view always gets the same mapping
 * and small changes of view do not shift colours.
 */
export function chooseMapping(values: ArrayLike<number>): ColorMapping {
  // A deterministic subsample keeps this cheap on the main thread.
  const stride = Math.max(1, Math.floor(values.length / 4096));
  const sample: number[] = [], escaped: number[] = [];
  for (let i = 0; i < values.length; i += stride) {
    sample.push(values[i]);
    if (values[i] !== -1) escaped.push(lapsOf(values[i]));
  }
  if (escaped.length < 64 || colorSpread(sample, ANIMATION_MAPPING) >= MIN_SPREAD) return ANIMATION_MAPPING;
  escaped.sort((a, b) => a - b);
  const median = escaped[escaped.length >> 1];
  let best = ANIMATION_MAPPING, bestSpread = -1;
  for (let k = 1; k <= MAX_STRETCH_STEPS; k++) {
    const stretch = 2 ** (k / 2), step = 0.05 / (stretch - 1);
    const mapping = { stretch, anchor: Math.round(median / step) * step };
    const spread = colorSpread(sample, mapping);
    if (spread >= MIN_SPREAD) return mapping;
    if (spread > bestSpread) { best = mapping; bestSpread = spread; }
  }
  return best;
}

export function color(value: number, pixels: Uint8ClampedArray, offset: number, mapping: ColorMapping = ANIMATION_MAPPING): void {
  scratch[0] = colorWord(value, mapping);
  pixels.set(scratchBytes, offset);
}
