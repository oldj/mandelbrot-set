/**
 * Renders on this machine's real GPU, in headless Chrome, and checks the
 * result against the workers: `npm run test:gpu`.
 *
 * Node has no WebGPU, so `npm test` never runs the shader. This does, through
 * the app as its own Vite server serves it, each check in a fresh browser
 * context:
 *
 * 1. The GPU passes its startup self-test and renders.
 * 2. Against the workers alone (`?cpu`), the GPU's final image leaves no
 *    more than 0.1% of pixels black that the workers colour (a budget stopped
 *    too low); pixels it colours where the workers leave black really escape
 *    (a sample, iterated exactly in BigInt, since the canvas cannot tell a
 *    proved interior from a budget run out); and pixels coloured in both
 *    match but for chaotic filament pixels (see VIEWS for how many may
 *    differ). The two may end at different budgets: each raises when its own
 *    count of unresolved pixels says so.
 * 3. Without WebGPU, with a shader compiler that folds the double-single
 *    error terms (the self-test must catch it), and with the device lost
 *    mid-render, the view still renders completely, on the workers.
 *
 * Needs Chrome (CHROME=/path/to/chrome to choose another) and Node 22+.
 * Exits 1 when a check fails. It checks this machine's GPU and browser only:
 * on others, open the app there and compare it with ?cpu (see README).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'vite';
import { directFixed } from '../src/fractal/index.ts';
import { initialView, scaledFixed } from '../src/math/precision.ts';
import { parseViewHash } from '../src/ui/url-state.ts';

/**
 * Views (rendered at 640x400), and the share of pixels coloured by both renderers whose colours may
 * differ visibly: double-single (48 bits) and the workers' doubles part ways in chaotic filaments.
 */
const VIEWS = [
  // An off-axis needle: no pixel differs.
  { name: 'needle at -1.854, 1.4e16', hash: 're=-1.8541330553638606402648&im=0.0000000000000000072361&zoom=1.397435138e16&palette=vivid', most: 0.001 },
  { name: 'spirals at -0.6776+0.4316i, 1.9e10', hash: 're=-0.6775690432191032&im=0.4316456926549795&zoom=1.927355912e10', most: 0.01 },
  { name: 'minibrot at -1.2507+0.0201i, 5e4', hash: 're=-1.25066&im=0.02012&zoom=5e4', most: 0.01 },
  { name: 'seahorse valley at -0.745+0.113i, 1000', hash: 're=-0.745&im=0.113&zoom=1000', most: 0.01 },
  // Shallow and mostly interior: the workers prove nearly every pixel, the GPU's fine pass is capped and
  // leaves them what it does not settle, and their unresolved pixels skip the GPU at each raise.
  { name: 'period-3 bulb at -0.125+0.6495i, 300', hash: 're=-0.125&im=0.6495&zoom=300', most: 0.01 },
  // The neck between the main cardioid and the period-2 bulb: the GPU leaves the bulbs' pixels to the
  // workers before it starts (it once took them for unsettled and raised the budget to 24576).
  { name: 'cardioid neck at -0.75+0.0001i, 2e4', hash: 're=-0.75&im=0.0001&zoom=20000', most: 0.01 },
  // The edge of a period-4 bulb, mostly interior, where the GPU's guesses once stopped the budget at
  // 24576 (the workers alone reach 98304). Its escaping pixels are chaotic: their exact counts vary by
  // ~1700 within 1e-5 pixel, so more of them differ (3.5%) though neither renderer is the more exact.
  { name: 'period-4 bulb edge at 0.3231+0.5529i, 4.7e6', hash: 're=0.3231068534708&im=0.5529136600610&zoom=4.742144417e6&palette=vivid', most: 0.05 },
];

/** Failures injected before the page loads; each sets window.__injected once it has happened. */
const FAILURES = [
  { name: 'no WebGPU', inject: `Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }); window.__injected = true;` },
  { name: 'error terms folded by the shader compiler', inject: `{
    const create = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (descriptor) {
      const code = descriptor.code
        .replace('return vec2f(s, fma(a, p.one, -aa) + fma(b, p.one, -bb));', 'return vec2f(s, 0.0);')
        .replace('return vec2f(s, fma(b, p.one, fma(a, p.one, -s)));', 'return vec2f(s, 0.0);');
      window.__injected = code !== descriptor.code;
      return create.call(this, { ...descriptor, code });
    };
  }` },
  { name: 'device lost mid-render', inject: `{
    let device, maps = 0;
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) { device = await request.apply(this, args); return device; };
    const map = GPUBuffer.prototype.mapAsync;
    // The first read-back is the self-test's; the fourth is early in the render.
    GPUBuffer.prototype.mapAsync = function (...args) {
      const mapped = map.apply(this, args);
      if (++maps === 4) mapped.then(() => setTimeout(() => {
        window.__injected = document.querySelector('#mandelbrot').dataset.rendered !== 'true';
        device.destroy();
      }));
      return mapped;
    };
  }` },
];
const FAILURE_VIEW = 're=-0.75&im=0.1&zoom=200';

