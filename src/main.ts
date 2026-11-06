import { initialView, isInitialView, transformView, viewOffset } from './precision';
import type { Point, View } from './precision';
import { adaptBudget, chooseBudget, rememberUse } from './budget';
import type { BudgetMemory } from './budget';
import { gesture, wheelAnchor, wheelLogFactor } from './gestures';
import { compactCoordinate, viewClipboardText, viewInfo } from './view-info';
import { missingRegions, panRaster, shiftQuality } from './raster-cache';
import { TileStage } from './tile-stage';
import { renderWorkerCount, workerCapacity } from './worker-policy';
import { needsReference, referenceOffset, referenceSpec, viewLogRadius } from './reference';
import type { OrbitData, ReferenceSpec } from './reference';
import type { ReferencePlan, RenderMessage, RenderRequest } from './types';

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
/** Learned iteration budget, and the coarse-pass tally that adapts it. */
let budgetMemory: BudgetMemory | undefined;
let coarseSamples = 0, coarseUnresolved = 0;
/** The finest pass every worker has finished for the current surface (255: none yet). */
let completedStep = 255;
const workers: Worker[] = [];
const workerLimit = workerCapacity(navigator.hardwareConcurrency);
let activeWorkerCount = 1;

/** The one reference orbit deep renders share; worker 0 builds it, the rest receive copies. */
interface SharedOrbit { key: number; spec: ReferenceSpec; orbit?: OrbitData }
let sharedOrbit: SharedOrbit | undefined;
let referenceKeys = 0;
/** The orbit key each worker already holds, so it is sent at most once per worker. */
const workerOrbitKeys: (number | undefined)[] = [];

function planReference(target: View, iterations: number): SharedOrbit | undefined {
  if (!needsReference(target, cssWidth, cssHeight)) return undefined;
  if (!sharedOrbit || !referenceOffset(sharedOrbit.spec, target, viewLogRadius(target, cssWidth, cssHeight), iterations)) {
    sharedOrbit = { key: ++referenceKeys, spec: referenceSpec(target, cssWidth, cssHeight, iterations) };
  }
  return sharedOrbit;
}

function referencePlan(shared: SharedOrbit, workerIndex: number): ReferencePlan {
  const plan: ReferencePlan = { key: shared.key, spec: shared.spec };
  if (workerOrbitKeys[workerIndex] === shared.key) return plan;
  if (shared.orbit) {
    workerOrbitKeys[workerIndex] = shared.key;
    return { ...plan, orbit: shared.orbit };
  }
  // Worker 0 is always active. Others wait; the orbit is forwarded once it exists.
  return workerIndex === 0 ? { ...plan, build: true } : plan;
}

interface Surface { canvas: HTMLCanvasElement; view: View; cssWidth: number; cssHeight: number; iterations: number }
let surface: Surface | undefined;
let quality = new Uint8Array();
let stage: TileStage | undefined;
let stageImage: ImageData | undefined;
// Transparent where nothing is staged, so the upload composites over the preview.
const uploadCanvas = document.createElement('canvas');
const uploadContext = uploadCanvas.getContext('2d')!;

/** Upload all tiles staged since the last frame with one putImageData and one drawImage. */
function flushTiles(): void {
  const region = stage?.pending();
  if (!region || !stage || !stageImage || !surface) return;
  uploadContext.putImageData(stageImage, 0, 0, region.x, region.y, region.width, region.height);
  const destination = surface.canvas.getContext('2d')!;
  destination.setTransform(1, 0, 0, 1, 0, 0);
  destination.imageSmoothingEnabled = false;
  destination.drawImage(uploadCanvas, region.x, region.y, region.width, region.height,
    region.x, region.y, region.width, region.height);
  stage.clear(region);
}

