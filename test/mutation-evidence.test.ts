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
    const old = world.save();
    old.lineageArchive = historicalArchive(old.lineageArchive);
    const loaded = Ecosystem.load(JSON.stringify({ ...old, version: 14 }));
    expect(events(loaded)).toEqual([]);
    expect(loaded.lineageSnapshot().mutationOriginTick).toBe(520);
    expect(retainedBirthExport(loaded.lineageSnapshot(), 520).events).toEqual([]);
    expect(() => Ecosystem.load(JSON.stringify({ ...world.save(), version: 14 }))).toThrow(
      'lineage archive',
    );
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
    const p = genome();
    const c = structuredClone(p);
    c.cells[0].type = 3;
    expect(inheritedDifference(p, c)).toBe(true);
    expect(birthOutcome(p, null, true)).toBe('failed-placement');
  });
});
