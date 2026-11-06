import './style.css';
import type { RenderRequest, RenderStrip } from './types';

const canvas = document.querySelector<HTMLCanvasElement>('#mandelbrot')!;
const context = canvas.getContext('2d', { alpha: false });
if (!context) throw new Error('浏览器无法创建 Canvas 2D 上下文。');
const ctx = context;
let worker: Worker | undefined;
let resizeTimer: ReturnType<typeof setTimeout>;

function render(): void {
  // Stop stale work immediately when the viewport changes.
  worker?.terminate();
  const { width, height } = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  ctx.fillStyle = '#050914';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  worker = new Worker(new URL('./mandelbrot.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<RenderStrip>) => {
    ctx.putImageData(new ImageData(data.pixels, canvas.width, data.height), 0, data.y);
    if (data.done) {
      canvas.dataset.rendered = 'true';
      worker?.terminate();
      worker = undefined;
    }
  };
  canvas.dataset.rendered = 'false';
  worker.postMessage({ width: canvas.width, height: canvas.height } satisfies RenderRequest);
}

const observer = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 100);
});
observer.observe(canvas);

// Browser zoom and moving between monitors can change DPR without resizing CSS pixels.
function watchPixelRatio(): void {
  const query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener('change', () => {
    clearTimeout(resizeTimer);
    render();
    watchPixelRatio();
  }, { once: true });
}
watchPixelRatio();
