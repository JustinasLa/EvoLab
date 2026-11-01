import { Ecosystem } from './ecosystem';
import { integer, WORLD_VERSION } from './model';
import { EXPERIMENT_RULES_VERSION, type ExperimentRecipe } from './experiment-model';
import { comparisonRuntime, createComparison, createRecipeComparison } from './experiments';
import {
  BATCH_MAX_BYTES,
  exactKeys,
  validateBatchPlan,
  encodeBatch,
  type BatchPlan,
  type BatchExport,
  type BatchProgress,
} from './batch-model';
export {
  BATCH_MAX_BYTES,
  validateBatchPlan,
  encodeBatch,
  type BatchPlan,
  type BatchExport,
  type BatchProgress,
} from './batch-model';

export function readBatch(text: string): BatchExport {
  if (
    typeof text !== 'string' ||
    text.length > BATCH_MAX_BYTES ||
    new TextEncoder().encode(text).byteLength > BATCH_MAX_BYTES
  )
    throw new Error('Batch export exceeds 16 MB.');
  const value = JSON.parse(text) as BatchExport;
  if (
    !exactKeys(value, 'format,version,rules,runtime,plan,runs') ||
    value.format !== 'evolab-drift-batch' ||
    value.version !== 1 ||
    !exactKeys(value.rules, 'version,worldVersion') ||
    value.rules.version !== EXPERIMENT_RULES_VERSION ||
    value.rules.worldVersion !== WORLD_VERSION ||
    value.runtime !== comparisonRuntime()
  )
    throw new Error('Batch replay requires identical rules and runtime provenance.');
  validateBatchPlan(value.plan);
  if (!Array.isArray(value.runs) || value.runs.length !== value.plan.seeds.length)
    throw new Error('Batch requires one outcome per independent seed.');
  let stopped = false;
  for (const [position, run] of value.runs.entries()) {
    if (
      !exactKeys(run, 'seed,status,tick,error,recipe,reproduced') ||
      run.seed !== value.plan.seeds[position] ||
      !['pending', 'cancelled', 'failed', 'complete'].includes(run.status) ||
      !integer(run.tick, 0, value.plan.burnInTicks + value.plan.durationTicks) ||
      typeof run.reproduced !== 'boolean' ||
      (run.status === 'failed'
        ? typeof run.error !== 'string' || run.error.length > 512
        : run.error !== null) ||
      (run.status === 'pending' && run.tick !== 0) ||
      (stopped && run.status !== 'pending') ||
      (run.status === 'cancelled' &&
        run.tick === value.plan.burnInTicks + value.plan.durationTicks) ||
      (run.status !== 'complete' && (run.recipe !== null || run.reproduced))
    )
      throw new Error('Invalid batch outcome.');
    stopped = run.status === 'cancelled' || run.status === 'pending';
    if (run.status === 'complete') {
      const recipe = run.recipe;
      if (
        !recipe ||
        recipe.seed !== run.seed ||
        recipe.sourceTick !== value.plan.burnInTicks ||
        run.tick !== value.plan.burnInTicks + value.plan.durationTicks ||
        recipe.plan.horizonTick !== run.tick ||
        recipe.plan.treatmentTick !== value.plan.burnInTicks + value.plan.treatmentDelay ||
        recipe.plan.intervention !== value.plan.intervention
      )
        throw new Error('Batch checkpoint does not match its plan.');
      createRecipeComparison(JSON.stringify(recipe)).dispose();
    }
  }
  return value;
}

export function createBatch(input: BatchPlan, expected?: BatchExport) {
  validateBatchPlan(input);
  const plan = structuredClone(input);
  const result: BatchExport = {
    format: 'evolab-drift-batch',
    version: 1,
    rules: { version: EXPERIMENT_RULES_VERSION, worldVersion: WORLD_VERSION },
    runtime: comparisonRuntime(),
    plan,
    runs: plan.seeds.map((seed) => ({
      seed,
      status: 'pending',
      tick: 0,
      error: null,
      recipe: null,
      reproduced: false,
    })),
  };
  let position = 0,
    stopped = false;
  let world: Ecosystem | undefined;
  let pair: ReturnType<typeof createComparison> | undefined;
  const release = (): void => {
    world = undefined;
    pair?.dispose();
    pair = undefined;
  };
  return {
    advance(now: () => number): BatchProgress {
      if (stopped) throw new Error('Batch was disposed or cancelled.');
      if (position === plan.seeds.length)
        return { run: position, tick: 0, phase: 'done', done: true };
      const run = result.runs[position];
      let phase: BatchProgress['phase'] = 'initialization';
      try {
        if (!world && !pair) {
          world = new Ecosystem(
            {
              seed: run.seed,
              mutation: plan.settings.mutation,
              nutrients: plan.settings.nutrients,
              climate: plan.settings.climate,
            },
            true,
            {
              terrain: plan.terrain,
            },
          );
        } else if (world && world.tick < plan.burnInTicks) {
          phase = 'burn-in';
          const began = now();
          for (let count = 0; count < 12 && world.tick < plan.burnInTicks; count++) {
            world.step();
            run.tick = world.tick;
            if (now() - began >= 8) break;
          }
        } else if (world) {
          const checkpoint = JSON.stringify(world.save());
          world = undefined;
          const recorded = expected?.runs[position].recipe;
          if (recorded && recorded.checkpoint !== checkpoint)
            throw new Error('Seeded initialization differs from the recorded complete checkpoint.');
          pair = recorded
            ? createRecipeComparison(JSON.stringify(recorded))
            : createComparison(checkpoint, {
                intervention: plan.intervention,
                treatmentTick: plan.burnInTicks + plan.treatmentDelay,
                horizonTick: plan.burnInTicks + plan.durationTicks,
              });
          phase = 'paired';
        } else {
          phase = 'paired';
          const progress = pair!.advance(now);
          run.tick = progress.tick;
          if (progress.tick === progress.horizonTick) {
            const completed = pair!.result();
            run.recipe = JSON.parse(completed.recipe) as ExperimentRecipe;
            run.status = 'complete';
            run.reproduced = completed.reproduced;
            encodeBatch(result);
            release();
            position++;
          }
        }
      } catch (error) {
        run.status = 'failed';
        run.recipe = null;
        run.reproduced = false;
        run.error =
          error instanceof Error ? error.message.slice(0, 512) : 'Batch replicate failed.';
        release();
        position++;
      }
      return { run: position, tick: run.tick, phase, done: position === plan.seeds.length };
    },
    snapshot(): BatchExport {
      return structuredClone(result);
    },
    cancel(): BatchExport {
      if (position < result.runs.length) result.runs[position].status = 'cancelled';
      stopped = true;
      release();
      return structuredClone(result);
    },
    dispose(): void {
      stopped = true;
      release();
      result.runs.length = 0;
      expected = undefined;
    },
  };
}

export function replayBatch(text: string) {
  const expected = readBatch(text);
  return createBatch(expected.plan, expected);
}
