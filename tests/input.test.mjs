import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { scaledFixed, viewOffset } from '../src/math/precision.ts';
import { initialView } from '../src/math/precision.ts';
import { EASE_MS, HOLD_RATE, MAX_FRAME_MS, STEP } from '../src/ui/hold-zoom.ts';
import { formatZoomText, parseDecimal } from '../src/ui/url-state.ts';
import { formatCoordinate } from '../src/ui/view-info.ts';

// Run the actual browser entry point with deterministic input/worker transports.
// This checks event wiring (including capture loss) without requiring a touch device.
const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife',
  loader: { '.css': 'empty' }, define: { 'import.meta.url': '"http://localhost/src/main.ts"' } });

function harness({ dpr = 1, width = 800, height = 600, cores = 3, clipboardWrite = async () => {}, hash = '' } = {}) {
  const canvases = [], workers = [], timers = new Map(), frames = new Map(), mediaQueries = [];
  const clipboardWrites = [];
  const resizeObservers = [];
  const location = { pathname: '/', search: '', hash, reload() {} };
  const replaced = [];
  const history = { state: null, replaceState(state, title, url) {
    replaced.push(url);
    const index = url.indexOf('#');
    location.hash = index < 0 ? '' : url.slice(index);
  } };
  let timerId = 0;
  class Target {
    listeners = new Map();
    textContent = '';
    value = '';
    dataset = {};
    style = {};
    attributes = {};
    classes = new Set();
    classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    clientWidth = 120;
    open = false;
    focused = false;
    showModal() { this.open = true; }
    focus() { this.focused = true; }
    select() { this.focused = true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    setPointerCapture() {}
    requestSubmit() { this.emit('submit'); }
    close() { if (this.open) { this.open = false; this.emit('close'); } }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    emit(type, data = {}) {
      const event = { preventDefault() {}, stopPropagation() { this.stopped = true; }, ...data };
      for (const callback of this.listeners.get(type) || []) callback(event);
      return event;
    }
  }
  class Canvas extends Target {
    width = 300; height = 150; dataset = {}; title = ''; attrs = {};
    rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
    classList = { add() {}, remove() {} };
    draws = [];
    context = { setTransform() {}, fillRect() {}, putImageData() {}, measureText: text => ({ width: text.length * 6.6 }), drawImage: (...args) => this.draws.push(args) };
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
  const elements = new Map([['#mandelbrot', canvas], ...['#view-info', '#centre-real', '#centre-imag', '#zoom-level', '#view-controls', '#reset-view', '#zoom-in', '#zoom-out', '#copy-view', '#copy-feedback',
    '#view-dialog', '#view-form', '#close-view-dialog', '#view-re', '#view-im', '#view-zoom', '#view-re-error', '#view-im-error', '#view-zoom-error', '#copy-view-values', '#view-copy-feedback'].map(id => [id, new Target()])]);
  canvas.rect = { left: 0, top: 0, right: width, bottom: height, width, height };
  window.devicePixelRatio = dpr;
  const globals = {
    document: { querySelector: selector => elements.get(selector), createElement: () => new Canvas() },
    window, location, history, URLSearchParams, navigator: { hardwareConcurrency: cores, clipboard: clipboardWrite ? {
      writeText: async text => { clipboardWrites.push(text); await clipboardWrite(text); },
    } : undefined }, Worker: FakeWorker, URL,
    getComputedStyle: () => ({ font: '', fontSize: '11px', fontFamily: 'monospace', fontWeight: '400', letterSpacing: '0.11px' }),
    ResizeObserver: class {
      targets = [];
      constructor(callback) { this.callback = callback; resizeObservers.push(this); }
      observe(target) { this.targets.push(target); }
    }, matchMedia: () => {
      const query = new Target(); mediaQueries.push(query); return query;
    },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { frames.set(++timerId, fn); return timerId; },
    cancelAnimationFrame: id => frames.delete(id), performance: { now: () => 0 },
    ImageData: class {}, console,
  };
  vm.runInNewContext(bundle.outputFiles[0].text, globals);
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  const flushFrames = (time = 0) => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); };
  return { canvas, window, workers, canvases, elements, flush, flushFrames, mediaQueries, clipboardWrites, resizeObservers, location, replaced, request: () => workers[0].messages.at(-1) };
}
function complexAt(view, x, y) {
  return [view.re + scaledFixed(x - 400, view.logScale, view.bits), view.im - scaledFixed(y - 300, view.logScale, view.bits)];
}
const abs = n => n < 0n ? -n : n;
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`); }

function completeRegion(h, region) {
  h.workers[0].emit({ type: 'tiles', id: h.request().id, tiles: [{ ...region, step: 1,
    pixels: new Uint8ClampedArray(region.width * region.height * 4) }] });
}

test('large renders expand the pool; narrow pans cancel surplus workers and finish with the active count', () => {
  const h = harness({ cores: 16 });
  assert.equal(h.workers.length, 8);
  assert.equal(h.request().workerCount, 8);
  completeRegion(h, { x: 0, y: 0, width: 800, height: 600 });
  h.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 400, clientY: 300 });
  h.canvas.emit('pointermove', { pointerId: 1, clientX: 403, clientY: 300 }); h.flush();
  const current = h.request();
  assert.equal(current.workerCount, 1);
  for (const worker of h.workers.slice(1)) assert.deepEqual(worker.messages.at(-1), { type: 'cancel', id: current.id });
  h.workers[0].emit({ type: 'pass', id: current.id, step: 1, elapsed: 1, fallbacks: 0 });
  assert.equal(h.canvas.dataset.rendered, 'true');
  h.window.emit('wheel', { clientX: 400, clientY: 300, deltaY: -100, deltaMode: 0 }); h.flush();
  assert.equal(h.request().workerCount, 8);
  assert.equal(h.workers.length, 8, 'existing workers are reused');
});

test('completed pixels survive a high-DPI pan, only exposed strips reach workers', () => {
  const h = harness({ dpr: 2, width: 100, height: 80 });
  completeRegion(h, { x: 0, y: 0, width: 200, height: 160 });
  const source = h.canvases.at(-1), previous = h.request();
  h.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 20, clientY: 20 });
  h.canvas.emit('pointermove', { pointerId: 1, clientX: 23, clientY: 18 }); h.flush();
  const next = h.request();
  assert.equal(next.regions.reduce((n, r) => n + r.width * r.height, 0), 200 * 160 - 194 * 156);
  assert.equal(Number(h.canvas.dataset.reusedPixels), 194 * 156);
  const copied = h.canvases.at(-1).draws[0];
  assert.deepEqual(copied, [source, 6, -4]);
  const draws = h.canvases.at(-1).draws.length;
  h.workers[0].emit({ type: 'tiles', id: previous.id, tiles: [{ x: 0, y: 0, width: 10, height: 10, step: 8, pixels: new Uint8ClampedArray(400) }] });
  h.flushFrames();
  assert.equal(h.canvases.at(-1).draws.length, draws);
  h.canvas.emit('pointerup', { pointerId: 1 }); h.flush();
  assert.equal(h.request().id, next.id, 'release must not restart an unchanged raster');
  h.window.emit('wheel', { clientX: 50, clientY: 40, deltaY: -100, deltaMode: 0 }); h.flush();
  assert.equal(h.canvas.dataset.reusedPixels, '0', 'zoom invalidates the old sampling grid');
});

test('unfinished regions are included after a pan; subpixel motion keeps the same job', () => {
  const h = harness({ dpr: 1.25, width: 80, height: 64 });
  completeRegion(h, { x: 0, y: 0, width: 40, height: 30 });
  const initial = h.request();
  h.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 20 });
  h.canvas.emit('pointermove', { pointerId: 1, clientX: 20.2, clientY: 20.2 }); h.flush();
  assert.equal(h.request().id, initial.id);
  h.canvas.emit('pointermove', { pointerId: 1, clientX: 21.6, clientY: 20 }); h.flush();
  assert.equal(Number(h.canvas.dataset.computePixels), 100 * 80 - 40 * 30);
  const regions = h.request().regions;
  for (const r of regions) {
    assert.ok(r.x + r.width <= 2 || r.x >= 42 || r.y >= 30);
  }
});

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

test('outdated generations are ignored; batched tiles reach the surface in one upload per frame', () => {
  const h = harness();
  const id = h.request().id;
  const image = h.canvases.at(-1);
  const tile = (x, y, step = 1) => ({ x, y, width: 32, height: 32, step, pixels: new Uint8ClampedArray(4096) });
  h.workers[0].emit({ type: 'tiles', id: id - 1, tiles: [tile(0, 0)] });
  h.flushFrames();
  assert.equal(image.draws.length, 0);
  h.workers[0].emit({ type: 'tiles', id, tiles: [tile(0, 0), tile(64, 0)] });
  h.workers[1].emit({ type: 'tiles', id, tiles: [tile(32, 32)] });
  assert.equal(image.draws.length, 0, 'tiles are staged, not drawn per message');
  h.flushFrames();
  assert.equal(image.draws.length, 1);
  assert.deepEqual(image.draws[0].slice(1), [0, 0, 96, 64, 0, 0, 96, 64]);
  h.flushFrames();
  assert.equal(image.draws.length, 1, 'nothing is uploaded twice');
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

test('reset button restores initial coordinates, zoom and labels after navigation', () => {
  const h = harness();
  const initial = h.request().view;
  h.flushFrames();
  assert.equal(h.elements.get('#centre-real').textContent, '-0.60000000');
  assert.equal(h.elements.get('#centre-imag').textContent, '0.00000000');
  assert.equal(h.elements.get('#zoom-level').textContent, '1.00×');
  h.window.emit('wheel', { clientX: 200, clientY: 200, deltaY: -300, deltaMode: 0 });
  h.flush(); h.flushFrames();
  assert.notEqual(h.elements.get('#zoom-level').textContent, '1.00×');
  assert.notEqual(h.elements.get('#centre-real').textContent, '-0.60000000');
  const previousId = h.request().id;
  h.elements.get('#reset-view').emit('click');
  h.flushFrames();
  assert.ok(h.request().id > previousId);
  assert.deepEqual(h.request().view, initial);
  assert.equal(h.elements.get('#centre-real').textContent, '-0.60000000');
  assert.equal(h.elements.get('#zoom-level').textContent, '1.00×');
});

test('scrolling the coordinate panel does not bubble into canvas zoom', () => {
  const h = harness();
  assert.equal(h.elements.get('#view-info').emit('wheel').stopped, true);
});

test('copy uses the latest view before painting and includes both coordinates and zoom', async () => {
  const h = harness();
  h.window.emit('wheel', { clientX: 200, clientY: 200, deltaY: -300, deltaMode: 0 });
  const button = h.elements.get('#copy-view');
  await button.listeners.get('click')[0]();
  assert.equal(button.dataset.state, 'copied');
  assert.equal(button.disabled, false);
  assert.equal(h.elements.get('#copy-feedback').textContent, 'Position and zoom copied');
  h.flush(); h.flushFrames();
  assert.equal(h.clipboardWrites.length, 1);
  assert.equal(h.clipboardWrites[0], `Mandelbrot set\nCenter (Re): ${h.elements.get('#centre-real').textContent}\nCenter (Im): ${h.elements.get('#centre-imag').textContent}\nZoom: ${h.elements.get('#zoom-level').textContent}`);
  assert.ok(!h.clipboardWrites[0].includes('Zoom: 1.00×'));
  assert.equal(h.elements.get('#copy-feedback').textContent, '');
});

test('clipboard denial and unavailable API show failure, never false success', async () => {
  for (const clipboardWrite of [null, async () => { throw new Error('Permission denied'); }]) {
    const h = harness({ clipboardWrite });
    const button = h.elements.get('#copy-view');
    await button.listeners.get('click')[0]();
    assert.equal(button.dataset.state, 'error');
    assert.equal(button.disabled, false);
    assert.match(h.elements.get('#copy-feedback').textContent, /Couldn’t copy/);
  }
});

test('abbreviated coordinates open one dialog with every digit and the zoom, and the clipboard keeps the complete view', async () => {
  const h = harness();
  for (let i = 0; i < 80; i++) h.window.emit('wheel', { clientX: 200, clientY: 200, deltaY: -600, deltaMode: 0 });
  h.flush(); h.flushFrames();
  const view = h.request().view;
  const real = formatCoordinate(view.re, view.bits, view.logScale);
  const imaginary = formatCoordinate(view.im, view.bits, view.logScale);
  assert.ok(real.length > 40);
  assert.ok(h.elements.get('#centre-real').textContent.includes('…'));
  assert.ok(h.elements.get('#centre-imag').textContent.includes('…'));
  const dialog = h.elements.get('#view-dialog');
  // Re, Im and the zoom all open the same dialog, filled with all three values.
  for (const opener of ['#centre-real', '#centre-imag', '#zoom-level']) {
    h.elements.get(opener).emit('click');
    assert.equal(dialog.open, true, opener);
    assert.equal(h.elements.get('#view-re').value, real);
    assert.equal(h.elements.get('#view-im').value, imaginary);
    assert.equal(h.elements.get('#view-zoom').value, formatZoomText(initialView(800, 600).logScale - view.logScale));
    h.elements.get('#close-view-dialog').emit('click');
    assert.equal(dialog.open, false);
  }
  h.elements.get('#centre-real').emit('click');
  assert.equal(dialog.emit('wheel').stopped, true);
  const id = h.request().id;
  h.window.emit('keydown', { key: 'Home' });
  assert.equal(h.request().id, id, 'reading the dialog must not reset the background view');
  h.elements.get('#close-view-dialog').emit('click');
  await h.elements.get('#copy-view').listeners.get('click')[0]();
  assert.ok(h.clipboardWrites[0].includes(`Center (Re): ${real}\nCenter (Im): ${imaginary}`));
  assert.ok(!h.clipboardWrites[0].includes('…'));
});

test('the view dialog copies the whole view, as the panel button does, and failures say so', async () => {
  const h = harness();
  for (let i = 0; i < 80; i++) h.window.emit('wheel', { clientX: 200, clientY: 200, deltaY: -600, deltaMode: 0 });
  h.flush(); h.flushFrames();
  h.elements.get('#centre-imag').emit('click');
  const button = h.elements.get('#copy-view-values'), feedback = h.elements.get('#view-copy-feedback');
  await button.listeners.get('click')[0]();
  await h.elements.get('#copy-view').listeners.get('click')[0]();
  assert.equal(h.clipboardWrites.length, 2);
  assert.equal(h.clipboardWrites[0], h.clipboardWrites[1]);
  assert.match(h.clipboardWrites[0], /Center \(Re\): .*\nCenter \(Im\): .*\nZoom: /);
  assert.equal(button.dataset.state, 'copied');
  assert.equal(feedback.textContent, 'Copied');
  // Closing the dialog clears its feedback for next time.
  h.elements.get('#close-view-dialog').emit('click');
  assert.equal(feedback.textContent, '');
  assert.equal(button.dataset.state, 'idle');
  const denied = harness({ clipboardWrite: async () => { throw new Error('Permission denied'); } });
  denied.elements.get('#centre-real').emit('click');
  await denied.elements.get('#copy-view-values').listeners.get('click')[0]();
  assert.equal(denied.elements.get('#copy-view-values').dataset.state, 'error');
  assert.match(denied.elements.get('#view-copy-feedback').textContent, /Couldn’t copy/);
});

test('applying the view dialog goes to the typed position and zoom', () => {
  const h = harness();
  h.flush();
  const before = h.request();
  const dialog = h.elements.get('#view-dialog');
  const re = h.elements.get('#view-re'), im = h.elements.get('#view-im'), zoom = h.elements.get('#view-zoom');
  const apply = () => h.elements.get('#view-form').emit('submit');

  // Applying untouched values only closes the dialog.
  h.elements.get('#centre-real').emit('click');
  apply();
  assert.equal(dialog.open, false);
  assert.equal(h.request().id, before.id);

  h.elements.get('#centre-real').emit('click');
  re.value = '-0.743643887037158704752191506114774'; im.value = '0.131825904205311970493132056385139'; zoom.value = '2.5e12';
  apply();
  assert.equal(dialog.open, false);
  const moved = h.request();
  assert.notEqual(moved.id, before.id);
  const initial = initialView(800, 600).logScale;
  near(initial - moved.view.logScale, Math.log2(2.5e12));
  // Every typed digit counts, beyond those the panel shows at this depth.
  assert.equal(moved.view.re, parseDecimal(re.value, moved.view.bits));
  assert.equal(moved.view.im, parseDecimal(im.value, moved.view.bits));
  assert.match(h.location.hash, /^#re=-0\.7436438870371587\d*&im=0\.13182590420531197\d*&zoom=2\.5e12$/);

  // Changing only the zoom keeps the exact centre, not the rounded digits shown.
  h.elements.get('#zoom-level').emit('click');
  zoom.value = '1.84×10^8';
  apply();
  const zoomed = h.request().view;
  near(initial - zoomed.logScale, Math.log2(1.84e8));
  const shift = BigInt(zoomed.bits - moved.view.bits);
  assert.equal(zoomed.re, moved.view.re << shift);
  assert.equal(zoomed.im, moved.view.im << shift);
});

test('invalid values in the view dialog are reported and change nothing', () => {
  const h = harness();
  h.flush();
  const before = h.request().id;
  const dialog = h.elements.get('#view-dialog');
  const re = h.elements.get('#view-re'), im = h.elements.get('#view-im'), zoom = h.elements.get('#view-zoom');
  h.elements.get('#centre-real').emit('click');
  re.value = '-0.75'; im.value = '0.1.2'; zoom.value = '-3';
  h.elements.get('#view-form').emit('submit');
  assert.equal(dialog.open, true, 'the dialog stays open');
  assert.equal(h.request().id, before, 'no render: not even the valid real part is applied');
  assert.equal(h.elements.get('#view-re-error').textContent, '');
  assert.match(h.elements.get('#view-im-error').textContent, /decimal number/);
  assert.match(h.elements.get('#view-zoom-error').textContent, /positive number/);
  assert.equal(im.attributes['aria-invalid'], 'true');
  assert.equal(im.focused, true, 'focus moves to the first invalid field');
  // Typing in a field clears its message.
  im.value = '0.1'; im.emit('input');
  assert.equal(h.elements.get('#view-im-error').textContent, '');
  assert.equal(im.attributes['aria-invalid'], undefined);
  zoom.value = '1e99999';
  h.elements.get('#view-form').emit('submit');
  assert.match(h.elements.get('#view-zoom-error').textContent, /up to 1e18000/);
  assert.equal(h.request().id, before);
  // Enter in a coordinate box applies, once the values are valid.
  zoom.value = '100';
  re.emit('keydown', { key: 'Enter' });
  assert.equal(dialog.open, false);
  assert.notEqual(h.request().id, before);
});

test('zoom buttons animate about the centre: a step per tap, steady while held, gliding to a stop', () => {
  const h = harness();
  h.flush();
  const start = h.request().view;
  const zoomIn = h.elements.get('#zoom-in'), zoomOut = h.elements.get('#zoom-out');
  // The current view: flushing timers starts the render that carries it.
  const zoomed = () => { h.flush(); return start.logScale - h.request().view.logScale; };
  let time = 1000;
  const frames = (ms, step = 16) => { for (const end = time + ms; time < end;) h.flushFrames(time += step); };

  // A tap: nothing jumps on the press; the step eases out over a few frames, then stops at exactly √2.
  zoomIn.emit('pointerdown', { pointerId: 7, pointerType: 'mouse', button: 0 });
  assert.equal(zoomed(), 0, 'no jump on press');
  frames(16);
  frames(16);
  const early = zoomed();
  assert.ok(early > 0 && early < STEP / 2, `eases in over frames, not at once: ${early}`);
  zoomIn.emit('pointerup', { pointerId: 7 });
  zoomIn.emit('click', { detail: 1 }); // the pointer's own click adds nothing
  frames(1000);
  near(zoomed(), STEP);
  // The centre stays put.
  const shift = BigInt(h.request().view.bits - start.bits);
  assert.equal(h.request().view.re, start.re << shift);
  assert.equal(h.request().view.im, start.im << shift);
  // A click held a little past the point where the step slows to the held
  // speed zooms a little more, smoothly, but doesn't add a whole glide on top.
  let before = zoomed();
  zoomIn.emit('pointerdown', { pointerId: 10, pointerType: 'mouse', button: 0 });
  frames(120, 8);
  zoomIn.emit('pointerup', { pointerId: 10 });
  frames(1000);
  const slowClick = zoomed() - before;
  assert.ok(slowClick > STEP && slowClick < STEP + 0.75 * HOLD_RATE * EASE_MS / 1000, `slow click: ${slowClick}`);
  // Settled: no more frames are asked for.
  const id = h.request().id;
  frames(200); h.flush();
  assert.equal(h.request().id, id);

  // A hold: the step flows into steady zooming at HOLD_RATE, every frame a little.
  before = zoomed();
  zoomIn.emit('pointerdown', { pointerId: 8, pointerType: 'mouse', button: 0 });
  frames(16);
  let previous = zoomed(), largestFrame = 0;
  for (let i = 0; i < 60; i++) {
    frames(16);
    const now = zoomed();
    assert.ok(now > previous, 'zooms on every frame while held');
    largestFrame = Math.max(largestFrame, now - previous);
    previous = now;
  }
  assert.ok(largestFrame < STEP / 4, `no frame jumps: ${largestFrame}`);
  const steadyFrom = zoomed();
  frames(1000, 20);
  near(zoomed() - steadyFrom, HOLD_RATE);
  // A late frame catches up, but a long stall zooms no more than MAX_FRAME_MS would.
  const beforeStall = zoomed();
  h.flushFrames(time += 5000);
  near(zoomed() - beforeStall, HOLD_RATE * MAX_FRAME_MS / 1000);
  // Released, it glides: decelerating, and covering what easing out from HOLD_RATE does.
  const released = zoomed();
  zoomIn.emit('pointerup', { pointerId: 8 });
  frames(16);
  const first = zoomed() - released;
  frames(16);
  const second = zoomed() - released - first;
  assert.ok(first > second && second > 0, 'decelerates');
  assert.ok(first < HOLD_RATE * 0.016 * 1.2, 'starts at about the held speed');
  frames(1000);
  near(zoomed() - released, HOLD_RATE * EASE_MS / 1000);

  // Keyboard: Enter held acts like a held pointer; its clicks add nothing. Space taps a step.
  before = zoomed();
  zoomOut.emit('keydown', { key: ' ' });
  zoomOut.emit('keyup', { key: ' ' });
  zoomOut.emit('click', { detail: 0 });
  frames(1000);
  near(zoomed() - before, -STEP);
  before = zoomed();
  zoomOut.emit('keydown', { key: 'Enter' }); zoomOut.emit('click', { detail: 0 });
  frames(16);
  for (let i = 0; i < 40; i++) { zoomOut.emit('keydown', { key: 'Enter', repeat: true }); zoomOut.emit('click', { detail: 0 }); frames(16); }
  const keyHeld = before - zoomed();
  assert.ok(keyHeld > STEP && keyHeld < STEP + HOLD_RATE * 0.7, `key repeats don't pile up steps: ${keyHeld}`);
  zoomOut.emit('keyup', { key: 'Enter' });
  frames(1000);
  // A click with no key behind it (assistive technology) is one step.
  before = zoomed();
  zoomOut.emit('click', { detail: 0 });
  frames(1000);
  near(zoomed() - before, -STEP);

  // Other mouse buttons don't press it; wheel over the controls doesn't zoom the fractal.
  before = zoomed();
  zoomOut.emit('pointerdown', { pointerId: 9, pointerType: 'mouse', button: 2 });
  frames(200);
  assert.equal(zoomed(), before);
  assert.equal(h.elements.get('#view-controls').emit('wheel').stopped, true);
});

