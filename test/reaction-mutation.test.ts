import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  Random,
  WORLD_VERSION,
  cloneGenome,
  connected,
  index,
  mutate,
  validGenome,
  type Genome,
} from '../src/model';

const categories = ['food', 'wall', 'harmless', 'dangerous'] as const;
const actions = ['ignore', 'chase', 'flee'] as const;
const active = (): Genome => ({
  cells: [{ x: 0, y: 0, type: 3 }],
  preference: 0.5,
  tolerance: 0.2,
  tempo: 5,
  behavior: {
    version: 2,
    mode: 'evolved',
    reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
  },
  legacyExtensions: [['payload', [['string', 'retained']]]],
});
function scene(mutation = 0.4) {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0, mutation }, false);
  const parent = world.spawn(active(), 60, 60)!;
  parent.age = 32;
  parent.energy = 40;
  world.random.state = 7;
  return { world, parent };
}

describe('active-only birth reaction mutation', () => {
  it('uses exactly two ordered draws after unchanged anatomy/climate/tempo for all 81 tables', () => {
    const transitions = new Set<string>();
    for (let table = 0; table < 81; table++) {
      const source = active();
      if (source.behavior.mode !== 'evolved') throw new Error('test table');
      for (const [i, category] of categories.entries())
        source.behavior.reactions[category] = actions[Math.floor(table / 3 ** i) % 3];
      const before = cloneGenome(source);
      for (let seed = 1; seed <= 80; seed++) {
        const passive = cloneGenome(source);
        passive.behavior.version = 1;
        const reference = new Random(seed * 7919),
          expected = mutate(passive, reference),
          category = categories[reference.int(4)],
          old = source.behavior.reactions[category],
          replacement = actions.filter((action) => action !== old)[reference.int(2)];
        expected.behavior.version = 2;
        if (expected.behavior.mode !== 'evolved') throw new Error('test table');
        expected.behavior.reactions[category] = replacement;
        const random = new Random(seed * 7919),
          actual = mutate(source, random);
        expect(actual).toEqual(expected);
        expect(random.state).toBe(reference.state);
        expect(validGenome(actual)).toBe(true);
        expect(connected(actual.cells)).toBe(true);
        transitions.add(`${category}:${old}:${replacement}`);
      }
      expect(source).toEqual(before);
    }
    expect(transitions.size).toBe(4 * 3 * 2);
  });

  it('records only an accepted genuine difference, with detached inheritance and real parental spending', () => {
    const { world, parent } = scene(),
      before = cloneGenome(parent.genome),
      random = new Random(world.random.state);
    expect(random.next()).toBeLessThan(world.settings.mutation);
    const expected = mutate(before, random);
    world.step();
    expect(world.births).toBe(1);
    const child = [...world.organisms.values()][1];
    expect(child.genome).toEqual(expected);
    expect(child.genome.behavior).not.toEqual(before.behavior);
    expect(parent.genome).toEqual(before);
    expect(child.species).not.toBe(parent.species);
    expect(child.ancestry).toEqual([parent.species]);
    const summary = world.lineageSnapshot().summaries.at(-1)!;
    expect(summary).toMatchObject({
      origin: 'mutation',
      parentId: parent.species,
      foundingGenome: expected,
    });
    const grant = expected.cells.length * 1.5 + 3;
    expect(child.energy).toBe(grant);
    expect(parent.energy).toBeCloseTo(40 - 0.012 - grant - 2, 12);
    expect(world.save().telemetry.pending.energy).toMatchObject({
      offspringGranted: grant,
      reproductionSpent: grant + 2,
    });
    const saved = world.save();
    const resumed = Ecosystem.load(JSON.stringify(saved));
    for (let tick = 0; tick < 150; tick++) {
      world.step();
      resumed.step();
    }
    expect(resumed.save()).toEqual(world.save());
    if (child.genome.behavior.mode !== 'evolved') throw new Error('test table');
    child.genome.behavior.reactions.food = 'ignore';
    expect(parent.genome).toEqual(before);
    expect(saved.lineageArchive.summaries.at(-1)!.foundingGenome).toEqual(expected);
  });

  it('consumes prescribed mutation and placement draws on failed births without phantom identities or evidence', () => {
    const { world, parent } = scene();
    for (let y = 51; y <= 69; y++)
      for (let x = 51; x <= 69; x++) if (x !== 60 || y !== 60) world.walls[index(x, y)] = 1;
    const before = world.save(),
      random = new Random(world.random.state);
    expect(random.next()).toBeLessThan(0.4);
    mutate(parent.genome, random);
    for (let attempt = 0; attempt < 3; attempt++) {
      random.int(4);
      random.int(5);
      random.int(4);
      random.int(4);
    }
    world.step();
    const after = world.save();
    expect(after.random).toBe(random.state);
    expect(after.births).toBe(0);
    expect(after.nextId).toBe(before.nextId);
    expect(after.nextSpecies).toBe(before.nextSpecies);
    expect(after.lineageArchive).toEqual(before.lineageArchive);
    expect(parent.children).toBe(0);
    expect(parent.energy).toBeCloseTo(40 - 0.012, 12);
    expect(after.telemetry.pending.energy.offspringGranted).toBe(0);
  });

  it('clones active reactions at a failed mutation gate without extra draws or lineage transitions', () => {
    const { world, parent } = scene(0),
      before = cloneGenome(parent.genome),
      random = new Random(world.random.state);
    random.next();
    random.int(4);
    random.int(5);
    random.int(4);
    random.int(4);
    world.step();
    const child = [...world.organisms.values()][1];
    expect(child.genome).toEqual(before);
    expect(child.genome).not.toBe(parent.genome);
    expect(child.genome.behavior).not.toBe(parent.genome.behavior);
    expect(child.species).toBe(parent.species);
    expect(world.random.state).toBe(random.state);
    expect(world.lineageSnapshot().summaries).toHaveLength(1);
  });

  it('migrates complete world11 data without draws, field loss, identity changes or activation', () => {
    const { world } = scene();
    const current = world.save(),
      predecessor = {
        ...current,
        version: 11,
        interventions: { ...current.interventions, version: 4 },
      };
    const migrated = Ecosystem.load(JSON.stringify(predecessor));
    expect(WORLD_VERSION).toBe(14);
    expect(migrated.save()).toEqual(current);
    world.step();
    migrated.step();
    expect(migrated.save()).toEqual(world.save());
    const bad = structuredClone(predecessor);
    if (bad.organisms[0].genome.behavior.mode !== 'evolved') throw new Error('test table');
    (bad.organisms[0].genome.behavior.reactions as any).food = 'attack';
    expect(() => Ecosystem.load(JSON.stringify(bad))).toThrow('organism');
    expect(migrated.save()).toEqual(world.save());
  });
});
