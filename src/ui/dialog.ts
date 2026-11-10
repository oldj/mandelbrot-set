/** Behaviour the view and share dialogs share: backdrop clicks, growing text boxes, copy buttons. */

/**
 * Close `dialog` when its backdrop is clicked. The browser reports backdrop
 * clicks as clicks on the <dialog> itself, as it does clicks on its padding,
 * so check that the point lies outside the box. The press must start outside
 * too: selecting text and releasing past the edge must not close it. Wheel
 * events stay in the dialog, so they don't zoom the fractal underneath.
 */
export function closeOnBackdrop(dialog: HTMLDialogElement): void {
  const outside = (event: MouseEvent) => {
    if (event.target !== dialog) return false;
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', event => { pressedOutside = outside(event); });
  dialog.addEventListener('click', event => {
    if (pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  });
  dialog.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
}

/** Grow a text box with its text, e.g. thousands of digits (CSS caps it). */
export function fitHeight(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
  // Scroll only once capped: line heights round, and a sub-pixel overflow would show a scrollbar.
  input.style.overflowY = input.scrollHeight > input.clientHeight + 1 ? 'auto' : 'hidden';
}

export interface CopyButton {
  /** Back to idle, clearing the feedback (e.g. when the dialog closes). */
  reset(): void;
  /** Cancel a pending reset. */
  dispose(): void;
}

/**
 * Copy `text()` to the clipboard when `button` is clicked, showing progress on
 * the button (data-state: pending, copied, error, idle) and in `feedback`, a
 * live region, until it resets after 2 s (4 s for errors). Nothing happens
 * while `text()` is undefined.
 */
export function copyOnClick(button: HTMLButtonElement, feedback: HTMLElement, text: () => string | undefined,
  copied: string, failed: string): CopyButton {
  let timer: ReturnType<typeof setTimeout>;
  let said = '';
  const say = (message: string) => { feedback.textContent = said = message; };
  const reset = () => {
    clearTimeout(timer);
    // Two buttons may share one feedback line: leave it if the other has spoken since.
    if (feedback.textContent === said) feedback.textContent = '';
    button.dataset.state = 'idle';
  };
  button.addEventListener('click', async () => {
    const value = text();
    if (button.disabled || value === undefined) return;
    clearTimeout(timer);
    button.disabled = true;
    button.dataset.state = 'pending';
    say('Copying…');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      button.dataset.state = 'copied';
      say(copied);
    } catch {
      button.dataset.state = 'error';
      say(failed);
    } finally {
      button.disabled = false;
      timer = setTimeout(reset, button.dataset.state === 'copied' ? 2000 : 4000);
    }
  });
  return { reset, dispose: () => clearTimeout(timer) };
}