test('+ and - zoom about the centre while held, like the buttons; 0 and Home reset', () => {
  const h = harness();
  h.flush();
  const start = h.request().view;
  const zoomed = () => { h.flush(); return start.logScale - h.request().view.logScale; };
  let time = 1000;
  const frames = (ms, step = 16) => { for (const end = time + ms; time < end;) h.flushFrames(time += step); };
  const key = (type, key, code, extra = {}) => h.window.emit(type, { key, code, ...extra });

  // A tap of = (the + key unshifted) is one step in, eased like a button tap.
  key('keydown', '=', 'Equal');
  assert.equal(zoomed(), 0, 'no jump on press');
  key('keyup', '=', 'Equal');
  frames(1000);
  near(zoomed(), STEP);
  const shift = BigInt(h.request().view.bits - start.bits);
  assert.equal(h.request().view.re, start.re << shift, 'the centre stays put');

  // Held, + zooms steadily: repeats add nothing; the zoom-in button shows it pressed.
  // Shift let go before the key still ends the hold: the release is matched by key position.
  let before = zoomed();
  key('keydown', '+', 'Equal', { shiftKey: true });
  assert.ok(h.elements.get('#zoom-in').classes.has('holding'));
  frames(16);
  for (let i = 0; i < 50; i++) { key('keydown', '+', 'Equal', { shiftKey: true, repeat: true }); frames(20, 20); }
  const held = zoomed() - before;
  assert.ok(held > HOLD_RATE * 0.9 && held < STEP + HOLD_RATE * 1.1, `held about a second: ${held}`);
  key('keyup', '=', 'Equal');
  assert.ok(!h.elements.get('#zoom-in').classes.has('holding'));
  frames(1000);
  const settled = zoomed();
  frames(1000);
  assert.equal(zoomed(), settled, 'stops once released');

  // - zooms out, numpad keys too.
  before = zoomed();
  key('keydown', '-', 'Minus'); key('keyup', '-', 'Minus');
  key('keydown', '-', 'NumpadSubtract'); key('keyup', '-', 'NumpadSubtract');
  frames(1000);
  near(zoomed() - before, -2 * STEP);
  before = zoomed();
  key('keydown', '+', 'NumpadAdd'); key('keyup', '+', 'NumpadAdd');
  frames(1000);
  near(zoomed() - before, STEP);

  // Browser zoom (Ctrl/⌘ +) and keys typed into the dialog are left alone.
  before = zoomed();
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    key('keydown', '+', 'Equal', { [modifier]: true });
    key('keyup', '=', 'Equal');
  }
  h.elements.get('#centre-real').emit('click');
  key('keydown', '-', 'Minus'); key('keyup', '-', 'Minus');
  key('keydown', '0', 'Digit0');
  h.elements.get('#close-view-dialog').emit('click');
  frames(1000);
  assert.equal(zoomed(), before);

  // 0 resets, and a step still easing out doesn't carry on from the reset view.
  key('keydown', '=', 'Equal'); key('keyup', '=', 'Equal');
  frames(16); frames(16);
  key('keydown', '0', 'Digit0');
  frames(1000);
  assert.equal(h.request().view.logScale, start.logScale);
  assert.equal(h.location.hash, '');
  // Held 0 resets once, not on every repeat.
  const id = h.request().id;
  key('keydown', '0', 'Digit0', { repeat: true });
  h.flush();
  assert.equal(h.request().id, id);

  // Leaving the window mid-hold lets go, as the key-up will never arrive.
  key('keydown', '+', 'Equal');
  frames(200);
  h.window.emit('blur');
  frames(1000);
  const afterBlur = zoomed();
  frames(1000);
  assert.equal(zoomed(), afterBlur);
});