/** Reproject the last pixels immediately; high precision differences keep deep pans stable. */
function project(target: CanvasRenderingContext2D, source: Surface, destination: View, width: number, height: number): void {
  const ratio = 2 ** (source.view.logScale - destination.logScale);
  const offset = viewOffset(source.view, destination);
  const x = width / 2 + offset.x - source.cssWidth * ratio / 2;
  const y = height / 2 + offset.y - source.cssHeight * ratio / 2;
  if (![ratio, x, y].every(Number.isFinite) || ratio < 1e-6 || ratio > 1e6) return;
  target.drawImage(source.canvas, x, y, source.cssWidth * ratio, source.cssHeight * ratio);
}

/**
 * Quality for a new surface whose preview is the projected old one. Zoomed in
 * by a factor F, a surface finished to step s looks like samples F s pixels
 * apart: coarser passes than that would replace the preview with a blockier
 * image, then sharpen it again, so the grain would grow and shrink while
 * zooming (sharp, blurry, sharp). Those
 * passes still run (their statistics drive the budget); they just are not
 * painted over the better preview. The final pass always paints.
 */
function projectedQuality(source: Surface | undefined, completed: number, width: number, height: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(width * height).fill(255);
  if (!source || source.cssWidth !== cssWidth || source.cssHeight !== cssHeight
    || source.canvas.width !== width || source.canvas.height !== height) return result;
  const ratio = 2 ** (source.view.logScale - view.logScale);
  // At least 2: quality 1 means finished, which a pan would reuse as is. Zoomed
  // out, the preview is sharper still but leaves the borders to the coarse passes.
  const effective = Math.max(2, Math.floor(ratio * completed));
  if (!Number.isFinite(ratio) || effective >= 255) return result;
  // Where the projected old image lands, in physical pixels (inset by a pixel for its soft edge).
  const offset = viewOffset(source.view, view), scaleX = width / cssWidth, scaleY = height / cssHeight;
  const left = Math.max(0, Math.ceil((cssWidth / 2 + offset.x - source.cssWidth * ratio / 2) * scaleX) + 1);
  const top = Math.max(0, Math.ceil((cssHeight / 2 + offset.y - source.cssHeight * ratio / 2) * scaleY) + 1);
  const right = Math.min(width, Math.floor((cssWidth / 2 + offset.x + source.cssWidth * ratio / 2) * scaleX) - 1);
  const bottom = Math.min(height, Math.floor((cssHeight / 2 + offset.y + source.cssHeight * ratio / 2) * scaleY) - 1);
  for (let y = top; y < bottom; y++) result.fill(effective, y * width + left, y * width + right);
  return result;
}

/** Reset is only offered once the view differs from the default one. */
function updateResetButton(): void {
  const hidden = isInitialView(view, cssWidth, cssHeight);
  if (resetButton.hidden === hidden) return;
  // Keep keyboard focus somewhere useful when the focused button disappears.
  if (hidden && document.activeElement === resetButton) canvas.focus({ preventScroll: true });
  resetButton.hidden = hidden;
}

