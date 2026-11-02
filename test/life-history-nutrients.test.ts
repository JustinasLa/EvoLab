import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, positions, type Genome, type WorldFile } from '../src/model';
import {
  defaultLifeHistory,
  emptyLifeHistoryLog,
  lifeRules,
  type LifeHistory,
} from '../src/life-history';
import { newController } from '../src/neural';
import { NUTRIENT_TOTAL, nutrientSummary, validateNutrients } from '../src/nutrients';
import { createComparison, createRecipeComparison } from '../src/experiments';
import { createBatch, encodeBatch, replayBatch, type BatchPlan } from '../src/experiment-batch';
import type { BirthEvent } from '../src/mutation-evidence';
import captured from './fixtures/life-history-nutrient17.json';

function scene(traits: LifeHistory = defaultLifeHistory()) {
  const world = new Ecosystem(
    { ...DEFAULTS, seed: 7, mutation: 0, climate: 0, nutrients: 0 },
    false,
    { nutrientCycle: true },
  );
  const genome: Genome = {
    ...founder(0),
    tolerance: 0.2,
    cells: [{ x: 0, y: 0, type: 7 }],
    lifeHistory: traits,
  };
  const parent = world.spawn(genome, 60, 60)!;
  const rules = lifeRules(genome);
  parent.age = Math.ceil((rules.maturity + 1) / rules.cadence) * rules.cadence - 1;
  parent.energy = 100;
  return { world, parent, rules };
}
function check(world: Ecosystem) {
  const summary = nutrientSummary(world.nutrientCycle!, world.organisms.values(), world.food);
  expect(summary.total).toBe(NUTRIENT_TOTAL);
  expect(Number.isFinite(summary.energy)).toBe(true);
  validateNutrients(world.nutrientCycle!, world.organisms.values(), world.food);
  expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
  return summary;
}
function births(world: Ecosystem) {
  return world
    .lineageSnapshot()
    .events.filter((event): event is BirthEvent => event.kind === 'reproduction');
}

