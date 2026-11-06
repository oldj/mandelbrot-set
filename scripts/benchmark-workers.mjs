// Measures the actual progressive worker pipeline, including message transfers.
import { Worker } from 'node:worker_threads';
import { ensurePrecision, initialView } from '../src/precision.ts';
import { iterationBudget } from '../src/fractal.ts';
const cssWidth = 1280, cssHeight = 800, width = 384, height = 240;
const view = ensurePrecision({ ...initialView(cssWidth, cssHeight),
  logScale: initialView(cssWidth, cssHeight).logScale - Math.log2(1.5e47) });
const decimal = text => {
  const [whole, fraction] = text.split('.');
  return BigInt(whole + fraction) * (1n << BigInt(view.bits)) / 10n ** BigInt(fraction.length);
};
view.re = decimal('-0.69378820112974505918001981502679506278690352790793731');
view.im = decimal('-0.34952527748216184476632029598345669714154984468763950');
const counts = process.argv.slice(2).map(Number);
const output = [];
for (const count of counts.length ? counts : [4, 8]) {
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Worker count must be 1–8');
  const workers = Array.from({ length: count }, () => new Worker(new URL('../tests/fixtures/worker-host.mjs', import.meta.url)));
  const times = [];
  let checksum = 0;
  try {
    for (let id = 1; id <= 4; id++) {
      const start = performance.now();
      const sums = await Promise.all(workers.map((worker, workerIndex) => new Promise((resolve, reject) => {
        let sum = 0;
        const receive = message => {
          if (message.id !== id) return;
          if (message.type === 'error') reject(new Error(message.message));
          if (message.type === 'tile' && message.step === 1) for (const byte of message.pixels) sum += byte;
          if (message.type === 'pass' && message.step === 1) {
            worker.off('message', receive); worker.off('error', reject); resolve(sum);
          }
        };
        worker.on('message', receive); worker.once('error', reject);
        worker.postMessage({ id, view, width, height, cssWidth, cssHeight, workerIndex, workerCount: count, iterations: iterationBudget(view.logScale) });
      })));
      if (id > 1) times.push(performance.now() - start);
      checksum = sums.reduce((a, b) => a + b, 0);
    }
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
  times.sort((a, b) => a - b);
  output.push({ workers: count, pixels: width * height, medianMs: +times[1].toFixed(2), checksum });
}
console.log(JSON.stringify(output, null, 2));