test('coordinate labels adapt to available width without changing the view', () => {
  const h = harness(); h.flushFrames();
  const real = h.elements.get('#centre-real');
  const id = h.request().id;
  real.clientWidth = 42;
  h.resizeObservers.find(observer => observer.targets.includes(real)).callback();
  h.flushFrames();
  assert.ok(real.textContent.includes('…'));
  assert.ok(real.textContent.length <= 6);
  real.clientWidth = 120;
  h.resizeObservers.find(observer => observer.targets.includes(real)).callback();
  h.flushFrames();
  assert.equal(real.textContent, '-0.60000000');
  assert.equal(h.request().id, id);
});

test('deep renders share one orbit: worker 0 builds it, the rest receive it once', () => {
  const h = harness({ cores: 4 });
  for (let i = 0; i < 26; i++) h.window.emit('wheel', { clientX: 70, clientY: 300, deltaY: -600, deltaMode: 0 });
  h.flush();
  const requests = () => h.workers.map(worker => worker.messages.at(-1));
  const first = requests();
  assert.ok(first[0].view.logScale <= -38);
  assert.equal(first.length, 3);
  const { key } = first[0].reference;
  assert.equal(first[0].reference.build, true);
  for (const request of first.slice(1)) {
    assert.equal(request.reference.key, key);
    assert.equal(request.reference.build, undefined);
    assert.equal(request.reference.orbit, undefined);
  }
  const orbit = { re: new Float64Array([0, 1]), im: new Float64Array([0, 0]), exp: new Float64Array([0, -1]) };
  h.workers[0].emit({ type: 'reference', key, orbit });
  for (const worker of h.workers.slice(1)) assert.deepEqual(worker.messages.at(-1), { type: 'reference', key, spec: first[0].reference.spec, orbit });
  // A small pan reuses the same reference; nobody is sent the orbit again.
  h.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 400, clientY: 300 });
  h.canvas.emit('pointermove', { pointerId: 1, clientX: 380, clientY: 300 }); h.flush();
  const panned = requests().filter(message => message.reference);
  assert.ok(panned.length > 0);
  for (const request of panned) assert.deepEqual(Object.keys(request.reference).sort(), ['key', 'spec']);
  assert.ok(panned.every(request => request.reference.key === key));
  // Zooming out far enough needs a new reference.
  h.canvas.emit('pointerup', { pointerId: 1 });
  for (let i = 0; i < 4; i++) h.window.emit('wheel', { clientX: 400, clientY: 300, deltaY: 600, deltaMode: 0 });
  h.flush();
  assert.notEqual(h.request().reference.key, key);
  assert.equal(h.request().reference.build, true);
});

