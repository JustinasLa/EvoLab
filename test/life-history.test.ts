import { createHash } from 'node:crypto';
import legacyOracle from './fixtures/life-history-legacy.json';
import { legacyV7 } from './fixtures/telemetry';
import { describe, expect, it } from 'vitest';
import { founder } from '../src/model';
import {
  defaultLifeHistory,
  lifeRules,
  sameLifeHistory,
  validLifeHistory,
} from '../src/life-history';

describe('bounded life-history contract', () => {
  it('preserves literal legacy costs and exposes paid tradeoffs', () => {
    const genome = founder(0),
      legacy = lifeRules(genome);
    expect([
      legacy.maturity,
      legacy.cadence,
      legacy.ageLimit,
      legacy.threshold,
      legacy.overhead,
      legacy.maintenance,
      legacy.grant(5),
    ]).toEqual([30, 11, 1275, 24, 2, 0, 10.5]);
    const early = lifeRules({
      ...genome,
      lifeHistory: { version: 1, maturity: 0, investment: 0, maintenance: 0 },
    });
    const late = lifeRules({
      ...genome,
      lifeHistory: { version: 1, maturity: 2, investment: 2, maintenance: 2 },
    });
    expect([early.maturity, early.overhead, early.grant(5), early.threshold]).toEqual([
      15, 4, 7, 13,
    ]);
    expect([late.maturity, late.overhead, late.grant(5), late.threshold]).toEqual([45, 2, 14, 19]);
    expect([late.cadence, late.ageLimit, late.maintenance]).toEqual([17, 1875, 0.04]);
  });
  it('requires a complete bounded opt-in and compares it by value', () => {
    const traits = defaultLifeHistory();
    expect(validLifeHistory(traits)).toBe(true);
    for (const value of [
      null,
      {},
      { ...traits, version: 2 },
      { ...traits, maturity: -1 },
      { ...traits, investment: 3 },
      { ...traits, maintenance: 0.5 },
      { ...traits, extra: 0 },
    ])
      expect(validLifeHistory(value)).toBe(false);
    expect(sameLifeHistory()).toBe(true);
    expect(sameLifeHistory(traits)).toBe(false);
    expect(sameLifeHistory(traits, { ...traits })).toBe(true);
    expect(sameLifeHistory(traits, { ...traits, maturity: 2 })).toBe(false);
  });
});

import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  LIMIT,
  Random,
  cloneGenome,
  observedGenome,
  positions,
  validGenome,
  type Genome,
} from '../src/model';
import { mutateLifeHistory, weightedMutation, MUTATION_CHANNELS } from '../src/mutation';
import { sameInherited } from '../src/lineage';
import { inheritedDifference, validBirthEvent, type BirthEvent } from '../src/mutation-evidence';
import {
  emptyLifeHistoryLog,
  recordLifeEvent,
  validateLifeHistoryLog,
  LIFE_TRAITS,
  type LifeHistory,
} from '../src/life-history';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { lifeDescription, lifeDiff, lifeInspection, lifeLogHtml } from '../src/life-history-view';

function body(traits: LifeHistory = defaultLifeHistory()): Genome {
  return { ...founder(0), cells: [{ x: 0, y: 0, type: 7 }], tolerance: 0.2, lifeHistory: traits };
}
function scene(traits = defaultLifeHistory(), seed = 7, mutation = 0) {
  const world = new Ecosystem({ ...DEFAULTS, seed, mutation, nutrients: 0, climate: 0 }, false);
  const parent = world.spawn(body(traits), 60, 60)!;
  const rules = lifeRules(parent.genome);
  parent.age = Math.ceil((rules.maturity + 1) / rules.cadence) * rules.cadence - 1;
  parent.energy = 100;
  world.random.state = seed;
  return { world, parent, rules };
}
const births = (world: Ecosystem) =>
  world.lineageSnapshot().events.filter((e): e is BirthEvent => e.kind === 'reproduction');

