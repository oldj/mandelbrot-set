/**
 * Renders on this machine's real GPU, in headless Chrome, and checks the
 * result against the workers: `npm run test:gpu`.
 *
 * Node has no WebGPU, so `npm test` never runs the shader. This does, through
 * the app as its own Vite server serves it, each check in a fresh browser
 * context:
 *
 * 1. The GPU passes its startup self-test and renders.
 * 2. On views where the GPU and the workers alone (`?cpu`) end at the same
 *    budget, the final images match but for chaotic filament pixels (see
 *    VIEWS for how many may differ).
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

/**
 * Views where both renderers end at the same budget (at 640x400), and the share of pixels whose colours
 * may differ visibly: double-single (48 bits) and the workers' doubles part ways in chaotic filaments.
 */
const VIEWS = [
  // An off-axis needle: no pixel differs.
  { name: 'needle at -1.854, 1.4e16', hash: 're=-1.8541330553638606402648&im=0.0000000000000000072361&zoom=1.397435138e16&palette=vivid', most: 0.001 },
  { name: 'spirals at -0.6776+0.4316i, 1.9e10', hash: 're=-0.6775690432191032&im=0.4316456926549795&zoom=1.927355912e10', most: 0.01 },
  { name: 'minibrot at -1.2507+0.0201i, 5e4', hash: 're=-1.25066&im=0.02012&zoom=5e4', most: 0.01 },
  { name: 'seahorse valley at -0.745+0.113i, 1000', hash: 're=-0.745&im=0.113&zoom=1000', most: 0.01 },
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
      const pixels = Buffer.from(await evaluate(`(() => {
        const canvas = document.querySelector('#mandelbrot'), copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = canvas.height;
        const context = copy.getContext('2d');
        context.drawImage(canvas, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let text = '';
        for (let i = 0; i < data.length; i += 32768) text += String.fromCharCode(...data.subarray(i, i + 32768));
        return btoa(text);
      })()`), 'base64');
      return { state, warnings, ms, finished: true, pixels, injected: await evaluate('window.__injected ?? null') };
    } finally {
      cdp.listeners.delete(listen);
    }
  } finally {
    await cdp.send('Target.disposeBrowserContext', { browserContextId });
  }
}

/** Share of pixels whose colours differ visibly (summed channel difference above 6). */
function differing(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) count++;
  }
  return count / (a.length / 4);
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
    if (gpu.state.iterations !== cpu.state.iterations) {
      report(view.name, false, `budgets differ: GPU ${gpu.state.iterations}, workers ${cpu.state.iterations}; choose a view where they agree`);
      continue;
    }
    const share = differing(gpu.pixels, cpu.pixels);
    report(view.name, gpu.pixels.length === cpu.pixels.length && share <= view.most,
      `${percent(share)} of pixels differ, at most ${percent(view.most)}; budget ${gpu.state.iterations}; GPU ${gpu.ms} ms, workers ${cpu.ms} ms`);
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
