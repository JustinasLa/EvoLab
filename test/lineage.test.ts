import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, LIMIT, Random, WIDTH, type Genome, type WorldFile } from '../src/model';
import { advance, legacyV3, legacyV4, legacyV5 } from './fixtures/telemetry';

const genome = (): Genome => ({
  cells: [{ x: 0, y: 0, type: 7 }],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 2,
});
const empty = () => new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
const reload = (world: Ecosystem) => Ecosystem.load(JSON.stringify(world.save()));
const beforeArchive = ({ lineageArchive: _archive, ...saved }: WorldFile) => saved;

describe('bounded observed lineage lifecycle', () => {
  it('records the genuine founder and detached ordered founding fields without extensions', () => {
    const world = new Ecosystem();
    const saved = world.save();
    expect(saved.version).toBe(6);
    expect(saved.nextSpecies).toBe(5);
    expect(saved.lineageArchive).toMatchObject({
      version: 1,
      originKind: 'fresh',
      originTick: 0,
      summariesPruned: false,
      eventsPruned: false,
      eventsEvictedThroughTick: null,
      living: [
        {
          id: 1,
          origin: 'founder',
          createdTick: 0,
          parentId: null,
          liveCount: 1,
          peakCount: 1,
          peakKind: 'lifetime',
          extinctTick: null,
        },
      ],
      events: [{ kind: 'created', id: 1, tick: 0, origin: 'founder', parentId: null }],
    });
    expect(saved.lineageArchive.summaries[0].foundingGenome).toEqual(saved.organisms[0].genome);
    const copy = world.lineageSnapshot();
    copy.living[0].peakCount = 99;
    copy.summaries[0].foundingGenome!.cells[0].type = 8;
    copy.events[0].tick = 9;
    saved.organisms[0].genome.preference = 0;
    expect(world.save()).toEqual(reload(world).save());
    expect(world.lineageSnapshot()).not.toEqual(copy);
  });

  it('implements the complete public caller matrix before direction draws or insertion', () => {
    const world = empty();
    const original = world.save();
    for (const id of [1, 2, 3, 4, 5, 100]) {
      expect(world.spawn(genome(), 1, 1, id)).toBeUndefined();
      expect(world.save()).toEqual(original);
    }
    const parent = world.spawn(genome(), 10, 10, undefined, undefined, 2)!;
    expect(parent.rotation).toBe(2);
    const clone = world.spawn(genome(), 20, 20, parent.species, parent)!;
    expect(clone.generation).toBe(1);
    expect(clone.ancestry).toEqual([]);
    expect(world.spawn(genome(), 30, 30, parent.species)).toBeDefined();
    expect(world.lineageSnapshot().events).toHaveLength(1);
    expect(world.lineageSnapshot().living[0]).toMatchObject({ liveCount: 3, peakCount: 3 });
    const stable = world.save();
    for (const candidate of [
      () => world.spawn({ ...genome(), preference: 0.2 }, 40, 40, parent.species),
      () => world.spawn({ ...genome(), tempo: 3 }, 40, 40, parent.species, parent),
      () => world.spawn(genome(), 40, 40, parent.species + 1, parent),
      () => world.spawn(genome(), 40, 40, parent.species, structuredClone(parent)),
    ]) {
      expect(candidate()).toBeUndefined();
      expect(world.save()).toEqual(stable);
    }
    const derived = world.spawn(genome(), 40, 40, undefined, parent)!;
    expect(derived.ancestry).toEqual([parent.species]);
    expect(world.lineageSnapshot().living[1]).toMatchObject({
      origin: 'mutation',
      parentId: parent.species,
    });
    expect(derived.species).not.toBe(parent.species);
    expect(world.births).toBe(0);
    expect(parent.children).toBe(0);
    const foreign = structuredClone(parent);
    const before = world.save();
    expect(world.spawn(genome(), 50, 50, undefined, foreign)).toBeUndefined();
    expect(world.save()).toEqual({ ...before, nextSpecies: before.nextSpecies + 1 });
    world.kill(derived, 'manual');
    const extinct = world.save();
    expect(world.spawn(genome(), 40, 40, derived.species)).toBeUndefined();
    expect(world.save()).toEqual(extinct);
    world.kill(parent, 'age');
    expect(world.lineageSnapshot().living[0].liveCount).toBe(2);
    expect(world.lineageSnapshot().events.at(-1)).toMatchObject({
      kind: 'extinct',
      id: derived.species,
    });
    expect(reload(world).save()).toEqual(world.save());
  });

  it('preserves blocked/default allocator holes and full-population direction side effects', () => {
    const world = empty();
    world.walls[0] = 1;
    const before = world.save(),
      random = new Random(1);
    random.state = before.random;
    random.int(4);
    expect(world.spawn(genome(), 0, 0)).toBeUndefined();
    expect(world.save()).toEqual({
      ...before,
      random: random.state,
      nextSpecies: before.nextSpecies + 1,
    });
    for (let position = 0; position < LIMIT; position++)
      expect(
        world.spawn(genome(), position % WIDTH, Math.floor(position / WIDTH) + 1),
      ).toBeDefined();
    const full = world.save();
    expect(world.spawn(genome(), 100, 100)).toBeUndefined();
    expect(world.save()).toEqual({ ...full, nextSpecies: full.nextSpecies + 1 });
    expect(world.lineageSnapshot().living).toHaveLength(LIMIT);
    expect(world.lineageSnapshot().summaries).toHaveLength(256);
    expect(world.lineageSnapshot().events).toHaveLength(512);
    expect(reload(world).save()).toEqual(world.save());
    const oldest = [...world.organisms.values()][0];
    world.kill(oldest, 'manual');
    expect(world.lineageSnapshot().summaries.at(-1)).toMatchObject({
      id: oldest.species,
      liveCount: 0,
      genomeStatus: 'pruned',
      foundingGenome: null,
      extinctTick: 0,
    });
    expect(reload(world).save()).toEqual(world.save());
  });

  it('keeps independent convergence, eight transitions and three same-tick ring wraps', () => {
    const world = empty();
    let parent = world.spawn(genome(), 1, 1)!;
    const first = parent.species;
    for (let generation = 0; generation < 12; generation++) {
      const child = world.spawn(genome(), generation + 2, 1, undefined, parent)!;
      world.kill(parent, 'energy');
      parent = child;
    }
    expect(parent.ancestry).toHaveLength(8);
    expect(new Set(parent.ancestry).size).toBe(8);
    world.kill(parent, 'manual');
    for (let iteration = 0; iteration < 1025; iteration++) {
      const placed = world.spawn(genome(), 1, 1)!;
      world.kill(placed, 'manual');
    }
    const snapshot = world.lineageSnapshot();
    expect(snapshot).toMatchObject({
      living: [],
      summariesPruned: true,
      eventsPruned: true,
      eventsEvictedThroughTick: 0,
    });
    expect(snapshot.summaries).toHaveLength(256);
    expect(snapshot.events).toHaveLength(512);
    expect(snapshot.events[0].kind).toBe('created');
    expect(snapshot.events.at(-1)?.kind).toBe('extinct');
    const restored = reload(world);
    expect(restored.save()).toEqual(world.save());
    for (const candidate of [world, restored]) {
      const before = candidate.save();
      expect(candidate.spawn(genome(), 1, 1, first)).toBeUndefined();
      expect(candidate.save()).toEqual(before);
      candidate.spawn(genome(), 1, 1);
      candidate.step();
    }
    expect(restored.save()).toEqual(world.save());
  });

  it('observes actual changed/clonal births and deaths with a separate 180-tick archive control', () => {
    const observed = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0.8 });
    const control = new Ecosystem(
      { ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0.8 },
      true,
      { lineage: false },
    );
    for (const world of [observed, control]) {
      const parent = [...world.organisms.values()][0];
      parent.age = 32;
      parent.energy = 100;
      world.spawn(genome(), 10, 10)!.energy = 0;
    }
    for (let tick = 0; tick < 180; tick++) {
      if (tick === 45) {
        observed.shock(-0.32);
        control.shock(-0.32);
      }
      observed.step();
      control.step();
      expect(beforeArchive(observed.save())).toEqual(beforeArchive(control.save()));
    }
    expect(observed.births).toBeGreaterThan(0);
    expect(observed.deaths).toBeGreaterThan(0);
    expect(
      observed
        .lineageSnapshot()
        .events.some((event) => event.kind === 'created' && event.origin === 'mutation'),
    ).toBe(true);
    expect(observed.save().telemetry.samples).toHaveLength(6);
    expect(control.lineageSnapshot()).toMatchObject({
      originKind: 'legacy-import',
      originTick: 180,
      events: [],
    });
    expect(reload(control).save()).toEqual(control.save());
    expect(reload(observed).save()).toEqual(observed.save());
  });

  it.each([2, 3, 4, 5])(
    'migrates literal v%s without inventing history, then continues exactly',
    (version) => {
      const source = empty();
      const first = source.spawn(genome(), 20, 20)!;
      source.spawn({ ...genome(), tempo: 3 }, 30, 30);
      source.spawn(genome(), 40, 40, first.species);
      advance(source, 29);
      const saved = source.save();
      saved.organisms.reverse();
      const v5 = legacyV5(saved);
      const { telemetry: _telemetry, interventions: _interventions, ...old } = v5;
      const file =
        version === 2
          ? { ...old, version: 2 }
          : version === 3
            ? legacyV3(saved)
            : version === 4
              ? legacyV4(saved)
              : v5;
      expect(file).not.toHaveProperty('lineageArchive');
      const migrated = Ecosystem.load(JSON.stringify(file));
      expect(migrated.lineageSnapshot()).toMatchObject({
        originKind: 'legacy-import',
        originTick: 29,
        events: [],
        summaries: [
          { id: saved.organisms[0].species, foundingGenome: null, genomeStatus: 'legacy-unknown' },
        ],
      });
      expect(migrated.save().organisms).toEqual(saved.organisms);
      const continued = reload(migrated);
      for (const world of [migrated, continued]) advance(world, 31);
      expect(continued.save()).toEqual(migrated.save());
    },
  );
});
