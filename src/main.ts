import { initialView, transformView, viewOffset } from './precision';
import type { Point, View } from './precision';
import { iterationBudget } from './fractal';
import { gesture, wheelAnchor, wheelLogFactor } from './gestures';
import { compactCoordinate, viewClipboardText, viewInfo } from './view-info';
import { claimTile, missingRegions, panRaster, shiftQuality } from './raster-cache';
import { renderWorkerCount, workerCapacity } from './worker-policy';
import type { RenderMessage, RenderRequest } from './types';

const canvas = document.querySelector<HTMLCanvasElement>('#mandelbrot')!;
const infoPanel = document.querySelector<HTMLElement>('#view-info')!;
const realLabel = document.querySelector<HTMLButtonElement>('#centre-real')!;
const imaginaryLabel = document.querySelector<HTMLButtonElement>('#centre-imag')!;
const coordinateDialog = document.querySelector<HTMLDialogElement>('#coordinate-dialog')!;
const coordinateTitle = document.querySelector<HTMLElement>('#coordinate-title')!;
const coordinateFull = document.querySelector<HTMLElement>('#coordinate-full')!;
const closeCoordinate = document.querySelector<HTMLButtonElement>('#close-coordinate')!;
const zoomLabel = document.querySelector<HTMLElement>('#zoom-level')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset-view')!;
const copyButton = document.querySelector<HTMLButtonElement>('#copy-view')!;
const copyFeedback = document.querySelector<HTMLElement>('#copy-feedback')!;
let copyFeedbackTimer: ReturnType<typeof setTimeout>;
const context = canvas.getContext('2d', { alpha: false });
if (!context) throw new Error('浏览器无法创建 Canvas 2D 上下文。');
const ctx = context;
canvas.tabIndex = 0;
let cssWidth = 1, cssHeight = 1;
let view: View;
let infoView: View | undefined;
let infoWidth = 0, infoHeight = 0;
let info: ReturnType<typeof viewInfo>;
let coordinateLayoutDirty = true;
let frame = 0;
let generation = 0;
let lastRender = -Infinity;
let renderTimer: ReturnType<typeof setTimeout>;
let coarseReady = false;
const passCounts = new Map<number, number>();
const workers: Worker[] = [];
const workerLimit = workerCapacity(navigator.hardwareConcurrency);
let activeWorkerCount = 1;

interface Surface { canvas: HTMLCanvasElement; view: View; cssWidth: number; cssHeight: number }
let surface: Surface | undefined;
let quality = new Uint8Array();
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
  // The label observer can fire before the canvas has a size (e.g. a hidden page).
  if (!view) return;
  if (infoView !== view || infoWidth !== cssWidth || infoHeight !== cssHeight) {
    info = viewInfo(view, initialView(cssWidth, cssHeight).logScale);
    zoomLabel.textContent = info.zoom;
    infoView = view; infoWidth = cssWidth; infoHeight = cssHeight;
    coordinateLayoutDirty = true;
  }
  if (coordinateLayoutDirty) {
    for (const [label, full] of [[realLabel, info.real], [imaginaryLabel, info.imaginary]] as const) {
      const style = getComputedStyle(label);
      // The font shorthand can be empty when font-variant-numeric is set.
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = parseFloat(style.letterSpacing) || 0;
      const available = Math.max(0, label.clientWidth - 1);
      const characterWidth = ctx.measureText('0').width + spacing;
      let budget = Math.max(5, Math.min(23, Math.floor(available / Math.max(1, characterWidth))));
      let compact = compactCoordinate(full, budget);
      while (budget > 5 && ctx.measureText(compact).width + spacing * (compact.length - 1) > available) {
        compact = compactCoordinate(full, --budget);
      }
      label.textContent = compact;
    }
    coordinateLayoutDirty = false;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#050914';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (surface && surface.view.logScale === view.logScale
    && surface.cssWidth === cssWidth && surface.cssHeight === cssHeight
    && surface.canvas.width === canvas.width && surface.canvas.height === canvas.height) {
    // Pure pans use integer physical pixels, never repeatedly resample the cache.
    const offset = viewOffset(surface.view, view);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(surface.canvas, Math.round(offset.x * canvas.width / cssWidth), Math.round(offset.y * canvas.height / cssHeight));
    return;
  }
  ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (surface) project(ctx, surface, view, cssWidth, cssHeight);
}

function scheduleDraw(): void {
  if (!frame) frame = requestAnimationFrame(draw);
}

const coordinateObserver = new ResizeObserver(() => {
  coordinateLayoutDirty = true;
  scheduleDraw();
});
coordinateObserver.observe(realLabel);
coordinateObserver.observe(imaginaryLabel);

