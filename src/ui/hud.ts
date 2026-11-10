/**
 * The information panel and its controls: the centre coordinates (abbreviated
 * to fit their boxes) and the magnification, which open the view dialog (all
 * digits, copy, edit and apply); copying the view to the clipboard; the reset
 * button, only shown away from the initial view; the zoom buttons; the
 * palette menu; the share dialog (share-dialog.ts); and the keyboard shortcuts (+ and - zoom, 0 and Home reset,
 * C the next palette).
 * main.ts owns the view; the panel reads it through `current`, is refreshed
 * from each drawn frame, and asks for changes through the callbacks.
 */
import { digitScale, initialView, isInitialView } from '../math/precision.ts';
import type { View } from '../math/precision.ts';
import type { Palette } from '../render/palette-names.ts';
import { holdToZoom } from './hold-zoom.ts';
import { createPaletteMenu } from './palette-menu.ts';
import { formatZoomText } from './url-state.ts';
import { compactCoordinate, formatCoordinate, viewClipboardText, viewInfo } from './view-info.ts';
import { readViewFields } from './view-form.ts';
import { closeOnBackdrop, copyOnClick, fitHeight } from './dialog.ts';
import { createShareDialog } from './share-dialog.ts';
import type { ViewFields } from './view-form.ts';

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
  /** Go to a view entered in the dialog. */
  onApply: (view: View) => void;
  /** Zoom about the centre by this log2 scale factor (negative zooms in). */
  onZoom: (logFactor: number) => void;
  /** The palette in use at first, and the one chosen in the palette menu (or with C, the next one). */
  palette: Palette;
  onPalette: (palette: Palette) => void;
  /** The full address of the view as shown now, for the share dialog. */
  shareLink: () => string | undefined;
}

export interface Hud {
  /** Refresh the panel for the view about to be drawn (cheap when nothing changed). */
  update(view: View, cssWidth: number, cssHeight: number): void;
  /** End any zoom the buttons or keys are animating, e.g. before jumping to another view. */
  stopZooming(): void;
  /** Show the palette in use (after a switch, or one a link named). */
  setPalette(palette: Palette): void;
  dispose(): void;
}

