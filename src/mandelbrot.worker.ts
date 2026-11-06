import type { RenderRequest, RenderStrip } from './types';

const MAX_ITERATIONS = 800;
const PALETTE = [
  [7, 15, 35],
  [18, 45, 94],
  [34, 100, 163],
  [105, 181, 210],
  [223, 236, 222],
  [244, 186, 91],
  [171, 83, 40],
  [35, 24, 44],
];

self.onmessage = ({ data }: MessageEvent<RenderRequest>): void => {
  const { width, height } = data;
  // A uniform scale preserves the geometry and fits the whole set in any aspect ratio.
  const scale = Math.max(3.4 / width, 2.7 / height);
  for (let y = 0; y < height; y += 32) {
    const stripHeight = Math.min(32, height - y);
    const pixels = new Uint8ClampedArray(width * stripHeight * 4);
    for (let row = 0; row < stripHeight; row++) {
      const ci = (height / 2 - (y + row + 0.5)) * scale;
      for (let x = 0; x < width; x++) {
        const cr = -0.6 + (x + 0.5 - width / 2) * scale;
        const offset = (row * width + x) * 4;
        const q = (cr - 0.25) ** 2 + ci * ci;
        // The main cardioid and period-two bulb are known to be inside the set.
        const inside = q * (q + cr - 0.25) <= 0.25 * ci * ci || (cr + 1) ** 2 + ci * ci <= 1 / 16;
        let zr = 0;
        let zi = 0;
        let zr2 = 0;
        let zi2 = 0;
        let iteration = 0;
        if (!inside) {
          while (zr2 + zi2 <= 256 && iteration < MAX_ITERATIONS) {
            zi = 2 * zr * zi + ci;
            zr = zr2 - zi2 + cr;
            zr2 = zr * zr;
            zi2 = zi * zi;
            iteration++;
          }
        }

        if (inside || iteration === MAX_ITERATIONS) {
          pixels[offset] = 3;
          pixels[offset + 1] = 5;
          pixels[offset + 2] = 10;
        } else {
          // Continuous escape-time coloring removes discrete iteration bands.
          const smooth = iteration + 1 - Math.log2(Math.log2(Math.sqrt(zr2 + zi2)));
          const position = Math.log2(1 + Math.max(0, smooth)) * 2.2;
          const index = Math.floor(position);
          const blend = position - index;
          const from = PALETTE[index % PALETTE.length];
          const to = PALETTE[(index + 1) % PALETTE.length];
          for (let channel = 0; channel < 3; channel++) {
            pixels[offset + channel] = from[channel] + (to[channel] - from[channel]) * blend;
          }
        }
        pixels[offset + 3] = 255;
      }
    }
    const strip: RenderStrip = { y, height: stripHeight, pixels, done: y + stripHeight === height };
    self.postMessage(strip, { transfer: [pixels.buffer] });
  }
};
