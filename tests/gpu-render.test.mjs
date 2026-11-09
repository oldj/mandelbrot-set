import test from 'node:test';
import assert from 'node:assert/strict';

// Node has no WebGPU: GpuJob only needs these flags and a device that records nothing and reads back zeros.
globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUMapMode ??= { READ: 1 };
const { GpuJob, GPU_TILE } = await import('../src/render/gpu-render.ts');

function fakeDevice() {
  const buffer = ({ size }) => ({ size, mapAsync: () => Promise.resolve(), getMappedRange: () => new ArrayBuffer(size), unmap() {}, destroy() {} });
  const computePass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
  return {
    createBuffer: buffer,
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginComputePass: () => computePass, copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { writeBuffer() {}, submit() {} },
  };
}

/** A job over a 2x2-tile canvas, current while `state.current`, the device lost once `state.lost`. */
function job(state) {
  const size = 2 * GPU_TILE;
  const target = { view: { logScale: -8 }, width: size, height: size, cssWidth: size, cssHeight: size, current: () => state.current };
  const result = new GpuJob(fakeDevice(), { getBindGroupLayout: () => ({}) }, target, () => state.lost);
  result.setOrbit({ re: [0, 0], im: [0, 0], exp: [0, 0] }, 0, 0);
  const tiles = [];
  for (let y = 0; y < size; y += GPU_TILE) for (let x = 0; x < size; x += GPU_TILE) tiles.push([x, y]);
  return { job: result, tiles };
}

/** Hold the main thread long enough that the pass gives the page a turn after this batch. */
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end); };

test('a GPU pass that stays current stages every tile once and reports success', async () => {
  const state = { current: true, lost: false }, { job: gpu, tiles } = job(state), staged = [];
  const ok = await gpu.pass({ iterations: 64, step: 1, tiles, onBatch: ({ first, count }) => { for (let t = first; t < first + count; t++) staged.push(t); } });
  assert.equal(ok, true);
  assert.deepEqual(staged.sort(), tiles.map((_, t) => t));
});

test('a GPU pass whose view changes while the page has its turn after the last batch reports that it stopped', async () => {
  // Without the check after the loop the pass returned success, and its stale render went on to send
  // the workers requests under its old id (stalling the newer render) or to mark the new view finished.
  for (const change of [state => { state.current = false; }, state => { state.lost = true; }]) {
    const state = { current: true, lost: false }, { job: gpu, tiles } = job(state);
    let staged = 0;
    const ok = await gpu.pass({ iterations: 64, step: 1, tiles, onBatch: ({ count }) => {
      staged += count;
      if (staged < tiles.length) return;
      busy(12);
      change(state);
    } });
    assert.equal(staged, tiles.length, 'every batch was staged before the change');
    assert.equal(ok, false);
  }
});

test('the GPU self-test accepts exact counts and rejects what a compiler folding the error terms computes', async () => {
  const { probeCounts, probePasses } = await import('../src/render/gpu-render.ts');
  const pairs = counts => counts.flatMap(count => [count, -1]);
  const exact = probeCounts();
  assert.ok(exact.every(count => count > 10000 && count < 18000), 'every probe point escapes, late');
  assert.equal(probePasses(pairs(exact)), true);
  assert.equal(probePasses(pairs(exact.map(count => count + 0.5))), true, 'within an iteration');
  // The same points with c kept to f32 (error terms folded to 0, so add() loses c's low bits), and
  // with every operation in f32 too: no count survives either.
  const exactly = x => x, f32 = x => Math.fround(x);
  const iterate = (roundC, roundOps) => exact.map((_, k) => {
    const c = roundC(0.25 + 16 * 2 ** -28 + (k - 7.5) * 2 ** -28);
    let z = 0;
    for (let n = 1; n <= 40000; n++) {
      z = roundOps(roundOps(z * z) + c);
      if (z * z > 256) return n + 1 - Math.log2(0.5 * Math.log2(z * z));
    }
    return -2;
  });
  assert.equal(probePasses(pairs(iterate(f32, exactly))), false, 'c without its low bits');
  assert.equal(probePasses(pairs(iterate(f32, f32))), false, 'f32 arithmetic');
  assert.equal(probePasses(new Float32Array(32)), false, 'zeros (a failed dispatch)');
});
