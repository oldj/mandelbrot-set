import test from 'node:test';
import assert from 'node:assert/strict';
import { compactCoordinate, formatCoordinate, formatZoom, viewClipboardText } from '../src/view-info.ts';
import { ensurePrecision, scaledFixed, toFixed } from '../src/precision.ts';

test('coordinates round correctly without negative zero', () => {
  assert.equal(formatCoordinate(toFixed(-0.6, 192), 192, -8), '-0.60000000');
  assert.equal(formatCoordinate(toFixed(1.999999999, 192), 192, -8), '2.00000000');
  assert.equal(formatCoordinate(-1n, 192, -8), '0.00000000');
});

test('display distinguishes adjacent pixels beyond double precision', () => {
  const view = ensurePrecision({ re: 0n, im: 0n, bits: 192, logScale: -2000 });
  const a = -(1n << BigInt(view.bits));
  const b = a + scaledFixed(1, view.logScale, view.bits);
  const first = formatCoordinate(a, view.bits, view.logScale);
  const second = formatCoordinate(b, view.bits, view.logScale);
  assert.notEqual(first, second);
  assert.ok(first.length > 600);
  assert.ok(second.startsWith('-0.99999'));
});

test('zoom display handles ordinary, extreme and sub-unit scales without overflow', () => {
  assert.equal(formatZoom(0), '1.00×');
  assert.equal(formatZoom(1), '2.00×');
  assert.equal(formatZoom(-1), '0.50×');
  assert.equal(formatZoom(4000), '1.32 × 10^1204');
  assert.equal(formatZoom(-4000), '7.59 × 10^-1205');
});

test('copied deep coordinates retain all displayed precision without truncation', () => {
  const view = ensurePrecision({ re: 0n, im: 0n, bits: 192, logScale: -2000 });
  view.re = -(1n << BigInt(view.bits)) + scaledFixed(1, view.logScale, view.bits);
  const text = viewClipboardText(view, -8);
  assert.ok(text.includes(`中心 Re: ${formatCoordinate(view.re, view.bits, view.logScale)}`));
  assert.ok(text.includes(`中心 Im: ${formatCoordinate(view.im, view.bits, view.logScale)}`));
  assert.ok(text.length > 1200);
  assert.ok(!text.includes('…'));
  assert.ok(!text.includes('Infinity'));
});

test('middle abbreviation retains the sign, prefix and changing final digits', () => {
  assert.equal(compactCoordinate('-0.60000000', 15), '-0.60000000');
  const coordinate = '-0.7436438870371510123456789';
  for (const budget of [5, 8, 12, 20, 23]) {
    const short = compactCoordinate(coordinate, budget);
    const [prefix, suffix] = short.split('…');
    assert.equal(short.length, budget);
    assert.ok(coordinate.startsWith(prefix));
    assert.ok(coordinate.endsWith(suffix));
    assert.ok(prefix.startsWith('-'));
    assert.ok(suffix.length >= 2);
  }
});
