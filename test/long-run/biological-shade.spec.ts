import assert from 'node:assert/strict';
import { it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT, type Genome } from '../../src/model';
import { nutrientSummary, NUTRIENT_TOTAL } from '../../src/nutrients';
import { context, digest, invariants, receipt } from './support';

const canopy: Genome = {
  cells: [
    { x: 0, y: 0, type: 7 },
    { x: -1, y: 0, type: 4 },
    { x: 0, y: -1, type: 4 },
    { x: 1, y: 0, type: 4 },
    { x: 0, y: 1, type: 3 },
  ],
  preference: 0.5,
  tolerance: 0.2,
  tempo: 12,
  behavior: { version: 1, mode: 'legacy' },
};

it('preserves replay and finite budgets through long shade ecology, starvation and extinction', () => {
  const outcomes: object[] = [];
  for (const seed of [7, 42, 314])
    for (const enabled of [false, true]) {
      const world = new Ecosystem({ ...DEFAULTS, seed, climate: 0.8, nutrients: 20 }, false, {
        biologicalShade: enabled,
        nutrientCycle: true,
      });
      world.spawn(canopy, 120, 78);
      const replay = Ecosystem.load(JSON.stringify(world.save()));
      const samples: object[] = [];
      const started = performance.now();
      for (let tick = 0; tick < 12000; tick++) {
        world.step();
        replay.step();
        if (tick % 600 === 599) {
          invariants(world);
          assert.equal(JSON.stringify(world.save()), JSON.stringify(replay.save()));
          const resources = nutrientSummary(
              world.nutrientCycle!,
              world.organisms.values(),
              world.food,
            ),
            budget = resources.budget!;
          assert.equal(resources.total, NUTRIENT_TOTAL);
          assert.ok(
            Math.abs(budget.before + budget.sunlight - budget.after - budget.dissipated) < 1e-7,
          );
          samples.push({
            tick: world.tick,
            population: world.organisms.size,
            births: world.births,
            deaths: world.deaths,
            resources,
            shade: world.presentation().biologicalShade,
          });
        }
      }
      outcomes.push({
        seed,
        enabled,
        elapsedMs: performance.now() - started,
        samples,
        finalSHA256: digest(JSON.stringify(world.save())),
      });
    }
  receipt('biological-shade-soak', { context: context(), outcomes });
});

it('measures empty, moderate and saturated shade costs without weakening throughput assertions', () => {
  const outcomes: object[] = [];
  for (const population of [0, 64, LIMIT])
    for (const enabled of [false, true]) {
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false, {
        biologicalShade: enabled,
        nutrientCycle: true,
      });
      for (let count = 0; count < population; count++) {
        const organism = world.spawn(canopy, (count % 60) * 4 + 1, Math.floor(count / 60) * 4 + 1)!;
        assert.ok(organism);
        organism.energy = 100;
      }
      const started = performance.now();
      for (let tick = 0; tick < 600; tick++) world.step();
      const elapsedMs = performance.now() - started;
      invariants(world);
      assert.equal(
        nutrientSummary(world.nutrientCycle!, world.organisms.values(), world.food).total,
        NUTRIENT_TOTAL,
      );
      assert.equal(
        JSON.stringify(Ecosystem.load(JSON.stringify(world.save())).save()),
        JSON.stringify(world.save()),
      );
      outcomes.push({
        population,
        enabled,
        ticks: 600,
        elapsedMs,
        ticksPerSecond: 600000 / elapsedMs,
        finalPopulation: world.organisms.size,
        finalSHA256: digest(JSON.stringify(world.save())),
      });
    }
  receipt('biological-shade-throughput', {
    context: context(),
    outcomes,
    limitations:
      'Direct engine, shared host, one bounded sample per configuration; no invented timing threshold or claim of physical realism. Standard throughput suite remains required.',
  });
});
