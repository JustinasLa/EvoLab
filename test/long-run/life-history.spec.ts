import assert from 'node:assert/strict';
import { it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT, founder } from '../../src/model';
import { context, digest, invariants, receipt } from './support';

it('retains bounded life histories and exact restoration through paid multi-condition trajectories', () => {
  const results: object[] = [];
  for (const climate of [0, 1])
    for (const strategy of [0, 2]) {
      let world = new Ecosystem(
        { ...DEFAULTS, seed: 42, mutation: 0.4, nutrients: 5, climate },
        false,
      );
      const genome = founder(0);
      genome.lifeHistory = {
        version: 1,
        maturity: strategy,
        investment: strategy,
        maintenance: strategy,
      };
      world.spawn(genome, 120, 78);
      const reference = Ecosystem.load(JSON.stringify(world.save()));
      let peak = 1;
      for (let tick = 0; tick < 12000; tick++) {
        world.step();
        reference.step();
        peak = Math.max(peak, world.organisms.size);
        if (tick % 1200 === 1199) {
          invariants(world);
          assert.deepEqual(world.save(), reference.save());
          assert.ok(world.save().lifeHistoryLog.events.length <= 128);
          world = Ecosystem.load(JSON.stringify(world.save()));
        }
      }
      results.push({
        climate,
        strategy,
        peak,
        births: world.births,
        deaths: world.deaths,
        log: world.save().lifeHistoryLog,
        finalSHA256: digest(JSON.stringify(world.save())),
      });
    }
  const throughput: object[] = [];
  for (const enabled of [false, true])
    for (const population of [64, LIMIT]) {
      const initial = new Ecosystem(
        { ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 },
        false,
      );
      const genome = founder(0);
      genome.cells = [{ x: 0, y: 0, type: 4 }];
      if (enabled) genome.lifeHistory = { version: 1, maturity: 2, investment: 2, maintenance: 2 };
      for (let i = 0; i < population; i++) initial.spawn(genome, i % 240, Math.floor(i / 240));
      const source = JSON.stringify(initial.save());
      let expected: string | undefined;
      for (let repetition = -1; repetition < 3; repetition++) {
        const world = Ecosystem.load(source),
          start = performance.now();
        for (let tick = 0; tick < 600; tick++) world.step();
        const elapsedMs = performance.now() - start,
          final = JSON.stringify(world.save());
        invariants(world);
        if (expected) assert.equal(final, expected);
        expected = final;
        if (repetition >= 0)
          throughput.push({
            enabled,
            population,
            repetition,
            elapsedMs,
            finalSHA256: digest(final),
            finalPopulation: world.organisms.size,
          });
      }
    }
  receipt('life-history', {
    ...context(),
    results,
    throughput,
    status: 'passed',
    limitations:
      'Direct engine, four 12000-tick trajectories, no rescue after extinction; 600-tick throughput with one warm-up and three measured repetitions. Contrasting opt-in strategies change ecology; elapsed differences include those consequences, not isolated observer overhead. No winner or biological conclusion.',
  });
});
