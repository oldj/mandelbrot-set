import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { scaledFixed, viewOffset } from '../src/precision.ts';
import { formatCoordinate } from '../src/view-info.ts';

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
    dataset = {};
    clientWidth = 120;
    open = false;
    showModal() { this.open = true; }
    close() { this.open = false; }
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
  const elements = new Map([['#mandelbrot', canvas], ...['#view-info', '#centre-real', '#centre-imag', '#zoom-level', '#reset-view', '#copy-view', '#copy-feedback', '#coordinate-dialog', '#coordinate-title', '#coordinate-full', '#close-coordinate'].map(id => [id, new Target()])]);
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
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
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
  assert.equal(h.elements.get('#copy-feedback').textContent, '已复制坐标和放大倍率');
  h.flush(); h.flushFrames();
  assert.equal(h.clipboardWrites.length, 1);
  assert.equal(h.clipboardWrites[0], `Mandelbrot Set\n中心 Re: ${h.elements.get('#centre-real').textContent}\n中心 Im: ${h.elements.get('#centre-imag').textContent}\n放大倍率: ${h.elements.get('#zoom-level').textContent}`);
  assert.ok(!h.clipboardWrites[0].includes('放大倍率: 1.00×'));
  assert.equal(h.elements.get('#copy-feedback').textContent, '');
});

test('clipboard denial and unavailable API show failure, never false success', async () => {
  for (const clipboardWrite of [null, async () => { throw new Error('Permission denied'); }]) {
    const h = harness({ clipboardWrite });
    const button = h.elements.get('#copy-view');
    await button.listeners.get('click')[0]();
    assert.equal(button.dataset.state, 'error');
    assert.equal(button.disabled, false);
    assert.match(h.elements.get('#copy-feedback').textContent, /复制失败/);
  }
});

test('abbreviated coordinates open full values while clipboard retains the complete view', async () => {
  const h = harness();
  for (let i = 0; i < 80; i++) h.window.emit('wheel', { clientX: 200, clientY: 200, deltaY: -600, deltaMode: 0 });
  h.flush(); h.flushFrames();
  const view = h.request().view;
  const real = formatCoordinate(view.re, view.bits, view.logScale);
  const imaginary = formatCoordinate(view.im, view.bits, view.logScale);
  assert.ok(real.length > 40);
  assert.ok(h.elements.get('#centre-real').textContent.includes('…'));
  assert.ok(h.elements.get('#centre-imag').textContent.includes('…'));
  h.elements.get('#centre-real').emit('click');
  assert.equal(h.elements.get('#coordinate-dialog').open, true);
  assert.equal(h.elements.get('#coordinate-title').textContent, '中心实部 Re');
  assert.equal(h.elements.get('#coordinate-full').textContent, real);
  assert.equal(h.elements.get('#coordinate-dialog').emit('wheel').stopped, true);
  const id = h.request().id;
  h.window.emit('keydown', { key: 'Home' });
  assert.equal(h.request().id, id, 'reading the dialog must not reset the background view');
  h.elements.get('#close-coordinate').emit('click');
  assert.equal(h.elements.get('#coordinate-dialog').open, false);
  h.elements.get('#centre-imag').emit('click');
  assert.equal(h.elements.get('#coordinate-full').textContent, imaginary);
  h.elements.get('#close-coordinate').emit('click');
  await h.elements.get('#copy-view').listeners.get('click')[0]();
  assert.ok(h.clipboardWrites[0].includes(`中心 Re: ${real}\n中心 Im: ${imaginary}`));
  assert.ok(!h.clipboardWrites[0].includes('…'));
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
