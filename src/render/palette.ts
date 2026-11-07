import type { Palette } from './palette-names.ts';

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
const scratchClamped = new Uint8ClampedArray(scratch.buffer);

/**
 * Distance-estimate shading, as in many deep-zoom renderers: pixels within
 * half a pixel of the set's boundary are darkened, by up to 65% right on it.
 * Any fixed count-to-colour mapping lets some views fall into a stretch of
 * the gradient with little contrast (pale cyan to white, or dark violet),
 * where filaments vanish into the background; the darkened outlines bring
 * them back whatever the hue, keeping it (all channels scale together).
 * The distance comes from each pixel's own derivative, so there is no
 * neighbour noise, and is measured in screen pixels, so outlines look the
 * same at every depth. The hue stays a fixed function of the count. The
 * first lap (the animation's own colouring) is left as is, with the outlines
 * fading in over the second.
 */
const EDGE_REACH = 0.5, EDGE_DEPTH = 0.65;

/** The pixel colour with boundary shading; `distance` is the distance estimate in screen pixels (NaN if unknown). */
export function shadedWord(value: number, distance: number): number {
  if (value === -1) return INTERIOR_WORD;
  const laps = lapsOf(value), index = Math.min(SIZE - 1, Math.floor((laps - Math.floor(laps)) * SIZE));
  if (laps < 1) return packed[index];
  const word = packedLater[index];
  if (!(distance < EDGE_REACH)) return word;
  const keep = 1 - Math.min(1, laps - 1) * EDGE_DEPTH * (1 - Math.sqrt(distance / EDGE_REACH));
  scratch[0] = word;
  for (let c = 0; c < 3; c++) scratchClamped[c] = scratchClamped[c] * keep;
  return scratch[0];
}

export function color(value: number, pixels: Uint8ClampedArray, offset: number): void {
  scratch[0] = colorWord(value);
  pixels.set(scratchBytes, offset);
}

// The second palette, "vivid", after the colouring of Maths Town's "Eye of the
// Universe" zoom: a long cycle in which every stretch is a different hue
// family, so each depth has colours of its own, rather than one gradient
// that returns every lap. Frame by frame that video shows a hue-tinted dark,
// clean, saturated tones of one family and a tinted near white; the family
// changes as the counts rise, and filaments are coloured lines rather than
// grey ones. Here each family is four tones of one hue, built in OKLCH around
// the hue's gamut cusp (its most colourful lightness, so yellows are bright
// and blues deep, both at full colour): dark, cusp, brighter, pale. A short
// step from one family's pale tone to the next one's dark gives the
// alternating light and dark rings. Families follow the hues of its first
// minutes, from the periwinkle of the full view through cyan, copper, magenta,
// violet, crimson, blue, purple, rose, olive, green, gold, teal, orange, red,
// mint, indigo, lime, yellow and pink. It shares lapsOf with the classic
// palette (shallow views stay calm, deep ones advance by a fixed factor of the
// count), at VIVID_STOPS_PER_LAP tones per lap: a family per 2/3 of a lap,
// about six per e-fold of the count.
export const VIVID_HUES = [268, 220, 35, 320, 285, 15, 245, 300, 340, 100, 140, 55, 205, 45, 5, 165, 275, 120, 85, 350];
/** Each family's tones: [OKLab lightness, or the cusp's lightness plus an offset; share of the chroma in gamut there]. */
const VIVID_TONES: readonly [number | { cusp: number }, number][] = [[0.25, 0.8], [{ cusp: 0 }, 0.8], [{ cusp: 0.12 }, 0.7], [0.965, 0.35]];
/** No tone more colourful than this (OKLCH chroma): blues and violets at their cusp would glare. */
const VIVID_CHROMA_CAP = 0.18;
/** Width of each step on the position axis: dark → cusp, cusp → brighter, brighter → pale, pale → the next family's dark. */
const VIVID_STEPS = [1, 1, 1, 0.35];
export const VIVID_STOPS_PER_LAP = 6;
/** Where the lowest counts sit: 1.5 stops in, between the first family's cusp and brighter tones (a soft periwinkle). */
const VIVID_START = 1.5;

