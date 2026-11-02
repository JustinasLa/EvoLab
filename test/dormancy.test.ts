import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULT_DORMANCY, dormancyTick, emptyReserveFlow } from '../src/dormancy';
import {
  DEFAULTS,
  Random,
  cloneGenome,
  founder,
  index,
  mutate,
  observedOrganism,
  migrateHistoricalGenome,
  sameDormancy,
  validDormancy,
  validGenome,
  type CellType,
  type Genome,
} from '../src/model';
import { sameInherited } from '../src/lineage';
import { inheritedDifference } from '../src/mutation-evidence';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { organismHtml } from '../src/view';
import { serializeMeasurements } from '../src/measurement-export';
import { NEURAL_COST, newController } from '../src/neural';
import { EventRecorder } from '../src/event-journal';
import { startReplayWorker, type ReplayScope } from '../src/event-replay-worker';
import type { ReplayResponse } from '../src/event-model';

const advance = (world: Ecosystem, ticks: number) => {
  for (let tick = 0; tick < ticks; tick++) world.step();
};
function genome(enabled = true, type: CellType = 7): Genome {
  return {
    ...founder(0),
    cells: [{ x: 0, y: 0, type }],
    tolerance: 0.12,
    ...(enabled ? { dormancy: { ...DEFAULT_DORMANCY } } : {}),
  };
}
function fixture(enabled = true, type: CellType = 7) {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  const organism = world.spawn(genome(enabled, type), 60, 60)!;
  return { world, organism };
}

