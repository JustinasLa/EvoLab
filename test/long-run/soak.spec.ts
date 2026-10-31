import assert from 'node:assert/strict';
import { it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT, WORLD_MAX_BYTES } from '../../src/model';
import { context, digest, invariants, receipt, starved, withOpaquePayload } from './support';

const TICKS = 100_000;
const checkpoints = [0, 29, 30, 31, 5399, 5400, 5401, 25_000, 50_000, 75_000, 99_863];
const corpus = [
  { seed: 1, name: 'default', make: () => new Ecosystem({ ...DEFAULTS, seed: 1 }) },
  { seed: 42, name: 'default-opaque', make: () => withOpaquePayload(new Ecosystem(DEFAULTS)) },
  { seed: 123, name: 'starvation', make: () => starved(123) },
];

for (const fixture of corpus)
  it(`${fixture.name} seed ${fixture.seed} completes ${TICKS} real ticks without rescue`, () => {
    const world = fixture.make();
    const initial = JSON.stringify(world.save());
    assert.equal(JSON.stringify(fixture.make().save()), initial, 'repeatable initialization');
    const forks: { world: Ecosystem; checkpoint: number; end: number }[] = [];
    const evidence = {
      ...context(),
      seed: fixture.seed,
      fixture: fixture.name,
      settings: world.save().settings,
      initialSaveSHA256: digest(initial),
      completedTicks: 0,
      status: 'incomplete',
      elapsedMs: 0,
      firstExtinction: null as null | { tick: number; cause: string },
      firstSaturationTick: null as number | null,
      saturatedTicks: 0,
      emptyTicks: 0,
      minPopulation: world.organisms.size,
      maxPopulation: world.organisms.size,
      populationTickSum: 0,
      invariantChecks: 0,
      maxCheckpointBytes: 0,
      maxConcurrentContinuations: 0,
      checkpoints: [] as {
        tick: number;
        end: number;
        saveSHA256: string;
        continuationSHA256?: string;
      }[],
      populations: [] as { tick: number; population: number; births: number; deaths: number }[],
      limitations:
        'Finite corpus in one runtime; bounds checked every 1000 ticks and at save/continuation boundaries. Population/counters checked every tick. Empty post-extinction ticks are retained, not used as crowded throughput. No interventions after initialization.',
    };
    const started = performance.now();
    const check = (candidate: Ecosystem) => {
      invariants(candidate);
      evidence.invariantChecks++;
    };
    try {
      for (;;) {
        if (world.tick % 1000 === 0) {
          check(world);
          evidence.populations.push({
            tick: world.tick,
            population: world.organisms.size,
            births: world.births,
            deaths: world.deaths,
          });
        }
        for (let index = forks.length - 1; index >= 0; index--) {
          const fork = forks[index];
          if (fork.end !== world.tick) continue;
          check(world);
          check(fork.world);
          const complete = JSON.stringify(world.save());
          assert.equal(
            JSON.stringify(fork.world.save()),
            complete,
            `complete continuation from ${fork.checkpoint}`,
          );
          evidence.checkpoints.find((row) => row.tick === fork.checkpoint)!.continuationSHA256 =
            digest(complete);
          forks.splice(index, 1);
        }
        if (checkpoints.includes(world.tick)) {
          check(world);
          const complete = JSON.stringify(world.save());
          const bytes = new TextEncoder().encode(complete).byteLength;
          evidence.maxCheckpointBytes = Math.max(evidence.maxCheckpointBytes, bytes);
          assert.ok(bytes <= WORLD_MAX_BYTES, 'this fixture remains a loadable checkpoint');
          const restored = Ecosystem.load(complete);
          check(restored);
          assert.equal(
            JSON.stringify(restored.save()),
            complete,
            'complete round trip including opaque payloads',
          );
          forks.push({ world: restored, checkpoint: world.tick, end: world.tick + 137 });
          evidence.checkpoints.push({
            tick: world.tick,
            end: world.tick + 137,
            saveSHA256: digest(complete),
          });
          evidence.maxConcurrentContinuations = Math.max(
            evidence.maxConcurrentContinuations,
            forks.length,
          );
          assert.ok(forks.length <= 4, 'bounded continuation ownership');
        }
        if (world.tick === TICKS) break;
        const births = world.births,
          deaths = world.deaths;
        world.step();
        for (const fork of forks) fork.world.step();
        assert.equal(world.tick, evidence.completedTicks + 1);
        assert.ok(world.births >= births && world.deaths >= deaths);
        assert.ok(world.organisms.size <= LIMIT);
        evidence.completedTicks = world.tick;
        evidence.populationTickSum += world.organisms.size;
        evidence.minPopulation = Math.min(evidence.minPopulation, world.organisms.size);
        evidence.maxPopulation = Math.max(evidence.maxPopulation, world.organisms.size);
        if (!world.organisms.size) {
          evidence.emptyTicks++;
          evidence.firstExtinction ??= { ...world.lastDeath! };
        }
        if (world.organisms.size === LIMIT) {
          evidence.saturatedTicks++;
          evidence.firstSaturationTick ??= world.tick;
        }
      }
      assert.equal(forks.length, 0);
      assert.equal(evidence.checkpoints.length, checkpoints.length);
      assert.ok(evidence.checkpoints.every((row) => row.continuationSHA256));
      assert.equal(evidence.populations.length, 101);
      if (fixture.name === 'starvation') {
        assert.equal(evidence.firstExtinction?.cause, 'energy');
        assert.ok(evidence.emptyTicks > 0);
        assert.equal(world.births, 0);
        assert.equal(world.deaths, 1);
        assert.equal(world.organisms.size, 0);
      } else {
        assert.ok(evidence.saturatedTicks > 0, 'retain genuinely saturated worlds');
        assert.ok(world.births > 0 && world.deaths > 0);
      }
      evidence.status = 'passed';
    } finally {
      evidence.elapsedMs = performance.now() - started;
      receipt(`soak-${fixture.seed}`, evidence);
    }
  });
