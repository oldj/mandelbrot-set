// Renders the site icons into public/: the whole Mandelbrot set in the site's
// own palette, supersampled. At a few pixels across, the initial view's thin
// bright rim around the set disappears, so escape counts are scaled by GAIN
// before colouring: the cyan-to-white glow then reaches further out and the
// black set stands out from the blue.
//   favicon.ico            16, 32 and 48 px, rounded corners with transparency
//   apple-touch-icon.png   180 px, square and opaque (iOS rounds the corners itself)
// Run with: node scripts/favicon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { directDouble, INTERIOR } from '../src/fractal/index.ts';
import { color } from '../src/render/palette.ts';

/** The set fits with a small margin: re from -2.04 to 0.56, im from -1.3 to 1.3. */
const CENTRE_RE = -0.74, SPAN = 2.6, LIMIT = 4096, GAIN = 6;

/** RGBA pixels of a size x size icon; `radius` rounds the corners (as a fraction of the size). */
function render(size, samples, radius) {
  const rgba = new Uint8Array(size * size * 4), pixel = new Uint8ClampedArray(4);
  const r = radius * size;
  // Coverage of the rounded square at a point (1 inside, 0 outside), sampled like the colours.
  const inside = (x, y) => {
    const dx = Math.max(r - x, 0, x - (size - r)), dy = Math.max(r - y, 0, y - (size - r));
    return r === 0 || dx * dx + dy * dy <= r * r;
  };
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let red = 0, green = 0, blue = 0, covered = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const x = px + (sx + 0.5) / samples, y = py + (sy + 0.5) / samples;
      if (!inside(x, y)) continue;
      const cr = CENTRE_RE + (x / size - 0.5) * SPAN, ci = (0.5 - y / size) * SPAN;
      const value = directDouble(cr, ci, LIMIT);
      color(value === INTERIOR ? INTERIOR : value * GAIN, pixel, 0);
      red += pixel[0]; green += pixel[1]; blue += pixel[2]; covered++;
    }
    const o = (py * size + px) * 4;
    if (covered) {
      rgba[o] = Math.round(red / covered); rgba[o + 1] = Math.round(green / covered); rgba[o + 2] = Math.round(blue / covered);
    }
    rgba[o + 3] = Math.round(covered / (samples * samples) * 255);
  }
  return rgba;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A minimal 8-bit RGBA PNG. */
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8 bits per channel, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** An ICO holding PNG images (supported by every current browser). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header[entry] = size % 256; header[entry + 1] = size % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(image => image.data)]);
}

const output = new URL('../public/', import.meta.url);
mkdirSync(output, { recursive: true });
const icons = [16, 32, 48].map(size => ({ size, data: png(size, render(size, 16, 0.2)) }));
writeFileSync(new URL('favicon.ico', output), ico(icons));
writeFileSync(new URL('apple-touch-icon.png', output), png(180, render(180, 6, 0)));
console.log('wrote public/favicon.ico (16, 32, 48 px) and public/apple-touch-icon.png (180 px)');