describe('life history with finite nutrient ecology', () => {
  it('continues frozen native nutrient17 saves without changing neural RNG, journals, roles or material', () => {
    for (const fixture of captured.outcomes) {
      let world = new Ecosystem(
        { ...DEFAULTS, seed: 42, mutation: 0.4, nutrients: 5, climate: 0.8 },
        false,
        { nutrientCycle: fixture.enabled },
      );
      const genome = founder(fixture.neural ? 1 : 0);
      if (fixture.neural) genome.controller = newController();
      const parent = world.spawn(genome, 120, 78)!;
      parent.age = 32;
      parent.energy = 100;
      let origin = 0;
      for (const endpoint of fixture.endpoints) {
        while (world.tick < endpoint.tick) world.step();
        const { lifeHistoryLog, ...native } = world.save();
        expect(lifeHistoryLog).toEqual(emptyLifeHistoryLog(origin));
        const projected = { ...native, version: 17 };
        for (const event of projected.lineageArchive.events)
          if (event.kind === 'reproduction') delete event.payment;
        expect(createHash('sha256').update(JSON.stringify(projected)).digest('hex')).toBe(
          endpoint.hash,
        );
        // Continue the actual version17 import, including nonzero-tick budgets.
        world = Ecosystem.load(JSON.stringify(projected));
        origin = world.tick;
        expect(world.save().lifeHistoryLog).toEqual(emptyLifeHistoryLog(origin));
        if (fixture.enabled) check(world);
      }
    }
  });

  it('conserves finite material and pays grants and overhead once across all 27 strategies', () => {
    for (const maturity of [0, 1, 2])
      for (const investment of [0, 1, 2])
        for (const maintenance of [0, 1, 2]) {
          const { world, parent, rules } = scene({ version: 1, maturity, investment, maintenance });
          const before = check(world);
          world.step();
          const after = check(world),
            event = births(world)[0];
          expect(world.births).toBe(1);
          const child = world.organisms.get(event.childOrganismId!)!;
          expect(child.energy).toBe(rules.grant(1));
          expect(event.payment).toEqual({
            parentAge: parent.age,
            parentPaid: 100 - 0.012 - rules.maintenance - parent.energy,
            offspringGranted: child.energy,
            overhead: rules.overhead,
          });
          expect(event.payment!.parentPaid).toBeCloseTo(child.energy + rules.overhead, 12);
          expect(after.biomass).toBe(before.biomass + 1);
          expect(after.minerals).toBe(before.minerals - 1);
          expect(after.detritus).toBe(0);
          expect(after.budget!.sunlight).toBe(0);
          expect(after.budget!.before).toBe(100);
          expect(after.budget!.after).toBeCloseTo(parent.energy + child.energy, 12);
          expect(after.budget!.dissipated).toBeCloseTo(
            0.012 + rules.maintenance + rules.overhead,
            12,
          );
          expect(world.save().lifeHistoryLog.maintenanceSpent).toBeCloseTo(rules.maintenance, 12);
        }
  });

  it('keeps three mineral-starved placement attempts free of grants or partial mineral debits', () => {
    const { world, parent, rules } = scene();
    world.nutrientCycle!.minerals.fill(0);
    world.nutrientCycle!.minerals[0] = NUTRIENT_TOTAL - 1;
    const before = world.save().nutrientCycle!;
    check(world);
    world.step();
    const after = check(world),
      event = births(world)[0];
    expect(world.births).toBe(0);
    expect(event.placementAttempts).toBe(3);
    expect(event.childOrganismId).toBeNull();
    expect(event.payment).toEqual({
      parentAge: parent.age,
      parentPaid: 0,
      offspringGranted: 0,
      overhead: 0,
    });
    expect(parent.energy).toBeCloseTo(100 - 0.012 - rules.maintenance, 12);
    expect(world.save().nutrientCycle!.minerals).toEqual(before.minerals);
    expect(after.budget!.dissipated).toBeCloseTo(0.012 + rules.maintenance, 12);
  });

  it('accounts for maintenance and age death as energy dissipation and returns biomass to detritus', () => {
    const { world, parent, rules } = scene({
      version: 1,
      maturity: 2,
      investment: 2,
      maintenance: 2,
    });
    parent.age = rules.ageLimit;
    const footprint = positions(parent);
    world.step();
    const after = check(world);
    expect(world.organisms.size).toBe(0);
    expect(after).toMatchObject({ biomass: 0, detritus: 1, food: 0, energy: 0 });
    expect(after.budget).toMatchObject({ before: 100, after: 0, dissipated: 100, sunlight: 0 });
    expect(world.save().lifeHistoryLog.maintenanceSpent).toBeCloseTo(rules.maintenance, 12);
    expect(world.save().lifeHistoryLog.events.at(-1)).toMatchObject({
      kind: 'age',
      age: rules.ageLimit + 1,
    });
    expect(world.nutrientCycle!.detritus[footprint[0]]).toBe(1);
    const saved = world.save();
    world.kill(parent, 'manual');
    expect(world.save()).toEqual(saved);
  });

  it('retains strict nutrient17 and nutrient18 validation alongside trait and identity checks', () => {
    const { world } = scene();
    world.step();
    const initial = world.save();
    for (const mutate of [
      (file: WorldFile) => {
        delete (file as Partial<WorldFile>).nutrientCycle;
      },
      (file: WorldFile) => {
        file.nutrientCycle!.minerals[0]++;
      },
      (file: WorldFile) => {
        file.nutrientCycle!.detritus[0] = 0.5;
      },
      (file: WorldFile) => {
        file.nutrientCycle!.budget!.after++;
      },
      (file: WorldFile) => {
        file.organisms[0].energy = 1001;
      },
      (file: WorldFile) => {
        file.food.push(positions(file.organisms[0])[0]);
      },
      (file: WorldFile) => {
        file.organisms[0].genome.lifeHistory!.maintenance = 3;
      },
      (file: WorldFile) => {
        file.lineageArchive.summaries[0].foundingGenome!.lifeHistory!.investment = 2;
      },
    ]) {
      const file = structuredClone(initial);
      mutate(file);
      expect(() => Ecosystem.load(JSON.stringify(file))).toThrow();
    }
    expect(() => Ecosystem.load(JSON.stringify({ ...initial, version: 17 }))).toThrow();
    const legacy = new Ecosystem(DEFAULTS, false, { nutrientCycle: true });
    legacy.spawn(founder(0), 60, 60);
    legacy.step();
    const { lifeHistoryLog: _log, ...native17 } = legacy.save();
    const valid = { ...native17, version: 17 };
    expect(Ecosystem.load(JSON.stringify(valid)).save().nutrientCycle).toEqual(valid.nutrientCycle);
    for (const invalid of [
      { ...valid, nutrientCycle: undefined },
      { ...valid, nutrientCycle: { ...valid.nutrientCycle, budget: null } },
      { ...valid, food: [...valid.food, positions(valid.organisms[0])[0]] },
      { ...valid, organisms: valid.organisms.map((o) => ({ ...o, energy: 1001 })) },
    ])
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow();
  });

  it('replays complete combined neural/life/nutrient checkpoints and keeps batch provenance strict', () => {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 5 }, false, {
      nutrientCycle: true,
    });
    const genome = founder(1);
    genome.controller = newController();
    genome.lifeHistory = defaultLifeHistory();
    const parent = world.spawn(genome, 60, 60)!;
    parent.energy = 100;
    parent.age = 32;
    const initial = JSON.stringify(world.save());
    const runner = createComparison(initial, {
      intervention: 'shade',
      treatmentTick: 0,
      horizonTick: 33,
    });
    while (runner.advance(() => 0).tick < 33) {}
    const result = runner.result();
    runner.dispose();
    for (const branch of [result.control, result.treatment]) check(Ecosystem.load(branch.state));
    expect(JSON.parse(result.recipe).rules).toEqual({
      id: 'evolab-drift-cellular',
      version: 10,
      worldVersion: 18,
    });
    const replay = createRecipeComparison(result.recipe);
    while (replay.advance(() => 0).tick < 33) {}
    expect(replay.result()).toEqual({ ...result, reproduced: true });
    replay.dispose();
    expect(JSON.stringify(world.save())).toBe(initial);
    const plan: BatchPlan = {
      seeds: [42],
      initialization: 'single-founder',
      settings: { mutation: 0.4, nutrients: 5, climate: DEFAULTS.climate },
      terrain: { version: 1, preset: 'open-field', seed: null },
      burnInTicks: 0,
      durationTicks: 33,
      treatmentDelay: 0,
      intervention: 'shade',
    };
    const batch = createBatch(plan);
    while (!batch.advance(() => 0).done) {}
    const recorded = batch.snapshot();
    batch.dispose();
    expect(recorded.runs[0].status).toBe('complete');
    const repeated = replayBatch(encodeBatch(recorded));
    while (!repeated.advance(() => 0).done) {}
    expect(repeated.snapshot().runs).toEqual(
      recorded.runs.map((run) => ({ ...run, reproduced: true })),
    );
    repeated.dispose();
    // An otherwise valid combined checkpoint cannot masquerade as seeded initialization.
    recorded.runs[0].recipe = JSON.parse(result.recipe);
    const forged = replayBatch(encodeBatch(recorded));
    while (!forged.advance(() => 0).done) {}
    expect(forged.snapshot().runs[0]).toMatchObject({
      status: 'failed',
      error: 'Seeded initialization differs from the recorded complete checkpoint.',
    });
    forged.dispose();
  });
});
