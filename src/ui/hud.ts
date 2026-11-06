/**
 * The information panel and its controls: the centre coordinates (abbreviated
 * to fit their boxes), the magnification, the full-coordinate dialog (with
 * its own copy button), copying the view to the clipboard, and the reset
 * button, which is only shown away from the initial view. main.ts owns the view; the panel reads it through
 * `current` and is refreshed from each drawn frame.
 */
import { initialView, isInitialView } from '../math/precision.ts';
import type { View } from '../math/precision.ts';
import { compactCoordinate, viewClipboardText, viewInfo } from './view-info.ts';

export interface HudOptions {
  /** The fractal canvas: keyboard focus moves there when the focused reset button disappears. */
  canvas: HTMLCanvasElement;
  /** A 2D context used only to measure coordinate text. */
  measure: CanvasRenderingContext2D;
  /** The view as currently shown, once there is one. */
  current: () => { view: View; cssWidth: number; cssHeight: number } | undefined;
  /** Ask for a frame, e.g. when the coordinate boxes change size. */
  requestDraw: () => void;
  onReset: () => void;
}

export interface Hud {
  /** Refresh the panel for the view about to be drawn (cheap when nothing changed). */
  update(view: View, cssWidth: number, cssHeight: number): void;
  /** Whether the full-coordinate dialog is open (keyboard shortcuts stay off then). */
  readonly dialogOpen: boolean;
  dispose(): void;
}

export function createHud({ canvas, measure, current, requestDraw, onReset }: HudOptions): Hud {
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
  const copyCoordinate = document.querySelector<HTMLButtonElement>('#copy-coordinate')!;
  const coordinateFeedback = document.querySelector<HTMLElement>('#coordinate-copy-feedback')!;

  let info: ReturnType<typeof viewInfo>;
  let infoView: View | undefined;
  let infoWidth = 0, infoHeight = 0;
  let layoutDirty = true;

  /** Reset is only offered once the view differs from the default one. */
  function updateResetButton(view: View, cssWidth: number, cssHeight: number): void {
    const hidden = isInitialView(view, cssWidth, cssHeight);
    if (resetButton.hidden === hidden) return;
    // Keep keyboard focus somewhere useful when the focused button disappears.
    if (hidden && document.activeElement === resetButton) canvas.focus({ preventScroll: true });
    resetButton.hidden = hidden;
  }

  function update(view: View, cssWidth: number, cssHeight: number): void {
    if (infoView !== view || infoWidth !== cssWidth || infoHeight !== cssHeight) {
      info = viewInfo(view, initialView(cssWidth, cssHeight).logScale);
      zoomLabel.textContent = info.zoom;
      infoView = view; infoWidth = cssWidth; infoHeight = cssHeight;
      layoutDirty = true;
      updateResetButton(view, cssWidth, cssHeight);
    }
    if (!layoutDirty) return;
    // As many significant digits as fit each box, measured in its own font.
    for (const [label, full] of [[realLabel, info.real], [imaginaryLabel, info.imaginary]] as const) {
      const style = getComputedStyle(label);
      // The font shorthand can be empty when font-variant-numeric is set.
      measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = parseFloat(style.letterSpacing) || 0;
      const available = Math.max(0, label.clientWidth - 1);
      const characterWidth = measure.measureText('0').width + spacing;
      let budget = Math.max(5, Math.min(23, Math.floor(available / Math.max(1, characterWidth))));
      let compact = compactCoordinate(full, budget);
      while (budget > 5 && measure.measureText(compact).width + spacing * (compact.length - 1) > available) {
        compact = compactCoordinate(full, --budget);
      }
      label.textContent = compact;
    }
    layoutDirty = false;
  }

  const layoutObserver = new ResizeObserver(() => {
    layoutDirty = true;
    requestDraw();
  });
  layoutObserver.observe(realLabel);
  layoutObserver.observe(imaginaryLabel);

  function showCoordinate(part: 'real' | 'imaginary'): void {
    const shown = current();
    if (!shown) return;
    const full = viewInfo(shown.view, initialView(shown.cssWidth, shown.cssHeight).logScale);
    coordinateTitle.textContent = part === 'real' ? 'Center · real part (Re)' : 'Center · imaginary part (Im)';
    coordinateFull.textContent = full[part];
    if (!coordinateDialog.open) coordinateDialog.showModal();
  }
  realLabel.addEventListener('click', () => showCoordinate('real'));
  imaginaryLabel.addEventListener('click', () => showCoordinate('imaginary'));
  closeCoordinate.addEventListener('click', () => coordinateDialog.close());
  coordinateDialog.addEventListener('wheel', event => event.stopPropagation(), { passive: true });

  const stopCopyView = copyOnClick(copyButton, copyFeedback, () => {
    // Snapshot the current view, including all coordinate digits, even before the next paint.
    const shown = current();
    return shown && viewClipboardText(shown.view, initialView(shown.cssWidth, shown.cssHeight).logScale);
  }, 'Position and zoom copied', 'Couldn’t copy. Try again, or open a coordinate and select it.');
  const stopCopyCoordinate = copyOnClick(copyCoordinate, coordinateFeedback, () => coordinateFull.textContent ?? undefined,
    'Copied', 'Couldn’t copy. Select the digits and copy them instead.');
  coordinateDialog.addEventListener('close', () => { coordinateFeedback.textContent = ''; copyCoordinate.dataset.state = 'idle'; });

  resetButton.addEventListener('click', onReset);
  // Interacting with the information controls must not zoom the fractal underneath.
  infoPanel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
  resetButton.addEventListener('wheel', event => event.stopPropagation(), { passive: true });

  return {
    update,
    get dialogOpen() { return coordinateDialog.open; },
    dispose() { stopCopyView(); stopCopyCoordinate(); },
  };
}

/**
 * Copy `text()` to the clipboard when `button` is clicked, showing progress on
 * the button (data-state: pending, copied, error, idle) and in `feedback`, a
 * live region, until it resets after 2 s (4 s for errors). Returns a function
 * that cancels a pending reset.
 */
function copyOnClick(button: HTMLButtonElement, feedback: HTMLElement, text: () => string | undefined,
  copied: string, failed: string): () => void {
  let timer: ReturnType<typeof setTimeout>;
  button.addEventListener('click', async () => {
    const value = text();
    if (button.disabled || value === undefined) return;
    clearTimeout(timer);
    button.disabled = true;
    button.dataset.state = 'pending';
    feedback.textContent = 'Copying…';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      button.dataset.state = 'copied';
      feedback.textContent = copied;
    } catch {
      button.dataset.state = 'error';
      feedback.textContent = failed;
    } finally {
      button.disabled = false;
      timer = setTimeout(() => {
        feedback.textContent = '';
        button.dataset.state = 'idle';
      }, button.dataset.state === 'copied' ? 2000 : 4000);
    }
  });
  return () => clearTimeout(timer);
}