describe('real life-history ecology and observations', () => {
  it('pays actual parent costs exactly once for every bounded trait combination', () => {
    for (let maturity = 0; maturity <= 2; maturity++)
      for (let investment = 0; investment <= 2; investment++)
        for (let maintenance = 0; maintenance <= 2; maintenance++) {
          const { world, parent, rules } = scene({ version: 1, maturity, investment, maintenance });
          world.step();
          const event = births(world)[0],
            child = world.organisms.get(event.childOrganismId!)!;
          expect(parent.children).toBe(1);
          expect(child.energy).toBe(rules.grant(1));
          expect(parent.energy).toBeCloseTo(
            100 - 0.012 - rules.maintenance - child.energy - rules.overhead,
            12,
          );
          expect(event.payment).toEqual({
            parentAge: parent.age,
            parentPaid: 100 - 0.012 - rules.maintenance - parent.energy,
            offspringGranted: child.energy,
            overhead: rules.overhead,
          });
          expect(child.genome.lifeHistory).toEqual(parent.genome.lifeHistory);
          expect(child.genome.lifeHistory).not.toBe(parent.genome.lifeHistory);
          expect(world.telemetrySnapshot().pending.energy.reproductionSpent).toBe(
            event.payment!.parentPaid,
          );
          expect(world.telemetrySnapshot().pending.energy.offspringGranted).toBe(child.energy);
          expect(world.save().lifeHistoryLog.maintenanceSpent).toBeCloseTo(rules.maintenance, 12);
          expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
        }
  });
  it('enforces maturity, cadence and a conservative threshold before any mutation or retry', () => {
    for (const [age, energy] of [
      [30, 100],
      [33, 100],
      [32, 8.012],
    ]) {
      const { world, parent } = scene();
      parent.age = age;
      parent.energy = energy;
      const rng = world.random.state;
      world.step();
      expect(world.births).toBe(0);
      expect(births(world)).toEqual([]);
      expect(world.random.state).toBe(rng);
    }
    const { world, parent } = scene(
      { version: 1, maturity: 0, investment: 2, maintenance: 0 },
      7,
      0.4,
    );
    const policy = weightedMutation();
    for (const channel of MUTATION_CHANNELS) policy.weights[channel] = channel === 'add' ? 100 : 0;
    world.changeMutationPolicy(policy);
    parent.energy = lifeRules(parent.genome).threshold + 0.013;
    world.step();
    expect(parent.energy).toBeGreaterThan(1);
    expect(world.births).toBe(1);
    expect(births(world)[0].payment!.offspringGranted).toBe(
      lifeRules(parent.genome).grant(births(world)[0].childGenome!.cells.length),
    );
  });
  it('charges zero on three failed placements and consumes no attempt draws at the cap', () => {
    const { world, parent, rules } = scene();
    world.walls.fill(1);
    for (const cell of positions(parent)) world.walls[cell] = 0;
    const oracle = new Random(world.random.state);
    oracle.next(); // gate
    for (let attempt = 0; attempt < 3; attempt++) {
      oracle.int(4);
      oracle.int(5);
      oracle.int(4);
      oracle.int(4);
    }
    world.step();
    expect(world.random.state).toBe(oracle.state);
    expect(parent.energy).toBe(100 - 0.012 - rules.maintenance);
    expect(births(world)[0]).toMatchObject({
      placementAttempts: 3,
      outcome: 'failed-placement',
      payment: { parentPaid: 0, offspringGranted: 0, overhead: 0 },
    });
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    const capped = scene();
    for (let i = 0; i < LIMIT - 1; i++) capped.world.spawn(body(), i % 240, Math.floor(i / 240));
    const rng = capped.world.random.state;
    capped.world.step();
    expect(capped.world.organisms.size).toBe(LIMIT);
    expect(capped.world.random.state).toBe(rng);
    expect(births(capped.world)).toEqual([]);
  });
  it('charges longevity upkeep and records actual mature and terminal ages without inventing past milestones', () => {
    const { world, parent, rules } = scene({
      version: 1,
      maturity: 1,
      investment: 1,
      maintenance: 2,
    });
    parent.age = rules.maturity;
    world.step();
    expect(world.save().lifeHistoryLog.events[0]).toMatchObject({
      kind: 'mature',
      age: 31,
      organismId: parent.id,
    });
    parent.age = rules.ageLimit;
    parent.energy = 1;
    world.step();
    expect(world.organisms.has(parent.id)).toBe(false);
    expect(world.save().lifeHistoryLog.events.at(-1)).toMatchObject({
      kind: 'age',
      age: rules.ageLimit + 1,
    });
    const energy = scene();
    energy.parent.energy = 0.001;
    energy.parent.age = 100000;
    energy.world.step();
    expect(energy.world.save().lifeHistoryLog.events[0]).toMatchObject({
      kind: 'energy',
      age: 100001,
    });
    expect(Ecosystem.load(JSON.stringify(energy.world.save())).save()).toEqual(energy.world.save());
    const manual = scene();
    manual.world.kill(manual.parent, 'manual');
    expect(manual.world.save().lifeHistoryLog.events[0].kind).toBe('manual');
    const log = emptyLifeHistoryLog(0);
    for (let id = 1; id <= 130; id++) recordLifeEvent(log, { ...parent, id, age: 31 }, 1, 'mature');
    expect(log.eventsPruned).toBe(true);
    expect(log.events).toHaveLength(128);
    expect(log.events[0].organismId).toBe(3);
    expect(validateLifeHistoryLog(log, 1, 131, 10)).toEqual(log);
    const legacy = { ...parent, genome: founder(0) };
    recordLifeEvent(log, legacy, 1, 'manual');
    expect(log.events).toHaveLength(128);
  });
  it('mutates exactly one bounded trait with two seeded draws, preserving absence and detached inheritance', () => {
    const disabled = founder(0),
      rng = new Random(123),
      before = rng.state;
    expect(mutateLifeHistory(disabled, rng)).toBe(disabled);
    expect(rng.state).toBe(before);
    const observed = new Set<string>();
    let noop = false;
    for (let seed = 1; seed <= 90; seed++) {
      const source = body({ version: 1, maturity: 0, investment: 1, maintenance: 2 });
      const random = new Random(seed),
        oracle = new Random(seed),
        key = LIFE_TRAITS[oracle.int(3)],
        delta = oracle.int(2) === 0 ? -1 : 1;
      const channels: string[] = [],
        child = mutateLifeHistory(source, random, (c) => channels.push(c));
      expect(child.lifeHistory![key]).toBe(
        Math.max(0, Math.min(2, source.lifeHistory![key] + delta)),
      );
      expect(random.state).toBe(oracle.state);
      expect(channels).toEqual(['lifeHistory']);
      expect(child.lifeHistory).not.toBe(source.lifeHistory);
      expect(validGenome(child)).toBe(true);
      expect(sameInherited(source, child)).toBe(!inheritedDifference(source, child));
      observed.add(key);
      noop ||= sameInherited(source, child);
    }
    expect(observed.size).toBe(3);
    expect(noop).toBe(true);
    let changed = false;
    for (let seed = 1; seed <= 20; seed++) {
      const { world } = scene(defaultLifeHistory(), seed, 0.4);
      world.step();
      const event = births(world)[0];
      expect(event.channels.includes('lifeHistory')).toBe(event.gate);
      changed ||= event.outcome === 'born-changed';
      expect(validBirthEvent(event, world.save().nextSpecies, world.save().nextId)).toBe(true);
    }
    expect(changed).toBe(true);
  });
  it('compares real contrasting resource/climate consequences without prescribing a winner', () => {
    const outcomes: {
      maintenance: number;
      shade: boolean;
      climate: number;
      births: number;
      deaths: number;
      spent: number;
    }[] = [];
    for (const shade of [false, true])
      for (const climate of [0, 1])
        for (const maintenance of [0, 2]) {
          const world = new Ecosystem(
            { ...DEFAULTS, seed: 42, nutrients: 0, mutation: 0, climate },
            false,
          );
          const genome = founder(0);
          genome.lifeHistory = {
            version: 1,
            maturity: maintenance,
            investment: maintenance,
            maintenance,
          };
          world.spawn(genome, 60, 60);
          if (shade) {
            world.changeShadeMode(true);
            world.paintShade({ rulesVersion: 1, tool: 'shade', radius: 8, units: 16 }, 60, 60);
          }
          for (let tick = 0; tick < 240; tick++) world.step();
          outcomes.push({
            maintenance,
            shade,
            climate,
            births: world.births,
            deaths: world.deaths,
            spent: world.save().lifeHistoryLog.maintenanceSpent,
          });
          expect(world.births).toBe(births(world).filter((e) => e.childGenome).length);
          expect(
            world
              .telemetrySnapshot()
              .samples.reduce((sum, sample) => sum + sample.energy.reproductionSpent, 0),
          ).toBeCloseTo(
            births(world).reduce((sum, event) => sum + event.payment!.parentPaid, 0),
            8,
          );
        }
    expect(outcomes.filter((o) => o.maintenance === 0).every((o) => o.spent === 0)).toBe(true);
    expect(outcomes.filter((o) => o.maintenance === 2).every((o) => o.spent > 0)).toBe(true);
    expect(new Set(outcomes.map((o) => `${o.births}/${o.deaths}`)).size).toBeGreaterThan(1);
  });
});