const root = fileURLToPath(new URL('..', import.meta.url));
const chromePath = process.env.CHROME ?? {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
}[process.platform] ?? 'google-chrome';

if (!globalThis.WebSocket) throw new Error('Node 22 or later is needed (for WebSocket).');

const freePort = () => new Promise((resolve, reject) => {
  const server = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** A minimal DevTools protocol client over one browser connection (flat sessions). */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id === undefined) { for (const listener of this.listeners) listener(message); return; }
      const call = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`)); else call.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
  }
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'gpu-check-'));
  const chrome = spawn(chromePath, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--enable-unsafe-webgpu', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let failed;
  chrome.once('error', error => { failed = error; });
  const portFile = join(profile, 'DevToolsActivePort');
  let endpoint;
  for (let i = 0; i < 200 && !endpoint && !failed; i++) {
    await sleep(100);
    if (!existsSync(portFile)) continue;
    const [port, path] = readFileSync(portFile, 'utf8').split('\n');
    if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
  }
  if (!endpoint) throw new Error(`Chrome did not start (${failed?.message ?? chromePath}); set CHROME to its path.`);
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  return {
    cdp: new Cdp(socket),
    async close() {
      socket.close();
      chrome.kill();
      await new Promise(resolve => chrome.exitCode !== null || chrome.signalCode !== null ? resolve() : chrome.once('exit', resolve));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Open `url` in a fresh browser context (with `inject` run before the page), wait for the render, and read the canvas. */
async function render(cdp, url, inject) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    const warnings = [];
    const listen = message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.consoleAPICalled' && (message.params.type === 'warning' || message.params.type === 'error')) {
        warnings.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
      }
      if (message.method === 'Runtime.exceptionThrown') warnings.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    };
    cdp.listeners.add(listen);
    try {
      await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 400, deviceScaleFactor: 1, mobile: false });
      await send('Page.enable');
      await send('Runtime.enable');
      if (inject) await send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
      await send('Page.navigate', { url });
      const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      };
      const started = Date.now();
      let state;
      while (Date.now() - started < 120000) {
        await sleep(100);
        state = await evaluate(`(() => { const c = document.querySelector('#mandelbrot'); return c && { ...c.dataset }; })()`);
        if (state?.rendered === 'true') break;
      }
      const ms = Date.now() - started;
      if (state?.rendered !== 'true') return { state, warnings, ms, finished: false };
      // Finished renders reach the visible canvas at the next animation frame (the app's draw, queued
      // before ours, runs first in it): read after two, and again two later to be sure it has settled.
      const read = async () => Buffer.from(await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const canvas = document.querySelector('#mandelbrot'), copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = canvas.height;
        const context = copy.getContext('2d');
        context.drawImage(canvas, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let text = '';
        for (let i = 0; i < data.length; i += 32768) text += String.fromCharCode(...data.subarray(i, i + 32768));
        resolve(btoa(text));
      })))`), 'base64');
      const pixels = await read(), settled = pixels.equals(await read());
      const size = await evaluate(`(() => { const c = document.querySelector('#mandelbrot'); return { width: c.width, height: c.height, cssWidth: c.clientWidth, cssHeight: c.clientHeight }; })()`);
      return { state, warnings, ms, finished: true, pixels, settled, size, injected: await evaluate('window.__injected ?? null') };
    } finally {
      cdp.listeners.delete(listen);
    }
  } finally {
    await cdp.send('Target.disposeBrowserContext', { browserContextId });
  }
}

/**
 * Among all pixels: the shares black (interior or unresolved) in `gpu` only, and coloured in both but
 * visibly different; and the pixels (indices) coloured in `gpu` only.
 */
function compare(gpu, cpu) {
  const black = (p, i) => p[i] + p[i + 1] + p[i + 2] < 6;
  let gpuBlack = 0, differ = 0;
  const gpuColoured = [];
  for (let i = 0; i < gpu.length; i += 4) {
    const a = black(gpu, i), b = black(cpu, i);
    if (a && !b) gpuBlack++;
    else if (!a && b) gpuColoured.push(i / 4);
    else if (!a && !b && Math.abs(gpu[i] - cpu[i]) + Math.abs(gpu[i + 1] - cpu[i + 1]) + Math.abs(gpu[i + 2] - cpu[i + 2]) > 6) differ++;
  }
  const pixels = gpu.length / 4;
  return { gpuBlack: gpuBlack / pixels, differ: differ / pixels, gpuColoured };
}
/** Pixels the GPU may leave black where the workers colour them: a budget that stopped too low leaves many more. */
const MOST_BLACK = 0.001;
/** Pixels coloured on the GPU only checked exactly (evenly spread), and the share of them that may fail to escape. */
const ESCAPE_SAMPLES = 24, MOST_NOT_ESCAPING = 0.1;