function startRender(): void {
  clearTimeout(renderTimer);
  const pan = surface && surface.cssWidth === cssWidth && surface.cssHeight === cssHeight
    && surface.canvas.width === canvas.width && surface.canvas.height === canvas.height
    ? panRaster(surface.view, view, canvas.width, canvas.height, cssWidth, cssHeight) : undefined;
  // A release or subpixel movement need not cancel useful work already in flight.
  if (pan && pan.dx === 0 && pan.dy === 0 && canvas.dataset.rendered !== 'error') {
    scheduleDraw();
    return;
  }
  const image = document.createElement('canvas');
  image.width = canvas.width; image.height = canvas.height;
  const imageContext = image.getContext('2d', { alpha: false })!;
  imageContext.fillStyle = '#050914';
  imageContext.fillRect(0, 0, image.width, image.height);
  if (pan && surface) {
    imageContext.imageSmoothingEnabled = false;
    imageContext.drawImage(surface.canvas, pan.dx, pan.dy);
    quality = shiftQuality(quality, image.width, image.height, pan.dx, pan.dy);
  } else {
    imageContext.setTransform(image.width / cssWidth, 0, 0, image.height / cssHeight, 0, 0);
    if (surface) project(imageContext, surface, view, cssWidth, cssHeight);
    quality = new Uint8Array(image.width * image.height).fill(255);
  }
  const regions = pan ? missingRegions(quality, image.width, image.height)
    : [{ x: 0, y: 0, width: image.width, height: image.height }];
  surface = { canvas: image, view: pan?.view ?? { ...view }, cssWidth, cssHeight };
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
  const renderPixels = regions.reduce((sum, region) => sum + region.width * region.height, 0);
  canvas.dataset.reusedPixels = String(image.width * image.height - renderPixels);
  canvas.dataset.computePixels = String(renderPixels);
  activeWorkerCount = renderWorkerCount(workerLimit, renderPixels, view.logScale, iterations);
  canvas.dataset.workers = String(activeWorkerCount);
  while (workers.length < activeWorkerCount) createWorker();
  workers.forEach((worker, workerIndex) => {
    if (workerIndex >= activeWorkerCount) {
      worker.postMessage({ type: 'cancel', id: generation });
      return;
    }
    worker.postMessage({ id: generation, view: surface!.view, width: image.width, height: image.height,
      cssWidth, cssHeight, workerIndex, workerCount: activeWorkerCount, iterations, regions } satisfies RenderRequest);
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

function createWorker(): void {
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
      if (count === activeWorkerCount) {
        if (data.step === 8) coarseReady = true;
        if (data.step === 1) {
          canvas.dataset.rendered = 'true';
          canvas.dataset.renderMs = String(Math.round(performance.now() - lastRender));
          canvas.setAttribute('aria-busy', 'false');
          canvas.title = '';
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
    const width = Math.min(surface.canvas.width - data.x, data.clipWidth ?? data.width * data.step);
    const height = Math.min(surface.canvas.height - data.y, data.clipHeight ?? data.height * data.step);
    for (const region of claimTile(quality, surface.canvas.width, { x: data.x, y: data.y, width, height }, data.step)) {
      destination.drawImage(tileCanvas, (region.x - data.x) / data.step, (region.y - data.y) / data.step,
        region.width / data.step, region.height / data.step, region.x, region.y, region.width, region.height);
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
  if (!view) return;
  const rect = canvas.getBoundingClientRect();
  const anchor = wheelAnchor(event.clientX, event.clientY, rect);
  view = transformView(view, anchor, anchor, wheelLogFactor(event.deltaY, event.deltaMode, cssHeight));
  changed();
}, { passive: false });

const pointers = new Map<number, Point>();
canvas.addEventListener('pointerdown', event => {
  if (!view || (event.pointerType === 'mouse' && event.button !== 0)) return;
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

function resetView(): void {
  pointers.clear();
  canvas.classList.remove('dragging');
  view = initialView(cssWidth, cssHeight);
  startRender();
}

resetButton.addEventListener('click', resetView);
function showCoordinate(part: 'real' | 'imaginary'): void {
  const current = viewInfo(view, initialView(cssWidth, cssHeight).logScale);
  coordinateTitle.textContent = part === 'real' ? '中心实部 Re' : '中心虚部 Im';
  coordinateFull.textContent = current[part];
  if (!coordinateDialog.open) coordinateDialog.showModal();
}
realLabel.addEventListener('click', () => showCoordinate('real'));
imaginaryLabel.addEventListener('click', () => showCoordinate('imaginary'));
closeCoordinate.addEventListener('click', () => coordinateDialog.close());
coordinateDialog.addEventListener('wheel', event => event.stopPropagation(), { passive: true });

copyButton.addEventListener('click', async () => {
  if (copyButton.disabled) return;
  clearTimeout(copyFeedbackTimer);
  copyButton.disabled = true;
  copyButton.dataset.state = 'pending';
  copyFeedback.textContent = '正在复制…';
  try {
    // Snapshot the current view, including all coordinate digits, even before the next paint.
    const text = viewClipboardText(view, initialView(cssWidth, cssHeight).logScale);
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    copyButton.dataset.state = 'copied';
    copyFeedback.textContent = '已复制坐标和放大倍率';
  } catch {
    copyButton.dataset.state = 'error';
    copyFeedback.textContent = '复制失败，请重试或手动选择坐标。';
  } finally {
    copyButton.disabled = false;
    copyFeedbackTimer = setTimeout(() => {
      copyFeedback.textContent = '';
      copyButton.dataset.state = 'idle';
    }, copyButton.dataset.state === 'copied' ? 2000 : 4000);
  }
});
// Interacting with the information controls must not zoom the fractal underneath.
infoPanel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
resetButton.addEventListener('wheel', event => event.stopPropagation(), { passive: true });

window.addEventListener('keydown', event => {
  if (coordinateDialog.open) return;
  if (event.key !== 'Home') return;
  event.preventDefault();
  resetView();
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
  clearTimeout(copyFeedbackTimer);
  cancelAnimationFrame(frame);
  workers.forEach(worker => worker.terminate());
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
