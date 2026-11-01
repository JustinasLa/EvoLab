import { assert, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT, founder } from '../../src/model';
import { newController } from '../../src/neural';
import { context, digest, invariants, receipt } from './support';

it('measures populated neural worlds with repeatable complete endpoints and continuation', () => {
  const measurements: object[] = [];
  for (const population of [64, LIMIT])
    for (const kind of ['legacy-producer', 'neural-blind', 'neural-sighted']) {
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false, {
        terrain: { version: 1, preset: 'open-field', seed: null },
      });
      const genome = founder(0);
      genome.tempo = 2;
      if (kind !== 'legacy-producer') genome.controller = newController();
      if (kind === 'neural-sighted')
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
      let endpoint: string | undefined;
      for (let repetition = -1; repetition < 3; repetition++) {
        let candidate = Ecosystem.load(initial);
        let elapsedMs = 0,
          populationTicks = 0,
          minimumPopulation = population;
        for (let segment = 0; segment < 2; segment++) {
          const start = performance.now();
          for (let tick = 0; tick < 300; tick++) {
            candidate.step();
            populationTicks += candidate.organisms.size;
            minimumPopulation = Math.min(minimumPopulation, candidate.organisms.size);
          }
          elapsedMs += performance.now() - start;
          if (segment === 0 && repetition === 1)
            candidate = Ecosystem.load(JSON.stringify(candidate.save()));
        }
        invariants(candidate);
        assert.ok(minimumPopulation > 0);
        const final = JSON.stringify(candidate.save());
        if (endpoint) assert.equal(final, endpoint);
        else endpoint = final;
        if (repetition >= 0)
          measurements.push({
            kind,
            initialPopulation: population,
            repetition,
            elapsedMs,
            ticksPerSecond: 600000 / elapsedMs,
            populationTicks,
            minimumPopulation,
            finalPopulation: candidate.organisms.size,
            births: candidate.births,
            deaths: candidate.deaths,
            finalSHA256: digest(final),
          });
      }
    }
  receipt('neural-throughput', {
    ...context(),
    neuralSourceSHA256: Object.fromEntries(
      [
        'src/neural.ts',
        'src/sensory.ts',
        'src/mutation-evidence.ts',
        'test/long-run/neural.spec.ts',
      ].map((file) => [file, digest(readFileSync(file, 'utf8'))]),
    ),
    status: 'passed',
    ticks: 600,
    warmups: 1,
    repetitions: 3,
    measurements,
    limits:
      'Fixed 6-4-4 topology: 40 multiply-adds, 8 clamps per evaluation; at most 16 five-cell eye rays. Direct engine, telemetry and lineage enabled; setup/save validation excluded from timing. Shared host, no timing threshold. Resting controllers, not a universal advantage or worst-case locomotion claim.',
  });
});
