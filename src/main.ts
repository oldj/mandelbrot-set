import './style.css';
import { initialView, transformView, viewOffset } from './precision';
import type { Point, View } from './precision';
import { iterationBudget } from './fractal';
import { gesture, wheelAnchor, wheelLogFactor } from './gestures';
import type { RenderMessage, RenderRequest } from './types';

const canvas = document.querySelector<HTMLCanvasElement>('#mandelbrot')!;
const context = canvas.getContext('2d', { alpha: false });
if (!context) throw new Error('浏览器无法创建 Canvas 2D 上下文。');
const ctx = context;
const help = '滚轮缩放 · 拖拽平移 · 双指缩放 · Home 恢复全貌';
canvas.title = help;
canvas.tabIndex = 0;
let cssWidth = 1, cssHeight = 1;
let view: View;
let frame = 0;
let generation = 0;
let lastRender = -Infinity;
let renderTimer: ReturnType<typeof setTimeout>;
let coarseReady = false;
const passCounts = new Map<number, number>();
const workers: Worker[] = [];
const workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

interface Surface { canvas: HTMLCanvasElement; view: View; cssWidth: number; cssHeight: number }
let surface: Surface | undefined;
let quality = new Uint8Array();
let qualityColumns = 0;
const tileCanvas = document.createElement('canvas');
const tileContext = tileCanvas.getContext('2d', { alpha: false })!;

/** Reproject the last pixels immediately; high precision differences keep deep pans stable. */
function project(target: CanvasRenderingContext2D, source: Surface, destination: View, width: number, height: number): void {
  const ratio = 2 ** (source.view.logScale - destination.logScale);
  const offset = viewOffset(source.view, destination);
  const x = width / 2 + offset.x - source.cssWidth * ratio / 2;
  const y = height / 2 + offset.y - source.cssHeight * ratio / 2;
  if (![ratio, x, y].every(Number.isFinite) || ratio < 1e-6 || ratio > 1e6) return;
  target.drawImage(source.canvas, x, y, source.cssWidth * ratio, source.cssHeight * ratio);
}

function draw(): void {
  frame = 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#050914';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (surface && surface.view.re === view.re && surface.view.im === view.im
    && surface.view.bits === view.bits && surface.view.logScale === view.logScale
    && surface.cssWidth === cssWidth && surface.cssHeight === cssHeight
    && surface.canvas.width === canvas.width && surface.canvas.height === canvas.height) {
    // At rest, copy physical pixels 1:1. Only gesture previews need interpolation.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(surface.canvas, 0, 0);
    return;
  }
  ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (surface) project(ctx, surface, view, cssWidth, cssHeight);
}

function scheduleDraw(): void {
  if (!frame) frame = requestAnimationFrame(draw);
}

function startRender(): void {
  clearTimeout(renderTimer);
  const image = document.createElement('canvas');
  image.width = canvas.width; image.height = canvas.height;
  const imageContext = image.getContext('2d', { alpha: false })!;
  imageContext.fillStyle = '#050914';
  imageContext.fillRect(0, 0, image.width, image.height);
  imageContext.setTransform(image.width / cssWidth, 0, 0, image.height / cssHeight, 0, 0);
  if (surface) project(imageContext, surface, view, cssWidth, cssHeight);
  surface = { canvas: image, view: { ...view }, cssWidth, cssHeight };
  qualityColumns = Math.ceil(image.width / 32);
  quality = new Uint8Array(qualityColumns * Math.ceil(image.height / 32)).fill(255);
  generation++;
  lastRender = performance.now();
  coarseReady = false;
  passCounts.clear();
  canvas.dataset.rendered = 'false';
  canvas.setAttribute('aria-busy', 'true');
  canvas.dataset.precisionBits = String(view.bits);
  canvas.dataset.logScale = String(view.logScale);
  const iterations = iterationBudget(view.logScale);
  canvas.dataset.iterations = String(iterations);
  workers.forEach((worker, workerIndex) => {
    worker.postMessage({ id: generation, view, width: image.width, height: image.height,
      cssWidth, cssHeight, workerIndex, workerCount, iterations } satisfies RenderRequest);
  });
  scheduleDraw();
}

function changed(): void {
  scheduleDraw();
  clearTimeout(renderTimer);
  // Continue supplying new detail during a long drag; never starve expensive references.
  if (coarseReady && performance.now() - lastRender > 180) startRender();
  else renderTimer = setTimeout(startRender, 120);
}

