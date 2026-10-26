import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, hostname, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const { advance, colony, ecology } = await server.ssrLoadModule('/test/fixtures/telemetry.ts');
  const { LIMIT } = await server.ssrLoadModule('/src/model.ts');
  const enabled = colony(LIMIT, 0.3),
    disabled = colony(LIMIT, 0.3, 0.5, false),
    warmups = [],
    raw = [];
  for (const world of [enabled, disabled]) {
    for (const organism of world.organisms.values()) organism.energy = 100;
    advance(world, 29);
    assert.equal(world.organisms.size, LIMIT);
  }
  const measure = (world) => {
    for (const organism of world.organisms.values()) {
      organism.age = 0;
      organism.energy = 100;
    }
    const fromTick = world.tick,
      started = performance.now();
    world.step();
    const boundaryMs = performance.now() - started;
    advance(world, 29);
    const thirtyTicksMs = performance.now() - started;
    assert.equal(world.tick, fromTick + 30);
    assert.equal(world.organisms.size, LIMIT);
    return { boundaryMs, thirtyTicksMs };
  };
  for (let pair = 0; pair < 45; pair++) {
    let observed, control;
    if (pair % 2) {
      control = measure(disabled);
      observed = measure(enabled);
    } else {
      observed = measure(enabled);
      control = measure(disabled);
    }
    const observedEcology = ecology(enabled.save()),
      controlEcology = ecology(disabled.save());
    assert.deepStrictEqual(observedEcology, controlEcology);
    const observation = {
      pair: pair - 5,
      tick: enabled.tick,
      population: enabled.organisms.size,
      controlPopulation: disabled.organisms.size,
      first: pair % 2 ? 'disabled' : 'enabled',
      enabledBoundaryMs: observed.boundaryMs,
      disabledBoundaryMs: control.boundaryMs,
      enabledThirtyTicksMs: observed.thirtyTicksMs,
      disabledThirtyTicksMs: control.thirtyTicksMs,
      ecologySHA256: createHash('sha256').update(JSON.stringify(observedEcology)).digest('hex'),
    };
    (pair < 5 ? warmups : raw).push(observation);
  }
  assert.equal(warmups.length, 5);
  assert.equal(raw.length, 40);
  const distribution = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return {
      min: sorted[0],
      median: (sorted[19] + sorted[20]) / 2,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      max: sorted.at(-1),
    };
  };
  console.log(
    JSON.stringify(
      {
        command: 'node test/telemetry-observer.measure.mjs',
        recordedAtUTC: new Date().toISOString(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        sourceSHA256: Object.fromEntries(
          [
            'src/ecosystem.ts',
            'src/model.ts',
            'test/fixtures/telemetry.ts',
            'test/telemetry-observer.measure.mjs',
          ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
        ),
        runtime: process.version,
        versions: process.versions,
        host: hostname(),
        platform: platform(),
        kernel: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        methodology:
          'Pinned Vite loads real TypeScript engine without coverage instrumentation or a listening server. Five warm-up pairs and forty retained pairs alternate enabled/disabled order. Each world advances 29 initial ticks, then exactly 30 real ticks per pair, with identical age/energy resets outside timing. Boundary timing is the first tick; total includes the next 29 ticks. Both worlds must retain 1600 organisms; two complete saves are compared after excluding only telemetry, outside timing. Enabled is all telemetry, not only adaptation counters. Raw warm-ups and all retained pairs are included.',
        limitations:
          'Local same-process shared-host observations, not CI results or universal throughput. Scheduler, CPU and GC effects are not isolated or attributed. Setup, resets, survival assertions, saves, equality and hashing are outside measured intervals but still executed. Ordinary coverage separately verifies deterministic saturated boundary behavior; this full measurement workload is not an ordinary discovered test.',
        distributions: {
          enabledBoundaryMs: distribution(raw.map((pair) => pair.enabledBoundaryMs)),
          disabledBoundaryMs: distribution(raw.map((pair) => pair.disabledBoundaryMs)),
          pairedBoundaryDeltaMs: distribution(
            raw.map((pair) => pair.enabledBoundaryMs - pair.disabledBoundaryMs),
          ),
          enabledThirtyTicksMs: distribution(raw.map((pair) => pair.enabledThirtyTicksMs)),
          disabledThirtyTicksMs: distribution(raw.map((pair) => pair.disabledThirtyTicksMs)),
          pairedThirtyTickDeltaMs: distribution(
            raw.map((pair) => pair.enabledThirtyTicksMs - pair.disabledThirtyTicksMs),
          ),
        },
        warmups,
        raw,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
