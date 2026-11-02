import { assert, it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT, founder } from '../../src/model';
import { newController } from '../../src/neural';
import { context, digest, invariants, receipt } from './support';

it('measures bounded selected capture against identical populated capture-off continuations', () => {
  const measurements: object[] = [];
  for (const population of [64, LIMIT]) {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
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
        let maximumBytes = 0;
        const start = performance.now();
        for (let tick = 0; tick < 600; tick++) {
          candidate.step();
          if (tick % 4 === 0) {
            const observation = candidate.neuralObservation();
            if (enabled) {
              assert.ok(observation);
              assert.ok(observation.decisions.length <= 12);
              const bytes = new TextEncoder().encode(JSON.stringify(observation)).byteLength;
              maximumBytes = Math.max(maximumBytes, bytes);
              assert.ok(bytes < 65536);
            } else assert.equal(observation, null);
          }
        }
        const elapsedMs = performance.now() - start;
        invariants(candidate);
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
            enabled,
            repetition,
            elapsedMs,
            ticksPerSecond: 600000 / elapsedMs,
            maximumBytes,
            finalSHA256: digest(final),
          });
      }
  }
  receipt('neural-observation-throughput', {
    ...context(),
    status: 'passed',
    ticks: 600,
    warmups: 1,
    repetitions: 3,
    measurements,
    limits:
      'One selected identity; 12 decisions; at most 16 rays of 5 cells each per decision; bounded snapshot every 4 ticks. No timing threshold or causal/performance advantage claimed.',
  });
});
