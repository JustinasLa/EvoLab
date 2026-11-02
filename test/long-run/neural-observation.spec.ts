import { assert, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT, founder } from '../../src/model';
import { newController } from '../../src/neural';
import { nutrientSummary, NUTRIENT_TOTAL, STORED_ENERGY_LIMIT } from '../../src/nutrients';
import { context, digest, invariants, receipt } from './support';

it('measures bounded selected capture against identical populated capture-off continuations', () => {
  const measurements: object[] = [];
  for (const nutrientCycle of [false, true]) {
    for (const population of [64, LIMIT]) {
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false, {
        nutrientCycle,
      });
      const genome = { ...founder(0), tempo: 2, controller: newController() };
      genome.cells.push({ x: 1, y: -1, type: 8 }, { x: 1, y: 1, type: 5 });
      for (let position = 0; position < population; position++)
        assert.ok(
          world.spawn(
            genome,
            (position % 60) * 4 + 1,
            Math.floor(position / 60) * 4 + 1,
            position ? 5 : undefined,
          ),
        );
      const initial = JSON.stringify(world.save());
      let expected: string | undefined;
      for (let repetition = -1; repetition < 3; repetition++)
        for (const enabled of [false, true]) {
          const candidate = Ecosystem.load(initial);
          candidate.selectNeural(1, enabled);
          let maximumBytes = 0,
            populationTicks = 0,
            minimumPopulation = population,
            actualDecisionSnapshots = 0;
          const start = performance.now();
          for (let tick = 0; tick < 600; tick++) {
            candidate.step();
            populationTicks += candidate.organisms.size;
            minimumPopulation = Math.min(minimumPopulation, candidate.organisms.size);
            if (tick % 4 === 0) {
              const observation = candidate.neuralObservation();
              if (enabled) {
                assert.ok(observation);
                assert.ok(observation.decisions.length <= 12);
                if (observation.decisions.length) actualDecisionSnapshots++;
                const bytes = new TextEncoder().encode(JSON.stringify(observation)).byteLength;
                maximumBytes = Math.max(maximumBytes, bytes);
                assert.ok(bytes < 65536);
              } else assert.equal(observation, null);
            }
          }
          const elapsedMs = performance.now() - start;
          invariants(candidate);
          assert.ok(minimumPopulation > 0);
          if (enabled) assert.ok(actualDecisionSnapshots > 0);
          if (candidate.nutrientCycle) {
            const resources = nutrientSummary(
              candidate.nutrientCycle,
              candidate.organisms.values(),
              candidate.food,
            );
            assert.equal(resources.total, NUTRIENT_TOTAL);
            assert.ok(resources.energy <= STORED_ENERGY_LIMIT);
            assert.ok(
              Math.abs(
                resources.budget!.before +
                  resources.budget!.sunlight -
                  resources.budget!.after -
                  resources.budget!.dissipated,
              ) < 1e-7,
            );
          }
          const final = JSON.stringify(candidate.save());
          if (expected) assert.equal(final, expected);
          else expected = final;
          const continued = Ecosystem.load(final);
          for (let tick = 0; tick < 30; tick++) {
            continued.step();
            candidate.step();
          }
          assert.deepEqual(candidate.save(), continued.save());
          if (repetition >= 0)
            measurements.push({
              population,
              nutrientCycle,
              enabled,
              repetition,
              elapsedMs,
              ticksPerSecond: 600000 / elapsedMs,
              maximumBytes,
              populationTicks,
              minimumPopulation,
              finalPopulation: candidate.organisms.size,
              actualDecisionSnapshots,
              finalSHA256: digest(final),
            });
        }
    }
  }
  receipt('neural-observation-throughput', {
    ...context(),
    observerSourceSHA256: Object.fromEntries(
      [
        'src/neural-observation.ts',
        'src/neural.ts',
        'src/sensory.ts',
        'src/nutrients.ts',
        'test/long-run/neural-observation.spec.ts',
      ].map((file) => [file, digest(readFileSync(file, 'utf8'))]),
    ),
    status: 'passed',
    ticks: 600,
    warmups: 1,
    repetitions: 3,
    measurements,
    limits:
      'Nutrient cycle off/on, each with identical capture-off/on complete endpoints and reload continuation. One selected identity; 12 decisions; at most 16 rays of 5 cells each per decision; bounded snapshot every 4 ticks. No timing threshold or causal/performance advantage claimed.',
  });
});
