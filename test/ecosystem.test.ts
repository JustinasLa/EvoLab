import { describe, it, expect } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  LIMIT,
  Random,
  index,
  positions,
  connected,
  validGenome,
  validSettings,
  founder,
  mutate,
  speciesName,
  temperature,
  type Genome,
  type CellType,
} from '../src/model';
const empty = () => new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0 }, false);
const single = (type: CellType = 3, preference = 0.5): Genome => ({
  cells: [{ x: 0, y: 0, type }],
  preference,
  tolerance: 0.3,
  tempo: 2,
});

describe('genomes and coordinates', () => {
  it('has bounded deterministic randomness, toroidal coordinates, and rotated anatomy', () => {
    const a = new Random(42),
      b = new Random(42);
    for (let i = 0; i < 10000; i++) {
      expect(a.next()).toBe(b.next());
      expect(a.state).toBeGreaterThanOrEqual(-2147483648);
    }
    expect(index(-1, -1)).toBe(WIDTH * HEIGHT - 1);
    expect(index(WIDTH, HEIGHT)).toBe(0);
    expect(positions({ x: 0, y: 0, rotation: 3, genome: founder(0) })).toHaveLength(5);
    expect(connected([])).toBe(false);
    expect(
      connected([
        { x: 0, y: 0, type: 3 },
        { x: 2, y: 0, type: 4 },
      ]),
    ).toBe(false);
    expect(validGenome(null)).toBe(false);
    expect(validGenome({})).toBe(false);
    expect(
      validGenome({
        ...single(),
        cells: [
          { x: 0, y: 0, type: 3 },
          { x: 0, y: 0, type: 4 },
        ],
      }),
    ).toBe(false);
    expect(validSettings(null)).toBe(false);
    expect(validSettings({})).toBe(false);
    expect(validSettings({ ...DEFAULTS, seed: 1.5 })).toBe(false);
    expect(speciesName(founder(0))).toBe('Bloom');
    expect(speciesName(founder(1))).toBe('Forager');
    expect(speciesName(founder(2))).toBe('Hunter');
    expect(speciesName(single())).toBe('Rootling');
    expect(validGenome(founder(3))).toBe(true);
  });
  it('keeps every mutated anatomy connected and within import bounds', () => {
    const random = new Random(17);
    let genome = founder(0);
    const sizes = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      genome = mutate(genome, random);
      expect(validGenome(genome)).toBe(true);
      sizes.add(genome.cells.length);
    }
    expect(sizes.size).toBeGreaterThan(5);
  });
});

