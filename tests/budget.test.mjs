import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptBudget, chooseBudget, maxIterations, rememberUse } from '../src/budget.ts';
import { iterationBudget } from '../src/fractal.ts';

test('a view whose coarse samples run out of iterations raises its budget', () => {
  const formula = iterationBudget(-60);
  assert.equal(chooseBudget(undefined, -60), formula);
  const first = adaptBudget(undefined, -60, formula, 49152, 49152);
  assert.equal(first.raise, true);
  assert.equal(first.memory.iterations, formula * 4);
  assert.equal(chooseBudget(first.memory, -60), formula * 4);
  // Resolved enough: keep the budget, no re-render.
  assert.deepEqual(adaptBudget(first.memory, -60, formula * 4, 49152, 100), { memory: first.memory, raise: false });
});

test('raises stop when they no longer help, at the cap, and resume deeper', () => {
  const formula = iterationBudget(-60);
  let memory = { iterations: formula * 16, logScale: -60, previousFraction: 0.5 };
  const stalled = adaptBudget(memory, -60, formula * 16, 1000, 450);
  assert.equal(stalled.raise, false);
  assert.equal(stalled.memory.saturatedAt, -60);
  assert.equal(adaptBudget(stalled.memory, -61, formula * 16, 1000, 450).raise, false);
  assert.equal(adaptBudget(stalled.memory, -65, formula * 16, 1000, 450).raise, true, 'zooming deeper may raise again');
  // Below 16x the formula, an unchanged share still raises (samples may just need a little more).
  memory = { iterations: formula * 4, logScale: -60, previousFraction: 1 };
  assert.equal(adaptBudget(memory, -60, formula * 4, 1000, 1000).raise, true);
  assert.equal(adaptBudget(undefined, -60, maxIterations(-60), 1000, 1000).raise, false);
  assert.ok(maxIterations(-60) <= 2 ** 20 && maxIterations(-8) >= 2 ** 16);
});

test('a learned budget follows the view deeper and is forgotten far out of it', () => {
  const memory = { iterations: 65536, logScale: -60, previousFraction: 1 };
  assert.equal(chooseBudget(memory, -55), 65536);
  assert.equal(chooseBudget(memory, -40), iterationBudget(-40));
  assert.equal(rememberUse(memory, -80).logScale, -80);
  assert.equal(rememberUse(memory, -40), undefined);
});
