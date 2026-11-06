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
// The first lap (n < 1020: dark blue, blue, cyan, white, gold, orange, red,
// violet) is the animation's exactly. Its laps then keep stretching with
// sqrt(n), so wherever counts grow slowly as you zoom, a whole view and many
// zoom levels sit inside a sliver of one lap: nearly one hue. After the first
// lap the rate therefore blends (C1, by n = 1500) into a logarithmic one:
// 4 laps each time n + 4 grows by a factor e, one lap per ~28% more
// iterations. A view whose counts spread by ~10% then shows about 0.4 of a
// lap at any depth, and colours keep cycling as counts rise while zooming.
// The mapping stays a fixed function of the count, so a point never changes
// colour on zoom.
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
/** sqrt(n + ROOT_OFFSET) advances by LAP_ROOT per gradient lap, as in the animation. */
const LAP_ROOT = 32;
const ROOT_OFFSET = 4;
/** Laps per e-fold of n + ROOT_OFFSET once fully logarithmic. */
export const LAPS_PER_E_FOLD = 4;
/** The rate blends from the animation's to the logarithmic one between these values of ln(n + 4). */
const BLEND_START = Math.log(LAP_ROOT * LAP_ROOT); // end of the first lap, n = 1020
const BLEND_END = Math.log(1500 + ROOT_OFFSET);

// Laps per unit of u = ln(n + 4): the animation's sqrt rate e^(u/2) / 64,
// smoothstepped into LAPS_PER_E_FOLD; integrated once (Simpson) into a table.
const BLEND_STEPS = 2048;
const blendRate = (u: number) => {
  const animation = Math.exp(u / 2) / (2 * LAP_ROOT);
  const t = Math.min(1, Math.max(0, (u - BLEND_START) / (BLEND_END - BLEND_START)));
  return animation + (LAPS_PER_E_FOLD - animation) * t * t * (3 - 2 * t);
};
const blendLaps = new Float64Array(BLEND_STEPS + 1);
blendLaps[0] = 1;
for (let i = 1; i <= BLEND_STEPS; i++) {
  const a = BLEND_START + (i - 1) * (BLEND_END - BLEND_START) / BLEND_STEPS;
  const b = BLEND_START + i * (BLEND_END - BLEND_START) / BLEND_STEPS;
  blendLaps[i] = blendLaps[i - 1] + (blendRate(a) + 4 * blendRate((a + b) / 2) + blendRate(b)) / 6 * (b - a);
}

/** Position on the gradient in laps (the fractional part is the turn). Continuous and increasing. */
export function lapsOf(value: number): number {
  const shifted = Math.max(0, value + ROOT_OFFSET);
  if (shifted <= LAP_ROOT * LAP_ROOT) return Math.sqrt(shifted) / LAP_ROOT;
  const u = Math.log(shifted);
  if (u >= BLEND_END) return blendLaps[BLEND_STEPS] + LAPS_PER_E_FOLD * (u - BLEND_END);
  const x = (u - BLEND_START) / (BLEND_END - BLEND_START) * BLEND_STEPS, i = Math.floor(x);
  return blendLaps[i] + (blendLaps[i + 1] - blendLaps[i]) * (x - i);
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

/**
 * After the first lap: where a turn lands on the gradient. About a quarter
 * of the gradient is dark (red at 0.8 through violet and dark blue-violet to
 * royal blue at 1.1, luminance under ~40), and a deep view whose counts sit
 * there looks almost black. Later laps pass through that stretch three times
 * faster (cosine-edged), so it stays as an accent between red and blue while
 * every other colour gets more of the lap. Turn 0 still lands on gradient 0,
 * so colours continue seamlessly from the first lap, which is unwarped.
 */
const DARK_FROM = 0.84, DARK_TO = 1.06, DARK_EDGE = 0.03, DARK_SPEEDUP = 3;
const darkWarp = (() => {
  const N = 4096, cumulative = new Float64Array(N + 1);
  const darkness = (g: number) => {
    const into = ((g - DARK_FROM) % 1 + 1) % 1, width = DARK_TO - DARK_FROM;
    const depth = into <= width ? Math.min(into, width - into) : -Math.min(into - width, 1 - into);
    return 0.5 + 0.5 * Math.max(-1, Math.min(1, depth / DARK_EDGE));
  };
  // Turn spent per unit of gradient: 1/DARK_SPEEDUP in the dark stretch, 1 elsewhere, normalised.
  for (let i = 1; i <= N; i++) {
    const dark = darkness((i - 0.5) / N);
    cumulative[i] = cumulative[i - 1] + (dark / DARK_SPEEDUP + 1 - dark) / N;
  }
  for (let i = 0; i <= N; i++) cumulative[i] /= cumulative[N];
  return (turn: number) => {
    let lo = 0, hi = N;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cumulative[mid] <= turn) lo = mid; else hi = mid; }
    return (lo + (turn - cumulative[lo]) / (cumulative[hi] - cumulative[lo])) / N;
  };
})();

function packTable(position: (turn: number) => number): Uint32Array {
  const table = new Uint32Array(SIZE), pixel = new Uint8ClampedArray(4), word = new Uint32Array(pixel.buffer);
  for (let i = 0; i < SIZE; i++) {
    const g = position(i / SIZE);
    for (let channel = 0; channel < 3; channel++) pixel[channel] = gradient(g - Math.floor(g), channel);
    pixel[3] = 255;
    table[i] = word[0];
  }
  return table;
}
/** First lap: the animation's gradient as is. Later laps: through the dark stretch faster. */
const packed = packTable(turn => turn);
const packedLater = packTable(darkWarp);
const INTERIOR_WORD = new Uint32Array(new Uint8ClampedArray([0, 0, 0, 255]).buffer)[0];

/** The pixel colour as a packed RGBA word (platform byte order, as a Uint32Array view of RGBA bytes). */
export function colorWord(value: number): number {
  // Only -1 is the sampler's interior sentinel. Far-away escaping points can
  // have other negative smooth counts and must retain the exterior colour.
  if (value === -1) return INTERIOR_WORD;
  const laps = lapsOf(value), index = Math.min(SIZE - 1, Math.floor((laps - Math.floor(laps)) * SIZE));
  return laps < 1 ? packed[index] : packedLater[index];
}

const scratch = new Uint32Array(1), scratchBytes = new Uint8Array(scratch.buffer);
export function color(value: number, pixels: Uint8ClampedArray, offset: number): void {
  scratch[0] = colorWord(value);
  pixels.set(scratchBytes, offset);
}