test('reset is hidden at the default view and appears once the view changes', () => {
  const h = harness();
  const reset = h.elements.get('#reset-view');
  h.flushFrames();
  assert.equal(reset.hidden, true);
  h.window.emit('wheel', { clientX: 400, clientY: 300, deltaY: -100, deltaMode: 0 });
  h.flushFrames();
  assert.equal(reset.hidden, false);
  reset.emit('click');
  h.flushFrames();
  assert.equal(reset.hidden, true);
  h.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 400, clientY: 300 });
  h.canvas.emit('pointermove', { pointerId: 1, clientX: 410, clientY: 300 });
  h.flushFrames();
  assert.equal(reset.hidden, false, 'panning alone also offers reset');
});

test('a draft that leaves a few pixels unresolved is finished first, then deepened in place', () => {
  const h = harness({ cores: 3 });
  const first = h.request();
  const active = h.workers.filter(worker => worker.messages.at(-1).id === first.id && !worker.messages.at(-1).type);
  const pixels = Number(h.canvas.dataset.computePixels);
  // 5% of coarse samples run out: no restart, the full-resolution draft goes on.
  for (const worker of active) worker.emit({ type: 'pass', id: first.id, step: 8, elapsed: 1, fallbacks: 0, samples: 1000, unresolved: 50 });
  assert.equal(h.request().id, first.id, 'a mostly resolved coarse pass does not restart');
  for (const worker of active) worker.emit({ type: 'pass', id: first.id, step: 1, elapsed: 1, fallbacks: 0, samples: 1000, unresolved: 10,
    pending: Math.ceil(pixels * 0.05 / active.length) });
  // The draft is done; the unresolved pixels of the same render are deepened at 4x the budget.
  const deepen = h.request();
  assert.equal(deepen.id, first.id);
  assert.equal(deepen.deepen, true);
  assert.equal(deepen.iterations, first.iterations * 4);
  assert.ok(active.every(worker => worker.messages.at(-1).deepen), 'every active worker deepens its own pixels');
  assert.equal(h.canvas.dataset.rendered, 'false');
  assert.equal(h.canvas.dataset.iterations, String(first.iterations), 'the surface keeps its budget until deepening completes');
  for (const worker of active) worker.emit({ type: 'pass', id: first.id, step: 1, deepen: true, elapsed: 1, fallbacks: 0, samples: 10, unresolved: 0, pending: 0 });
  assert.equal(h.canvas.dataset.rendered, 'true');
  assert.equal(h.canvas.dataset.iterations, String(first.iterations * 4));
  // The learned budget carries on to the next render nearby.
  h.window.emit('wheel', { clientX: 400, clientY: 300, deltaY: -100, deltaMode: 0 });
  h.flush();
  assert.equal(h.request().iterations, first.iterations * 4);
});

