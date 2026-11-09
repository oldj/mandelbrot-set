// Runs src/render/worker.ts in a Node worker thread, standing in for the browser's worker globals.
import { parentPort } from 'node:worker_threads';

// Test hook: after { type: 'test-hold', step }, the worker stops at its first yield after it reports
// that pass, until { type: 'test-release' }; messages sent meanwhile are handled before it goes on.
let holdStep, armed = false, held;
globalThis.self = {
  postMessage: (message, options) => {
    if (message?.type === 'pass' && message.step === holdStep && !message.deepen) { armed = true; holdStep = undefined; }
    parentPort.postMessage(message, options?.transfer);
  },
};

// The worker yields by posting to itself through a MessageChannel. Browsers deliver those messages and
// the main thread's in the order sent, so a new request, cancel or palette switch is handled at the
// next yield; Node never interleaves another port's messages with parentPort's, so a worker yielding
// this way saw none of the main thread's until it stopped. Self-posts through setImmediate let them in.
globalThis.MessageChannel = class {
  constructor() {
    const port1 = { onmessage: null };
    this.port1 = port1;
    this.port2 = {
      postMessage: data => {
        const deliver = () => port1.onmessage?.({ data });
        if (armed) { armed = false; held = deliver; } else setImmediate(deliver);
      },
    };
  }
};

await import('../../src/render/worker.ts');
parentPort.on('message', data => {
  if (data?.type === 'test-hold') { holdStep = data.step; return; }
  if (data?.type === 'test-release') {
    const deliver = held;
    held = undefined;
    armed = false;
    if (deliver) setImmediate(deliver);
    return;
  }
  self.onmessage({ data });
});