function draw(): void {
  frame = 0;
  // The label observer can fire before the canvas has a size (e.g. a hidden page).
  if (!view) return;
  flushTiles();
  if (infoView !== view || infoWidth !== cssWidth || infoHeight !== cssHeight) {
    info = viewInfo(view, initialView(cssWidth, cssHeight).logScale);
    zoomLabel.textContent = info.zoom;
    infoView = view; infoWidth = cssWidth; infoHeight = cssHeight;
    coordinateLayoutDirty = true;
    updateResetButton();
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
  const iterations = chooseBudget(budgetMemory, view.logScale);
  budgetMemory = rememberUse(budgetMemory, view.logScale);
  // Reused pixels must come from the same budget: a larger one may resolve black pixels.
  const pan = surface && surface.cssWidth === cssWidth && surface.cssHeight === cssHeight && surface.iterations === iterations
    && surface.canvas.width === canvas.width && surface.canvas.height === canvas.height
    ? panRaster(surface.view, view, canvas.width, canvas.height, cssWidth, cssHeight) : undefined;
  // A release or subpixel movement need not cancel useful work already in flight.
  if (pan && pan.dx === 0 && pan.dy === 0 && canvas.dataset.rendered !== 'error') {
    scheduleDraw();
    return;
  }
  // Staged pixels belong to the outgoing surface and are part of the next preview.
  flushTiles();
  const image = document.createElement('canvas');
  image.width = canvas.width; image.height = canvas.height;
  if (stage?.width !== image.width || stage.height !== image.height) {
    stage = new TileStage(image.width, image.height);
    stageImage = new ImageData(stage.pixels, image.width, image.height);
    uploadCanvas.width = image.width; uploadCanvas.height = image.height;
  }
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
    quality = projectedQuality(surface, completedStep, image.width, image.height);
  }
  const regions = pan ? missingRegions(quality, image.width, image.height)
    : [{ x: 0, y: 0, width: image.width, height: image.height }];
  surface = { canvas: image, view: pan?.view ?? { ...view }, cssWidth, cssHeight, iterations };
  completedStep = 255;
  generation++;
  lastRender = performance.now();
  coarseReady = false;
  passCounts.clear();
  coarseSamples = coarseUnresolved = 0;
  canvas.dataset.rendered = 'false';
  canvas.setAttribute('aria-busy', 'true');
  canvas.dataset.precisionBits = String(view.bits);
  canvas.dataset.logScale = String(view.logScale);
  canvas.dataset.iterations = String(iterations);
  const renderPixels = regions.reduce((sum, region) => sum + region.width * region.height, 0);
  canvas.dataset.reusedPixels = String(image.width * image.height - renderPixels);
  canvas.dataset.computePixels = String(renderPixels);
  activeWorkerCount = renderWorkerCount(workerLimit, renderPixels, view.logScale, iterations);
  canvas.dataset.workers = String(activeWorkerCount);
  while (workers.length < activeWorkerCount) createWorker();
  const shared = renderPixels ? planReference(surface.view, iterations) : undefined;
  canvas.dataset.referenceKey = shared ? String(shared.key) : '';
  workers.forEach((worker, workerIndex) => {
    if (workerIndex >= activeWorkerCount) {
      worker.postMessage({ type: 'cancel', id: generation });
      return;
    }
    worker.postMessage({ id: generation, view: surface!.view, width: image.width, height: image.height,
      cssWidth, cssHeight, workerIndex, workerCount: activeWorkerCount, iterations, regions,
      reference: shared && referencePlan(shared, workerIndex) } satisfies RenderRequest);
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
    if (data.type === 'reference') {
      // Still useful after newer generations when they reuse the same reference.
      if (sharedOrbit?.key !== data.key) return;
      sharedOrbit.orbit = data.orbit;
      workers.forEach((other, workerIndex) => {
        if (workerOrbitKeys[workerIndex] === data.key) return;
        if (other === worker) { workerOrbitKeys[workerIndex] = data.key; return; }
        if (workerIndex >= activeWorkerCount) return;
        workerOrbitKeys[workerIndex] = data.key;
        other.postMessage({ type: 'reference', key: data.key, spec: sharedOrbit!.spec, orbit: data.orbit });
      });
      return;
    }
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
      if (data.step === 8) { coarseSamples += data.samples; coarseUnresolved += data.unresolved; }
      if (count === activeWorkerCount) {
        completedStep = data.step;
        if (data.step === 8) {
          coarseReady = true;
          const adapted = adaptBudget(budgetMemory, surface.view.logScale, surface.iterations, coarseSamples, coarseUnresolved);
          budgetMemory = adapted.memory;
          if (adapted.raise) { startRender(); return; }
        }
        if (data.step === 1) {
          flushTiles();
          canvas.dataset.rendered = 'true';
          canvas.dataset.renderMs = String(Math.round(performance.now() - lastRender));
          canvas.setAttribute('aria-busy', 'false');
          canvas.title = '';
        }
      }
      return;
    }
    // Workers finish passes independently. A late coarse tile must never erase finer pixels.
    for (const tile of data.tiles) stage!.add(tile, quality);
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
  // Capture can fail if the pointer is already gone (released before this handler ran).
  try { canvas.setPointerCapture(event.pointerId); } catch { return; }
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
  budgetMemory = undefined;
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
