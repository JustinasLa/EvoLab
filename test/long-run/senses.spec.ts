import { assert, it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT, type Genome } from '../../src/model';
import { newController } from '../../src/neural';
import { newSenses } from '../../src/senses';
import { context, digest, invariants, receipt } from './support';

it('measures bounded expanded sensing with real energy, extinction and complete continuation', () => {
  const measurements: object[] = [];
  for (const population of [64, LIMIT])
    for (const temperature of [false, true]) {
      const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, mutation: 0, climate: 0 }, false);
      const genome: Genome = {
        cells: Array.from({ length: 16 }, (_, cell) => ({
          x: (cell % 4) - 1,
          y: Math.floor(cell / 4) - 1,
          type: 8,
        })),
        preference: 0.5,
        tolerance: 0.2,
        tempo: 2,
        behavior: { version: 1, mode: 'legacy' },
        controller: newController(2),
        senses: { ...newSenses(), range: 8, fov: 4, temperature },
      };
      for (let organism = 0; organism < population; organism++) {
        const spawned = world.spawn(
          genome,
          (organism % 60) * 4 + 1,
          Math.floor(organism / 60) * 4 + 1,
          organism ? 1 : undefined,
        )!;
        assert.ok(spawned);
        spawned.energy = 56;
      }
      const initial = JSON.stringify(world.save());
      let endpoint = '';
      for (let repetition = 0; repetition < 2; repetition++) {
        let candidate = Ecosystem.load(initial);
        let populatedTicks = 0,
          firstExtinction: number | null = null;
        const started = performance.now();
        for (let tick = 0; tick < 600; tick++) {
          candidate.step();
          if (candidate.organisms.size) populatedTicks++;
          else firstExtinction ??= candidate.tick;
          if (tick === 29 && repetition === 1)
            candidate = Ecosystem.load(JSON.stringify(candidate.save()));
        }
        const elapsedMs = performance.now() - started;
        invariants(candidate);
        const final = JSON.stringify(candidate.save());
        if (endpoint) assert.equal(final, endpoint);
        else endpoint = final;
        assert.ok(populatedTicks > 0);
        assert.ok(candidate.deaths > 0);
        assert.equal(candidate.births, 0);
        measurements.push({
          population,
          temperature,
          repetition,
          elapsedMs,
          populatedTicks,
          firstExtinction,
          finalSHA256: digest(final),
        });
      }
    }
  receipt('expanded-senses', {
    ...context(),
    status: 'passed',
    measurements,
    limits:
      'Sixteen eyes, four rays each, range eight: at most 512 visits per evaluation, 56 neural multiply-adds, four paid temperature samples when enabled. Dense bodies self-occlude. Real starvation, no population rescue; empty ticks disclosed, not counted as populated throughput. No timing threshold or guaranteed adaptation.',
  });
});