for (let i = 0; i < workerCount; i++) {
  const worker = new Worker(new URL('./mandelbrot.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<RenderMessage>) => {
    if (data.id !== generation || !surface) return;
    if (data.type === 'error') {
      canvas.title = `绘制失败：${data.message}。按 Home 重试。`;
      canvas.dataset.rendered = 'error';
      canvas.setAttribute('aria-busy', 'false');
      console.error(data.message);
      return;
    }
    if (data.type === 'pass') {
      const count = (passCounts.get(data.step) || 0) + 1;
      passCounts.set(data.step, count);
      if (count === workerCount) {
        if (data.step === 8) coarseReady = true;
        if (data.step === 1) {
          canvas.dataset.rendered = 'true';
          canvas.dataset.renderMs = String(Math.round(performance.now() - lastRender));
          canvas.setAttribute('aria-busy', 'false');
          canvas.title = help;
        }
      }
      return;
    }
    tileCanvas.width = data.width; tileCanvas.height = data.height;
    tileContext.putImageData(new ImageData(data.pixels, data.width, data.height), 0, 0);
    const destination = surface.canvas.getContext('2d')!;
    destination.setTransform(1, 0, 0, 1, 0, 0);
    destination.imageSmoothingEnabled = false;
    // Workers finish passes independently. A late coarse tile must never erase finer pixels.
    const right = Math.min(surface.canvas.width, data.x + data.width * data.step);
    const bottom = Math.min(surface.canvas.height, data.y + data.height * data.step);
    for (let y = data.y; y < bottom; y += 32) {
      for (let x = data.x; x < right; x += 32) {
        const index = Math.floor(y / 32) * qualityColumns + Math.floor(x / 32);
        if (quality[index] < data.step) continue;
        quality[index] = data.step;
        const width = Math.min(32, right - x), height = Math.min(32, bottom - y);
        destination.drawImage(tileCanvas, (x - data.x) / data.step, (y - data.y) / data.step,
          width / data.step, height / data.step, x, y, width, height);
      }
    }
    scheduleDraw();
  };
  worker.onerror = event => {
    canvas.title = '绘制线程异常，请刷新页面重试。';
    canvas.dataset.rendered = 'error';
    canvas.setAttribute('aria-busy', 'false');
    console.error(event.message);
  };
  workers.push(worker);
}

function localPoint(clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
}

window.addEventListener('wheel', event => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const anchor = wheelAnchor(event.clientX, event.clientY, rect);
  view = transformView(view, anchor, anchor, wheelLogFactor(event.deltaY, event.deltaMode, cssHeight));
  changed();
}, { passive: false });

const pointers = new Map<number, Point>();
canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, localPoint(event.clientX, event.clientY));
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  const before = gesture(pointers.values())!;
  pointers.set(event.pointerId, localPoint(event.clientX, event.clientY));
  const after = gesture(pointers.values())!;
  const logFactor = before.distance > 2 && after.distance > 2 ? Math.log2(before.distance / after.distance) : 0;
  view = transformView(view, before.centre, after.centre, logFactor);
  changed();
});

function releasePointer(event: PointerEvent): void {
  if (!pointers.delete(event.pointerId)) return;
  if (pointers.size === 0) {
    canvas.classList.remove('dragging');
    clearTimeout(renderTimer);
    renderTimer = setTimeout(startRender, 0);
  }
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('lostpointercapture', releasePointer);
window.addEventListener('blur', () => { pointers.clear(); canvas.classList.remove('dragging'); });

window.addEventListener('keydown', event => {
  if (event.key !== 'Home') return;
  event.preventDefault();
  view = initialView(cssWidth, cssHeight);
  startRender();
});

function resize(): void {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
  if (view && width === canvas.width && height === canvas.height && cssWidth === rect.width && cssHeight === rect.height) return;
  cssWidth = rect.width; cssHeight = rect.height;
  canvas.width = width; canvas.height = height;
  view ??= initialView(cssWidth, cssHeight);
  pointers.clear(); canvas.classList.remove('dragging');
  startRender();
}
new ResizeObserver(resize).observe(canvas);
resize();

function watchPixelRatio(): void {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    resize(); watchPixelRatio();
  }, { once: true });
}
watchPixelRatio();
window.addEventListener('pagehide', () => {
  clearTimeout(renderTimer);
  cancelAnimationFrame(frame);
  workers.forEach(worker => worker.terminate());
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