describe('life-history schema and inspection', () => {
  it('restores complete state, observations and seeded future births with detached opted-in genomes', () => {
    const { world, parent } = scene(defaultLifeHistory(), 7, 0.4);
    parent.genome.legacyExtensions = [['lifeHistory', [['string', 'historical opaque name']]]];
    world.step();
    const saved = JSON.stringify(world.save()),
      loaded = Ecosystem.load(saved);
    expect(JSON.stringify(loaded.save())).toBe(saved);
    for (let tick = 0; tick < 80; tick++) {
      world.step();
      loaded.step();
    }
    expect(loaded.save()).toEqual(world.save());
    const blueprint = serializeBlueprint({ name: 'life', description: '', genome: parent.genome });
    expect(JSON.parse(blueprint).version).toBe(6);
    expect(parseBlueprint(blueprint).genome).toEqual(parent.genome);
    expect(cloneGenome(parent.genome).lifeHistory).not.toBe(parent.genome.lifeHistory);
    expect(observedGenome(parent.genome).lifeHistory).toEqual(parent.genome.lifeHistory);
    expect(observedGenome(parent.genome).legacyExtensions).toBeUndefined();
    const observed = world.presentation(parent.id, true);
    expect(observed.lifeHistory).toEqual(world.save().lifeHistoryLog);
    observed.lifeHistory!.maintenanceSpent++;
    expect(world.save().lifeHistoryLog.maintenanceSpent).toBe(0);
    expect(world.presentation(parent.id).lifeHistory).toBeUndefined();
  });
  it('rejects activation through predecessor envelopes, invalid living/extinct traits and forged payment evidence', () => {
    const { world, parent } = scene();
    world.step();
    const current = world.save();
    for (const version of [9, 10, 11, 12, 13, 14, 15, 16])
      expect(() => Ecosystem.load(JSON.stringify({ ...current, version }))).toThrow();
    const blueprint = JSON.parse(
      serializeBlueprint({ name: 'life', description: '', genome: parent.genome }),
    );
    for (const version of [2, 3, 4, 5])
      expect(() => parseBlueprint(JSON.stringify({ ...blueprint, version }))).toThrow();
    for (const value of [null, undefined, { ...defaultLifeHistory(), maturity: 3 }])
      expect(validGenome({ ...parent.genome, lifeHistory: value })).toBe(false);
    expect(validGenome(parent.genome, true, true, true, false)).toBe(false);
    const broken = structuredClone(current);
    broken.organisms[0].genome.lifeHistory!.maintenance = 3;
    expect(() => Ecosystem.load(JSON.stringify(broken))).toThrow('organism');
    world.kill(parent, 'manual');
    const extinct = world.save();
    extinct.lineageArchive.summaries[0].foundingGenome!.lifeHistory!.investment = -1;
    expect(() => Ecosystem.load(JSON.stringify(extinct))).toThrow('lineage archive');
    const mutations: ((event: any) => void)[] = [
      (e) => (e.payment = null),
      (e) => (e.payment.parentPaid = -1),
      (e) => (e.payment.parentAge = 31),
      (e) => (e.payment.offspringGranted = 100),
      (e) => (e.payment.overhead = 0),
      (e) => (e.payment.extra = 1),
      (e) => {
        e.gate = false;
        e.channels = ['lifeHistory'];
      },
      (e) => {
        e.gate = true;
        e.channels = ['lifeHistory'];
        delete e.parentGenome.lifeHistory;
      },
      (e) => {
        e.childGenome.lifeHistory.maturity = 2;
        e.channels = [];
      },
      (e) => {
        e.childGenome.lifeHistory.maturity = 0;
        e.childGenome.lifeHistory.maintenance = 2;
        e.gate = true;
        e.channels = ['lifeHistory'];
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(current);
      const event = candidate.lineageArchive.events.find((e) => e.kind === 'reproduction')!;
      mutate(event);
      expect(() => Ecosystem.load(JSON.stringify(candidate))).toThrow('lineage archive');
    }
    expect(current).toEqual(Ecosystem.load(JSON.stringify(current)).save());
  });
  it('validates bounded logs and shows legacy unknowns, exact rules, costs, mutation deltas and age outcomes', () => {
    const { world, parent } = scene();
    parent.age = 30;
    world.step();
    const log = world.save().lifeHistoryLog;
    expect(validateLifeHistoryLog(log, world.tick, 100, 100)).toEqual(log);
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    const forged = world.save();
    forged.lifeHistoryLog.events[0].kind = 'manual';
    expect(() => Ecosystem.load(JSON.stringify(forged))).toThrow('life-history identity');
    const inconsistent = structuredClone(log);
    inconsistent.events.push({ ...inconsistent.events[0], kind: 'manual', cells: 2 });
    expect(() => validateLifeHistoryLog(inconsistent, 1, 100, 100)).toThrow(
      'life-history identity',
    );

    for (const value of [
      null,
      { ...log, version: 2 },
      { ...log, maintenanceSpent: -1 },
      { ...log, maintenanceSpent: 1000 },
      { ...log, eventsPruned: true },
      { ...log, events: [{ ...log.events[0], age: 30 }] },
      { ...log, events: [{ ...log.events[0], kind: 'age', age: 31 }] },
      { ...log, events: [{ ...log.events[0], cells: 0 }] },
      { ...log, events: [log.events[0], log.events[0]] },
    ])
      expect(() => validateLifeHistoryLog(value, 1, 100, 100)).toThrow('life-history');
    const missing = world.save();
    delete (missing as any).lifeHistoryLog;
    expect(() => Ecosystem.load(JSON.stringify(missing))).toThrow('life-history');
    expect(lifeDescription(founder(0))).toContain('Legacy');
    expect(lifeDescription(parent.genome)).toContain('investment 1');
    expect(lifeInspection(parent)).toContain('mature');
    expect(lifeInspection({ ...parent, age: 0 })).toContain('immature');
    expect(
      lifeDiff(parent.genome, body({ version: 1, maturity: 2, investment: 0, maintenance: 2 })),
    ).toContain('maturity: 1');
    expect(lifeDiff(founder(0), parent.genome)).toContain('mode comparison');
    expect(lifeLogHtml()).toContain('Open the lineage explorer');
    expect(lifeLogHtml(log)).toContain('reached maturity');
    world.kill(parent, 'manual');
    expect(lifeLogHtml(world.save().lifeHistoryLog)).toContain('death (manual)');
    expect(lifeLogHtml({ ...log, eventsPruned: true })).toContain('older events pruned');
  });
  it('migrates world15 observations with explicit unknown provenance, retaining historic opaque lifeHistory names', () => {
    const legacy = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 }, false);
    const genome = body();
    delete genome.lifeHistory;
    genome.legacyExtensions = [['lifeHistory', [['string', 'opaque historical value']]]];
    const parent = legacy.spawn(genome, 60, 60)!;
    parent.age = 32;
    parent.energy = 100;
    legacy.step();
    const original = legacy.save();
    const old = structuredClone(original);
    for (const event of old.lineageArchive.events)
      if (event.kind === 'reproduction') delete event.payment;
    const loaded = Ecosystem.load(
      JSON.stringify({ ...old, version: 15, lifeHistoryLog: { ignored: 'old root extension' } }),
    );
    expect(loaded.save().lifeHistoryLog).toEqual(emptyLifeHistoryLog(1));
    expect(births(loaded)[0].payment).toBeUndefined();
    expect(loaded.organisms.get(parent.id)!.genome.lifeHistory).toBeUndefined();
    expect(loaded.organisms.get(parent.id)!.genome.legacyExtensions).toEqual(
      genome.legacyExtensions,
    );
    for (let tick = 0; tick < 120; tick++) {
      legacy.step();
      loaded.step();
    }
    const { lifeHistoryLog: leftLog, lineageArchive: leftArchive, ...left } = legacy.save();
    const { lifeHistoryLog: rightLog, lineageArchive: rightArchive, ...right } = loaded.save();
    expect(left).toEqual(right);
    expect(leftLog).toEqual(emptyLifeHistoryLog(0));
    expect(rightLog).toEqual(emptyLifeHistoryLog(1));
    expect(leftArchive.events.slice(2)).toEqual(rightArchive.events.slice(2));
  });
});

