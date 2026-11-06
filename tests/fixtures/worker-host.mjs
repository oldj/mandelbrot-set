// Runs src/render/worker.ts in a Node worker thread, standing in for the browser's worker globals.
import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: (message, options) => parentPort.postMessage(message, options?.transfer) };
await import('../../src/render/worker.ts');
parentPort.on('message', data => self.onmessage({ data }));