// OKLab and OKLCH (Björn Ottosson's), with sRGB in [0, 255].
const toLinear = (v: number) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toSrgb = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);
function oklab(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
/** Linear sRGB (0..1, possibly out of gamut) of an OKLab colour. */
function linearRgb([L, a, b]: readonly number[]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const lch = (L: number, C: number, hue: number): [number, number, number] => [L, C * Math.cos(hue * Math.PI / 180), C * Math.sin(hue * Math.PI / 180)];
const inGamut = (lab: readonly number[]) => linearRgb(lab).every(v => v >= -1e-4 && v <= 1 + 1e-4);
/** The most chroma sRGB allows at this lightness and hue. */
function maxChroma(L: number, hue: number): number {
  let low = 0, high = 0.4;
  for (let i = 0; i < 24; i++) { const mid = (low + high) / 2; if (inGamut(lch(L, mid, hue))) low = mid; else high = mid; }
  return low;
}
/** The lightness with the most chroma for this hue (its gamut cusp). */
function cuspLightness(hue: number): number {
  let best = 0.5, chroma = 0;
  for (let L = 0.3; L <= 0.95; L += 0.005) { const c = maxChroma(L, hue); if (c > chroma) { best = L; chroma = c; } }
  return best;
}

/** The vivid stops in OKLab, family by family from the first one's dark tone. */
const vividLab = VIVID_HUES.flatMap(hue => {
  const cusp = cuspLightness(hue);
  return VIVID_TONES.map(([lightness, share]) => {
    const L = typeof lightness === 'number' ? lightness : cusp + lightness.cusp;
    return lch(L, Math.min(VIVID_CHROMA_CAP, maxChroma(L, hue) * share), hue);
  });
});
/** The stops in sRGB (for tests and the menu's swatch). */
export const VIVID_STOPS: readonly (readonly number[])[] = vividLab.map(lab => linearRgb(lab).map(toSrgb));

/**
 * Within half a pixel of the boundary, the vivid palette moves the colour up to
 * 70% of the way to a deep tone of its own hue, rather than towards black:
 * darkening its pale tones would turn the filaments grey, where the video's
 * are coloured lines (deep teal on pale blue, crimson on pink, a lighter glow
 * on dark grounds).
 */
const VIVID_EDGE_DEPTH = 0.7;
const VIVID_OUTLINE_L = 0.32;
/** Outline tones are kept for every 16th colour entry: hue changes slowly along the cycle. */
const VIVID_EDGE_SHIFT = 4;
const VIVID_SIZE = 65536, VIVID_EDGE_SIZE = VIVID_SIZE >> VIVID_EDGE_SHIFT;
const packWord = (pixel: Uint8ClampedArray, word: Uint32Array, rgb: readonly number[]) => {
  pixel[0] = rgb[0]; pixel[1] = rgb[1]; pixel[2] = rgb[2]; pixel[3] = 255;
  return word[0];
};
const vividTables = (() => {
  const count = vividLab.length, widths = Array.from({ length: count }, (_, k) => VIVID_STEPS[k % VIVID_STEPS.length]);
  const total = widths.reduce((a, b) => a + b, 0);
  const colours = new Uint32Array(VIVID_SIZE), outlines = new Uint32Array(VIVID_EDGE_SIZE);
  const pixel = new Uint8ClampedArray(4), word = new Uint32Array(pixel.buffer);
  let segment = 0, start = 0;
  for (let i = 0; i < VIVID_SIZE; i++) {
    const x = i / VIVID_SIZE * total;
    while (x >= start + widths[segment]) start += widths[segment++];
    // Catmull-Rom through the neighbouring stops, in OKLab.
    const t = (x - start) / widths[segment], t2 = t * t, t3 = t2 * t;
    const p0 = vividLab[(segment - 1 + count) % count], p1 = vividLab[segment];
    const p2 = vividLab[(segment + 1) % count], p3 = vividLab[(segment + 2) % count];
    const mixed = [0, 1, 2].map(c => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2
      + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3));
    colours[i] = packWord(pixel, word, linearRgb(mixed).map(toSrgb));
    // Outlines are drawn towards a deep, saturated tone of the same hue.
    if ((i & ((1 << VIVID_EDGE_SHIFT) - 1)) === 0) {
      const hue = Math.atan2(mixed[2], mixed[1]) * 180 / Math.PI;
      outlines[i >> VIVID_EDGE_SHIFT] = packWord(pixel, word, linearRgb(lch(VIVID_OUTLINE_L, maxChroma(VIVID_OUTLINE_L, hue) * 0.9, hue)).map(toSrgb));
    }
  }
  return { colours, outlines };
})();
const outlineScratch = new Uint32Array(1), outlineBytes = new Uint8ClampedArray(outlineScratch.buffer);

/** The vivid colour with boundary outlines, as shadedWord (distance in screen pixels, NaN if unknown). */
export function vividWord(value: number, distance: number): number {
  if (value === -1) return INTERIOR_WORD;
  const cycle = vividLab.length;
  const position = (lapsOf(value) * VIVID_STOPS_PER_LAP + VIVID_START - lapsOf(0) * VIVID_STOPS_PER_LAP) / cycle;
  const index = Math.min(VIVID_SIZE - 1, Math.floor((position - Math.floor(position)) * VIVID_SIZE));
  const word = vividTables.colours[index];
  if (!(distance < EDGE_REACH)) return word;
  const amount = VIVID_EDGE_DEPTH * (1 - Math.sqrt(distance / EDGE_REACH));
  outlineScratch[0] = vividTables.outlines[index >> VIVID_EDGE_SHIFT];
  scratch[0] = word;
  for (let c = 0; c < 3; c++) scratchClamped[c] = scratchClamped[c] + (outlineBytes[c] - scratchClamped[c]) * amount;
  return scratch[0];
}

/** The shading function of a palette (classic when absent). */
export const paletteShader = (palette: Palette | undefined): (value: number, distance: number) => number =>
  palette === 'vivid' ? vividWord : shadedWord;