/**
 * Of `indices` (pixels the GPU colours, the workers leave black), how many of a sample escape when
 * iterated exactly (BigInt, 64 bits beyond the view's) within twice the GPU's budget: a proved interior
 * never does, a pixel that just needed more than the workers' budget does. Twice, because chaotic
 * pixels' exact counts vary by thousands within a hundred-thousandth of a pixel.
 */
function escapingExactly(hash, size, budget, indices) {
  const view = parseViewHash(hash, initialView(size.cssWidth, size.cssHeight).logScale), bits = view.bits + 64;
  const sample = indices.filter((_, k) => k % Math.max(1, Math.floor(indices.length / ESCAPE_SAMPLES)) === 0).slice(0, ESCAPE_SAMPLES);
  let escaping = 0;
  for (const index of sample) {
    // Pixel centres in CSS pixels from the view centre, as the app samples them.
    const x = ((index % size.width) + 0.5) / size.width * size.cssWidth - size.cssWidth / 2;
    const y = (Math.floor(index / size.width) + 0.5) / size.height * size.cssHeight - size.cssHeight / 2;
    const count = directFixed((view.re << 64n) + scaledFixed(x, view.logScale, bits), (view.im << 64n) - scaledFixed(y, view.logScale, bits), bits, 2 * budget);
    if (count >= 0) escaping++;
  }
  return { escaping, sampled: sample.length };
}

/** Pixels still the page's placeholder fill (#050914): never painted. */
function unpainted(pixels) {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 5 && pixels[i + 1] === 9 && pixels[i + 2] === 20) count++;
  return count;
}

const results = [];
function report(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` (${detail})` : ''}`);
}
const percent = share => `${(share * 100).toFixed(2)}%`;
const why = result => result.warnings[0] ? `: ${result.warnings[0].split('\n')[0]}` : '';

const port = await freePort();
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const base = `http://127.0.0.1:${port}/`;
const browser = await launchChrome().catch(async error => { await server.close(); throw error; });
try {
  console.log(`GPU rendering against the workers, in headless Chrome at ${base}\n`);
  for (const [index, view] of VIEWS.entries()) {
    const gpu = await render(browser.cdp, `${base}#${view.hash}`);
    if (index === 0) report('the GPU passes its self-test and renders', gpu.finished && gpu.state.gpu === 'true', gpu.state?.gpu === 'true' ? `${gpu.ms} ms` : `the workers rendered${why(gpu)}`);
    if (!gpu.finished || gpu.state.gpu !== 'true') { report(view.name, false, gpu.finished ? 'not rendered on the GPU' : 'did not finish'); continue; }
    const cpu = await render(browser.cdp, `${base}?cpu#${view.hash}`);
    if (!cpu.finished) { report(view.name, false, 'the workers did not finish'); continue; }
    if (gpu.pixels.length !== cpu.pixels.length) { report(view.name, false, 'the canvases differ in size'); continue; }
    if (!gpu.settled || !cpu.settled) { report(view.name, false, 'the canvas still changed after the render finished'); continue; }
    const { gpuBlack, differ, gpuColoured } = compare(gpu.pixels, cpu.pixels);
    const { escaping, sampled } = escapingExactly(view.hash, gpu.size, +gpu.state.iterations, gpuColoured);
    report(view.name, gpuBlack <= MOST_BLACK && differ <= view.most && sampled - escaping <= Math.floor(sampled * MOST_NOT_ESCAPING),
      `${percent(gpuBlack)} black only on the GPU, at most ${percent(MOST_BLACK)}; `
      + `${gpuColoured.length} coloured only on the GPU, ${escaping} of ${sampled} checked escape exactly; `
      + `${percent(differ)} coloured differently, at most ${percent(view.most)}; `
      + `budgets ${gpu.state.iterations} and ${cpu.state.iterations}; GPU ${gpu.ms} ms, workers ${cpu.ms} ms`);
  }
  console.log('');
  for (const failure of FAILURES) {
    const result = await render(browser.cdp, `${base}#${FAILURE_VIEW}`, failure.inject);
    const blank = result.finished ? unpainted(result.pixels) : NaN;
    const ok = result.finished && result.injected === true && result.state.gpu === '' && blank === 0;
    report(`${failure.name}: renders on the workers`, ok, !result.finished ? 'did not finish'
      : result.injected !== true ? 'the failure was not injected (does the injection still match the code?)'
      : result.state.gpu !== '' ? 'still rendered on the GPU' : blank ? `${blank} pixels never painted` : `${result.ms} ms`);
  }
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
