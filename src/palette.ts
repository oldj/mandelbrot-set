// Golden/blue hues referenced from the 475-frame Mandelbrot_sequence_new.gif
// and its linked palette source. Stop spacing is calibrated to the supplied
// frames, not a claim to reproduce the animation's original rendering pipeline.
// https://commons.wikimedia.org/wiki/File:Mandelbrot_sequence_new.gif
// https://github.com/josch/mandelbrot_zomb/blob/master/src/deepZoom/MandelAnimator.java
const STOPS = [
  [0, 14, 44, 138],
  [10, 14, 60, 165],
  [36, 78, 154, 220],
  [90, 176, 229, 255],
  [140, 249, 253, 239],
  [260, 249, 229, 96],
  [400, 249, 181, 15],
  [550, 217, 108, 3],
  [680, 134, 32, 13],
  [850, 57, 4, 35],
  [960, 14, 3, 65],
  [1024, 14, 11, 82],
  [1122.25, 14, 44, 138],
] as const;

// Keep the reference's broad shallow hues, but do not let escape-time bands
// keep widening in deep views. Palette shape and recurrence are independent.
const phaseAt = (value: number) => Math.sqrt(value);
const CYCLE = 33.5;
const TRANSITION_START = 144;
const TRANSITION_END = 512;
const TRANSITION_LENGTH = TRANSITION_END - TRANSITION_START;
const START_PHASE = phaseAt(TRANSITION_START);
const START_SLOPE = 1 / (2 * START_PHASE);
/** Fixed deep-view period, independent of absolute iteration count or zoom. */
export const COLOR_PERIOD = 128;
const END_SLOPE = CYCLE / COLOR_PERIOD;
const END_PHASE = START_PHASE + TRANSITION_LENGTH * (START_SLOPE + END_SLOPE) / 2;

function escapePhase(value: number): number {
  if (value <= TRANSITION_START) return phaseAt(Math.max(0, value));
  if (value >= TRANSITION_END) {
    // Reduce before multiplying to preserve phase at very large counts.
    return END_PHASE + ((value - TRANSITION_END) % COLOR_PERIOD) * END_SLOPE;
  }
  const distance = value - TRANSITION_START;
  const t = distance / TRANSITION_LENGTH;
  // Integrate a smoothstep change in frequency. Phase and its first derivative
  // agree at both joins; no abrupt colour change as iteration counts increase.
  return START_PHASE + START_SLOPE * distance
    + (END_SLOPE - START_SLOPE) * TRANSITION_LENGTH * (t ** 3 - t ** 4 / 2);
}

const positions = STOPS.map(stop => phaseAt(stop[0]));
const segments = STOPS.length - 1;
const intervals = positions.slice(1).map((position, i) => position - positions[i]);
// Periodic monotone cubic interpolation: no overshoot or muddy artificial hues,
// and the derivative agrees on both sides of the wrap.
const slopes = [1, 2, 3].map(channel => {
  const secants = intervals.map((width, i) => (STOPS[i + 1][channel] - STOPS[i][channel]) / width);
  return intervals.map((width, i) => {
    const previous = (i + segments - 1) % segments;
    const a = secants[previous], b = secants[i];
    if (a * b <= 0) return 0;
    const w1 = 2 * width + intervals[previous], w2 = width + 2 * intervals[previous];
    return (w1 + w2) / (w1 / a + w2 / b);
  });
});
const SIZE = 4096;
const table = new Float32Array((SIZE + 1) * 3);
let segment = 0;
for (let i = 0; i <= SIZE; i++) {
  const phase = i / SIZE * CYCLE;
  while (segment < segments - 1 && phase > positions[segment + 1]) segment++;
  const h = intervals[segment], t = (phase - positions[segment]) / h;
  const t2 = t * t, t3 = t2 * t;
  for (let channel = 0; channel < 3; channel++) {
    table[i * 3 + channel] = (2 * t3 - 3 * t2 + 1) * STOPS[segment][channel + 1]
      + (t3 - 2 * t2 + t) * h * slopes[channel][segment]
      + (-2 * t3 + 3 * t2) * STOPS[segment + 1][channel + 1]
      + (t3 - t2) * h * slopes[channel][(segment + 1) % segments];
  }
}

export function color(value: number, pixels: Uint8ClampedArray, offset: number): void {
  // Only -1 is the sampler's interior sentinel. Far-away escaping points can
  // have other negative smooth counts and must retain the exterior colour.
  if (value === -1) {
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
  } else {
    const phase = escapePhase(value);
    const position = (phase % CYCLE) / CYCLE * SIZE;
    const index = Math.floor(position), blend = position - index;
    for (let channel = 0; channel < 3; channel++) {
      const from = table[index * 3 + channel], to = table[(index + 1) * 3 + channel];
      pixels[offset + channel] = from + (to - from) * blend;
    }
  }
  pixels[offset + 3] = 255;
}
