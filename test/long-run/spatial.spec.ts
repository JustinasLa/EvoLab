import assert from 'node:assert/strict';
import { it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT } from '../../src/model';
import { SPATIAL_COMPLETED_WINDOWS, spatialBudget } from '../../src/spatial';
import { roleGenome } from '../fixtures/roles';
import { populatedWorld } from '../fixtures/spatial';
import { context, digest, invariants, receipt } from './support';

function crowded(population: number): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  for (let count = 0; count < population; count++)
    world.spawn(roleGenome(4), (count % 80) * 3, Math.floor(count / 80) * 3)!.energy = 8;
  return world;
}

it('measures opt-in spatial capture overhead and exact complete outcomes', () => {
  const budget = spatialBudget();
  const scenes: [string, () => Ecosystem][] = [
    ['empty', () => crowded(0)],
    ['mixed-240', populatedWorld],
    [`leaves-${LIMIT}`, () => crowded(LIMIT)],
  ];
  const results: object[] = [];
  for (const [scene, build] of scenes) {
    const initial = build();
    const saved = JSON.stringify(initial.save());
    for (let repetition = -1; repetition < 3; repetition++) {
      let expected: string | undefined;
      for (const enabled of repetition % 2 ? [true, false] : [false, true]) {
        const world = Ecosystem.load(saved);
        world.observeSpatial(enabled);
        let maximumSummaryBytes = 0;
        const start = performance.now();
        for (let count = 0; count < 2400; count++) {
          world.step();
          if (enabled && world.tick % 30 === 0)
            maximumSummaryBytes = Math.max(
              maximumSummaryBytes,
              Buffer.byteLength(JSON.stringify(world.spatialSummary())),
            );
        }
        const elapsedMs = performance.now() - start;
        invariants(world);
        const final = JSON.stringify(world.save());
        if (expected) assert.equal(final, expected);
        expected = final;
        const snapshot = world.spatialSnapshot();
        if (enabled) {
          assert.equal(snapshot!.windows.length, SPATIAL_COMPLETED_WINDOWS + 1);
          assert.equal(snapshot!.evictedWindows, 2);
          const bytes = snapshot!.windows.reduce(
            (total, window) => total + window.values.byteLength + 9 * 8,
            0,
          );
          assert.equal(bytes, budget.bytes);
        } else assert.equal(snapshot, undefined);
        if (repetition >= 0)
          results.push({
            scene,
            initialPopulation: initial.organisms.size,
            finalPopulation: world.organisms.size,
            repetition,
            enabled,
            ticks: 2400,
            elapsedMs,
            ticksPerSecond: (2400 * 1000) / elapsedMs,
            maximumSummaryBytes,
            events: enabled
              ? snapshot!.windows.reduce(
                  (total, window) =>
                    total +
                    window.totals.births +
                    window.totals.starvationDeaths +
                    window.totals.ageDeaths +
                    window.totals.feedings +
                    window.totals.attacks,
                  0,
                )
              : null,
            finalSHA256: digest(final),
          });
      }
    }
  }
  receipt('spatial', {
    ...context(),
    budget,
    results,
    status: 'passed',
    limitations:
      'Direct engine, one warm-up and three alternating-order repetitions of 2,400 ticks (two evictions). Timing includes a summary every 30 ticks when enabled, not worker messaging or browser rendering. Shared-host JIT/GC/load affect timing; no timing threshold.',
  });
});
