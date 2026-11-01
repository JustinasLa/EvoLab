import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_MAX_BYTES,
  createBatch,
  encodeBatch,
  readBatch,
  replayBatch,
  validateBatchPlan,
  type BatchPlan,
} from '../src/experiment-batch';
import { Ecosystem } from '../src/ecosystem';
import {
  EXPERIMENT_INTERVENTIONS,
  validExperimentIntervention,
} from '../src/experiment-interventions';
import { createComparison } from '../src/experiments';
import { DEFAULTS, HEIGHT, WIDTH, index } from '../src/model';

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
function finish(runner: ReturnType<typeof createBatch>) {
  while (!runner.advance(() => 0).done) {}
  const result = runner.snapshot();
  runner.dispose();
  return result;
}
afterEach(() => vi.restoreAllMocks());

describe('independent seeded batches', () => {
  it('forks complete identical checkpoints after independent founder burn-in, without changing inputs', () => {
    const plan = batchPlan();
    const runner = createBatch(plan);
    plan.seeds[0] = 9;
    const output = finish(runner);
    expect(output.runs.map((run) => run.seed)).toEqual([41, 42]);
    expect(output.runs.every((run) => run.status === 'complete')).toBe(true);
    for (const run of output.runs) {
      const recipe = run.recipe!;
      expect(recipe.control).toEqual(recipe.treatment);
      const world = new Ecosystem({ ...DEFAULTS, seed: run.seed });
      world.step();
      world.step();
      expect(recipe.checkpoint).toBe(JSON.stringify(world.save()));
      expect(recipe.control.samples.map((sample) => sample.tick)).toEqual([2, 32, 33]);
      expect(recipe.plan).toEqual({ intervention: 'none', treatmentTick: 14, horizonTick: 33 });
    }
    expect(output.runs[0].recipe!.checkpoint).not.toBe(output.runs[1].recipe!.checkpoint);
    const replay = finish(replayBatch(encodeBatch(output)));
    expect(replay.runs).toEqual(output.runs.map((run) => ({ ...run, reproduced: true })));
    expect(readBatch(encodeBatch(replay))).toEqual(replay);
    expect(() => runner.advance(() => 0)).toThrow('disposed');
    runner.dispose();
  });
  it('bounds all recipe dimensions and rejects duplicate seeds rather than pseudo-replicating a replay', () => {
    const valid = batchPlan();
    const invalid = [
      null,
      {},
      { ...valid, extra: 1 },
      { ...valid, seeds: [1, 1] },
      { ...valid, seeds: [] },
      { ...valid, seeds: Array.from({ length: 9 }, (_, position) => position) },
      { ...valid, seeds: [-1] },
      { ...valid, seeds: [4294967296] },
      { ...valid, seeds: [1.5] },
      { ...valid, initialization: 'empty' },
      { ...valid, settings: { ...valid.settings, extra: 1 } },
      { ...valid, settings: { ...valid.settings, mutation: 0.5 } },
      { ...valid, terrain: { ...valid.terrain, preset: 'bogus' } },
      { ...valid, burnInTicks: 1201 },
      { ...valid, durationTicks: 3601 },
      { ...valid, durationTicks: 0 },
      { ...valid, treatmentDelay: 31 },
      { ...valid, treatmentDelay: -1 },
      { ...valid, intervention: '__proto__' },
      { ...valid, seeds: [1, 2, 3, 4], durationTicks: 3600, burnInTicks: 1 },
    ];
    for (const plan of invalid)
      expect(() => createBatch(plan as BatchPlan)).toThrow('Invalid batch plan');
    validateBatchPlan(
      batchPlan({ seeds: [0, 4294967295], burnInTicks: 1200, durationTicks: 3600 }),
    );
    expect(validExperimentIntervention({})).toBe(false);
  });
  it('yields during burn-in and pairs and releases all scheduled state on cancellation', () => {
    const runner = createBatch(batchPlan({ burnInTicks: 30, durationTicks: 60 }));
    expect(runner.advance(() => 0)).toMatchObject({ phase: 'initialization', tick: 0 });
    let now = 0;
    expect(runner.advance(() => (now += 9))).toMatchObject({ phase: 'burn-in', tick: 1 });
    expect(runner.advance(() => 0).tick).toBe(13);
    expect(runner.advance(() => 0).tick).toBe(25);
    expect(runner.advance(() => 0).tick).toBe(30);
    expect(runner.advance(() => 0).phase).toBe('paired');
    expect(runner.advance(() => (now += 9)).tick).toBe(31);
    const partial = runner.cancel();
    expect(partial.runs.map((run) => [run.status, run.tick])).toEqual([
      ['cancelled', 31],
      ['pending', 0],
    ]);
    expect(() => runner.advance(() => 0)).toThrow('cancelled');
    const replay = finish(replayBatch(encodeBatch(partial)));
    expect(replay.runs.every((run) => run.status === 'complete' && !run.reproduced)).toBe(true);
    runner.dispose();
    expect(runner.snapshot().runs).toEqual([]);
    const completed = createBatch(batchPlan({ seeds: [0], durationTicks: 1, treatmentDelay: 0 }));
    while (!completed.advance(() => 0).done) {}
    expect(completed.advance(() => 0)).toEqual({ run: 1, tick: 0, phase: 'done', done: true });
    expect(completed.cancel().runs[0].status).toBe('complete');
    completed.dispose();
  });
  it.each(['heat', 'cold', 'shade', 'mutation-off', 'mutation-high'] as const)(
    'applies %s at exact boundaries with real energy/settings effects and no RNG used by the edit',
    (intervention) => {
      for (const delay of [0, 12, 30]) {
        const output = finish(
          createBatch(batchPlan({ seeds: [42], intervention, treatmentDelay: delay })),
        );
        const recipe = output.runs[0].recipe!;
        const reference = Ecosystem.load(recipe.checkpoint),
          control = Ecosystem.load(recipe.checkpoint);
        while (reference.tick < 33) {
          if (reference.tick === 2 + delay) {
            const rng = reference.save().random;
            EXPERIMENT_INTERVENTIONS[intervention].apply(reference);
            expect(reference.save().random).toEqual(rng);
          }
          reference.step();
          control.step();
        }
        const comparison = createComparison(recipe.checkpoint, recipe.plan);
        while (comparison.advance(() => 0).tick < 33) {}
        expect(JSON.parse(comparison.result().treatment.state)).toEqual(reference.save());
        expect(JSON.parse(comparison.result().control.state)).toEqual(control.save());
        expect(
          reference.interventions.entries.every((entry) => entry.firstTick === 2 + delay),
        ).toBe(true);
        if (intervention === 'shade') {
          expect(reference.shadeHabitats.nonzeroCells).toBe(197);
          expect(reference.shadeHabitats.units[index(WIDTH / 2, HEIGHT / 2)]).toBe(16);
          expect(reference.organisms.values().next().value!.energy).toBeLessThan(
            control.organisms.values().next().value!.energy,
          );
        }
        comparison.dispose();
        expect(finish(replayBatch(encodeBatch(output))).runs[0].reproduced).toBe(true);
      }
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0 });
      EXPERIMENT_INTERVENTIONS['mutation-off'].apply(world);
      expect(world.interventions.entries).toEqual([]);
    },
  );
  it('records genuine extinction and equal empty horizons, without population rescue', () => {
    const result = finish(
      createBatch(
        batchPlan({
          seeds: [42],
          burnInTicks: 0,
          durationTicks: 300,
          treatmentDelay: 0,
          intervention: 'shade',
        }),
      ),
    );
    const recipe = result.runs[0].recipe!;
    expect(recipe.treatment.extinction).toMatchObject({
      cause: 'energy',
      tick: expect.any(Number),
    });
    expect(recipe.treatment.samples.at(-1)).toMatchObject({
      tick: 300,
      population: 0,
      meanPreference: null,
    });
    expect(recipe.control.samples.at(-1)!.population).toBeGreaterThan(0);
    expect(finish(replayBatch(encodeBatch(result))).runs[0].reproduced).toBe(true);
  });
  it('records individual failures and continues other independent seeds; failed seeds can be rerun', () => {
    const runner = createBatch(batchPlan());
    runner.advance(() => 0);
    vi.spyOn(Ecosystem.prototype, 'step').mockImplementationOnce(() => {
      throw new Error('tick failed');
    });
    const result = finish(runner);
    expect(result.runs[0]).toMatchObject({ status: 'failed', error: 'tick failed', recipe: null });
    expect(result.runs[1].status).toBe('complete');
    const rerun = finish(replayBatch(encodeBatch(result)));
    expect(rerun.runs.map((run) => [run.status, run.reproduced])).toEqual([
      ['complete', false],
      ['complete', true],
    ]);
    const opaque = createBatch(batchPlan());
    opaque.advance(() => 0);
    vi.spyOn(Ecosystem.prototype, 'step').mockImplementationOnce(() => {
      throw 'failure';
    });
    expect(finish(opaque).runs[0].error).toBe('Batch replicate failed.');
  });
  it('validates complete imports, provenance, observations and regenerated checkpoints', () => {
    const output = finish(createBatch(batchPlan()));
    const mutations: ((value: any) => void)[] = [
      (value) => value.version++,
      (value) => (value.runtime = 'elsewhere'),
      (value) => value.rules.version++,
      (value) => value.rules.worldVersion++,
      (value) => (value.extra = 1),
      (value) => value.runs.pop(),
      (value) => value.runs[0].seed++,
      (value) => value.runs[0].tick++,
      (value) => (value.runs[0].status = 'bogus'),
      (value) => (value.runs[0].error = 'unexpected'),
      (value) => (value.runs[0].recipe = null),
      (value) => value.runs[0].recipe.seed++,
      (value) => (value.runs[0].recipe.plan.intervention = 'heat'),
      (value) => (value.runs[0].recipe.control.samples[0].population = -1),
      (value) => (value.runs[0].recipe.checkpoint = '{}'),
    ];
    for (const change of mutations) {
      const altered = structuredClone(output);
      change(altered);
      expect(() => replayBatch(JSON.stringify(altered))).toThrow();
    }
    const changed = structuredClone(output);
    const checkpoint = JSON.parse(changed.runs[0].recipe!.checkpoint);
    checkpoint.organisms[0].energy += 1;
    changed.runs[0].recipe!.checkpoint = JSON.stringify(checkpoint);
    expect(finish(replayBatch(encodeBatch(changed))).runs[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('initialization differs'),
    });
    const observed = structuredClone(output);
    observed.runs[0].recipe!.control.samples[0].meanPreference = 0.99;
    expect(finish(replayBatch(encodeBatch(observed))).runs[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('replay differs'),
    });
    const pending = createBatch(batchPlan()).snapshot();
    const cancelled = structuredClone(pending);
    cancelled.runs[0].status = 'cancelled';
    cancelled.runs[1].status = 'cancelled';
    expect(() => readBatch(encodeBatch(cancelled))).toThrow('outcome');
    cancelled.runs[1].status = 'pending';
    cancelled.runs[0].tick = cancelled.plan.burnInTicks + cancelled.plan.durationTicks;
    expect(() => readBatch(encodeBatch(cancelled))).toThrow('outcome');
    pending.runs[0].tick = 1;
    expect(() => readBatch(encodeBatch(pending))).toThrow('outcome');
    const tooLarge = ' '.repeat(BATCH_MAX_BYTES + 1);
    expect(() => readBatch(tooLarge)).toThrow('16 MB');
    expect(() => encodeBatch({ ...output, runtime: tooLarge })).toThrow('16 MB');
  });
});
