/**
 * The fractal computation, as the render worker, the main thread and the
 * tests use it. Modules:
 *   escape.ts        interior sentinel, iteration budget, smooth count, distance estimate
 *   direct.ts        direct iteration: shallow doubles (rows three lanes at a time), BigInt oracle
 *   orbit.ts         the reference orbit (BigInt) and its BLA tables
 *   perturbation.ts  perturbation kernels, native and extended-exponent
 *   interior.ts      interior proofs (disk inclusion, attracting cycles)
 *   sampler.ts       per-view sampler choosing among all of the above
 *   reference.ts     planning references: where, how deep, when one can be reused
 */
export { INTERIOR, iterationBudget, lastDistance } from './escape.ts';
export { directDouble, directFixed, directRow, insideFixed } from './direct.ts';
export { buildReference, computeOrbit, EXTENDED_LOG_SCALE, referenceFromOrbit } from './orbit.ts';
export type { Checkpoint, Reference } from './orbit.ts';
export type { SampleStats } from './perturbation.ts';
export { createSampler } from './sampler.ts';
export type { ReferenceCache, ReferenceEntry, ReferenceSource, Sampler } from './sampler.ts';
