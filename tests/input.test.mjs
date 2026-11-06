import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { scaledFixed, viewOffset } from '../src/precision.ts';

// Run the actual browser entry point with deterministic input/worker transports.
// This checks event wiring (including capture loss) without requiring a touch device.
const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife',
  loader: { '.css': 'empty' }, define: { 'import.meta.url': '"http://localhost/src/main.ts"' } });

function harness({ dpr = 1, width = 800, height = 600 } = {}) {
  const canvases = [], workers = [], timers = new Map(), frames = new Map(), mediaQueries = [];
  let timerId = 0;
  class Target {
    listeners = new Map();
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    emit(type, data = {}) {
      const event = { preventDefault() {}, ...data };
      for (const callback of this.listeners.get(type) || []) callback(event);
    }
  }
  class Canvas extends Target {
    width = 300; height = 150; dataset = {}; title = ''; attrs = {};
    rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
    classList = { add() {}, remove() {} };
    draws = [];
    context = { setTransform() {}, fillRect() {}, putImageData() {}, drawImage: (...args) => this.draws.push(args) };
    constructor() { super(); canvases.push(this); }
    getContext() { return this.context; }
    getBoundingClientRect() { return this.rect; }
    setPointerCapture() {}
    focus() {}
    setAttribute(key, value) { this.attrs[key] = value; }
  }
  class FakeWorker {
    messages = [];
    constructor() { workers.push(this); }
    postMessage(data) { this.messages.push(structuredClone(data)); }
    terminate() {}
    emit(data) { this.onmessage({ data }); }
  }
  const canvas = new Canvas(), window = new Target();
  canvas.rect = { left: 0, top: 0, right: width, bottom: height, width, height };
  window.devicePixelRatio = dpr;
  const globals = {
    document: { querySelector: () => canvas, createElement: () => new Canvas() },
    window, navigator: { hardwareConcurrency: 3 }, Worker: FakeWorker, URL,
    ResizeObserver: class { observe() {} }, matchMedia: () => {
      const query = new Target(); mediaQueries.push(query); return query;
    },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { frames.set(++timerId, fn); return timerId; },
    cancelAnimationFrame: id => frames.delete(id), performance: { now: () => 0 },
    ImageData: class {}, console,
  };
  vm.runInNewContext(bundle.outputFiles[0].text, globals);
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  return { canvas, window, workers, canvases, flush, flushFrames, mediaQueries, request: () => workers[0].messages.at(-1) };
}
function complexAt(view, x, y) {
  return [view.re + scaledFixed(x - 400, view.logScale, view.bits), view.im - scaledFixed(y - 300, view.logScale, view.bits)];
}
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`); }

test('actual wheel handler keeps outside-canvas zoom centred', () => {
  const h = harness(), before = h.request().view;
  h.window.emit('wheel', { clientX: -10, clientY: -10, deltaY: -200, deltaMode: 0 }); h.flush();
  const after = h.request().view;
  assert.equal(before.re, after.re); assert.equal(before.im, after.im);
  assert.ok(after.logScale < before.logScale);
});

test('actual pointer handlers support pinch, single-finger continuation and capture loss', () => {
  const h = harness(), before = h.request().view;
  const emit = (type, id, x, y) => h.canvas.emit(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y });
  emit('pointerdown', 1, 200, 200); emit('pointerdown', 2, 600, 200);
  emit('pointermove', 1, 100, 200); emit('pointermove', 2, 700, 200); h.flush();
  const pinched = h.request().view;
  near(pinched.logScale - before.logScale, Math.log2(400 / 600));
  const a = complexAt(before, 200, 200), b = complexAt(pinched, 100, 200);
  const scale = scaledFixed(1e-9, pinched.logScale, pinched.bits);
  assert.ok((a[0] - b[0]) ** 2n < scale ** 2n);
  assert.ok((a[1] - b[1]) ** 2n < scale ** 2n);
  emit('pointerup', 1, 100, 200); emit('lostpointercapture', 1, 100, 200);
  emit('pointermove', 2, 710, 210); h.flush();
  const offset = viewOffset(pinched, h.request().view);
  near(offset.x, 10); near(offset.y, 10);
  emit('pointercancel', 2, 710, 210); h.flush();
  const final = h.request().view;
  emit('pointermove', 2, 900, 900); h.flush();
  assert.deepEqual(h.request().view, final);
});

test('outdated generations and late coarse tiles cannot erase completed fine pixels', () => {
  const h = harness();
  const id = h.request().id;
  const image = h.canvases.at(-1);
  const tile = { type: 'tile', id, x: 0, y: 0, width: 32, height: 32, step: 1, pixels: new Uint8ClampedArray(4096) };
  h.workers[0].emit({ ...tile, id: id - 1 });
  assert.equal(image.draws.length, 0);
  h.workers[0].emit(tile);
  const fineCount = image.draws.length;
  h.workers[1].emit({ ...tile, step: 8 });
  assert.ok(image.draws.length > fineCount);
  assert.ok(image.draws.slice(fineCount).every(args => args[5] !== 0 || args[6] !== 0));
});

test('native physical resolution is rendered at fractional, Retina and higher pixel densities', () => {
  for (const dpr of [1, 1.25, 2, 3, 4]) {
    const h = harness({ dpr, width: 800.4, height: 600.3 });
    assert.equal(h.canvas.width, Math.round(800.4 * dpr));
    assert.equal(h.canvas.height, Math.round(600.3 * dpr));
    assert.equal(h.request().width, h.canvas.width);
    assert.equal(h.request().height, h.canvas.height);
    assert.equal(h.request().cssWidth, 800.4);
    assert.equal(h.request().cssHeight, 600.3);
    h.flushFrames();
    const draw = h.canvas.draws.at(-1);
    assert.equal(draw.length, 3, 'stationary image must use an unscaled pixel copy');
    assert.equal(draw[0].width, h.canvas.width);
    assert.equal(draw[0].height, h.canvas.height);
    assert.equal(h.canvas.context.imageSmoothingEnabled, false);
  }
});

test('changing monitor pixel density rebuilds the physical raster without changing the view', () => {
  const h = harness({ dpr: 2 });
  const before = h.request();
  h.window.devicePixelRatio = 3;
  h.mediaQueries.at(-1).emit('change');
  const after = h.request();
  assert.ok(after.id > before.id);
  assert.equal(after.width, 2400);
  assert.equal(after.height, 1800);
  assert.deepEqual(after.view, before.view);
  assert.equal(h.mediaQueries.length, 2, 'monitor change must re-arm the DPR watcher');
});