/** Report every pass of the latest request from its active workers, with `pending` unresolved pixels in all. */
function finishRequest(h, { coarseUnresolved = 0, pending = 0 } = {}) {
  const request = h.request();
  const active = h.workers.filter(worker => worker.messages.at(-1).id === request.id && !worker.messages.at(-1).type);
  active.forEach((worker, i) => {
    for (const step of [8, 4, 2]) worker.emit({ type: 'pass', id: request.id, step, elapsed: 1, fallbacks: 0, samples: 1000, unresolved: step === 8 ? coarseUnresolved : 0 });
    worker.emit({ type: 'pass', id: request.id, step: 1, elapsed: 1, fallbacks: 0, samples: 1000, unresolved: 0,
      pending: Math.floor(pending / active.length) + (i < pending % active.length ? 1 : 0) });
  });
  return request;
}

test('after a pan, unresolved pixels lead to a full render instead of deepening only the new strips', () => {
  const h = harness({ width: 100, height: 80 });
  completeRegion(h, { x: 0, y: 0, width: 100, height: 80 });
  const first = finishRequest(h);
  assert.equal(h.canvas.dataset.rendered, 'true');
  h.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 20, clientY: 20 });
  h.canvas.emit('pointermove', { pointerId: 1, clientX: 23, clientY: 18 }); h.flush();
  const pan = h.request();
  assert.ok(pan.regions.length && Number(h.canvas.dataset.reusedPixels) > 0, 'the pan reuses pixels');
  // The new strips leave pixels unresolved: the reused ones may hold more, at the old budget.
  finishRequest(h, { pending: 100 });
  const next = h.request();
  assert.ok(next.id > pan.id && !next.deepen, 'a new render, not a deepening');
  assert.equal(next.iterations, first.iterations * 4);
  assert.equal(Number(h.canvas.dataset.computePixels), 100 * 80, 'nothing reused from the lower budget');
});

