import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinateText, parseZoomInput, readViewFields } from '../src/ui/view-form.ts';
import { parseDecimal, parseViewHash } from '../src/ui/url-state.ts';
import { ensurePrecision, initialView } from '../src/math/precision.ts';

test('coordinates are read as typed or pasted, in plain or e notation', () => {
  const bits = 128;
  for (const [text, plain] of [
    ['-0.75', '-0.75'], ['  -0.75\n', '-0.75'], ['−0.75', '-0.75'], ['+.5', '0.5'], ['3.', '3'],
    ['-1.25e-3', '-0.00125'], ['125E-5', '0.00125'], ['0.004e3', '4'], ['0', '0'], ['-0.000', '0'],
    ['0.7436438870\n3715870475', '0.74364388703715870475'],
  ]) assert.equal(parseCoordinateText(text, bits), parseDecimal(plain, bits), text);
  // e notation moves the point exactly: no rounding through a double.
  assert.equal(parseCoordinateText('1e-300', 1100), parseDecimal(`0.${'0'.repeat(299)}1`, 1100));
  for (const text of ['', '.', '-', 'abc', '1.2.3', '1e', '0x10', '1,5', 'Infinity', '--1']) {
    assert.equal(parseCoordinateText(text, bits), 'invalid', text);
  }
  for (const text of ['4.5', '-10', '1e1', '0004.1', '99999e99999']) assert.equal(parseCoordinateText(text, bits), 'range', text);
  assert.equal(typeof parseCoordinateText('4', bits), 'bigint');
  assert.equal(typeof parseCoordinateText('0004', bits), 'bigint', 'leading zeros are no reason to reject');
  // Huge exponents are refused before any long string is built.
  assert.equal(parseCoordinateText('1e-999999', bits), 'digits');
  assert.equal(parseCoordinateText(`0.${'1'.repeat(30000)}`, bits), 'digits');
});

test('zoom accepts the panel format and common ways of writing powers of ten', () => {
  for (const [text, value] of [
    ['250', 250], ['2.5e12', 2.5e12], ['2.5E+12', 2.5e12], ['1.84×10^8', 1.84e8], ['1.84 x 10^8', 1.84e8],
    ['1.84*10^8', 1.84e8], ['10^8', 1e8], ['3.5×', 3.5], ['3.5x', 3.5], ['0.5', 0.5], ['1e-2', 0.01],
  ]) assert.ok(Math.abs(parseZoomInput(text) - Math.log2(value)) < 1e-9, text);
  for (const text of ['', '0', '-3', 'abc', '1e', '×10^8', '2^10']) assert.equal(parseZoomInput(text), undefined, text);
});

test('the fields become a view: untouched ones exact, edited ones checked, nothing applied with any error', () => {
  const initial = initialView(800, 600).logScale;
  const view = ensurePrecision({ re: 123456789n << 100n, im: -(987654321n << 90n), bits: 192, logScale: initial - 30 });
  const shown = { re: '0.000000123', im: '-0.000000000987', zoom: '1.073741824e9' };

  const same = readViewFields({ ...shown, re: ` ${shown.re}\n` }, shown, view, initial);
  assert.deepEqual(same, { view, changed: false }, 'whitespace alone is no edit');

  const zoomed = readViewFields({ ...shown, zoom: '1e20' }, shown, view, initial);
  assert.equal(zoomed.changed, true);
  assert.ok(Math.abs(initial - zoomed.view.logScale - Math.log2(1e20)) < 1e-9);
  const shift = BigInt(zoomed.view.bits - view.bits);
  assert.equal(zoomed.view.re, view.re << shift, 'the centre keeps every bit, not the shown digits');
  assert.equal(zoomed.view.im, view.im << shift);
  assert.ok(zoomed.view.bits >= 192);

  // Zooming out stops where the wheel does.
  assert.equal(readViewFields({ ...shown, zoom: '1e-9' }, shown, view, initial).view.logScale, 2);

  const moved = readViewFields({ ...shown, im: '0.25' }, shown, view, initial);
  assert.equal(moved.view.im, parseDecimal('0.25', moved.view.bits));
  assert.equal(moved.view.re, view.re);

  const bad = readViewFields({ re: '9', im: '', zoom: '0' }, shown, view, initial);
  assert.deepEqual(bad.errors.map(error => error.field).sort(), ['im', 're', 'zoom']);
  assert.match(bad.errors.find(error => error.field === 're').message, /-4 to 4/);
  assert.match(bad.errors.find(error => error.field === 'im').message, /Enter a number/);
  assert.match(readViewFields({ ...shown, zoom: '1e18001' }, shown, view, initial).errors[0].message, /1e18000/);
});

test('links are refused beyond the deepest zoom, instead of allocating gigabytes', () => {
  const initial = initialView(800, 600).logScale;
  assert.ok(parseViewHash('#re=0&im=0&zoom=1e18000', initial));
  assert.equal(parseViewHash('#re=0&im=0&zoom=1e18001', initial), undefined);
  assert.equal(parseViewHash('#re=0&im=0&zoom=1e999999999', initial), undefined);
});
