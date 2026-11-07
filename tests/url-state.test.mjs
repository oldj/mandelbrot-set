import test from 'node:test';
import assert from 'node:assert/strict';
import { formatViewHash, formatZoomText, parseDecimal, parseViewHash, parseZoomText } from '../src/ui/url-state.ts';
import { ensurePrecision, initialView, toFixed, transformView } from '../src/math/precision.ts';

const abs = n => n < 0n ? -n : n;

test('zoom text round-trips from 1x to far beyond double range', () => {
  for (const logZoom of [0, 1.5, 17.3, 19.9, 100, 4000.25, 40000]) {
    const text = formatZoomText(logZoom);
    assert.ok(Math.abs(parseZoomText(text) - logZoom) < 1e-8 * Math.max(1, logZoom), `${logZoom} -> ${text}`);
  }
  assert.equal(formatZoomText(0), '1');
  assert.match(formatZoomText(4000), /^\d(\.\d+)?e1204$/);
  for (const bad of ['', 'abc', '-3', '0', '1e', 'Infinity', '1e9999999999']) assert.equal(parseZoomText(bad), undefined, bad);
});

test('decimals become correctly rounded fixed point', () => {
  assert.equal(parseDecimal('0.5', 8), 128n);
  assert.equal(parseDecimal('-1.25', 4), -20n);
  assert.equal(parseDecimal('3', 2), 12n);
  assert.equal(parseDecimal('0.1', 4), 2n, '1.6 rounds to 2');
  for (const bad of ['', '1.2.3', '1e5', '--1', 'x']) assert.equal(parseDecimal(bad, 64), undefined, bad);
});

test('views survive the hash at shallow, deep and extreme depths', () => {
  const width = 1024, height = 768, initial = initialView(width, height).logScale;
  assert.equal(formatViewHash(initialView(width, height), width, height, initial), '');
  for (const logScale of [-12, -60, -1200, -4000]) {
    const view = ensurePrecision({ re: 0n, im: 0n, bits: 128, logScale });
    view.re = toFixed(-0.743643887037158704752, view.bits) + 12345n; view.im = toFixed(0.1318259042053119, view.bits) - 777n;
    const hash = formatViewHash(view, width, height, initial);
    const restored = parseViewHash(`#${hash}`, initial);
    assert.ok(Math.abs(restored.logScale - logScale) < 1e-8 * Math.max(1, -logScale), `scale at ${logScale}`);
    const shift = BigInt(Math.max(view.bits, restored.bits));
    const align = (value, bits) => value << (shift - BigInt(bits));
    const pixel = 2n ** (shift + BigInt(Math.floor(logScale)));
    for (const key of ['re', 'im']) {
      assert.ok(abs(align(restored[key], restored.bits) - align(view[key], view.bits)) <= pixel / 500n, `${key} at ${logScale}`);
    }
  }
});

test('invalid or hostile hashes are rejected', () => {
  const initial = initialView(800, 600).logScale;
  for (const hash of ['', '#', '#re=0&im=0', '#re=1&im=x&zoom=2', '#re=99&im=0&zoom=2', `#re=0.${'1'.repeat(30000)}&im=0&zoom=2`]) {
    assert.equal(parseViewHash(hash, initial), undefined, hash.slice(0, 30));
  }
  // Zooming out is limited exactly as interactive zooming is.
  assert.equal(parseViewHash('#re=0&im=0&zoom=1e-9', initial).logScale, 2);
  // Hashes produced after real interaction parse back.
  const view = transformView(initialView(800, 600), { x: 120, y: -40 }, { x: 0, y: 0 }, -30);
  assert.ok(parseViewHash(`#${formatViewHash(view, 800, 600, initial)}`, initial));
});

test('a link made after zooming out keeps the deep digits, so a friend zooming back in lands on the same spot', async () => {
  const { transformView } = await import('../src/math/precision.ts');
  const { formatCoordinate } = await import('../src/ui/view-info.ts');
  const initial = initialView(1280, 800).logScale;
  const deep = parseViewHash('#re=-0.743643887037158704752191506114774&im=0.131825904205311970493132056385139&zoom=1e30', initial);
  // Zoom out about the centre, all the way, as the buttons do.
  let out = deep;
  for (let i = 0; i < 200; i++) out = transformView(out, { x: 0, y: 0 }, { x: 0, y: 0 }, 0.5);
  assert.ok(out.logScale > deep.logScale + 90);
  const link = formatViewHash(out, 1280, 800, initial);
  assert.match(link, /^re=-0\.743643887037158704752191506114774\d*&im=0\.131825904205311970493132056385139\d*&zoom=/, link);
  // The friend opens it and zooms back in about the centre: the same spot, to a thousandth of a pixel.
  let friend = parseViewHash(`#${link}`, initial);
  for (let i = 0; i < 200; i++) friend = transformView(friend, { x: 0, y: 0 }, { x: 0, y: 0 }, -0.5);
  assert.ok(Math.abs(friend.logScale - deep.logScale) < 1e-9);
  assert.equal(formatCoordinate(friend.re, friend.bits, deep.logScale), formatCoordinate(deep.re, deep.bits, deep.logScale));
  assert.equal(formatCoordinate(friend.im, friend.bits, deep.logScale), formatCoordinate(deep.im, deep.bits, deep.logScale));
  // Passing the link on keeps the same digits: they neither get lost nor grow.
  const again = parseViewHash(`#${link}`, initial);
  assert.equal(formatViewHash(again, 1280, 800, initial), link);
  // Links that never went deep stay as short as their zoom needs.
  assert.equal(formatViewHash(parseViewHash('#re=-0.75&im=0.1&zoom=50', initial), 1280, 800, initial), 're=-0.75000000&im=0.10000000&zoom=50');
});