describe('a shared, living world', () => {
  it('reproduces the same ecosystem from the same seed, then changes through actual births and deaths', () => {
    const a = new Ecosystem(),
      b = new Ecosystem();
    expect(a.save()).toEqual(b.save());
    for (let i = 0; i < 350; i++) {
      a.step();
      b.step();
    }
    expect(a.save()).toEqual(b.save());
    expect(a.births).toBeGreaterThan(0);
    expect(a.deaths).toBeGreaterThan(0);
    expect(a.frame().stats.generation).toBeGreaterThan(0);
    expect(a.frame().stats.top.length).toBeLessThanOrEqual(5);
    expect([...a.food.keys()].some((i) => a.food[i] && a.walls[i])).toBe(false);
  });
  it('supports food consumption, photosynthesis, starvation and old age', () => {
    const w = empty(),
      eater = w.spawn(single(), 10, 10)!;
    w.food[index(11, 10)] = 1;
    const energy = eater.energy;
    w.step();
    expect(eater.energy).toBeGreaterThan(energy);
    expect(w.food[index(11, 10)]).toBe(0);
    const leaf = w.spawn(single(4), 25, 25)!;
    const start = leaf.energy;
    for (let i = 0; i < 100; i++) w.step();
    expect(leaf.energy).toBeGreaterThan(start);
    eater.energy = 0;
    w.step();
    expect(w.organisms.has(eater.id)).toBe(false);
    expect(w.food[index(10, 10)]).toBe(1);
    leaf.age = 2000;
    w.step();
    expect(w.organisms.has(leaf.id)).toBe(false);
  });
  it('requires room for births and movement, and wraps at world edges', () => {
    const w = empty(),
      g = single();
    w.walls[index(4, 4)] = 1;
    expect(w.spawn(g, 4, 4)).toBeUndefined();
    const o = w.spawn(g, 0, 0)!;
    expect(w.spawn(g, 0, 0)).toBeUndefined();
    expect(w.move(o, -1, 0)).toBe(true);
    expect(o.x).toBe(WIDTH - 1);
    w.walls[index(WIDTH - 2, 0)] = 1;
    expect(w.move(o, -1, 0)).toBe(false);
    w.organisms.clear();
    w.occupied.fill(0);
    for (let i = 0; i < LIMIT; i++) w.spawn(g, i % WIDTH, Math.floor(i / WIDTH) + 20);
    expect(w.spawn(g, 100, 100)).toBeUndefined();
    expect(w.organisms.size).toBe(LIMIT);
  });
  it('lets predators drain victims while armor protects the contacted cell', () => {
    for (const armor of [false, true]) {
      const w = empty(),
        hunter = w.spawn(single(6), 10, 10)!,
        victim = w.spawn(single(armor ? 7 : 3), 11, 10)!;
      hunter.age = 3;
      victim.energy = 30;
      w.step();
      expect(victim.energy).toBeCloseTo(30 - 0.012 - (armor ? 0 : 2.5));
    }
  });
  it('moves foragers toward food and deals with blocked or unsighted motion', () => {
    const w = empty(),
      o = w.spawn(founder(1), 20, 20)!;
    o.age = o.genome.tempo - 1;
    w.food[index(23, 20)] = 1;
    w.step();
    expect(o.x).toBe(21);
    const blind = w.spawn(
      { cells: [{ x: 0, y: 0, type: 5 }], preference: 0.5, tolerance: 0.3, tempo: 2 },
      50,
      50,
    )!;
    blind.age = 1;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      w.walls[index(50 + dx, 50 + dy)] = 1;
    w.step();
    expect(blind.x).toBe(50);
    expect(blind.rotation).toBe(1);
  });
  it('inherits anatomy and temperature preferences, with mutation creating new lineages', () => {
    for (const mutation of [0, 0.4]) {
      const w = empty();
      w.settings.mutation = mutation;
      const o = w.spawn(single(4, 0.7), 100, 80)!;
      o.age = 32;
      o.energy = 200;
      for (let i = 0; i < 120; i++) w.step();
      expect(w.births).toBeGreaterThan(0);
      expect(o.children).toBeGreaterThan(0);
      const descendants = [...w.organisms.values()].filter((c) => c.id !== o.id);
      expect(
        descendants.every((c) => c.species === o.species || c.ancestry.includes(o.species)),
      ).toBe(true);
      if (mutation === 0) expect(descendants.every((c) => c.genome.preference === 0.7)).toBe(true);
    }
  });
  it('applies climate stress and finite environmental events', () => {
    expect(temperature(0, 0, 0, 1)).not.toBe(temperature(0, 0, 1500, 1));
    expect(temperature(0, 0, 0, 0)).toBe(0.5);
    const w = empty(),
      adapted = w.spawn(single(4, 0.82), 10, 10)!,
      unadapted = w.spawn(single(4, 0), 30, 30)!;
    w.shock('heat');
    for (let i = 0; i < 30; i++) w.step();
    expect(adapted.energy).toBeGreaterThan(unadapted.energy);
    expect(w.frame().stats.event).toContain('Heatwave');
    w.shock('cold');
    expect(w.frame().stats.event).toContain('Cold snap');
    w.tick = w.eventUntil;
    expect(w.frame().stats.event).toBe('Drifting climate');
    expect(w.frame().offset).toBe(0);
    w.tick = 2800;
    expect(w.frame().stats.season).toBe('Cold season');
    const food = w.frame().stats.food;
    w.shock('bloom');
    expect(w.frame().stats.food).toBeGreaterThan(food);
  });
  it('makes broad climate tolerance cost energy in a comfortable habitat', () => {
    const w = empty();
    const narrow = w.spawn({ ...single(4), tolerance: 0.12 }, 10, 10)!;
    const broad = w.spawn({ ...single(4), tolerance: 0.6 }, 30, 30)!;
    for (let i = 0; i < 10; i++) w.step();
    expect(narrow.energy).toBeGreaterThan(broad.energy);
  });
  it('paints food, blocking walls, complete organisms and erasure without corrupting occupancy', () => {
    const w = empty(),
      g = founder(0);
    w.paint('food', 10, 10, 2, g);
    expect(w.food[index(10, 10)]).toBe(1);
    w.paint('wall', 10, 10, 1, g);
    expect(w.walls[index(10, 10)]).toBe(1);
    expect(w.food[index(10, 10)]).toBe(0);
    w.paint('plant', 30, 30, 0, g);
    expect(w.organisms.size).toBe(1);
    w.paint('wall', 30, 30, 0, g);
    expect(w.walls[index(30, 30)]).toBe(0);
    w.paint('erase', 30, 30, 0, g);
    expect(w.organisms.size).toBe(0);
    expect(w.occupied.some(Boolean)).toBe(false);
    expect(w.food[index(30, 30)]).toBe(0);
    w.paint('erase', 10, 10, 2, g);
    expect(w.walls[index(10, 10)]).toBe(0);
  });
});

describe('whole-world persistence', () => {
  it('restores every organism, terrain, counters and RNG state and continues identically', () => {
    const w = new Ecosystem();
    for (let i = 0; i < 100; i++) w.step();
    w.shock('heat');
    const saved = w.save();
    const restored = Ecosystem.load(JSON.stringify(saved));
    expect(restored.save()).toEqual(saved);
    for (let i = 0; i < 100; i++) {
      w.step();
      restored.step();
    }
    expect(restored.save()).toEqual(w.save());
  });
  it('rejects malformed, huge, out-of-range or overlapping worlds', () => {
    expect(() => Ecosystem.load('x'.repeat(2500001))).toThrow('2.5 MB');
    expect(() => Ecosystem.load('{')).toThrow();
    for (const invalid of [null, {}, { version: 1 }])
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('version 2');
    const w = empty();
    w.spawn(single(), 10, 10);
    const file = w.save();
    const change = (f: (file: any) => void) => {
      const copy = structuredClone(file);
      f(copy);
      return () => Ecosystem.load(JSON.stringify(copy));
    };
    expect(change((f) => (f.food = [-1]))).toThrow('terrain');
    expect(change((f) => (f.walls = null))).toThrow('terrain');
    expect(change((f) => (f.organisms[0].genome.cells[0].x = 20))).toThrow('organism');
    expect(change((f) => (f.organisms[0].energy = null))).toThrow('organism');
    expect(change((f) => f.organisms.push({ ...f.organisms[0] }))).toThrow('organism');
    expect(change((f) => (f.walls = [index(10, 10)]))).toThrow('organism');
    expect(change((f) => (f.organisms[0].ancestry = [999999]))).toThrow('organism');
    const withTerrain = structuredClone(file);
    withTerrain.food = [0];
    withTerrain.walls = [0];
    expect(Ecosystem.load(JSON.stringify(withTerrain)).food[0]).toBe(0);
  });
});
