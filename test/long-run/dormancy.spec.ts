import assert from 'node:assert/strict';
import { it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULT_DORMANCY } from '../../src/dormancy';
import { DEFAULTS, LIMIT, founder } from '../../src/model';
import { context, digest, invariants, receipt } from './support';

it('records real dormant, active and migrating seasonal survival and bounded throughput', () => {
  const evidence = {
    ...context(),
    cases: [] as object[],
    throughput: [] as object[],
    limitations:
      'Finite seeded fixtures, not universal winners. Matched initial energy, no initial reserves, population rescue or runtime interventions. Direct engine throughput on a shared host, not worker/browser latency; no timing threshold.',
  };
  for (const scenario of ['seasonal', 'heat', 'cold', 'scarcity'] as const)
    for (const strategy of ['active', 'dormancy', 'migrating'] as const) {
      const world = new Ecosystem(
        {
          ...DEFAULTS,
          seed: 42,
          mutation: 0,
          nutrients: 0,
          climate: scenario === 'seasonal' ? 1 : 0,
        },
        false,
      );
      const genome = founder(0);
      genome.cells = [
        { x: 0, y: 0, type: 4 },
        { x: -1, y: 0, type: 3 },
        { x: 0, y: -1, type: strategy === 'migrating' ? 5 : 7 },
      ];
      genome.tolerance = 0.12;
      if (strategy === 'dormancy')
        genome.dormancy = { ...DEFAULT_DORMANCY, enterStress: 0.08, wakeStress: 0.02 };
      for (let position = 0; position < 64; position++)
        assert.ok(
          world.spawn(genome, (position % 16) * 12 + 4, Math.floor(position / 16) * 12 + 50),
        );
      if (scenario === 'heat' || scenario === 'cold') world.shock(scenario);
      if (scenario === 'scarcity') {
        world.shadeHabitats.enabled = true;
        for (const organism of world.organisms.values())
          world.shadeHabitats.units[organism.y * 240 + organism.x] = 16;
        world.shadeHabitats.nonzeroCells = 64;
      }
      let dormantOrganismTicks = 0,
        populationTicks = 0,
        firstExtinction: number | null = null;
      const initial = JSON.stringify(world.save()),
        started = performance.now();
      let continuation = Ecosystem.load(initial);
      for (let tick = 1; tick <= 10_000; tick++) {
        world.step();
        continuation.step();
        populationTicks += world.organisms.size;
        if (world.organisms.size === 0 && firstExtinction === null) firstExtinction = tick;
        for (const organism of world.organisms.values()) {
          if (organism.genome.dormancy) {
            assert.ok(
              organism.reserves!.stored >= 0 &&
                organism.reserves!.stored <= organism.genome.dormancy.capacity,
            );
            if (organism.reserves!.dormant) dormantOrganismTicks++;
          }
        }
        if ([30, 900, 1200, 5401, 10_000].includes(tick)) {
          invariants(world);
          assert.deepEqual(continuation.save(), world.save());
          continuation = Ecosystem.load(JSON.stringify(world.save()));
        }
      }
      evidence.cases.push({
        scenario,
        strategy,
        completedTicks: world.tick,
        initialSHA256: digest(initial),
        finalSHA256: digest(JSON.stringify(world.save())),
        elapsedMs: performance.now() - started,
        populationTicks,
        dormantOrganismTicks,
        firstExtinction,
        births: world.births,
        deaths: world.deaths,
        finalPopulation: world.organisms.size,
      });
    }
  for (const population of [0, 64, LIMIT])
    for (const enabled of [false, true]) {
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
      const genome = founder(0);
      if (enabled) genome.dormancy = { ...DEFAULT_DORMANCY };
      for (let position = 0; position < population; position++)
        assert.ok(world.spawn(genome, (position % 60) * 4 + 1, Math.floor(position / 60) * 4 + 1));
      const initial = JSON.stringify(world.save());
      const finalStates: string[] = [];
      for (let repetition = 0; repetition < 3; repetition++) {
        const candidate = Ecosystem.load(initial),
          started = performance.now();
        let populationTicks = 0;
        for (let tick = 0; tick < 600; tick++) {
          candidate.step();
          populationTicks += candidate.organisms.size;
        }
        const elapsedMs = performance.now() - started;
        invariants(candidate);
        finalStates.push(JSON.stringify(candidate.save()));
        evidence.throughput.push({
          population,
          enabled,
          repetition,
          completedTicks: 600,
          elapsedMs,
          ticksPerSecond: 600_000 / elapsedMs,
          populationTicks,
          finalPopulation: candidate.organisms.size,
          finalSHA256: digest(finalStates[repetition]),
        });
      }
      assert.equal(finalStates[0], finalStates[1]);
      assert.equal(finalStates[1], finalStates[2]);
    }
  receipt('dormancy', evidence);
});
