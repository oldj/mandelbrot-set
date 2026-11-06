import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: (message, options) => parentPort.postMessage(message, options?.transfer) };
await import('../../src/mandelbrot.worker.ts');
parentPort.on('message', data => self.onmessage({ data }));
