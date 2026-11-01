import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, LIMIT, positions, type Genome } from '../src/model';
import { MUTATION_CHANNELS, weightedMutation, type MutationChannel } from '../src/mutation';
import {
  birthOutcome,
  inheritedDifference,
  retainedBirthExport,
  type BirthEvent,
} from '../src/mutation-evidence';
import { historicalArchive } from './fixtures/telemetry';

const genome = (propensity?: number): Genome => ({
  cells: [
    { x: 0, y: 0, type: 7 },
    { x: 1, y: 0, type: 7 },
    { x: 2, y: 0, type: 7 },
  ],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 5,
  behavior: {
    version: 2,
    mode: 'evolved',
    reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
  },
  ...(propensity === undefined ? {} : { mutationPropensity: propensity }),
});
function scene(
  seed: number,
  channel?: MutationChannel | 'none',
  propensity?: number,
  recording = true,
  rate = 0.4,
) {
  const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: rate }, false, {
    lineage: recording,
  });
  if (channel) {
    const policy = weightedMutation();
    for (const key of MUTATION_CHANNELS) policy.weights[key] = key === channel ? 1 : 0;
    world.changeMutationPolicy(policy);
  }
  const parent = world.spawn(genome(propensity), 60, 60)!;
  parent.age = 32;
  parent.energy = 100;
  world.random.state = seed;
  return { world, parent };
}
function events(world: Ecosystem) {
  return world
    .lineageSnapshot()
    .events.filter((event): event is BirthEvent => event.kind === 'reproduction');
}
describe('retained actual reproductive evidence', () => {
  it.each(MUTATION_CHANNELS)(
    'records real funded births and exact %s channel outcomes',
    (channel) => {
      let changed = 0;
      for (let i = 1; i <= 50; i++) {
        const { world, parent } = scene((i * 2654435761) >>> 0, channel);
        world.step();
        const event = events(world)[0];
        expect(event.childOrganismId).not.toBeNull();
        const child = world.organisms.get(event.childOrganismId!)!;
        expect(event.parentGenome).toEqual(parent.genome);
        expect(event.childGenome).toEqual(child.genome);
        expect(parent.children).toBe(1);
        expect(world.births).toBe(1);
        expect(world.telemetrySnapshot().pending.energy.reproductionSpent).toBe(child.energy + 2);
        expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
        if (event.gate) {
          expect(event.channels).toEqual([channel]);
          if (event.outcome === 'born-changed') changed++;
        } else expect(event.outcome).toBe('born-clone');
      }
      expect(changed).toBeGreaterThan(0);
    },
  );
  it('distinguishes all-off no-ops, clones, clamped attempts and actual independent self changes', () => {
    let noops = 0,
      self = 0;
    for (let i = 1; i <= 240; i++) {
      const { world, parent } = scene((i * 2654435761) >>> 0, 'none', 0);
      world.step();
      const event = events(world)[0];
      if (event.channels.includes('propensity')) {
        if (event.outcome === 'born-changed') {
          self++;
          expect(event.childLineageId).toBeGreaterThan(parent.species);
        } else {
          noops++;
          expect(event.outcome).toBe('born-no-op');
        }
      } else expect(event.outcome).toBe('born-clone');
    }
    expect(self).toBeGreaterThan(0);
    expect(noops).toBeGreaterThan(0);
    for (let i = 1; i <= 30; i++) {
      const { world } = scene((i * 2654435761) >>> 0, 'none');
      world.step();
      const event = events(world)[0];
      expect(event.outcome).toBe(event.gate ? 'born-no-op' : 'born-clone');
      expect(event.childLineageId).toBe(event.id);
    }
  });
  it('preserves legacy new-lineage identity even when an actual mutation is a no-op', () => {
    let found = false;
    for (let i = 1; i <= 800 && !found; i++) {
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0.4, climate: 0, nutrients: 0 }, false);
      const g = genome();
      g.preference = 0;
      g.tolerance = 0.12;
      g.tempo = 2;
      g.behavior = {
        version: 1,
        mode: 'evolved',
        reactions: { food: 'flee', wall: 'ignore', harmless: 'chase', dangerous: 'ignore' },
      };
      const parent = world.spawn(g, 60, 60)!;
      parent.age = 32;
      parent.energy = 100;
      world.random.state = (i * 2654435761) >>> 0;
      world.step();
      const event = events(world)[0];
      if (event.outcome === 'born-no-op') {
        found = true;
        expect(event.childLineageId).toBeGreaterThan(parent.species);
        expect(event.childGenome).toEqual(event.parentGenome);
        expect(event.channels).not.toContain('reactions');
        expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
      }
    }
    expect(found).toBe(true);
  });
  it('records failed placement without candidate inheritance or parent payment, and no attempt at population cap', () => {
    const { world, parent } = scene(7);
    world.walls.fill(1);
    for (const index of positions(parent)) world.walls[index] = 0;
    world.step();
    expect(events(world)[0]).toMatchObject({
      outcome: 'failed-placement',
      placementAttempts: 3,
      childGenome: null,
      childLineageId: null,
      childOrganismId: null,
    });
    expect(parent.children).toBe(0);
    expect(world.births).toBe(0);
    expect(world.telemetrySnapshot().pending.energy.reproductionSpent).toBe(0);
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    const duplicate = world.save();
    duplicate.lineageArchive.events.push(structuredClone(events(world)[0]));
    expect(() => Ecosystem.load(JSON.stringify(duplicate))).toThrow('lineage archive');
    const capped = scene(7, undefined, undefined, true, 0);
    const single = genome();
    single.cells = [{ x: 0, y: 0, type: 7 }];
    for (let i = 0; i < LIMIT - 1; i++)
      expect(capped.world.spawn(single, i % 240, Math.floor(i / 240))).toBeDefined();
    capped.world.step();
    expect(events(capped.world)).toEqual([]);
    expect(capped.parent.children).toBe(0);
  });
  it('observes without ecological RNG/state changes and retains detached curated pairs only', () => {
    for (const channel of [undefined, 'none', ...MUTATION_CHANNELS] as const) {
      const observed = scene(92321, channel, 0.5),
        silent = scene(92321, channel, 0.5, false);
      for (let i = 0; i < 65; i++) {
        observed.world.step();
        silent.world.step();
        const { lineageArchive: _a, ...left } = observed.world.save(),
          { lineageArchive: _b, ...right } = silent.world.save();
        expect(left).toEqual(right);
      }
      const archive = observed.world.lineageSnapshot();
      const pair = archive.events.find((event) => event.kind === 'reproduction') as BirthEvent;
      pair.parentGenome.cells[0].type = 3;
      expect(events(observed.world)[0].parentGenome.cells[0].type).toBe(7);
    }
  });
  it('uses the shared512 ring, discloses eviction and never reconstructs legacy events', () => {
    const { world, parent } = scene(42, undefined, undefined, true, 0);
    for (let i = 0; i < 520; i++) {
      parent.age = 32;
      parent.energy = 100;
      world.step();
      for (const o of [...world.organisms.values()]) if (o !== parent) world.kill(o, 'manual');
    }
    const archive = world.lineageSnapshot(),
      exported = retainedBirthExport(archive, world.tick);
    expect(archive.events).toHaveLength(512);
    expect(archive.eventsPruned).toBe(true);
    expect(exported.events).toHaveLength(512);
    expect(exported.window).toMatchObject({
      eventsPruned: true,
      evictedThroughTick: 8,
      recordingOriginTick: 0,
    });
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    const predecessor = scene(7, undefined, undefined, true, 0).world;
    predecessor.step();
    const old = predecessor.save();
    old.lineageArchive = historicalArchive(old.lineageArchive);
    const loaded = Ecosystem.load(JSON.stringify({ ...old, version: 14 }));
    expect(events(loaded)).toEqual([]);
    expect(loaded.lineageSnapshot().mutationOriginTick).toBe(1);
    expect(retainedBirthExport(loaded.lineageSnapshot(), 1).events).toEqual([]);
    expect(() => Ecosystem.load(JSON.stringify({ ...world.save(), version: 14 }))).toThrow(
      'lineage archive',
    );
  });
  it('round-trips signed-zero parents without changing existing lineage semantics', () => {
    let observed = false;
    for (let i = 1; i <= 200 && !observed; i++) {
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
      const g = genome(-0);
      g.preference = -0;
      const parent = world.spawn(g, 60, 60)!;
      parent.age = 32;
      parent.energy = 100;
      world.random.state = (i * 2654435761) >>> 0;
      world.step();
      const event = events(world)[0];
      if (
        event.channels.includes('propensity') &&
        Object.is(event.childGenome!.mutationPropensity, 0)
      ) {
        observed = true;
        expect(event.childLineageId).toBeGreaterThan(parent.species);
        expect(event.outcome).toBe('born-no-op');
        const text = JSON.stringify(world.save());
        expect(JSON.stringify(Ecosystem.load(text).save())).toBe(text);
      }
    }
    expect(observed).toBe(true);
  });
  it('rejects malformed retained observations before any active world replacement', () => {
    const { world } = scene(7);
    world.step();
    const before = world.save();
    const mutations: ((event: any) => void)[] = [
      (e) => delete e.gate,
      (e) => (e.extra = true),
      (e) => (e.id = 0),
      (e) => (e.tick = 2),
      (e) => (e.parentOrganismId = 0),
      (e) => (e.parentGenome.extra = 1),
      (e) => (e.parentGenome.cells[0].extra = 1),
      (e) => (e.parentGenome = null),
      (e) => (e.gate = 'true'),
      (e) => (e.channels = null),
      (e) => {
        e.gate = false;
        e.channels = ['add'];
      },
      (e) => {
        e.gate = false;
        e.channels = ['propensity'];
      },
      (e) => (e.channels = ['bad']),
      (e) => (e.channels = ['add', 'add']),
      (e) => (e.placementAttempts = 0),
      (e) => (e.childOrganismId = 0),
      (e) => (e.childLineageId = 0),
      (e) => (e.childGenome = null),
      (e) => (e.outcome = 'failed-placement'),
      (e) => (e.childGenome.cells = []),
    ];
    for (const change of mutations) {
      const invalid = structuredClone(before),
        event = invalid.lineageArchive.events.find((e) => e.kind === 'reproduction')!;
      change(event);
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow();
      expect(world.save()).toEqual(before);
    }
    for (const mutate of [
      (file: typeof before) =>
        file.lineageArchive.events.push(structuredClone(file.lineageArchive.events.at(-1)!)),
      (file: typeof before) => (file.lineageArchive.mutationOriginTick = file.tick + 1),
    ]) {
      const invalid = structuredClone(before);
      mutate(invalid);
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('lineage archive');
    }
    const p = genome();
    const c = structuredClone(p);
    c.cells[0].type = 3;
    expect(inheritedDifference(p, c)).toBe(true);
    expect(birthOutcome(p, null, true)).toBe('failed-placement');
  });
});
