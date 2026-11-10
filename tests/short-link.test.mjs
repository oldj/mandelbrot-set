import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortener, isLocalAddress, MAX_SHORTEN_LENGTH, RATE_LIMIT_WAIT_MS, SHORTEN_TIMEOUT_MS, shortLinkStatus } from '../src/ui/short-link.ts';

/** A shortener whose is.gd answers with `reply(url)` (a body, or a thrown error), on a clock the test moves. */
function fake(reply) {
  const requests = [], timers = new Map();
  let time = 0, id = 0;
  const shorten = createShortener({
    fetch: async (input, init) => {
      requests.push({ input, init, url: init.body.get('url') });
      const body = await reply(init.body.get('url'), init);
      return { json: async () => body };
    },
    now: () => time,
    setTimeout: (callback, ms) => { timers.set(++id, { callback, at: time + ms }); return id; },
    clearTimeout: timer => timers.delete(timer),
  });
  const advance = ms => {
    time += ms;
    for (const [key, timer] of timers) if (timer.at <= time) { timers.delete(key); timer.callback(); }
  };
  return { shorten, requests, timers, advance };
}

const link = 'https://example.org/#re=-0.75&im=0.1&zoom=250';

test('a link is shortened by a simple CORS POST to is.gd, once, however often it is asked for', async () => {
  const f = fake(() => ({ shorturl: 'https://is.gd/R709K6' }));
  const [first, second] = await Promise.all([f.shorten(link), f.shorten(link)]);
  assert.deepEqual(first, { ok: true, url: 'https://is.gd/R709K6' });
  assert.equal(second, first);
  assert.deepEqual(await f.shorten(link), first);
  assert.equal(f.requests.length, 1);
  const { input, init } = f.requests[0];
  assert.equal(input, 'https://is.gd/create.php');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  // A form body (no custom headers) keeps it a simple request: no preflight, and the hash survives encoding.
  assert.equal(init.headers, undefined);
  assert.equal(init.body.toString(), `format=json&url=${encodeURIComponent(link).replace(/%20/g, '+')}`);
  assert.equal(f.timers.size, 0, 'the timeout is cleared');
});

test('local and private-network addresses are not sent: is.gd rejects them, and they would reach no one else', async () => {
  const f = fake(() => ({ shorturl: 'https://is.gd/R709K6' }));
  for (const url of ['http://127.0.0.1:59472/?gpu#re=-0.75&im=0&zoom=2', 'http://localhost:5173/', 'http://app.localhost/',
    'http://[::1]:59472/', 'http://192.168.1.20:59472/', 'http://10.0.0.2/', 'http://172.20.1.1/', 'http://mac-mini.local:59472/',
    'http://0.0.0.0:59472/', 'http://[fd12:3456::1]/']) {
    assert.equal(isLocalAddress(url), true, url);
    assert.deepEqual(await f.shorten(url), { ok: false, reason: 'local' });
  }
  assert.equal(f.requests.length, 0);
  for (const url of ['https://example.org/#re=0', 'http://172.32.0.1/', 'http://11.0.0.1/', 'https://localhost.example.com/', 'not a url']) {
    assert.equal(isLocalAddress(url), false, url);
  }
  assert.match(shortLinkStatus({ ok: false, reason: 'local' }), /only on the published site/);
});

test('links over 5000 characters are not sent; the dialog explains', async () => {
  const f = fake(() => ({ shorturl: 'https://is.gd/R709K6' }));
  const long = `https://example.org/#re=0.${'1'.repeat(MAX_SHORTEN_LENGTH)}&im=0&zoom=1e3000`;
  assert.deepEqual(await f.shorten(long), { ok: false, reason: 'too-long' });
  assert.equal(f.requests.length, 0);
  const exact = `https://example.org/#re=${'1'.repeat(MAX_SHORTEN_LENGTH - 24)}`;
  assert.equal(exact.length, MAX_SHORTEN_LENGTH);
  assert.equal((await f.shorten(exact)).ok, true);
  assert.match(shortLinkStatus({ ok: false, reason: 'too-long' }), /over 5,000 characters/);
});

test('is.gd errors: a rate limit pauses requests for a minute, other failures may be retried', async () => {
  let body = { errorcode: 3, errormessage: 'Rate limit exceeded' };
  const f = fake(() => body);
  assert.deepEqual(await f.shorten(link), { ok: false, reason: 'rate-limited' });
  body = { shorturl: 'https://is.gd/R709K6' };
  assert.deepEqual(await f.shorten(link), { ok: false, reason: 'rate-limited' });
  assert.equal(f.requests.length, 1, 'no request while paused');
  f.advance(RATE_LIMIT_WAIT_MS);
  assert.equal((await f.shorten(link)).ok, true);

  const rejected = fake(() => ({ errorcode: 1, errormessage: 'Please specify a valid URL to shorten.' }));
  assert.deepEqual(await rejected.shorten(link), { ok: false, reason: 'rejected' });
  await rejected.shorten(link);
  assert.equal(rejected.requests.length, 2, 'failures are not cached');
  const down = fake(() => ({ errorcode: 4, errormessage: 'Maintenance' }));
  assert.deepEqual(await down.shorten(link), { ok: false, reason: 'unavailable' });
  const offline = fake(() => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(await offline.shorten(link), { ok: false, reason: 'unavailable' });
  // Anything that isn't an is.gd link is not shown as one.
  const odd = fake(() => ({ shorturl: 'javascript:alert(1)' }));
  assert.deepEqual(await odd.shorten(link), { ok: false, reason: 'unavailable' });
  for (const reason of ['rate-limited', 'rejected', 'unavailable']) assert.match(shortLinkStatus({ ok: false, reason }), /full link/);
});

test('a request that hangs is abandoned after the timeout', async () => {
  let signal;
  const f = fake((url, init) => { signal = init.signal; return new Promise(() => {}); });
  const pending = f.shorten(link);
  await Promise.resolve();
  f.advance(SHORTEN_TIMEOUT_MS);
  assert.deepEqual(await pending, { ok: false, reason: 'unavailable' });
  assert.equal(signal.aborted, true);
  // Also without AbortController, and when the answer starts but its body never arrives.
  let fire;
  const bare = createShortener({ AbortController: null, fetch: async () => ({ json: () => new Promise(() => {}) }),
    setTimeout: callback => { fire = callback; return 1; }, clearTimeout: () => {} });
  const hanging = bare(link);
  await new Promise(resolve => setImmediate(resolve));
  fire();
  assert.deepEqual(await hanging, { ok: false, reason: 'unavailable' });
});