describe('bounded inherited dormancy', () => {
  it('validates all traits, canonical copying and order-independent comparisons', () => {
    expect(validDormancy(DEFAULT_DORMANCY)).toBe(true);
    expect(validDormancy({ ...DEFAULT_DORMANCY, wakeStress: 0.14 })).toBe(true);
    for (const patch of [
      { version: 2 },
      { capacity: 0 },
      { capacity: 65 },
      { capacity: Infinity },
      { enterStress: 0 },
      { wakeStress: 0.15 },
      { wakeStress: -1 },
      { enterEnergy: 17 },
      { wakeEnergy: 3 },
      { wakeEnergy: 65 },
      { extra: 1 },
    ])
      expect(validDormancy({ ...DEFAULT_DORMANCY, ...patch })).toBe(false);
    for (const value of [null, undefined, [], 'sleep']) expect(validDormancy(value)).toBe(false);
    const source = genome(),
      copy = cloneGenome(source);
    expect(copy).toEqual(source);
    expect(copy.dormancy).not.toBe(source.dormancy);
    expect(validGenome(source, true, true, true, false)).toBe(false);
    expect(validGenome({ ...source, dormancy: undefined })).toBe(false);
    copy.dormancy = Object.fromEntries(
      Object.entries(copy.dormancy!).reverse(),
    ) as typeof copy.dormancy;
    expect(sameInherited(source, copy)).toBe(true);
    expect(inheritedDifference(source, copy)).toBe(false);
    copy.dormancy!.capacity++;
    expect(sameInherited(source, copy)).toBe(false);
    expect(inheritedDifference(source, copy)).toBe(true);
    expect(sameDormancy(undefined, source.dormancy)).toBe(false);
    expect(sameDormancy(undefined, undefined)).toBe(true);
    expect(mutate(source, new Random(3)).dormancy).toEqual(source.dormancy);
  });

  it('accounts for lossy capped storage without inventing intake or double counting', () => {
    const { world, organism } = fixture();
    organism.energy = 60;
    organism.genome.dormancy!.capacity = 1;
    const total = organism.energy;
    advance(world, 10);
    const flow = world.telemetry.pending.reserves!;
    expect(organism.reserves!.stored).toBe(1);
    expect(flow.deposited).toBe(1);
    expect(flow.conversionSpent).toBeCloseTo(0.25);
    expect(flow.maintenanceSpent).toBeGreaterThan(0);
    expect(total - organism.energy - organism.reserves!.stored).toBeCloseTo(
      flow.conversionSpent + flow.maintenanceSpent + world.telemetry.pending.energy.upkeepSpent,
    );
    expect(world.telemetry.pending.energy.leavesGained).toBe(0);
    expect(world.telemetry.pending.energy.mouthsGained).toBe(0);
    const frame = observedOrganism(organism);
    frame.reserves!.stored = 0;
    expect(organism.reserves!.stored).toBe(1);
    expect(organismHtml(organism, world.presentation())).toContain('Dormancy: Active');
    const noRecording = new Ecosystem(DEFAULTS, false, { telemetry: false });
    noRecording.spawn(genome(), 60, 60);
    noRecording.step();
    expect(noRecording.telemetry.pending.reserves).toBeUndefined();
  });

  it('keeps sub-precision storage conservative and every resulting save reloadable', () => {
    for (const stored of [16, 32, 48, 63])
      for (let offset = 1; offset < 40; offset++) {
        const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
        const design = genome();
        design.dormancy!.capacity = 64;
        const organism = world.spawn(design, 60, 60)!;
        organism.reserves!.stored = stored;
        organism.energy = 10 + 0.001 + stored * 0.0005 + offset * Number.EPSILON;
        world.step();
        const flow = world.telemetry.pending.reserves!;
        expect(flow.conversionSpent).toBeGreaterThanOrEqual(0);
        expect(organism.reserves!.stored).toBeLessThanOrEqual(64);
        expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
        if (stored === 32 && offset === 21) {
          expect(organism.reserves!.stored).toBe(32);
          expect(flow.deposited).toBe(0);
        }
      }
  });

  it('pays entry and exit, funds upkeep, and resumes only after a paid successful wake', () => {
    const { world, organism } = fixture();
    organism.energy = 2;
    organism.reserves!.stored = 20;
    world.shock('heat');
    world.eventUntil = 3;
    world.step();
    expect(organism.reserves!.dormant).toBe(true);
    expect(world.telemetry.pending.reserves!.entrySpent).toBe(0.2);
    world.step();
    expect(world.telemetry.pending.reserves!.entrySpent).toBe(0.2);
    world.step();
    expect(organism.reserves!.dormant).toBe(false);
    expect(world.telemetry.pending.reserves!.exitSpent).toBe(0.3);
    expect(world.telemetry.pending.reserves!.withdrawn).toBeGreaterThan(8);
    expect(organism.energy).toBeGreaterThan(9);
    const flows = world.telemetry.pending.reserves!;
    expect(22 - organism.energy - organism.reserves!.stored).toBeCloseTo(
      flows.entrySpent +
        flows.exitSpent +
        flows.maintenanceSpent +
        flows.conversionSpent +
        world.telemetry.pending.energy.upkeepSpent,
    );
    expect(organismHtml(organism, world.presentation())).toContain('reserves');
  });

  it('cannot wake from adjacent food alone; starves with empty reserves and never rescues extinction', () => {
    const { world, organism } = fixture(true, 3);
    organism.energy = 1;
    organism.reserves!.stored = 0.5;
    world.food[index(61, 60)] = 1;
    advance(world, 10);
    expect(organism.reserves!.dormant).toBe(true);
    expect(world.food[index(61, 60)]).toBe(1);
    expect(world.telemetry.pending.reserves!.withdrawn).toBeGreaterThan(0);
    expect(world.telemetry.pending.energy.mouthsGained).toBe(0);
    expect(organismHtml(organism, world.presentation())).toContain('Dormancy: Dormant');
    advance(world, 1000);
    expect(world.organisms.size).toBe(0);
    expect(world.deaths).toBe(1);
    advance(world, 100);
    expect(world.organisms.size).toBe(0);
    const poor = fixture();
    poor.organism.energy = 0.1;
    poor.world.step();
    expect(poor.organism.reserves!.dormant).toBe(false);
    expect(poor.world.telemetry.pending.reserves!.entrySpent).toBe(0);
  });

  it('suppresses all active actions but keeps normal aging, armor and predation vulnerability', () => {
    const { world, organism } = fixture(true, 3);
    organism.genome.cells.push(
      { x: -1, y: 0, type: 4 },
      { x: 0, y: -1, type: 5 },
      { x: 0, y: 1, type: 6 },
    );
    organism.energy = 50;
    organism.age = 32;
    organism.reserves!.dormant = true;
    world.shock('heat');
    world.eventUntil = 500;
    world.food[index(61, 60)] = 1;
    const attacker = world.spawn(genome(false, 6), 61, 60)!;
    attacker.age = 3;
    const random = world.random.state;
    world.step();
    expect(world.random.state).toBe(random);
    expect(organism.age).toBe(33);
    expect([organism.x, organism.y, organism.children]).toEqual([60, 60, 0]);
    expect(world.telemetry.pending.energy.leavesGained).toBe(0);
    expect(world.telemetry.pending.energy.mouthsGained).toBe(0);
    expect(world.telemetry.pending.energy.movementSpent).toBe(0);
    expect(world.telemetry.pending.energy.stingsDrained).toBe(2.5);
    organism.age = 900 + organism.genome.cells.length * 75;
    world.step();
    expect(world.organisms.has(organism.id)).toBe(false);
    const armored = fixture();
    armored.organism.reserves!.dormant = true;
    armored.world.shock('heat');
    armored.world.eventUntil = 100;
    armored.world.spawn(genome(false, 6), 61, 60)!.age = 3;
    armored.world.step();
    expect(armored.world.telemetry.pending.energy.stingsDrained).toBe(0);
  });

  it('inherits only traits and spends parent energy on fresh active, empty-reserve offspring', () => {
    const { world, organism } = fixture();
    organism.energy = 50;
    organism.age = 32;
    organism.reserves!.stored = 4;
    world.step();
    const child = [...world.organisms.values()].find((value) => value.generation === 1)!;
    expect(child).toBeDefined();
    expect(child.genome.dormancy).toEqual(organism.genome.dormancy);
    expect(child.genome.dormancy).not.toBe(organism.genome.dormancy);
    expect(child.reserves).toEqual({ stored: 0, dormant: false });
    expect(world.telemetry.pending.energy.reproductionSpent).toBe(child.energy + 2);
    expect(world.telemetry.pending.energy.offspringGranted).toBe(child.energy);
    const file = world.save();
    expect(Ecosystem.load(JSON.stringify(file)).save()).toEqual(file);
    const reproduction = file.lineageArchive.events.find((event) => event.kind === 'reproduction')!;
    if (reproduction.kind !== 'reproduction') throw new Error('Missing birth');
    reproduction.childGenome!.dormancy!.capacity++;
    expect(() => Ecosystem.load(JSON.stringify(file))).toThrow('lineage');
  });

  it('records discarded reserves on death and preserves inert historical organism extensions', () => {
    const historical = migrateHistoricalGenome({
      cells: [{ x: 0, y: 0, type: 7 }],
      preference: 0.5,
      tolerance: 0.3,
      tempo: 5,
      dormancy: { ...DEFAULT_DORMANCY },
    });
    expect(historical.dormancy).toBeUndefined();
    expect(historical.legacyExtensions![0][0]).toBe('dormancy');
    const { world, organism } = fixture();
    organism.reserves!.stored = 7;
    world.kill(organism, 'manual');
    expect(world.telemetry.pending.reserves!.discarded).toBe(7);
    expect(world.organisms.size).toBe(0);
    const old = fixture(false).world.save();
    (old.organisms[0] as unknown as Record<string, unknown>).reserves = {
      stored: 'opaque legacy data',
      dormant: true,
    };
    const restored = Ecosystem.load(JSON.stringify({ ...old, version: 16 }));
    expect(Ecosystem.load(JSON.stringify(restored.save())).save()).toEqual(restored.save());
    expect(observedOrganism(restored.organisms.values().next().value!)).not.toHaveProperty(
      'reserves',
    );
    restored.step();
    expect(restored.telemetry.pending.reserves).toBeUndefined();
    const invalid = fixture().world.save();
    delete invalid.organisms[0].genome.dormancy;
    expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('lineage');
  });

  it('enforces predecessor envelopes in extinct archives and birth projections', () => {
    const { world, organism } = fixture();
    organism.energy = 40;
    organism.age = 32;
    world.step();
    const born = world.save();
    for (const version of [14, 15, 16]) {
      const invalid = structuredClone(born);
      for (const living of invalid.organisms) delete living.genome.dormancy;
      delete invalid.telemetry.pending.reserves;
      expect(() => Ecosystem.load(JSON.stringify({ ...invalid, version }))).toThrow('lineage');
    }
    const extinct = fixture();
    extinct.world.kill(extinct.organism, 'manual');
    const archive = extinct.world.save();
    archive.lineageArchive.summaries[0].foundingGenome!.dormancy!.capacity = 65;
    expect(() => Ecosystem.load(JSON.stringify(archive))).toThrow('lineage');
  });

  it('preserves neural world16 and blueprint5 without activating dormancy', () => {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 }, false);
    const design = genome(false, 5);
    design.controller = newController();
    design.controller.biases[5] = 1;
    const organism = world.spawn(design, 60, 60)!;
    organism.energy = 100;
    organism.age = 32;
    organism.neuralBlocked = true;
    const saved = world.save();
    const prior = { ...saved, version: 16 };
    const migrated = Ecosystem.load(JSON.stringify(prior));
    const current = Ecosystem.load(JSON.stringify(saved));
    expect(migrated.save()).toEqual(saved);
    advance(migrated, 60);
    advance(current, 60);
    expect(migrated.save()).toEqual(current.save());
    expect(migrated.births).toBeGreaterThan(0);
    expect(migrated.telemetry.pending.reserves).toBeUndefined();
    for (const living of migrated.organisms.values()) {
      expect(living.genome.dormancy).toBeUndefined();
      expect(living.reserves).toBeUndefined();
      expect(typeof living.neuralBlocked).toBe('boolean');
    }
    const invalid = structuredClone(prior);
    delete invalid.organisms[0].neuralBlocked;
    expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('organism');
    const blueprint = JSON.parse(
      serializeBlueprint({ name: 'Neural', description: '', genome: design }),
    );
    expect(blueprint.version).toBe(6);
    expect(parseBlueprint(JSON.stringify({ ...blueprint, version: 5 })).genome).toEqual(design);
  });

  it('suspends neural actions during dormancy and preserves paid waking and joint inheritance', () => {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
    const design = genome(true, 5);
    design.tempo = 2;
    design.controller = newController();
    design.controller.biases[5] = 1;
    const organism = world.spawn(design, 60, 60)!;
    organism.energy = 20;
    organism.reserves!.stored = 12;
    organism.neuralBlocked = true;
    world.shock('heat');
    world.eventUntil = 3;
    const random = world.random.state;
    advance(world, 2);
    expect(organism.reserves!.dormant).toBe(true);
    expect(organism.neuralBlocked).toBe(true);
    expect([organism.x, organism.y]).toEqual([60, 60]);
    expect(world.random.state).toBe(random);
    expect(world.telemetry.pending.energy.movementSpent).toBe(0);
    const restored = Ecosystem.load(JSON.stringify(world.save()));
    world.step();
    restored.step();
    expect(restored.save()).toEqual(world.save());
    expect(organism.reserves!.dormant).toBe(false);
    expect(world.telemetry.pending.reserves!.exitSpent).toBe(0.3);
    const upkeep = world.telemetry.pending.energy.upkeepSpent;
    world.step();
    restored.step();
    expect(restored.save()).toEqual(world.save());
    expect(organism.neuralBlocked).toBe(false);
    expect([organism.x, organism.y]).not.toEqual([60, 60]);
    expect(world.telemetry.pending.energy.upkeepSpent - upkeep).toBeCloseTo(0.012 + NEURAL_COST);
    expect(world.telemetry.pending.energy.movementSpent).toBeCloseTo(0.03);
    organism.energy = 100;
    organism.age = 32;
    world.step();
    const child = [...world.organisms.values()].find((living) => living.generation === 1)!;
    expect(child.genome.controller).toEqual(design.controller);
    expect(child.genome.controller).not.toBe(organism.genome.controller);
    expect(child.genome.dormancy).toEqual(design.dormancy);
    expect(child.genome.dormancy).not.toBe(organism.genome.dormancy);
    expect(child.neuralBlocked).toBe(false);
    expect(child.reserves).toEqual({ stored: 0, dormant: false });
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
  });

  it('replays complete journal checkpoints containing neural dormancy and reserve loss on age death', () => {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
    const design = genome();
    design.controller = newController();
    const organism = world.spawn(design, 60, 60)!;
    organism.energy = 20;
    organism.age = 974;
    organism.neuralBlocked = true;
    organism.reserves = { stored: 12, dormant: true };
    world.shock('heat');
    const recorder = new EventRecorder(world);
    for (let tick = 0; tick < 2; tick++) {
      world.step();
      recorder.observe(world);
    }
    const event = recorder.snapshot().events.at(-1)!;
    expect(event.kind).toBe('lineage-extinction');
    const evidence = recorder.replay(event.id);
    expect(evidence.worldVersion).toBe(17);
    expect(world.telemetry.pending.reserves!.discarded).toBeGreaterThan(0);
    const tasks: (() => void)[] = [];
    const messages: ReplayResponse[] = [];
    const scope: ReplayScope = {
      onmessage: null,
      postMessage: (message) => messages.push(message),
    };
    startReplayWorker(
      scope,
      (callback) => tasks.push(callback),
      () => {},
      () => 0,
    );
    scope.onmessage!({ data: { type: 'start', evidence, tick: event.tick } } as MessageEvent);
    while (tasks.length) tasks.shift()!();
    expect(messages.at(-1)).toMatchObject({
      type: 'complete',
      verified: true,
      population: 0,
      tick: 2,
    });
  });

  it('roundtrips exact living state and separate flows, rejects invalid whole candidates and legacy activation', () => {
    const { world, organism } = fixture();
    organism.reserves!.stored = 12.3456;
    world.eventOffset = -0.32;
    world.eventUntil = 100;
    advance(world, 31);
    const file = world.save();
    const csv = serializeMeasurements(world.measurements(), 'csv').text;
    expect(csv).toContain('reserves.deposited');
    expect(csv).toContain(String(file.telemetry.samples[0].reserves!.maintenanceSpent));
    const restored = Ecosystem.load(JSON.stringify(file));
    expect(restored.save()).toEqual(file);
    advance(world, 150);
    advance(restored, 150);
    expect(restored.save()).toEqual(world.save());
    for (const reserves of [
      undefined,
      null,
      { stored: -1, dormant: true },
      { stored: 65, dormant: false },
      { stored: 0, dormant: 1 },
      { stored: 1, dormant: true, extra: 0 },
    ]) {
      const invalid = structuredClone(file);
      invalid.organisms[0].reserves = reserves as never;
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('reserves');
    }
    for (const field of Object.keys(emptyReserveFlow())) {
      const invalid = structuredClone(file);
      (invalid.telemetry.pending.reserves as unknown as Record<string, number>)[field] = -1;
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
    }
    const badSample = structuredClone(file);
    badSample.telemetry.samples[0].reserves = {} as never;
    expect(() => Ecosystem.load(JSON.stringify(badSample))).toThrow('telemetry');
    expect(() => Ecosystem.load(JSON.stringify({ ...file, version: 15 }))).toThrow();
    const old = fixture(false).world.save();
    const legacy = Ecosystem.load(JSON.stringify({ ...old, version: 15 }));
    const current = Ecosystem.load(JSON.stringify(old));
    advance(legacy, 50);
    advance(current, 50);
    expect(legacy.save()).toEqual(current.save());
    expect(current.telemetry.pending.reserves).toBeUndefined();
    expect(
      dormancyTick(current.organisms.values().next().value!, 1, () => {
        throw new Error('Legacy flow');
      }),
    ).toBe(false);
    const blueprint = serializeBlueprint({ name: 'Sleeper', description: '', genome: genome() });
    expect(parseBlueprint(blueprint).genome).toEqual(genome());
    expect(() =>
      parseBlueprint(JSON.stringify({ ...JSON.parse(blueprint), version: 5 })),
    ).toThrow();
  });

  it.each([0.32, -0.32])(
    'measures heatwave/cold-snap survival benefit and lack of free energy (%s)',
    (offset) => {
      const sleeper = fixture(),
        active = fixture(false);
      for (const { world } of [sleeper, active]) {
        world.eventOffset = offset;
        world.eventUntil = 500;
        advance(world, 220);
      }
      expect(active.world.organisms.size).toBe(0);
      expect(sleeper.world.organisms.size).toBe(1);
      expect(sleeper.organism.energy).toBeLessThan(9);
      expect(sleeper.world.births).toBe(0);
    },
  );

  it('measures seasonal switching and the opportunity cost in a productive habitat', () => {
    const sleepy = fixture(true, 4),
      active = fixture(false, 4);
    sleepy.organism.genome.dormancy!.enterStress = 0.01;
    sleepy.organism.genome.dormancy!.wakeStress = 0;
    for (const { world, organism } of [sleepy, active]) {
      world.settings.climate = 1;
      organism.genome.preference = 0.56;
      organism.genome.tolerance = 0.12;
      organism.energy = 9;
    }
    let sleeping = 0,
      awake = 0;
    for (let tick = 0; tick < 800; tick++) {
      sleepy.world.step();
      active.world.step();
      if (sleepy.world.organisms.has(sleepy.organism.id)) {
        if (sleepy.organism.reserves!.dormant) sleeping++;
        else awake++;
      }
    }
    expect(sleeping).toBeGreaterThan(0);
    expect(awake).toBeGreaterThan(0);
    const totals = (world: Ecosystem) =>
      [...world.telemetry.samples, world.telemetry.pending].reduce(
        (sum, sample) => sum + sample.energy.leavesGained,
        0,
      );
    expect(totals(active.world)).toBeGreaterThan(totals(sleepy.world));
  });
});