test('deepening that needs a longer reference than the workers can share renders again with fewer workers', () => {
  // Below 2^-800 each worker's reference tables take ~768 bytes per iteration: at 4x the budget fewer workers fit.
  const h = harness({ cores: 9, hash: '#re=-1.75&im=0&zoom=1e300' });
  const first = h.request();
  assert.ok(first.reference && first.workerCount > 1, `a deep render with ${first.workerCount} workers`);
  finishRequest(h, { coarseUnresolved: 10, pending: Math.ceil(Number(h.canvas.dataset.computePixels) * 0.02) });
  const next = h.request();
  assert.ok(next.id > first.id && !next.deepen, 'a new render, not a deepening');
  assert.equal(next.iterations, first.iterations * 4);
  assert.ok(next.workerCount < first.workerCount, `${next.workerCount} workers`);
});

test('a deepening is abandoned when the view changes', () => {
  const h = harness({ cores: 3 });
  const first = h.request();
  const active = h.workers.filter(worker => worker.messages.at(-1).id === first.id && !worker.messages.at(-1).type);
  for (const worker of active) worker.emit({ type: 'pass', id: first.id, step: 8, elapsed: 1, fallbacks: 0, samples: 1000, unresolved: 20 });
  for (const worker of active) worker.emit({ type: 'pass', id: first.id, step: 1, elapsed: 1, fallbacks: 0, samples: 1000, unresolved: 0, pending: 5000 });
  assert.equal(h.request().deepen, true);
  h.window.emit('wheel', { clientX: 400, clientY: 300, deltaY: -100, deltaMode: 0 });
  h.flush();
  const next = h.request();
  assert.ok(next.id > first.id && !next.deepen);
  // Late reports of the old deepening change nothing.
  for (const worker of active) worker.emit({ type: 'pass', id: first.id, step: 1, deepen: true, elapsed: 1, fallbacks: 0, samples: 10, unresolved: 0, pending: 0 });
  assert.equal(h.canvas.dataset.rendered, 'false');
  assert.equal(h.request().id, next.id);
});

