import { createBatch, type BatchPlan } from '../src/experiment-batch';

export const batchPlan = (changes: Partial<BatchPlan> = {}): BatchPlan => ({
  seeds: [41, 42],
  initialization: 'single-founder',
  settings: { mutation: 0.12, nutrients: 5, climate: 0.8 },
  terrain: { version: 1, preset: 'porous-ridges', seed: null },
  burnInTicks: 2,
  durationTicks: 31,
  treatmentDelay: 12,
  intervention: 'none',
  ...changes,
});
export function batchResult(changes: Partial<BatchPlan> = {}) {
  const runner = createBatch(batchPlan(changes));
  while (!runner.advance(() => 0).done) {}
  const result = runner.snapshot();
  runner.dispose();
  return result;
}
