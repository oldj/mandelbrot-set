/**
 * The share dialog, opened by the share button at the top right: a short link
 * to the current view (from is.gd, see short-link.ts) and the full address,
 * each with a copy button. The full link is always there, so the dialog still
 * works when is.gd can't help (too long, rate limited, offline).
 */
import { closeOnBackdrop, copyOnClick, fitHeight } from './dialog.ts';
import { createShortener, shortLinkStatus } from './short-link.ts';
import type { ShortenResult } from './short-link.ts';

export interface ShareDialog {
  readonly open: boolean;
  dispose(): void;
}

/** `link()` is the address of the view as shown now, hash included. */
export function createShareDialog(link: () => string | undefined): ShareDialog {
  const dialog = document.querySelector<HTMLDialogElement>('#share-dialog')!;
  const openButton = document.querySelector<HTMLButtonElement>('#share-button')!;
  const closeButton = document.querySelector<HTMLButtonElement>('#close-share-dialog')!;
  const shortInput = document.querySelector<HTMLInputElement>('#share-short')!;
  const shortStatus = document.querySelector<HTMLElement>('#share-short-status')!;
  const fullInput = document.querySelector<HTMLTextAreaElement>('#share-full')!;
  const copyShort = document.querySelector<HTMLButtonElement>('#copy-share-short')!;
  const copyFull = document.querySelector<HTMLButtonElement>('#copy-share-full')!;
  const feedback = document.querySelector<HTMLElement>('#share-copy-feedback')!;
  const shorten = createShortener({ fetch: (input, init) => fetch(input, init) });

  /** The link the dialog was opened with, and its short form once is.gd has made it. */
  let full: string | undefined;
  let short: string | undefined;

  function showShort(result: ShortenResult | undefined): void {
    short = result?.ok ? result.url : undefined;
    shortInput.value = short ?? '';
    shortInput.placeholder = result ? 'Not available' : 'Making…';
    shortStatus.textContent = shortLinkStatus(result);
    // A local address is expected during development, not a failure: it keeps the plain hint colour.
    shortStatus.dataset.state = !result ? 'pending' : result.ok ? 'ready' : result.reason === 'local' ? 'local' : 'failed';
    copyShort.setAttribute('aria-disabled', String(!short));
  }

  openButton.addEventListener('click', () => {
    const url = link();
    if (!url) return;
    full = url;
    fullInput.value = url;
    showShort(undefined);
    if (!dialog.open) dialog.showModal();
    fitHeight(fullInput);
    shorten(url).then(result => {
      // Closed, or reopened on another view, meanwhile: this answer is for an old link.
      if (dialog.open && full === url) showShort(result);
    });
  });
  closeButton.addEventListener('click', () => dialog.close());
  closeOnBackdrop(dialog);

  // Clicking into a link selects all of it, ready to copy by hand; a click in a field already focused
  // places the caret as usual, so part of it can still be selected. WebKit collapses a selection made
  // on focus at the mouseup that follows, hence selecting again there.
  for (const input of [shortInput, fullInput]) {
    const selectAll = () => input.setSelectionRange(0, input.value.length);
    let focusing = false;
    input.addEventListener('pointerdown', () => { focusing = document.activeElement !== input; });
    input.addEventListener('focus', selectAll);
    input.addEventListener('mouseup', event => {
      if (!focusing) return;
      focusing = false;
      event.preventDefault();
      selectAll();
    });
  }
  // A rotated phone or resized window changes how many lines the full link takes.
  const refit = () => { if (dialog.open) fitHeight(fullInput); };
  window.addEventListener('resize', refit);

  const copyShortButton = copyOnClick(copyShort, feedback, () => short, 'Short link copied',
    'Couldn’t copy. Select the short link and copy it instead.');
  const copyFullButton = copyOnClick(copyFull, feedback, () => full, 'Full link copied',
    'Couldn’t copy. Select the full link and copy it instead.');
  dialog.addEventListener('close', () => {
    copyShortButton.reset(); copyFullButton.reset();
    full = short = undefined;
  });

  return {
    get open() { return dialog.open; },
    dispose() { copyShortButton.dispose(); copyFullButton.dispose(); window.removeEventListener('resize', refit); },
  };
}