test('a coarse pass that runs out of iterations re-renders with a raised budget', () => {
  const h = harness({ cores: 3 });
  const first = h.request();
  const active = h.workers.filter(worker => worker.messages.at(-1).id === first.id && !worker.messages.at(-1).type);
  for (const worker of active) {
    worker.emit({ type: 'pass', id: first.id, step: 8, elapsed: 1, fallbacks: 0, samples: 1000, unresolved: 500 });
  }
  const raised = h.request();
  assert.equal(raised.id, first.id + 1);
  assert.equal(raised.iterations, first.iterations * 4);
  assert.equal(h.canvas.dataset.iterations, String(first.iterations * 4));
  // Resolved now: completing the render does not raise again.
  for (const worker of h.workers.filter(worker => worker.messages.at(-1).id === raised.id && !worker.messages.at(-1).type)) {
    worker.emit({ type: 'pass', id: raised.id, step: 8, elapsed: 1, fallbacks: 0, samples: 1000, unresolved: 0 });
  }
  assert.equal(h.request().id, raised.id);
  // Home forgets the learned budget.
  h.window.emit('keydown', { key: 'Home' });
  assert.equal(h.request().iterations, first.iterations);
});

test('after zooming, coarse passes do not repaint a sharper projected preview', () => {
  const h = harness({ cores: 3 });
  const finish = (id, steps) => {
    for (const worker of h.workers.filter(worker => worker.messages.at(-1).id === id && !worker.messages.at(-1).type)) {
      for (const step of steps) worker.emit({ type: 'pass', id, step, elapsed: 1, fallbacks: 0, samples: 100, unresolved: 0 });
    }
  };
  finish(h.request().id, [8, 4, 2, 1]);
  h.window.emit('wheel', { clientX: 400, clientY: 300, deltaY: -100, deltaMode: 0 }); h.flush();
  const zoomed = h.request(), image = h.canvases.at(-1);
  const drawsBefore = image.draws.length;
  const tile = (step, x = 64, y = 64) => ({ x, y, width: 32 / step, height: 32 / step, step, clipWidth: 32, clipHeight: 32,
    edgeRight: false, edgeBottom: false, pixels: new Uint8ClampedArray((32 / step) ** 2 * 4) });
  h.workers[0].emit({ type: 'tiles', id: zoomed.id, tiles: [tile(8), tile(4)] });
  h.flushFrames();
  assert.equal(image.draws.length, drawsBefore, 'step 8 and 4 blocks would be coarser than the preview');
  h.workers[0].emit({ type: 'tiles', id: zoomed.id, tiles: [tile(2)] });
  h.flushFrames();
  assert.equal(image.draws.length, drawsBefore + 1, 'the 2-pixel and final passes still paint');
  // Without a finished previous render there is no sharp preview to protect.
  h.window.emit('wheel', { clientX: 400, clientY: 300, deltaY: -100, deltaMode: 0 }); h.flush();
  const next = h.request(), fresh = h.canvases.at(-1), before = fresh.draws.length;
  h.workers[0].emit({ type: 'tiles', id: next.id, tiles: [tile(8)] });
  h.flushFrames();
  assert.equal(fresh.draws.length, before + 1);
});