export function createHud({ canvas, measure, current, requestDraw, onReset, onApply, onZoom, palette, onPalette, shareLink }: HudOptions): Hud {
  const infoPanel = document.querySelector<HTMLElement>('#view-info')!;
  const realLabel = document.querySelector<HTMLButtonElement>('#centre-real')!;
  const imaginaryLabel = document.querySelector<HTMLButtonElement>('#centre-imag')!;
  const zoomLabel = document.querySelector<HTMLButtonElement>('#zoom-level')!;
  const controls = document.querySelector<HTMLElement>('#view-controls')!;
  const resetButton = document.querySelector<HTMLButtonElement>('#reset-view')!;
  const copyButton = document.querySelector<HTMLButtonElement>('#copy-view')!;
  const copyFeedback = document.querySelector<HTMLElement>('#copy-feedback')!;
  const viewDialog = document.querySelector<HTMLDialogElement>('#view-dialog')!;
  const viewForm = document.querySelector<HTMLFormElement>('#view-form')!;
  const closeDialog = document.querySelector<HTMLButtonElement>('#close-view-dialog')!;
  const copyValues = document.querySelector<HTMLButtonElement>('#copy-view-values')!;
  const valuesFeedback = document.querySelector<HTMLElement>('#view-copy-feedback')!;
  const fields = ['re', 'im', 'zoom'] as const;
  const inputs = {
    re: document.querySelector<HTMLTextAreaElement>('#view-re')!,
    im: document.querySelector<HTMLTextAreaElement>('#view-im')!,
    zoom: document.querySelector<HTMLInputElement>('#view-zoom')!,
  };
  const fieldErrors = Object.fromEntries(fields.map(field =>
    [field, document.querySelector<HTMLElement>(`#view-${field}-error`)!])) as Record<keyof ViewFields, HTMLElement>;

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

  const clipboardText = () => {
    // Snapshot the current view, including all coordinate digits, even before the next paint.
    const shown = current();
    return shown && viewClipboardText(shown.view, initialView(shown.cssWidth, shown.cssHeight).logScale);
  };

  // The view dialog: every digit of the centre and the zoom, editable. What it
  // was opened with is kept, so untouched fields keep their exact values.
  let opened: { view: View; initialLogScale: number; fields: ViewFields } | undefined;

  function setError(field: keyof ViewFields, message: string): void {
    fieldErrors[field].textContent = message;
    if (message) inputs[field].setAttribute('aria-invalid', 'true');
    else inputs[field].removeAttribute('aria-invalid');
  }

  function openDialog(field: keyof ViewFields): void {
    const shown = current();
    if (!shown) return;
    const { view } = shown, initialLogScale = initialView(shown.cssWidth, shown.cssHeight).logScale;
    opened = { view, initialLogScale, fields: {
      re: formatCoordinate(view.re, view.bits, digitScale(view)),
      im: formatCoordinate(view.im, view.bits, digitScale(view)),
      zoom: formatZoomText(initialLogScale - view.logScale),
    } };
    for (const name of fields) { inputs[name].value = opened.fields[name]; setError(name, ''); }
    if (!viewDialog.open) viewDialog.showModal();
    fitHeight(inputs.re); fitHeight(inputs.im);
    // With a mouse, start in the value that was clicked, ready to be replaced.
    // Touch keeps focus on the close button so no keyboard pops up unasked.
    if (matchMedia('(pointer: fine)').matches) inputs[field].select();
  }
  realLabel.addEventListener('click', () => openDialog('re'));
  imaginaryLabel.addEventListener('click', () => openDialog('im'));
  zoomLabel.addEventListener('click', () => openDialog('zoom'));
  closeDialog.addEventListener('click', () => viewDialog.close());

  for (const name of fields) {
    inputs[name].addEventListener('input', () => {
      setError(name, '');
      if (name !== 'zoom') fitHeight(inputs[name]);
    });
  }
  // Values are single lines: Enter applies in the coordinate boxes too, as it does in the zoom field.
  for (const input of [inputs.re, inputs.im]) {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      viewForm.requestSubmit();
    });
  }
  viewForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!opened) return;
    const typed = { re: inputs.re.value, im: inputs.im.value, zoom: inputs.zoom.value };
    const result = readViewFields(typed, opened.fields, opened.view, opened.initialLogScale);
    if ('errors' in result) {
      // Nothing changes until every value is usable.
      for (const name of fields) setError(name, result.errors.find(error => error.field === name)?.message ?? '');
      inputs[fields.find(name => result.errors.some(error => error.field === name))!].focus();
      return;
    }
    viewDialog.close();
    if (result.changed) onApply(result.view);
  });

  closeOnBackdrop(viewDialog);
  // A rotated phone or resized window changes how many lines the coordinates take.
  const refitCoordinates = () => { if (viewDialog.open) { fitHeight(inputs.re); fitHeight(inputs.im); } };
  window.addEventListener('resize', refitCoordinates);

  const copyViewButton = copyOnClick(copyButton, copyFeedback, clipboardText,
    'Position and zoom copied', 'Couldn’t copy. Try again, or open a coordinate and select it.');
  const copyValuesButton = copyOnClick(copyValues, valuesFeedback, clipboardText,
    'Copied', 'Couldn’t copy. Select the digits and copy them instead.');
  viewDialog.addEventListener('close', () => {
    copyValuesButton.reset();
    opened = undefined;
  });

  const share = createShareDialog(shareLink);

  resetButton.addEventListener('click', onReset);
  const paletteMenu = createPaletteMenu(document.querySelector<HTMLElement>('#palette-picker')!,
    document.querySelector<HTMLButtonElement>('#palette-button')!, document.querySelector<HTMLElement>('#palette-menu')!,
    palette, onPalette);
  const zoomIn = holdToZoom(document.querySelector<HTMLButtonElement>('#zoom-in')!, -1, onZoom);
  const zoomOut = holdToZoom(document.querySelector<HTMLButtonElement>('#zoom-out')!, 1, onZoom);

  // Keyboard shortcuts: + (or =, its unshifted key) and - press the zoom
  // buttons for as long as they are held; 0 and Home reset the view; C takes the next palette.
  /** Each held shortcut by physical key, so releasing Shift before = still ends the + hold. */
  const heldKeys = new Map<string, ReturnType<typeof holdToZoom>>();
  const shortcutZoom = (key: string) => key === '+' || key === '=' ? zoomIn : key === '-' || key === '_' ? zoomOut : undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    // Browser zoom (Ctrl/⌘ with + or -) and other shortcuts are left alone, as is typing.
    if (viewDialog.open || share.open || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return;
    const control = shortcutZoom(event.key);
    if (control) {
      event.preventDefault();
      const code = event.code || event.key;
      // Repeats while held change nothing; a hold the page missed the start of (a key pressed elsewhere) starts here.
      if (heldKeys.has(code)) return;
      heldKeys.set(code, control);
      control.press(`key:${code}`);
    } else if (event.key === '0' || event.key === 'Home') {
      event.preventDefault();
      if (!event.repeat) onReset();
    } else if (event.key === 'c' || event.key === 'C') {
      event.preventDefault();
      if (!event.repeat) paletteMenu.cycle();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const code = event.code || event.key;
    heldKeys.get(code)?.release(`key:${code}`);
    heldKeys.delete(code);
  };
  // The buttons let go of every hold on blur; forget which keys held them too.
  const onBlur = () => heldKeys.clear();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  function stopZooming(): void {
    zoomIn.stop(); zoomOut.stop();
    heldKeys.clear();
  }
  // Interacting with the information controls must not zoom the fractal underneath.
  infoPanel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
  controls.addEventListener('wheel', event => event.stopPropagation(), { passive: true });

  return {
    update,
    stopZooming,
    setPalette: next => paletteMenu.set(next),
    dispose() { copyViewButton.dispose(); copyValuesButton.dispose(); share.dispose(); window.removeEventListener('resize', refitCoordinates); stopZooming(); paletteMenu.dispose(); },
  };
}