describe('legacy life-history continuation oracle', () => {
  it('matches six pre-change ecological trajectories, including global and inherited mutation gates', () => {
    for (const { seed, weighted, hash } of legacyOracle.outcomes) {
      const world = new Ecosystem(
        { ...DEFAULTS, seed, mutation: 0.4, nutrients: 5, climate: 0.8 },
        false,
      );
      if (weighted) world.changeMutationPolicy(weightedMutation());
      const genome = founder(0);
      if (weighted) genome.mutationPropensity = 0.7;
      const parent = world.spawn(genome, 120, 78)!;
      parent.age = 32;
      parent.energy = 80;
      for (let tick = 0; tick < 120; tick++) world.step();
      const {
        version: _version,
        lineageArchive: _archive,
        lifeHistoryLog: log,
        ...ecology
      } = world.save();
      expect(createHash('sha256').update(JSON.stringify(ecology)).digest('hex')).toBe(hash);
      expect(log).toEqual(emptyLifeHistoryLog(0));
    }
  });
  it('retains historical opaque lifeHistory names without interpreting them as an opt-in', () => {
    const world = new Ecosystem(DEFAULTS);
    const old = legacyV7(world.save());
    old.organisms[0].genome.lifeHistory = defaultLifeHistory();
    const loaded = Ecosystem.load(JSON.stringify(old));
    const genome = loaded.organisms.values().next().value!.genome;
    expect(genome.lifeHistory).toBeUndefined();
    expect(genome.legacyExtensions?.some(([key]) => key === 'lifeHistory')).toBe(true);
    const restored = Ecosystem.load(JSON.stringify(loaded.save()));
    loaded.step();
    restored.step();
    expect(restored.save()).toEqual(loaded.save());
  });
});
