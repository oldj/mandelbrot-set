/**
 * A zoom button that animates, and keeps zooming while held.
 *
 * Every frame zooms by part of what is still owed, so motion never jumps:
 * - A press owes one STEP, paid off with an ease-out (fast, then settling)
 *   with time constant EASE_MS.
 * - While the button is held, each frame zooms at least HOLD_RATE: once the
 *   step's ease-out slows to that speed, the zoom carries on at it, so a
 *   quick tap is one step and a hold flows into steady zooming.
 * - Released while zooming steadily, it glides to a stop, decelerating from
 *   that speed as a step's ease-out does.
 *
 * Enter or Space held on the focused button act like a held pointer; a click
 * with no key or pointer behind it (assistive technology) zooms one step.
 */

/** log2 of the zoom for one press: a factor of √2. */
export const STEP = 0.5;
/** log2 of the zoom per second while held: about ×5.7 a second. */
export const HOLD_RATE = 2.5;
/** Time constant of the ease-out: a step is 95% done after 3 of these. */
export const EASE_MS = 80;
/**
 * A late frame catches up on the zoom it missed, up to this much: a busy
 * page (repainting the blurred glass can take a moment) still zooms at the
 * held rate, but a long freeze doesn't end in a sudden jump.
 */
export const MAX_FRAME_MS = 250;
/** Below this much owed (log2) and not held, the rest is zoomed at once and the animation ends. */
const SETTLED = 1e-3;

const isActivationKey = (key: string) => key === 'Enter' || key === ' ';

/**
 * Wire `button` to call `zoom(direction * amount)` once per animation frame
 * while it moves: direction -1 zooms in (the scale shrinks), +1 out.
 * Returns a function that stops it at once.
 */
export function holdToZoom(button: HTMLButtonElement, direction: -1 | 1, zoom: (logFactor: number) => void): () => void {
  /** log2 still to zoom: from presses, and the glide after a hold. */
  let owed = 0;
  let held: 'pointer' | 'key' | undefined;
  let pointer: number | undefined;
  /** Whether the last frame zoomed at the held rate rather than easing out a step. */
  let steady = false;
  let frame = 0;
  let last: number | undefined;
  /** A key press is handled on keydown and keyup; the click the browser adds for it must not zoom again. */
  let keyClick = false;

  function tick(time: number): void {
    frame = 0;
    // The first frame only starts the clock.
    if (last !== undefined) {
      const dt = Math.min(time - last, MAX_FRAME_MS);
      let amount = owed * (1 - Math.exp(-dt / EASE_MS));
      steady = held !== undefined && HOLD_RATE * dt / 1000 >= amount;
      if (steady) amount = HOLD_RATE * dt / 1000;
      if (!held && owed - amount < SETTLED) amount = owed;
      owed = Math.max(0, owed - amount);
      if (amount > 0) zoom(direction * amount);
    }
    last = time;
    if (held || owed > 0) frame = requestAnimationFrame(tick);
    else last = undefined;
  }
  function run(): void {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function press(by: 'pointer' | 'key'): void {
    held = by;
    owed += STEP;
    button.classList.add('holding');
    run();
  }
  function release(): void {
    if (!held) return;
    held = undefined; pointer = undefined;
    button.classList.remove('holding');
    // Coming off steady zooming, owe what decelerating from HOLD_RATE with
    // the ease-out covers, so its speed starts where the hold's left off. At
    // least that, not that much more: a click held just past the step's
    // slowing down is still owed most of its step, and stays about one step.
    if (steady) owed = Math.max(owed, HOLD_RATE * EASE_MS / 1000);
    steady = false;
    run();
  }
  function stop(): void {
    cancelAnimationFrame(frame);
    frame = 0; last = undefined; owed = 0; held = undefined; pointer = undefined; steady = false;
    button.classList.remove('holding');
  }

  button.addEventListener('pointerdown', event => {
    if (held || (event.pointerType === 'mouse' && event.button !== 0)) return;
    // No focus ring, text selection or (on touch) long-press menu for a held button.
    event.preventDefault();
    // Capture so a finger sliding off the button still ends the hold on release.
    try { button.setPointerCapture(event.pointerId); } catch { return; }
    pointer = event.pointerId;
    press('pointer');
  });
  const releasePointer = (event: PointerEvent) => { if (held === 'pointer' && event.pointerId === pointer) release(); };
  button.addEventListener('pointerup', releasePointer);
  button.addEventListener('pointercancel', releasePointer);
  button.addEventListener('lostpointercapture', releasePointer);
  button.addEventListener('contextmenu', event => event.preventDefault());

  button.addEventListener('keydown', event => {
    if (!isActivationKey(event.key)) return;
    // Enter clicks on every keydown, repeats included; Space clicks on keyup.
    keyClick = true;
    if (!event.repeat && !held) press('key');
  });
  button.addEventListener('keyup', event => { if (isActivationKey(event.key) && held === 'key') release(); });
  button.addEventListener('blur', () => { if (held === 'key') release(); });
  // Pointer presses already zoomed (their clicks have detail ≥ 1), and so did keys.
  button.addEventListener('click', event => {
    if (event.detail !== 0) return;
    if (keyClick) { keyClick = false; return; }
    owed += STEP;
    run();
  });
  window.addEventListener('blur', release);
  return stop;
}
