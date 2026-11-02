import assert from 'node:assert/strict';
import { it } from 'vitest';
import { BATCH_MAX_TICKS, BATCH_MAX_BYTES } from '../../src/batch-model';
import { createBatch, encodeBatch, replayBatch } from '../../src/experiment-batch';
import { batchPlan } from '../batch-fixture';
import { context, digest, receipt } from './support';

it('runs the full eight-seed engine-tick budget and replays every complete checkpoint', () => {
  const plan = batchPlan({
    seeds: [1, 7, 41, 42, 43, 67, 77, 1234],
    burnInTicks: 0,
    durationTicks: 1800,
    treatmentDelay: 0,
  });
  assert.equal(plan.seeds.length * (plan.burnInTicks + 2 * plan.durationTicks), BATCH_MAX_TICKS);
  const execute = (runner: ReturnType<typeof createBatch>) => {
    const started = performance.now();
    let callbacks = 0,
      maximumCallbackMs = 0;
    while (true) {
      const began = performance.now();
      const progress = runner.advance(() => performance.now());
      maximumCallbackMs = Math.max(maximumCallbackMs, performance.now() - began);
      callbacks++;
      if (progress.done) break;
    }
    const elapsedMs = performance.now() - started,
      result = runner.snapshot();
    runner.dispose();
    return { result, elapsedMs, callbacks, maximumCallbackMs };
  };
  const original = execute(createBatch(plan));
  for (const run of original.result.runs) {
    assert.equal(run.status, 'complete', run.error ?? undefined);
    assert.deepEqual(run.recipe!.control, run.recipe!.treatment);
    assert.equal(run.recipe!.control.samples.length, 61);
    assert.equal(run.tick, 1800);
  }
  const text = encodeBatch(original.result);
  assert.ok(Buffer.byteLength(text) <= BATCH_MAX_BYTES);
  const replay = execute(replayBatch(text));
  assert.deepEqual(
    replay.result.runs,
    original.result.runs.map((run) => ({ ...run, reproduced: true })),
  );
  receipt('batches', {
    ...context(),
    status: 'complete',
    plan,
    engineTicksPerPass: BATCH_MAX_TICKS,
    original: {
      elapsedMs: original.elapsedMs,
      callbacks: original.callbacks,
      maximumCallbackMs: original.maximumCallbackMs,
    },
    replay: {
      elapsedMs: replay.elapsedMs,
      callbacks: replay.callbacks,
      maximumCallbackMs: replay.maximumCallbackMs,
    },
    exportBytes: Buffer.byteLength(text),
    exportSHA256: digest(text),
    outcomes: original.result.runs.map((run) => ({
      seed: run.seed,
      controlPopulation: run.recipe!.control.samples.at(-1)!.population,
      extinction: run.recipe!.control.extinction,
    })),
    limitations:
      'Synchronous same-runtime runner, full eight-seed budget, fixed founder recipe. Includes checkpoint construction/validation. No assertion about wall-clock throughput on a shared host or worst-case dense organisms. Whole ticks and checkpoint codecs are non-preemptible; 8ms is a cooperative stepping budget, not a hard latency guarantee.',
  });
});
