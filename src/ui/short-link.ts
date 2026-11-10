/**
 * Short links from is.gd, called straight from the browser: its API sends
 * `Access-Control-Allow-Origin: *` and needs no key, and its rate limits are
 * per IP, so each visitor spends only their own allowance
 * (https://is.gd/apishorteningreference.php, https://is.gd/usagelimits.php).
 * Requests are made only when asked for (opening the share dialog), and each
 * link is shortened once per page: is.gd links are permanent.
 */

/** is.gd's create endpoint. A form-encoded POST is a simple CORS request: no preflight. */
export const SHORTENER_ENDPOINT = 'https://is.gd/create.php';
/** The longest URL is.gd accepts (https://is.gd/faq.php). Links deeper than about 10^2400 are longer. */
export const MAX_SHORTEN_LENGTH = 5000;
/** Give up on a request after this long, and offer the full link instead. */
export const SHORTEN_TIMEOUT_MS = 8000;
/** After is.gd reports its rate limit, wait this long before asking again, as its docs ask. */
export const RATE_LIMIT_WAIT_MS = 60_000;

export type ShortenFailure = 'too-long' | 'rate-limited' | 'rejected' | 'unavailable';
export type ShortenResult = { ok: true; url: string } | { ok: false; reason: ShortenFailure };

export interface ShortenerOptions {
  fetch: (input: string, init: RequestInit) => Promise<Pick<Response, 'json'>>;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (id: never) => void;
  AbortController?: typeof AbortController;
}

/** A short link is.gd made, checked so nothing else ends up in the dialog. */
const SHORT_URL = /^https:\/\/(?:is|v)\.gd\/[A-Za-z0-9_]{1,30}$/;

/**
 * A function that shortens a URL with is.gd. Results are cached, so the same
 * link is never submitted twice; concurrent requests for one link share a
 * request; failures are not cached (except the rate-limit pause), so asking
 * again later retries.
 */
export function createShortener({ fetch, now = Date.now, setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout, AbortController: Abort = globalThis.AbortController }: ShortenerOptions) {
  const cache = new Map<string, Promise<ShortenResult>>();
  let waitUntil = -Infinity;

  async function request(url: string): Promise<ShortenResult> {
    const abort = Abort ? new Abort() : undefined;
    const timer = setTimer(() => abort?.abort(), SHORTEN_TIMEOUT_MS);
    try {
      const response = await Promise.race([
        fetch(SHORTENER_ENDPOINT, {
          method: 'POST',
          body: new URLSearchParams({ format: 'json', url }),
          credentials: 'omit',
          cache: 'no-store',
          signal: abort?.signal,
        }),
        // Also without AbortController (or a fetch that ignores it), stop waiting.
        new Promise<never>((_, reject) => abort?.signal.addEventListener('abort', () => reject(new Error('timeout')))),
      ]);
      const body = await response.json() as { shorturl?: unknown; errorcode?: unknown };
      if (typeof body.shorturl === 'string' && SHORT_URL.test(body.shorturl)) return { ok: true, url: body.shorturl };
      // 1: is.gd refused the long URL (e.g. one it can't reach); 3: rate limit; 2 or 4: anything else.
      if (body.errorcode === 3) {
        waitUntil = now() + RATE_LIMIT_WAIT_MS;
        return { ok: false, reason: 'rate-limited' };
      }
      return { ok: false, reason: body.errorcode === 1 ? 'rejected' : 'unavailable' };
    } catch {
      return { ok: false, reason: 'unavailable' };
    } finally {
      clearTimer(timer as never);
    }
  }

  return function shorten(url: string): Promise<ShortenResult> {
    if (url.length > MAX_SHORTEN_LENGTH) return Promise.resolve({ ok: false, reason: 'too-long' });
    const cached = cache.get(url);
    if (cached) return cached;
    if (now() < waitUntil) return Promise.resolve({ ok: false, reason: 'rate-limited' });
    const pending = request(url).then(result => {
      if (!result.ok) cache.delete(url);
      return result;
    });
    cache.set(url, pending);
    return pending;
  };
}

/** What the share dialog says about the short link, by outcome. */
export function shortLinkStatus(result: ShortenResult | undefined): string {
  if (!result) return 'Making a short link with is.gd…';
  if (result.ok) return 'Made by is.gd. It opens this exact view.';
  switch (result.reason) {
    case 'too-long': return `This view’s link is over ${MAX_SHORTEN_LENGTH.toLocaleString('en')} characters, too long for is.gd. Share the full link below instead.`;
    case 'rate-limited': return 'is.gd is limiting requests from this connection. Share the full link below, or try again in a minute.';
    case 'rejected': return 'is.gd wouldn’t shorten this address. Share the full link below instead.';
    case 'unavailable': return 'Couldn’t reach is.gd. Share the full link below, or reopen this to try again.';
  }
}
