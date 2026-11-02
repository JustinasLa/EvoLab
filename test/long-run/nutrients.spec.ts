import assert from 'node:assert/strict';
import { it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, WIDTH, LIMIT, type Genome } from '../../src/model';
import { nutrientSummary, NUTRIENT_TOTAL, STORED_ENERGY_LIMIT } from '../../src/nutrients';
import { context, digest, invariants, receipt } from './support';

const producer: Genome = {
  cells: [{ x: 0, y: 0, type: 4 }],
  preference: 0.5,
  tolerance: 0.2,
  tempo: 2,
  behavior: { version: 1, mode: 'legacy' },
};

it('measures reproducible depletion, recycling and finite long-run resources without rescue', () => {
  const outcomes: object[] = [];
  for (const seed of [7, 42, 314]) {
    for (const scene of ['founder', 'producer-only', 'extinct'] as const) {
      for (const enabled of [false, true]) {
        const world = new Ecosystem(
          { ...DEFAULTS, seed, mutation: 0, climate: 0, nutrients: 20 },
          scene === 'founder',
          { nutrientCycle: enabled, terrain: { version: 1, preset: 'open-field', seed: null } },
        );
        if (scene !== 'founder') {
          const organism = world.spawn(producer, WIDTH / 2, 78)!;
          if (scene === 'extinct') world.kill(organism, 'manual');
        }
        const replay = Ecosystem.load(JSON.stringify(world.save()));
        const initialRandom = world.random.state;
        const samples: object[] = [];
        const started = performance.now();
        for (let tick = 0; tick < 12000; tick++) {
          world.step();
          replay.step();
          if (tick % 600 === 599 || tick === 63) {
            invariants(world);
            assert.equal(JSON.stringify(world.save()), JSON.stringify(replay.save()));
            const resources = world.nutrientCycle
              ? nutrientSummary(world.nutrientCycle, world.organisms.values(), world.food)
              : null;
            if (resources) {
              assert.equal(resources.total, NUTRIENT_TOTAL);
              assert.ok(resources.energy <= STORED_ENERGY_LIMIT);
              assert.ok(resources.budget!.sunlight >= 0);
              assert.ok(
                Math.abs(
                  resources.budget!.before +
                    resources.budget!.sunlight -
                    resources.budget!.after -
                    resources.budget!.dissipated,
                ) < 1e-7,
              );
            }
            samples.push({
              tick: world.tick,
              population: world.organisms.size,
              births: world.births,
              deaths: world.deaths,
              food: world.presentation().stats.food,
              resources,
            });
          }
        }
        if (scene === 'extinct') {
          assert.equal(world.random.state, initialRandom);
          assert.equal(world.organisms.size, 0);
          if (world.nutrientCycle)
            assert.equal(
              nutrientSummary(world.nutrientCycle, [], world.food).minerals,
              NUTRIENT_TOTAL,
            );
        }
        assert.deepEqual(Ecosystem.load(JSON.stringify(world.save())).save(), world.save());
        outcomes.push({
          seed,
          scene,
          enabled,
          horizon: world.tick,
          elapsedMs: performance.now() - started,
          finalSHA256: digest(JSON.stringify(world.save())),
          samples,
        });
      }
    }
  }
  receipt('nutrient-comparisons', { context: context(), outcomes });
});

it('records enabled versus disabled whole-tick throughput at bounded populations', () => {
  const outcomes: object[] = [];
  for (const population of [0, 64, LIMIT]) {
    for (const enabled of [false, true]) {
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false, {
        nutrientCycle: enabled,
      });
      for (let count = 0; count < population; count++) {
        const organism = world.spawn(producer, (count % 80) * 3, Math.floor(count / 80) * 3)!;
        organism.energy = 8;
      }
      const start = performance.now();
      for (let tick = 0; tick < 600; tick++) world.step();
      const elapsedMs = performance.now() - start;
      invariants(world);
      outcomes.push({
        population,
        enabled,
        ticks: 600,
        elapsedMs,
        ticksPerSecond: 600000 / elapsedMs,
        finalSHA256: digest(JSON.stringify(world.save())),
      });
    }
  }
  receipt('nutrient-throughput', { context: context(), outcomes });
});