test('the URL hash follows the view, restores a shared view and clears on reset', () => {
  const h = harness();
  h.flush();
  assert.equal(h.location.hash, '', 'the default view has no hash');
  h.window.emit('wheel', { clientX: 300, clientY: 200, deltaY: -600, deltaMode: 0 });
  h.canvas.emit('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 400, clientY: 300 });
  h.canvas.emit('pointermove', { pointerId: 1, clientX: 430, clientY: 280 });
  h.canvas.emit('pointerup', { pointerId: 1 });
  h.flush();
  const shared = h.location.hash, view = h.request().view;
  assert.match(shared, /^#re=-?\d+\.\d+&im=-?\d+\.\d+&zoom=[\d.e+-]+$/);
  assert.ok(h.replaced.length <= 3, 'replaceState, debounced, never one entry per event');

  // Another visitor opening the link (same window size) lands on the same view.
  const other = harness({ hash: shared });
  const restored = other.request().view;
  assert.ok(Math.abs(restored.logScale - view.logScale) < 1e-8);
  const shift = BigInt(Math.max(view.bits, restored.bits));
  const align = (value, bits) => value << (shift - BigInt(bits));
  const pixel = 1n << (shift - BigInt(Math.ceil(-view.logScale)));
  assert.ok(abs(align(restored.re, restored.bits) - align(view.re, view.bits)) < pixel / 100n);
  assert.ok(abs(align(restored.im, restored.bits) - align(view.im, view.bits)) < pixel / 100n);

  // Reset clears the hash at once, without waiting for the debounce.
  h.elements.get('#reset-view').emit('click');
  assert.equal(h.location.hash, '');

  // An edited hash (or back/forward) moves the view; an invalid one is ignored.
  h.location.hash = shared; h.window.emit('hashchange');
  assert.ok(Math.abs(h.request().view.logScale - view.logScale) < 1e-8);
  const before = h.request().id;
  h.location.hash = '#re=abc&im=0&zoom=2'; h.window.emit('hashchange');
  assert.equal(h.request().id, before);
});
