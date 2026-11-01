import assert from 'node:assert/strict';
import { it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT } from '../../src/model';
import { ROLE_LINEAGE_CAPACITY, ROLE_EDGE_CAPACITY } from '../../src/roles';
import { roleGenome, roleScene } from '../fixtures/roles';
import { context, digest, invariants, receipt } from './support';

it('measures opt-in role overhead and exact complete outcomes at bounded populations', () => {
  const results: object[] = [];
  for (const population of [0, 64, LIMIT]) {
    const initial = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
    for (let count = 0; count < population; count++) {
      const organism = initial.spawn(roleGenome(4), (count % 80) * 3, Math.floor(count / 80) * 3)!;
      organism.energy = 8;
    }
    const saved = JSON.stringify(initial.save());
    for (let repetition = -1; repetition < 3; repetition++) {
      let expected: string | undefined;
      for (const enabled of repetition % 2 ? [true, false] : [false, true]) {
        const world = Ecosystem.load(saved);
        if (enabled) world.observeRoles();
        let maximumBytes = 0;
        const start = performance.now();
        for (let count = 0; count < 600; count++) {
          world.step();
          if (enabled && world.tick % 30 === 0) {
            const snapshot = world.roleSnapshot()!;
            assert.ok(snapshot.lineages.length <= ROLE_LINEAGE_CAPACITY);
            assert.ok(snapshot.edges.length <= ROLE_EDGE_CAPACITY);
            maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(snapshot)));
          }
        }
        const elapsedMs = performance.now() - start;
        invariants(world);
        const final = JSON.stringify(world.save());
        if (expected) assert.equal(final, expected);
        expected = final;
        if (repetition >= 0)
          results.push({
            population,
            repetition,
            enabled,
            ticks: 600,
            elapsedMs,
            maximumBytes,
            finalSHA256: digest(final),
          });
      }
    }
  }
  const { world } = roleScene();
  const reference = Ecosystem.load(JSON.stringify(world.save()));
  world.observeRoles();
  for (let count = 0; count < 6000; count++) {
    world.step();
    reference.step();
    if (count % 300 === 0) {
      assert.deepEqual(world.save(), reference.save());
      assert.ok(world.roleSnapshot()!.lineages.length <= ROLE_LINEAGE_CAPACITY);
    }
  }
  assert.deepEqual(world.save(), reference.save());
  receipt('roles', {
    ...context(),
    results,
    trajectoryTicks: 6000,
    status: 'passed',
    limitations:
      'Direct engine, one warm-up and three alternating-order repetitions. Timing includes snapshots every 30 ticks when enabled, not browser rendering. Shared-host JIT/GC/load affect timing; no timing threshold. Bounded first-seen evidence is not complete lineage coverage.',
  });
});
