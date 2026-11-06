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

/** The pixel colour as a packed RGBA word (platform byte order, as a Uint32Array view of RGBA bytes). */
export function colorWord(value: number): number {
  // Only -1 is the sampler's interior sentinel. Far-away escaping points can
  // have other negative smooth counts and must retain the exterior colour.
  if (value === -1) return INTERIOR_WORD;
  return packed[Math.min(SIZE - 1, Math.floor(turnOf(value) * SIZE))];
}

const scratch = new Uint32Array(1), scratchBytes = new Uint8Array(scratch.buffer);
export function color(value: number, pixels: Uint8ClampedArray, offset: number): void {
  scratch[0] = colorWord(value);
  pixels.set(scratchBytes, offset);
}
