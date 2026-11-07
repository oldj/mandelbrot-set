/**
 * The palette picker: a button that opens a menu of the palettes, each with a
 * swatch, its name and where its colours come from. It opens on click (or
 * tap), and on hover where there is a mouse, and stays open while palettes
 * are tried, until a press outside it or on the button again (or Escape);
 * the keyboard works as for any menu (arrows, Home/End, Enter or Space).
 */
import { PALETTE_INFO, PALETTES } from '../render/palette-names.ts';
import type { Palette } from '../render/palette-names.ts';

/** How long the pointer may be away from a hover-opened menu before it closes. */
const HOVER_CLOSE_MS = 250;

export interface PaletteMenu {
  /** Show which palette is in use. */
  set(palette: Palette): void;
  /** Ask for the next palette in the list (the C shortcut). */
  cycle(): void;
  readonly open: boolean;
  dispose(): void;
}

export function createPaletteMenu(picker: HTMLElement, button: HTMLButtonElement, menu: HTMLElement,
  initial: Palette, onSelect: (palette: Palette) => void): PaletteMenu {
  let current = initial;
  /** Opened by click or keyboard (stays until dismissed), or by hover (closes when the pointer leaves). */
  let pinned = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const hover = matchMedia('(hover: hover) and (pointer: fine)');

  const items = PALETTES.map(palette => {
    const info = PALETTE_INFO[palette];
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'palette-option';
    item.setAttribute('role', 'menuitemradio');
    item.dataset.palette = palette;
    const swatch = document.createElement('span');
    swatch.className = 'palette-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.background = `linear-gradient(90deg, ${info.swatch.join(', ')})`;
    const name = document.createElement('span');
    name.className = 'palette-name';
    name.textContent = info.name;
    const note = document.createElement('span');
    note.className = 'palette-note';
    note.textContent = info.note;
    item.append(swatch, name, note);
    item.addEventListener('click', () => choose(palette));
    item.addEventListener('keydown', event => moveFocus(event, palette));
    menu.append(item);
    return item;
  });

  function set(palette: Palette): void {
    current = palette;
    items.forEach((item, i) => item.setAttribute('aria-checked', String(PALETTES[i] === palette)));
    button.setAttribute('aria-label', `Colour scheme: ${PALETTE_INFO[palette].name}`);
    button.dataset.palette = palette;
  }

  function show(focus?: 'current'): void {
    clearTimeout(closeTimer);
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (focus) items[PALETTES.indexOf(current)].focus();
  }
  function hide(returnFocus = false): void {
    clearTimeout(closeTimer);
    pinned = false;
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  }
  /**
   * Choosing keeps the menu open, so another palette can be tried straight
   * away; a hover-opened menu is pinned by it, as by a click. It closes on a
   * press outside, on the button again, or on Escape.
   */
  function choose(palette: Palette): void {
    pinned = true;
    clearTimeout(closeTimer);
    if (palette !== current) onSelect(palette);
  }

  function moveFocus(event: KeyboardEvent, palette: Palette): void {
    const index = PALETTES.indexOf(palette), last = items.length - 1;
    const target = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + last) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
    if (target >= 0) { event.preventDefault(); items[target].focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(true); }
    else if (event.key === 'Tab') hide();
  }

  button.addEventListener('click', () => {
    // A click pins a hover-opened menu instead of closing it under the pointer.
    if (!menu.hidden && pinned) { hide(); return; }
    pinned = true;
    show();
  });
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); pinned = true; show('current'); }
    else if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); hide(); }
  });
  picker.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse' || !hover.matches) return;
    clearTimeout(closeTimer);
    if (menu.hidden) { pinned = false; show(); }
  });
  picker.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'mouse' || pinned || menu.hidden) return;
    closeTimer = setTimeout(() => hide(), HOVER_CLOSE_MS);
  });
  // Anywhere else closes it: a press outside, or focus moving away.
  const outside = (event: Event) => { if (!menu.hidden && !picker.contains(event.target as Node)) hide(); };
  document.addEventListener('pointerdown', outside);
  // Only focus that lands on another element: a click on a menu item in Safari, which does not
  // focus buttons, moves focus to nothing, and must not close the menu before the click arrives.
  picker.addEventListener('focusout', event => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && !picker.contains(next)) hide();
  });

  set(initial);
  return {
    set,
    cycle: () => onSelect(PALETTES[(PALETTES.indexOf(current) + 1) % PALETTES.length]),
    get open() { return !menu.hidden; },
    dispose() { clearTimeout(closeTimer); document.removeEventListener('pointerdown', outside); },
  };
}
