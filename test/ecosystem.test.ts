import { describe, it, expect } from 'vitest';
import { cpus, platform, totalmem } from 'node:os';
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
  type WorldFile,
  type LegacyWorldFile,
  type WorldFileV3,
  PREFERENCE_ENDPOINTS,
  WORLD_MAX_BYTES,
} from '../src/model';
const empty = () => new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0 }, false);
const single = (type: CellType = 3, preference = 0.5): Genome => ({
  cells: [{ x: 0, y: 0, type }],
  preference,
  tolerance: 0.3,
  tempo: 2,
});
const advance = (world: Ecosystem, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick++) world.step();
};
const ecology = ({ telemetry: _telemetry, ...saved }: WorldFile) => saved;
function oldTelemetry(world: Ecosystem): WorldFileV3 {
  const saved = world.save(),
    { adaptationOriginTick: _origin, ...telemetry } = saved.telemetry;
  return {
    ...saved,
    version: 3,
    telemetry: {
      ...telemetry,
      version: 1,
      samples: telemetry.samples.map(({ adaptation: _adaptation, ...sample }) => sample),
    },
  };
}
function colony(count: number, tolerance: number, preference = 0.5, telemetry = true): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false, {
    telemetry,
  });
  for (let organism = 0; organism < count; organism++)
    expect(
      world.spawn(
        { ...single(7, preference), tolerance },
        organism % WIDTH,
        Math.floor(organism / WIDTH),
      ),
    ).toBeDefined();
  return world;
}
function adjacent(value: number, direction: -1 | 1): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  view.setBigUint64(0, view.getBigUint64(0, false) + BigInt(direction), false);
  return view.getFloat64(0, false);
}

describe('final removal observations', () => {
  it.each([
    { age: 0, energy: 0.001, cause: 'energy' },
    { age: 975, energy: 5, cause: 'age' },
    { age: 975, energy: 0.001, cause: 'energy' },
  ])(
    'records $cause at the actual removal tick without changing death effects',
    ({ age, energy, cause }) => {
      const world = empty();
      advance(world, 81);
      const organism = world.spawn(single(), 40, 40)!;
      Object.assign(organism, { age, energy });
      const random = world.random.state;
      world.step();
      expect(world.lastDeath).toEqual({ tick: 82, cause });
      expect(world.deaths).toBe(1);
      expect(world.organisms.size).toBe(0);
      expect(world.occupied.some(Boolean)).toBe(false);
      expect(world.food[index(40, 40)]).toBe(1);
      expect(world.random.state).toBe(random);
      const saved = world.save();
      world.frame();
      expect(world.save()).toEqual(saved);
      expect(saved).not.toHaveProperty('lastDeath');
      expect(Ecosystem.load(JSON.stringify(saved)).lastDeath).toBeNull();
    },
  );

  it('records the actual last removal in iteration order, not an aggregate cause', () => {
    const world = empty();
    world.spawn(single(), 20, 20)!.age = 975;
    world.spawn(single(), 50, 50)!.energy = 0.001;
    world.step();
    expect(world.deaths).toBe(2);
    expect(world.lastDeath).toEqual({ tick: 1, cause: 'energy' });
  });

  it('records manual erasure at the same tick with wrapped rotated body food intact outside the brush', () => {
    const world = empty();
    const organism = world.spawn(founder(0), 0, 0, 1, undefined, 1)!;
    const body = positions(organism);
    world.tick = 53;
    world.food[index(8, 8)] = 1;
    world.walls[index(9, 9)] = 1;
    const random = world.random.state;
    world.paint('erase', 0, 0, 0, single());
    expect(world.lastDeath).toEqual({ tick: 53, cause: 'manual' });
    expect(world.deaths).toBe(1);
    expect(world.organisms.size).toBe(0);
    for (const position of body) {
      expect(world.occupied[position]).toBe(0);
      expect(world.food[position]).toBe(position === index(0, 0) ? 0 : 1);
    }
    expect(world.food[index(8, 8)]).toBe(1);
    expect(world.walls[index(9, 9)]).toBe(1);
    expect(world.random.state).toBe(random);
    const saved = world.save();
    expect(world.lastDeath).toEqual({ tick: 53, cause: 'manual' });
    expect(world.save()).toEqual(saved);
  });
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
  it('starts with exactly one central founder and a clear footprint for every tested seed', () => {
    for (const seed of [0, 1, 42, 100, 123, 4294967295]) {
      const world = new Ecosystem({ ...DEFAULTS, seed }),
        [organism] = world.organisms.values();
      expect(world.organisms.size).toBe(1);
      expect(organism).toMatchObject({
        id: 1,
        species: 1,
        x: WIDTH / 2,
        y: HEIGHT / 2,
        rotation: 0,
        age: 0,
        generation: 0,
        children: 0,
        ancestry: [],
        genome: founder(0),
      });
      expect(world.frame().stats).toMatchObject({
        tick: 0,
        population: 1,
        species: 1,
        births: 0,
        deaths: 0,
        generation: 0,
      });
      expect([...world.occupied].filter(Boolean)).toHaveLength(organism.genome.cells.length);
      for (const position of positions(organism)) {
        expect(world.occupied[position]).toBe(organism.id);
        expect(world.walls[position]).toBe(0);
        expect(world.food[position]).toBe(0);
      }
      expect(world.food.some(Boolean)).toBe(false);
      expect(world.walls.some(Boolean)).toBe(true);
    }
  });
  it('reproduces the same ecosystem from the same seed, then changes through actual births and deaths', () => {
    const a = new Ecosystem(),
      b = new Ecosystem();
    expect(a.save()).toEqual(b.save());
    for (let i = 0; i < 1600; i++) {
      a.step();
      b.step();
    }
    expect(a.save()).toEqual(b.save());
    expect(a.births).toBeGreaterThan(0);
    expect(a.deaths).toBeGreaterThan(0);
    expect(a.organisms.has(1)).toBe(false);
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
    expect(w.food[index(25, 25)]).toBe(1);
  });
  it.each(['starvation', 'old age'] as const)(
    'turns every cell type into food after %s, including rotated bodies across wrapped edges',
    (cause) => {
      for (const rotation of [0, 1, 2, 3]) {
        const world = empty(),
          genome: Genome = {
            ...single(),
            cells: [
              { x: 0, y: 0, type: 3 },
              { x: 1, y: 0, type: 4 },
              { x: 2, y: 0, type: 5 },
              { x: 0, y: 1, type: 6 },
              { x: 1, y: 1, type: 7 },
              { x: 2, y: 1, type: 8 },
            ],
          },
          organism = world.spawn(genome, WIDTH - 1, HEIGHT - 1, 1, undefined, rotation)!,
          footprint = positions(organism).sort((left, right) => left - right);
        if (cause === 'starvation') organism.energy = -100;
        else organism.age = 900 + genome.cells.length * 75;
        world.step();
        expect(world.organisms.size).toBe(0);
        expect(world.deaths).toBe(1);
        expect(world.occupied.some(Boolean)).toBe(false);
        expect(world.save().food).toEqual(footprint);
        const frame = world.frame();
        expect(frame.stats.food).toBe(genome.cells.length);
        for (const position of footprint) {
          expect(frame.cells[position]).toBe(1);
          expect(frame.ids[position]).toBe(0);
        }
        const restored = Ecosystem.load(JSON.stringify(world.save()));
        expect(restored.save()).toEqual(world.save());
      }
    },
  );
  it('does not scatter food beyond dead bodies without leaves, including after climate events', () => {
    const world = new Ecosystem({ ...DEFAULTS, nutrients: 20, climate: 0 }, false);
    world.spawn(single(3), 20, 20);
    world.spawn(single(7), 40, 40);
    world.shock('cold');
    world.shock('heat');
    for (let tick = 0; tick < 1000; tick++) world.step();
    expect(world.organisms.size).toBe(0);
    expect(world.deaths).toBe(2);
    expect(world.births).toBe(0);
    expect(world.save().food).toEqual([index(20, 20), index(40, 40)]);
  });
  it('produces food beside leaves only, respecting wrapped edges, walls, occupancy and the rate', () => {
    const world = new Ecosystem({ ...DEFAULTS, nutrients: 20, climate: 0 }, false);
    world.spawn(single(4), 0, 0);
    world.spawn(single(7), 1, 0);
    world.walls[index(0, -1)] = 1;
    for (let tick = 0; tick < 100; tick++) world.step();
    const food = world.save().food,
      allowed = new Set([index(-1, 0), index(0, 1)]);
    expect(food.length).toBeGreaterThan(0);
    expect(food.every((position) => allowed.has(position))).toBe(true);
    expect(world.food[index(0, -1)]).toBe(0);
    expect(world.food[index(1, 0)]).toBe(0);
    world.settings.nutrients = 0;
    world.food.fill(0);
    for (let tick = 0; tick < 100; tick++) world.step();
    expect(world.food.some(Boolean)).toBe(false);
  });
  it('retains food from saved worlds without resuming random food generation', () => {
    const world = new Ecosystem({ ...DEFAULTS, nutrients: 20, climate: 0 }, false);
    world.food[index(10, 10)] = 1;
    const restored = Ecosystem.load(JSON.stringify(world.save()));
    for (let tick = 0; tick < 1000; tick++) restored.step();
    expect(restored.save().food).toEqual([index(10, 10)]);
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
  it('makes sighted foragers avoid nearby organisms while predators approach them', () => {
    for (const predator of [false, true]) {
      const world = empty(),
        genome: Genome = {
          cells: [
            { x: 0, y: 0, type: 5 },
            { x: -1, y: 0, type: 8 },
            { x: 0, y: -1, type: predator ? 6 : 3 },
          ],
          preference: 0.5,
          tolerance: 0.3,
          tempo: 2,
        },
        observer = world.spawn(genome, 20, 20)!;
      world.spawn(single(), 22, 20);
      observer.age = 1;
      world.step();
      expect(observer.x).toBe(predator ? 21 : 20);
      expect(observer.y).toBe(predator ? 20 : 21);
    }
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
    for (const position of positions({ genome: g, x: 30, y: 30, rotation: 0 }))
      expect(w.food[position]).toBe(position === index(30, 30) ? 0 : 1);
    w.paint('erase', 10, 10, 2, g);
    expect(w.walls[index(10, 10)]).toBe(0);
  });
});

describe('tick-aligned ecosystem telemetry', () => {
  it.each([1, 42, 123])(
    'does not change ecology, RNG or update order over the full retention window (seed %i)',
    (seed) => {
      const settings = { ...DEFAULTS, seed, mutation: 0.4 },
        observed = new Ecosystem(settings),
        control = new Ecosystem(settings, true, { telemetry: false });
      for (const world of [observed, control]) {
        expect(world.spawn(founder(1), 2, 10)).toBeDefined();
        expect(world.spawn(founder(2), 2, 25)).toBeDefined();
        world.shock('cold');
      }
      for (let tick = 1; tick <= 5430; tick++) {
        observed.step();
        control.step();
        if (tick % 137 === 0) {
          const before = observed.save();
          observed.frame();
          observed.frame();
          expect(observed.save()).toEqual(before);
        }
        if ([29, 30, 31, 5400, 5430].includes(tick))
          expect(ecology(observed.save())).toEqual(ecology(control.save()));
        if (tick === 700)
          for (const world of [observed, control]) {
            world.shock('heat');
            world.paint('food', 20, 20, 2, founder(0));
          }
      }
      expect(observed.births).toBeGreaterThan(0);
      expect(observed.deaths).toBeGreaterThan(0);
      const disabled = control.save().telemetry;
      expect(disabled).toMatchObject({
        originTick: 5430,
        samples: [],
        pending: { fromTick: 5430 },
      });
      expect(control.frame().telemetry).toEqual(disabled);
      const restored = Ecosystem.load(JSON.stringify(control.save()));
      advance(restored, 30);
      expect(restored.save().telemetry.samples[0]).toMatchObject({ fromTick: 5430, tick: 5460 });
    },
    120000,
  );

  it('samples actual boundaries inside 4/12-tick groups without observing batch-end state', () => {
    const reference = new Ecosystem(),
      snapshots = new Map<number, WorldFile>();
    for (let tick = 0; tick <= 120; tick++) {
      if (tick) reference.step();
      snapshots.set(tick, reference.save());
    }
    for (const size of [1, 4, 12]) {
      const world = new Ecosystem();
      expect(world.frame().telemetry.samples).toEqual([]);
      for (let batch = 0; batch < 120 / size; batch++) {
        advance(world, size);
        world.frame();
        expect(world.save()).toEqual(snapshots.get(world.tick));
        for (const sample of world.save().telemetry.samples)
          expect(sample).toEqual(snapshots.get(sample.tick)!.telemetry.samples.at(-1));
      }
    }
    expect(snapshots.get(36)!.telemetry).toMatchObject({
      pending: { fromTick: 30 },
      samples: [{ tick: 30 }],
    });
    expect(snapshots.get(96)!.telemetry.samples.map((sample) => sample.tick)).toEqual([30, 60, 90]);
  });

  it('retains 180 chronological samples over repeated wraps, including empty worlds and food', () => {
    const world = empty();
    world.paint('food', 10, 10, 0, single());
    advance(world, 29);
    expect(world.frame().telemetry.samples).toEqual([]);
    world.step();
    expect(world.frame().telemetry.samples[0]).toMatchObject({
      tick: 30,
      fromTick: 0,
      population: 0,
      food: 1,
      cellCounts: [0, 0, 0, 0, 0, 0],
      meanPreference: null,
      meanTolerance: null,
    });
    advance(world, 5370);
    expect(world.frame().telemetry.samples).toHaveLength(180);
    expect(world.frame().telemetry.samples[0].tick).toBe(30);
    world.step();
    expect(world.frame().telemetry.samples).toHaveLength(180);
    advance(world, 29);
    expect(world.frame().telemetry.samples[0].tick).toBe(60);
    expect(world.frame().telemetry.samples.at(-1)!.tick).toBe(5430);
    advance(world, 10800);
    const saved = world.save(),
      restored = Ecosystem.load(JSON.stringify(saved));
    expect(restored.save()).toEqual(saved);
    expect(saved.telemetry.samples.map((sample) => sample.tick)).toEqual(
      Array.from({ length: 180 }, (_, index) => 10860 + index * 30),
    );
    advance(world, 100);
    advance(restored, 100);
    expect(restored.save()).toEqual(world.save());
  });

  it('counts living cell types and food, detaches every nested snapshot, and never counts placement as birth', () => {
    const world = empty(),
      genome: Genome = {
        ...single(3, 0.25),
        cells: [3, 4, 5, 6, 7, 8].map((type, index) => ({
          x: index % 3,
          y: Math.floor(index / 3),
          type: type as CellType,
        })),
      };
    world.paint('plant', 20, 20, 0, genome);
    world.paint('plant', 70, 70, 0, { ...single(7, 0.75), tolerance: 0.5 });
    world.paint('food', 100, 100, 0, single());
    expect(world.save().telemetry.pending.births).toBe(0);
    advance(world, 30);
    const original = world.save(),
      sample = original.telemetry.samples[0];
    expect(sample).toMatchObject({
      population: 2,
      food: 1,
      cellCounts: [1, 1, 1, 1, 2, 1],
      meanPreference: 0.5,
      meanTolerance: 0.4,
      births: 0,
    });
    const frame = world.frame();
    frame.telemetry.samples[0].cellCounts.fill(0);
    frame.telemetry.samples[0].deaths.age = 99;
    frame.telemetry.samples[0].energy.upkeepSpent = 99;
    frame.telemetry.pending.energy.mouthsGained = 99;
    frame.telemetry.pending.deaths.manual = 99;
    frame.telemetry.samples.push(sample);
    expect(world.save()).toEqual(original);
    original.telemetry.samples[0].energy.upkeepSpent = 99;
    expect(world.save().telemetry.samples[0].energy.upkeepSpent).not.toBe(99);
    const history = world.save().telemetry.samples;
    const survivor = [...world.organisms.values()][1];
    world.paint('erase', survivor.x, survivor.y, 0, single());
    expect(world.frame().telemetry.samples).toEqual(history);
    expect(world.frame().telemetry.pending).toMatchObject({ fromTick: 30, deaths: { manual: 1 } });
    const restored = Ecosystem.load(JSON.stringify(world.save()));
    expect(restored.save()).toEqual(world.save());
    advance(world, 100);
    advance(restored, 100);
    expect(restored.save()).toEqual(world.save());
  });

  it.each([0.12, 0.6])(
    'preserves endpoint tolerance %s through real colonies, JSON and continuation',
    (tolerance) => {
      for (const population of [1, 2, 3, 7, 31, 100, 255, 1000, 1599, 1600]) {
        const world = colony(population, tolerance),
          disabled = colony(population, tolerance, 0.5, false),
          groupedFour = colony(population, tolerance),
          groupedTwelve = colony(population, tolerance),
          restored: Ecosystem[] = [];
        for (let tick = 1; tick <= 160; tick++) {
          world.step();
          disabled.step();
          for (const twin of restored) twin.step();
          if (tick % 4 === 0) advance(groupedFour, 4);
          if (tick % 12 === 0) advance(groupedTwelve, 12);
          if ([29, 30, 36].includes(tick)) {
            const saved = world.save();
            const twin = Ecosystem.load(JSON.stringify(saved));
            expect(twin.save()).toEqual(saved);
            restored.push(twin);
          }
          if ([24, 30, 36, 60, 90, 96, 160].includes(tick)) {
            expect(world.organisms.size).toBe(population);
            expect(ecology(world.save())).toEqual(ecology(disabled.save()));
            for (const sample of world.frame().telemetry.samples) {
              expect(sample.population).toBe(population);
              expect(sample.meanTolerance).toBe(tolerance);
              expect(sample.meanPreference).toBe(0.5);
            }
            for (const twin of restored) expect(twin.save()).toEqual(world.save());
            if (tick % 4 === 0) expect(groupedFour.save()).toEqual(world.save());
            if (tick % 12 === 0) expect(groupedTwelve.save()).toEqual(world.save());
          }
        }
      }
    },
    120000,
  );

  it.each([0, 1])(
    'preserves preference endpoint %s without changing source genomes',
    (preference) => {
      for (const population of [1, 2, 3, 7, 31, 100, 255, 1000, 1599, 1600]) {
        const world = colony(population, 0.6, preference),
          control = colony(population, 0.6, preference, false);
        advance(world, 36);
        advance(control, 36);
        expect(world.frame().telemetry.samples[0].meanPreference).toBe(preference);
        const restored = Ecosystem.load(JSON.stringify(world.save()));
        advance(world, 100);
        advance(control, 100);
        advance(restored, 100);
        expect(world.organisms.size).toBe(population);
        expect(restored.save()).toEqual(world.save());
        expect(ecology(world.save())).toEqual(ecology(control.save()));
        expect(
          [...world.organisms.values()].every((organism) =>
            Object.is(organism.genome.preference, preference),
          ),
        ).toBe(true);
      }
    },
    30000,
  );

  it.each([
    { values: [0.12, adjacent(0.12, 1)], trait: 'tolerance', expected: 0.12 },
    { values: [0.6, adjacent(0.6, -1)], trait: 'tolerance', expected: adjacent(0.6, -1) },
    { values: [0.12, 0.6], trait: 'tolerance', expected: 0.36 },
    { values: [0.2, 0.3, 0.4], trait: 'tolerance', expected: 0.3 },
    { values: [0.25, adjacent(0.25, 1)], trait: 'tolerance', expected: 0.25 },
    {
      values: [adjacent(0.25, 1), adjacent(adjacent(0.25, 1), 1)],
      trait: 'tolerance',
      expected: adjacent(adjacent(0.25, 1), 1),
    },
    { values: [0.12, 0.12, adjacent(0.12, 1)], trait: 'tolerance', expected: 0.12 },
    {
      values: [0.12, adjacent(0.12, 1), adjacent(0.12, 1)],
      trait: 'tolerance',
      expected: adjacent(0.12, 1),
    },
    { values: [0.6, 0.6, adjacent(0.6, -1)], trait: 'tolerance', expected: 0.6 },
    {
      values: [0.6, adjacent(0.6, -1), adjacent(0.6, -1)],
      trait: 'tolerance',
      expected: adjacent(0.6, -1),
    },
    { values: [0, Number.MIN_VALUE], trait: 'preference', expected: 0 },
    {
      values: [0, Number.MIN_VALUE, Number.MIN_VALUE],
      trait: 'preference',
      expected: Number.MIN_VALUE,
    },
    { values: [0, 1], trait: 'preference', expected: 0.5 },
    { values: [1, adjacent(1, -1)], trait: 'preference', expected: 1 },
    {
      values: [1, adjacent(1, -1), adjacent(1, -1)],
      trait: 'preference',
      expected: adjacent(1, -1),
    },
    { values: [Number.MIN_VALUE, 0.5], trait: 'preference', expected: 0.25 },
    { values: [2 ** -1022, adjacent(2 ** -1022, -1)], trait: 'preference', expected: 2 ** -1022 },
    { values: [0, 2 ** -1022], trait: 'preference', expected: 2 ** -1023 },
    {
      values: [Number.MIN_VALUE, 2 * Number.MIN_VALUE],
      trait: 'preference',
      expected: 2 * Number.MIN_VALUE,
    },
    { values: [-0, 0], trait: 'preference', expected: 0 },
  ] as const)('rounds the exact $trait mean once for $values', ({ values, trait, expected }) => {
    for (const ordered of [values, [...values].reverse()]) {
      const world = empty(),
        control = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0 }, false, {
          telemetry: false,
        });
      for (const [position, value] of ordered.entries())
        for (const target of [world, control])
          target.spawn({ ...single(7, 0.5), tolerance: 0.6, [trait]: value }, position * 2, 0);
      advance(world, 30);
      advance(control, 30);
      const sample = world.save().telemetry.samples[0];
      expect(sample[trait === 'preference' ? 'meanPreference' : 'meanTolerance']).toBe(expected);
      expect(ecology(world.save())).toEqual(ecology(control.save()));
      const restored = Ecosystem.load(JSON.stringify(world.save()));
      advance(world, 100);
      advance(restored, 100);
      expect(JSON.stringify(restored.save())).toBe(JSON.stringify(world.save()));
      if (Object.is(ordered[0], -0))
        expect(Object.is([...world.organisms.values()][0].genome.preference, -0)).toBe(true);
    }
  });

  it.each([
    ['preference', -Number.MIN_VALUE],
    ['preference', adjacent(1, 1)],
    ['preference', NaN],
    ['tolerance', adjacent(0.12, -1)],
    ['tolerance', adjacent(0.6, 1)],
  ] as const)('rejects an invalid internal %s before averaging can conceal it', (trait, value) => {
    const world = colony(2, 0.3);
    advance(world, 29);
    [...world.organisms.values()][0].genome[trait] = value;
    expect(() => world.step()).toThrow('Invalid telemetry source trait');
    expect(world.save().telemetry.samples).toEqual([]);
  });
  it('retains endpoint history after real erasure, then observes null means only at the next boundary', () => {
    const world = colony(3, 0.12);
    advance(world, 30);
    const previous = world.save().telemetry.samples;
    for (const organism of [...world.organisms.values()])
      world.paint('erase', organism.x, organism.y, 0, single());
    expect(world.save().telemetry.samples).toEqual(previous);
    expect(world.save().telemetry.pending.deaths.manual).toBe(3);
    advance(world, 30);
    expect(world.save().telemetry.samples[0]).toEqual(previous[0]);
    expect(world.save().telemetry.samples[1]).toMatchObject({
      tick: 60,
      population: 0,
      meanPreference: null,
      meanTolerance: null,
      cellCounts: [0, 0, 0, 0, 0, 0],
    });
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
  });
});

describe('actual-operation energy and terminal causes', () => {
  it('samples post-tick births/deaths at the true boundary and excludes newborns from that tick update', () => {
    const world = empty(),
      parent = world.spawn(single(7), 20, 20)!,
      aging = world.spawn(single(7), 40, 40)!,
      exhausted = world.spawn(single(7), 60, 60)!;
    advance(world, 29);
    parent.age = 32;
    parent.energy = 100;
    aging.age = 975;
    exhausted.age = 975;
    exhausted.energy = 0;
    world.step();
    const [sample] = world.save().telemetry.samples,
      child = [...world.organisms.values()].find((organism) => organism.id !== parent.id)!;
    expect(sample).toMatchObject({
      tick: 30,
      population: 2,
      births: 1,
      deaths: { age: 1, energy: 1, manual: 0 },
      cellCounts: [0, 0, 0, 0, 2, 0],
    });
    expect(child.age).toBe(0);
    expect(sample.energy.offspringGranted).toBe(child.energy);
    expect(world.save().telemetry.pending.births).toBe(0);
    expect(world.save().telemetry.pending.deaths).toEqual({ age: 0, energy: 0, manual: 0 });
  });

  it('records exact before/after intake and the original unsplit upkeep with included climate attribution', () => {
    const world = empty(),
      leaf = world.spawn({ ...single(4, 0), tolerance: 0.12 }, 10, 10)!,
      mouth = world.spawn({ ...single(3, 0.5), tolerance: 0.6 }, 30, 30)!,
      motor = world.spawn(single(5), 50, 50)!;
    motor.age = 1;
    world.food[index(31, 30)] = 1;
    world.food[index(30, 31)] = 1;
    const initial = [leaf.energy, mouth.energy, motor.energy],
      stress = 0.5 - 0.12,
      leafAfterUpkeep = initial[0] - (0.012 + stress * 0.2),
      mouthAfterUpkeep = initial[1] - (0.012 + (0.6 - 0.2) * 0.025),
      motorAfterUpkeep = initial[2] - (0.012 + (0.3 - 0.2) * 0.025),
      firstBite = mouthAfterUpkeep + 2.2,
      secondBite = firstBite + 2.2;
    world.step();
    const ledger = world.save().telemetry.pending.energy;
    expect(leaf.energy).toBe(
      leafAfterUpkeep + 0.04 * (0.65 + 0.35 * Math.sin(1 / 180)) * (1 - stress),
    );
    expect(mouth.energy).toBe(secondBite);
    expect(motor.energy).toBe(motorAfterUpkeep - 0.03);
    expect(ledger.leavesGained).toBe(leaf.energy - leafAfterUpkeep);
    expect(ledger.mouthsGained).toBe(firstBite - mouthAfterUpkeep + (secondBite - firstBite));
    expect(ledger.upkeepSpent).toBe(
      initial[0] -
        leafAfterUpkeep +
        (initial[1] - mouthAfterUpkeep) +
        (initial[2] - motorAfterUpkeep),
    );
    expect(ledger.movementSpent).toBe(motorAfterUpkeep - motor.energy);
    expect(ledger.climateUpkeepSpent).toBeCloseTo(
      stress * 0.2 + (0.6 - 0.2) * 0.025 + (0.3 - 0.2) * 0.025,
      14,
    );
    expect(ledger.climateUpkeepSpent).toBeLessThan(ledger.upkeepSpent);
    expect(ledger.reproductionSpent).toBe(0);
    expect(ledger.offspringGranted).toBe(0);
  });

  it.each(['translation', 'rotation', 'blocked'] as const)(
    'charges movement once for %s without changing movement rules',
    (mode) => {
      const world = empty(),
        mover = world.spawn(
          {
            ...single(5),
            cells: [
              { x: 0, y: 0, type: 5 },
              { x: 1, y: 0, type: 7 },
            ],
          },
          50,
          50,
        )!;
      mover.age = 1;
      if (mode !== 'translation')
        for (const [dx, dy] of [
          [2, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ])
          world.walls[index(50 + dx, 50 + dy)] = 1;
      if (mode === 'rotation') {
        world.walls[index(50, 51)] = 0;
        world.walls[index(51, 51)] = 1;
        mover.direction = 0;
      }
      const before = mover.energy,
        afterUpkeep = before - (0.012 + (0.3 - 0.2) * 0.025) * 2;
      world.step();
      expect(world.save().telemetry.pending.energy.movementSpent).toBe(afterUpkeep - mover.energy);
      expect(mover.energy).toBe(afterUpkeep - 0.03);
      if (mode === 'rotation') expect(mover.rotation).toBe(1);
      if (mode === 'blocked') expect([mover.x, mover.y, mover.rotation]).toEqual([50, 50, 0]);
      if (mode === 'translation') expect([mover.x, mover.y]).not.toEqual([50, 50]);
    },
  );

  it.each(['successful', 'blocked', 'capped'] as const)(
    'records reproduction transfer only on %s placement',
    (mode) => {
      const world = mode === 'capped' ? colony(LIMIT, 0.3) : empty(),
        parent =
          mode === 'capped' ? [...world.organisms.values()][0] : world.spawn(single(7), 20, 20)!;
      parent.age = 32;
      parent.energy = 100;
      if (mode === 'blocked') {
        world.walls.fill(1);
        for (const place of positions(parent)) world.walls[place] = 0;
      }
      const afterUpkeep = parent.energy - (0.012 + (0.3 - 0.2) * 0.025);
      world.step();
      const pending = world.save().telemetry.pending;
      if (mode === 'successful') {
        const child = [...world.organisms.values()][1];
        expect(child.energy).toBe(4.5);
        expect(child.age).toBe(0);
        expect(pending.births).toBe(1);
        expect(pending.energy.offspringGranted).toBe(child.energy);
        expect(pending.energy.reproductionSpent).toBe(afterUpkeep - parent.energy);
        expect(parent.energy).toBe(afterUpkeep - (child.energy + 2));
      } else {
        expect(pending.births).toBe(0);
        expect(pending.energy.reproductionSpent).toBe(0);
        expect(pending.energy.offspringGranted).toBe(0);
        expect(parent.energy).toBe(afterUpkeep);
      }
    },
  );

  it('uses energy-first terminal classification and counts whole-body erasure once', () => {
    const world = empty(),
      energy = world.spawn(single(7), 10, 10)!,
      age = world.spawn(single(7), 20, 20)!,
      both = world.spawn(single(7), 30, 30)!,
      erased = world.spawn(founder(2), 0, 0, undefined, undefined, 1)!;
    energy.energy = 0;
    age.age = 975;
    both.energy = 0;
    both.age = 975;
    world.step();
    expect(world.frame().telemetry.pending.deaths).toEqual({ age: 1, energy: 2, manual: 0 });
    erased.age = 2000;
    erased.energy = -1;
    world.paint('erase', 0, 0, 1, single());
    expect(world.frame().telemetry.pending.deaths).toEqual({ age: 1, energy: 2, manual: 1 });
    expect(world.deaths).toBe(4);
    expect(world.frame().telemetry.samples).toEqual([]);
    advance(world, 29);
    expect(world.frame().telemetry.samples[0]).toMatchObject({
      population: 0,
      deaths: { age: 1, energy: 2, manual: 1 },
    });
  });

  it('records nonexclusive gross sting evidence while a victim feeds and recovers before its death check', () => {
    const world = empty(),
      attacker = world.spawn(single(6), 10, 10)!,
      victim = world.spawn(single(3), 11, 10)!;
    attacker.age = 3;
    victim.energy = 1;
    world.food[index(12, 10)] = 1;
    world.step();
    expect(world.organisms.has(victim.id)).toBe(true);
    expect(victim.energy).toBeGreaterThan(0);
    expect(world.save().telemetry.pending.deaths).toEqual({ age: 0, energy: 0, manual: 0 });
    expect(world.save().telemetry.pending.energy.stingsDrained).toBe(2.5);
    const attackerAfterUpkeep = 9 - (0.012 + (0.3 - 0.2) * 0.025);
    expect(world.save().telemetry.pending.energy.stingsGained).toBe(
      attacker.energy - attackerAfterUpkeep,
    );
    expect(world.save().telemetry.pending.energy.mouthsGained).toBeGreaterThan(0);
  });

  it('does not kill a victim drained after its turn until its next real death check', () => {
    const world = empty(),
      victim = world.spawn(single(3), 11, 10)!,
      attacker = world.spawn(single(6), 10, 10)!;
    victim.energy = 2;
    attacker.age = 3;
    world.step();
    expect(victim.energy).toBeLessThan(0);
    expect(world.organisms.has(victim.id)).toBe(true);
    expect(world.save().telemetry.pending.deaths.energy).toBe(0);
    world.step();
    expect(world.organisms.has(victim.id)).toBe(false);
    expect(world.save().telemetry.pending.deaths).toEqual({ age: 0, energy: 1, manual: 0 });
    expect(world.save().telemetry.pending.energy.stingsDrained).toBe(2.5);
  });

  it('does not clamp drains on negative-energy victims and armor records zero transfer', () => {
    for (const armored of [false, true]) {
      const world = empty(),
        first = world.spawn(single(6), 10, 10)!,
        second = world.spawn(single(6), 12, 10)!,
        victim = world.spawn(single(armored ? 7 : 3), 11, 10)!;
      first.age = second.age = 3;
      victim.energy = 1;
      world.step();
      const pending = world.save().telemetry.pending;
      expect(pending.energy.stingsDrained).toBe(armored ? 0 : 5);
      expect(pending.deaths.energy).toBe(armored ? 0 : 1);
      expect(world.organisms.has(victim.id)).toBe(armored);
      if (armored) expect(pending.energy.stingsGained).toBe(0);
      else expect(pending.energy.stingsGained).toBeGreaterThan(1.2);
    }
  });
});

describe('measured thermal adaptation', () => {
  it('measures populated 1600-organism/16-cell/eight-ancestor full-history UTF-8 payloads', () => {
    const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false);
    world.nextId = 999_998_000;
    world.nextSpecies = 1_000_000_000;
    for (let position = 0; position < LIMIT; position++) {
      const genome: Genome = {
        cells: Array.from({ length: 16 }, (_, cell) => ({
          x: cell % 4,
          y: Math.floor(cell / 4),
          type: (3 + (cell % 6)) as CellType,
        })),
        preference: ((position % 10) + 0.12345678901234568) / 10,
        tolerance: 0.3456789012345679,
        tempo: 12,
      };
      const organism = world.spawn(
        genome,
        (position % 60) * 4,
        Math.floor(position / 60) * 4,
        999_999_999,
      )!;
      organism.energy = 80000.12345678901;
      organism.generation = 999_999_999;
      organism.children = 999_999_999;
      organism.ancestry = Array(8).fill(999_999_999);
    }
    world.births = 999_999_999;
    world.deaths = 999_999_999;
    const size = (file: unknown) => new TextEncoder().encode(JSON.stringify(file)).byteLength;
    const emptyHistoryBytes = size(world.save());
    advance(world, 30);
    expect(world.organisms.size).toBe(LIMIT);
    const saved = world.save(),
      observation = saved.telemetry.samples[0];
    saved.tick = 5400;
    saved.telemetry.samples = Array.from({ length: 180 }, (_, interval) => ({
      ...structuredClone(observation),
      fromTick: interval * 30,
      tick: (interval + 1) * 30,
    }));
    saved.telemetry.pending.fromTick = 5400;
    const restored = Ecosystem.load(JSON.stringify(saved));
    expect(restored.save()).toEqual(saved);
    const old = oldTelemetry(restored),
      fullHistoryBytes = size(saved),
      legacyFullHistoryBytes = size(old);
    expect(fullHistoryBytes).toBeLessThan(WORLD_MAX_BYTES);
    console.info(
      'TELEMETRY_SIZE_MEASUREMENTS',
      JSON.stringify({
        fixture:
          'Validated populated saturated-shape fixture: one real 1600-organism boundary repeated in 180 explicit schema-valid intervals for payload sizing, not an uninterrupted ecology trajectory',
        population: LIMIT,
        cellsPerOrganism: 16,
        ancestryPerOrganism: 8,
        samples: 180,
        emptyHistoryBytes,
        fullHistoryBytes,
        legacyFullHistoryBytes,
        addedBytes: fullHistoryBytes - legacyFullHistoryBytes,
        cap: WORLD_MAX_BYTES,
      }),
    );
  });

  it('retains raw paired observer timings with 1600 surviving organisms and exact ecology equality', () => {
    const enabled = colony(1600, 0.3),
      disabled = colony(1600, 0.3, 0.5, false),
      raw: object[] = [];
    for (const world of [enabled, disabled]) {
      for (const organism of world.organisms.values()) organism.energy = 100;
      advance(world, 29);
    }
    const measure = (world: Ecosystem) => {
      for (const organism of world.organisms.values()) {
        organism.age = 0;
        organism.energy = 100;
      }
      const start = performance.now();
      world.step();
      const boundaryMs = performance.now() - start;
      advance(world, 29);
      return { boundaryMs, thirtyTicksMs: performance.now() - start };
    };
    for (let pair = 0; pair < 45; pair++) {
      let observed, control;
      if (pair % 2) {
        control = measure(disabled);
        observed = measure(enabled);
      } else {
        observed = measure(enabled);
        control = measure(disabled);
      }
      expect(enabled.organisms.size).toBe(1600);
      expect(ecology(enabled.save())).toEqual(ecology(disabled.save()));
      if (pair >= 5)
        raw.push({
          pair: pair - 5,
          tick: enabled.tick,
          population: enabled.organisms.size,
          first: pair % 2 ? 'disabled' : 'enabled',
          enabledBoundaryMs: observed.boundaryMs,
          disabledBoundaryMs: control.boundaryMs,
          enabledThirtyTicksMs: observed.thirtyTicksMs,
          disabledThirtyTicksMs: control.thirtyTicksMs,
        });
    }
    console.info(
      'TELEMETRY_OBSERVER_RAW',
      JSON.stringify({
        runtime: process.version,
        platform: platform(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        notes:
          'Same process/runtime; five warm-up pairs; alternating order; 1600 one-cell stationary organisms; identical explicit age/energy resets before each 30-tick observation; scheduler/CPU/GC noise not isolated; no universal throughput claim',
        raw,
      }),
    );
  });

  it('classifies stored binary64 endpoints and adjacent values without scaled rounding', () => {
    const values = [
        -0,
        0,
        Number.MIN_VALUE,
        1,
        ...PREFERENCE_ENDPOINTS.slice(0, -1).flatMap((endpoint) => [
          adjacent(endpoint, -1),
          endpoint,
          adjacent(endpoint, 1),
        ]),
      ],
      world = empty();
    values.forEach((preference, position) => world.spawn(single(7, preference), position * 3, 10));
    for (const organism of world.organisms.values()) organism.energy = 100;
    advance(world, 30);
    const sample = world.save().telemetry.samples[0],
      expected = Array(10).fill(0);
    for (const value of values)
      expected[Math.min(9, PREFERENCE_ENDPOINTS.filter((endpoint) => value >= endpoint).length)]++;
    expect(sample.population).toBe(values.length);
    expect(sample.adaptation!.preferenceBins).toEqual(expected);
  });

  it('samples boundary newborns and excludes boundary deaths rather than reusing the tick-start population', () => {
    const world = empty();
    advance(world, 29);
    const parent = world.spawn({ ...single(7, 0), tolerance: 0.12 }, 40, 40)!,
      doomed = world.spawn(single(7), 80, 80)!;
    parent.age = 32;
    parent.energy = 100;
    doomed.energy = 0.001;
    world.step();
    const sample = world.save().telemetry.samples[0];
    expect(sample).toMatchObject({
      tick: 30,
      population: 2,
      births: 1,
      deaths: { energy: 1 },
      adaptation: { stressedOrganisms: 2, preferenceBins: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    });
    expect(world.organisms.has(doomed.id)).toBe(false);
    expect([...world.organisms.values()].some((organism) => organism.age === 0)).toBe(true);
  });

  it('observes post-movement stress rather than the earlier upkeep location', () => {
    const source = new Ecosystem({ ...DEFAULTS, nutrients: 0, mutation: 0, climate: 1 }, false);
    advance(source, 29);
    const mover = source.spawn({ ...single(5), tolerance: 0.12 }, 40, 40)!;
    mover.age = 1;
    mover.energy = 100;
    mover.direction = 0;
    const saved = source.save();
    source.step();
    const moved = [...source.organisms.values()][0],
      before = temperature(40, 40, 30, 1),
      after = temperature(moved.x, moved.y, 30, 1);
    expect(after).not.toBe(before);
    saved.organisms[0].genome.preference = (before + after) / 2 - 0.12;
    const world = Ecosystem.load(JSON.stringify(saved));
    world.step();
    const preference = saved.organisms[0].genome.preference,
      earlyStress = Math.max(0, Math.abs(before - preference) - 0.12) > 0,
      lateStress = Math.max(0, Math.abs(after - preference) - 0.12) > 0;
    expect(lateStress).not.toBe(earlyStress);
    expect(world.save().telemetry.samples[0].adaptation!.stressedOrganisms).toBe(
      Number(lateStress),
    );
  });

  it.each(
    [0, 0.8, 1].flatMap((climate) => [30, 31].map((eventUntil) => ({ climate, eventUntil }))),
  )(
    'uses real post-tick anchors with climate $climate and event expiry $eventUntil',
    ({ climate, eventUntil }) => {
      const world = new Ecosystem({ ...DEFAULTS, climate, nutrients: 0, mutation: 0 }, false);
      for (let organism = 0; organism < 80; organism++) {
        const genome = organism % 2 ? founder(1) : single(7, organism / 80);
        genome.tolerance = organism % 3 ? 0.12 : 0.6;
        world.spawn(genome, (organism * 3) % WIDTH, Math.floor((organism * 3) / WIDTH) * 10 + 20);
      }
      world.shock('heat');
      world.eventUntil = eventUntil;
      advance(world, 30);
      const sample = world.save().telemetry.samples[0];
      let expected = 0;
      for (const organism of world.organisms.values()) {
        const local = temperature(
          organism.x,
          organism.y,
          30,
          climate,
          30 < eventUntil ? world.eventOffset : 0,
        );
        if (
          Math.max(0, Math.abs(local - organism.genome.preference) - organism.genome.tolerance) > 0
        )
          expected++;
      }
      expect(sample.adaptation!.stressedOrganisms).toBe(expected);
      expect(sample.adaptation!.preferenceBins.reduce((total, count) => total + count, 0)).toBe(
        world.organisms.size,
      );
    },
  );

  it('distinguishes exact tolerance, broad-tolerance upkeep, empty populations and detached bins', () => {
    const world = empty();
    for (const preference of [
      0.25,
      adjacent(0.25, -1),
      adjacent(adjacent(0.25, -1), -1),
      adjacent(0.25, 1),
      0.5,
    ]) {
      const organism = world.spawn(
        { ...single(7, preference), tolerance: preference === 0.5 ? 0.6 : 0.25 },
        world.organisms.size * 10,
        10,
      )!;
      organism.energy = 100;
    }
    advance(world, 30);
    const saved = world.save(),
      sample = saved.telemetry.samples[0];
    expect(sample.adaptation!.stressedOrganisms).toBe(1);
    expect(sample.energy.climateUpkeepSpent).toBeGreaterThan(0);
    sample.adaptation!.preferenceBins[0] = 1600;
    world.frame().telemetry.samples[0].adaptation!.stressedOrganisms = 1600;
    expect(world.save().telemetry.samples[0].adaptation!.stressedOrganisms).toBe(1);
    expect(world.save().telemetry.samples[0].adaptation!.preferenceBins[0]).toBe(0);
    world.paint('erase', 0, 10, 0, single());
    for (const organism of [...world.organisms.values()]) world.kill(organism, 'manual');
    advance(world, 30);
    expect(world.save().telemetry.samples[1]).toMatchObject({
      population: 0,
      meanPreference: null,
      meanTolerance: null,
      adaptation: { preferenceBins: Array(10).fill(0), stressedOrganisms: 0 },
    });
  });

  it.each([30, 65, 5430])(
    'strictly migrates every v3 scalar and pending flow at tick %i',
    (tick) => {
      const world = new Ecosystem();
      advance(world, tick);
      world.paint('erase', WIDTH / 2, HEIGHT / 2, 0, founder(0));
      const legacy = oldTelemetry(world),
        restored = Ecosystem.load(JSON.stringify(legacy)),
        saved = restored.save();
      expect(saved.telemetry.adaptationOriginTick).toBe(tick);
      expect(saved.telemetry.originTick).toBe(legacy.telemetry.originTick);
      expect(saved.telemetry.pending).toEqual(legacy.telemetry.pending);
      expect(
        saved.telemetry.samples.map(({ adaptation, ...sample }) => {
          expect(adaptation).toBeNull();
          return sample;
        }),
      ).toEqual(legacy.telemetry.samples);
      expect(ecology(saved)).toEqual({ ...ecology(world.save()), version: 4 });
      const nextBoundary = (Math.floor(tick / 30) + 1) * 30;
      advance(restored, nextBoundary - tick);
      expect(restored.save().telemetry.samples.at(-1)!.adaptation).not.toBeNull();
      const roundtrip = Ecosystem.load(JSON.stringify(restored.save()));
      advance(restored, 100);
      advance(roundtrip, 100);
      expect(roundtrip.save()).toEqual(restored.save());
      for (const invalid of [
        { ...legacy, telemetry: { ...legacy.telemetry, version: 2 } },
        { ...legacy, telemetry: { ...legacy.telemetry, adaptationOriginTick: tick } },
        {
          ...legacy,
          telemetry: {
            ...legacy.telemetry,
            samples: legacy.telemetry.samples.map((sample) => ({ ...sample, adaptation: null })),
          },
        },
      ])
        expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
    },
  );

  it('rejects all malformed adaptation/provenance shapes including a corrupt last record', () => {
    const world = new Ecosystem();
    advance(world, 60);
    const saved = world.save();
    for (const adaptation of [
      undefined,
      null,
      {},
      [],
      { preferenceBins: Array(9).fill(0), stressedOrganisms: 0 },
      ...[-1, 0.5, '1', null, 1601].map((count) => ({
        preferenceBins: [count, ...Array(9).fill(0)],
        stressedOrganisms: 0,
      })),
      {
        preferenceBins: [saved.telemetry.samples[1].population, ...Array(9).fill(0)],
        stressedOrganisms: 1601,
      },
      { ...saved.telemetry.samples[1].adaptation, extra: 1 },
    ]) {
      const invalid = structuredClone(saved);
      invalid.telemetry.samples[1].adaptation = adaptation as never;
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
    }
    for (const origin of [-1, 0.5, 61, 60]) {
      const invalid = structuredClone(saved);
      invalid.telemetry.adaptationOriginTick = origin;
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
    }
    expect(world.save()).toEqual(saved);
  });

  it('enforces the 2.5MB UTF-8 cap, including multibyte extensions, without truncation', () => {
    const saved = JSON.stringify(empty().save());
    expect(Ecosystem.load(saved + ' '.repeat(WORLD_MAX_BYTES - saved.length)).save()).toEqual(
      empty().save(),
    );
    expect(() => Ecosystem.load(saved + ' '.repeat(WORLD_MAX_BYTES - saved.length + 1))).toThrow(
      '2.5 MB',
    );
    const multibyte = JSON.stringify({ ...empty().save(), extension: 'é'.repeat(1_250_000) });
    expect(multibyte.length).toBeLessThan(WORLD_MAX_BYTES);
    expect(() => Ecosystem.load(multibyte)).toThrow('2.5 MB');
  });
});

describe('telemetry persistence, migration and complete candidate validation', () => {
  function recorded(): Ecosystem {
    const world = colony(1, 0.3);
    world.paint('food', 100, 100, 0, single());
    advance(world, 65);
    world.paint('erase', 0, 0, 0, single());
    return world;
  }
  const legacy = (tick: number, populated: boolean): LegacyWorldFile => ({
    version: 2,
    settings: { seed: 42, mutation: 0.12, nutrients: 5, climate: 0.8 },
    random: -2147483000,
    tick,
    births: 19,
    deaths: 20,
    nextId: 2,
    nextSpecies: 5,
    eventUntil: tick + 100,
    eventOffset: -0.32,
    food: [2400],
    walls: [3000],
    organisms: populated
      ? [
          {
            id: 1,
            species: 1,
            x: 10,
            y: 10,
            rotation: 0,
            direction: 1,
            age: 0,
            energy: 9,
            generation: 0,
            children: 0,
            ancestry: [],
            genome: { cells: [{ x: 0, y: 0, type: 7 }], preference: 0.5, tolerance: 0.3, tempo: 2 },
          },
        ]
      : [],
  });

  it.each([0, 25, 29, 30, 31])(
    'migrates literal populated/empty v2 worlds at tick %i with explicitly empty history',
    (tick) => {
      for (const populated of [false, true]) {
        const file = legacy(tick, populated),
          world = Ecosystem.load(
            JSON.stringify({ ...file, telemetry: { untrusted: 'ignored legacy extension' } }),
          ),
          { version: _version, ...expectedEcology } = file,
          { version: current, ...actualEcology } = ecology(world.save());
        expect(current).toBe(4);
        expect(actualEcology).toEqual(expectedEcology);
        expect(world.save().telemetry).toMatchObject({
          originTick: tick,
          samples: [],
          pending: { fromTick: tick, births: 0, deaths: { age: 0, energy: 0, manual: 0 } },
        });
        expect(Object.values(world.save().telemetry.pending.energy)).toEqual(Array(9).fill(0));
        world.frame();
        const restored = Ecosystem.load(JSON.stringify(world.save())),
          firstTick = (Math.floor(tick / 30) + 1) * 30;
        advance(world, firstTick - tick);
        advance(restored, firstTick - tick);
        expect(world.save().telemetry.samples[0]).toMatchObject({
          fromTick: tick,
          tick: firstTick,
        });
        expect(restored.save()).toEqual(world.save());
        advance(world, 100);
        advance(restored, 100);
        expect(restored.save()).toEqual(world.save());
      }
    },
  );

  it.each([29, 30, 36, 59, 60, 61])(
    'restores pending operations/history exactly at tick %i and continues for 100 ticks',
    (tick) => {
      const world = new Ecosystem();
      advance(world, tick);
      world.paint('erase', WIDTH / 2, HEIGHT / 2, 0, founder(0));
      const saved = world.save(),
        restored = Ecosystem.load(JSON.stringify(saved));
      expect(restored.save()).toEqual(saved);
      advance(world, 100);
      advance(restored, 100);
      expect(restored.save()).toEqual(world.save());
    },
  );

  it('retains historical scalars independently of current organisms and permits the exact ledger ceiling', () => {
    const world = recorded(),
      saved = world.save();
    saved.telemetry.samples[0].meanPreference = Number.MIN_VALUE;
    saved.telemetry.samples[0].meanTolerance = adjacent(0.12, 1);
    for (const ledger of [
      saved.telemetry.pending.energy,
      ...saved.telemetry.samples.map((sample) => sample.energy),
    ])
      for (const key of Object.keys(ledger) as (keyof typeof ledger)[]) ledger[key] = 1e9;
    const restored = Ecosystem.load(JSON.stringify(saved));
    expect(restored.save()).toEqual(saved);
    expect(restored.organisms.size).toBe(0);
    expect(world.save()).not.toEqual(saved);
  });

  it('rejects missing/unknown fields and malformed nesting everywhere without changing the active state', () => {
    const world = recorded(),
      saved = world.save();
    const targets = [
      (file: WorldFile) => file.telemetry,
      (file: WorldFile) => file.telemetry.pending,
      (file: WorldFile) => file.telemetry.pending.deaths,
      (file: WorldFile) => file.telemetry.pending.energy,
      (file: WorldFile) => file.telemetry.samples[0],
      (file: WorldFile) => file.telemetry.samples[0].deaths,
      (file: WorldFile) => file.telemetry.samples[0].energy,
      (file: WorldFile) => file.telemetry.samples[1],
      (file: WorldFile) => file.telemetry.samples[1].deaths,
      (file: WorldFile) => file.telemetry.samples[1].energy,
    ];
    for (const select of targets) {
      const keys = Object.keys(select(saved));
      for (const key of [...keys, 'unknown']) {
        const invalid = structuredClone(saved),
          target = select(invalid) as unknown as Record<string, unknown>;
        if (key === 'unknown') target[key] = { arbitrary: ['not retained'] };
        else delete target[key];
        expect(() => Ecosystem.load(JSON.stringify(invalid)), key).toThrow('telemetry');
        expect(world.save()).toEqual(saved);
      }
    }
    for (const field of ['pending', 'samples', 'telemetry'] as const)
      for (const value of [null, 12, 'data', {}]) {
        const invalid: any = structuredClone(saved);
        if (field === 'telemetry') invalid.telemetry = value;
        else invalid.telemetry[field] = value;
        expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
      }
    for (const field of ['deaths', 'energy'] as const)
      for (const value of [null, 0, 'data', []]) {
        const invalid: any = structuredClone(saved);
        invalid.telemetry.samples[1][field] = value;
        expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
        invalid.telemetry.pending[field] = value;
        expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
      }
  });

  it('rejects every scalar bound and type across retained samples and pending counts/energy', () => {
    const saved = recorded().save();
    for (const select of [
      (file: WorldFile) => file.telemetry.pending,
      (file: WorldFile) => file.telemetry.samples[0],
      (file: WorldFile) => file.telemetry.samples[1],
    ]) {
      for (const path of [
        'births',
        'deaths.age',
        'deaths.energy',
        'deaths.manual',
        ...Object.keys(saved.telemetry.pending.energy).map((key) => `energy.${key}`),
      ]) {
        const isEnergy = path.startsWith('energy.');
        for (const value of [-1, 1e9 + 1, null, '0', NaN, Infinity, ...(isEnergy ? [] : [0.5])]) {
          const invalid: any = structuredClone(saved),
            parts = path.split('.'),
            target = select(invalid) as any;
          if (parts.length === 1) target[path] = value;
          else target[parts[0]][parts[1]] = value;
          expect(() => Ecosystem.load(JSON.stringify(invalid)), `${path}: ${value}`).toThrow(
            'telemetry',
          );
        }
      }
    }
    for (const select of [
      (file: WorldFile) => file.telemetry.pending,
      (file: WorldFile) => file.telemetry.samples[1],
    ])
      for (const field of ['climateUpkeepSpent', 'offspringGranted'] as const) {
        const invalid = structuredClone(saved),
          ledger = select(invalid).energy;
        ledger[field] = 100;
        expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
      }
  });

  it('rejects corrupt cadence, origins, history length, cell totals, trait semantics and lifetime totals', () => {
    const world = recorded(),
      saved = world.save(),
      mutations: ((file: any) => void)[] = [
        (file) => delete file.telemetry,
        (file) => {
          (file.telemetry as { version: number }).version = 3;
        },
        (file) => {
          file.telemetry.intervalTicks = 12;
        },
        (file) => {
          file.telemetry.intervalTicks = '30';
        },
        (file) => {
          file.telemetry.originTick = -1;
        },
        (file) => {
          file.telemetry.originTick = 0.5;
        },
        (file) => {
          file.telemetry.originTick = 66;
        },
        (file) => {
          file.telemetry.originTick = 30;
        },
        (file) => {
          file.telemetry.pending.fromTick = 59;
        },
        (file) => {
          file.telemetry.pending.fromTick = '60';
        },
        (file) => {
          file.telemetry.samples = [];
        },
        (file) => {
          file.telemetry.samples.reverse();
        },
        (file) => {
          file.telemetry.samples.push(file.telemetry.samples[1]);
        },
        (file) => {
          file.telemetry.samples = Array(181).fill(file.telemetry.samples[0]);
        },
        (file) => {
          file.telemetry.samples[1].tick = 30;
        },
        (file) => {
          file.telemetry.samples[1].tick = 90;
        },
        (file) => {
          file.telemetry.samples[1].tick = 48;
        },
        (file) => {
          file.telemetry.samples[0].tick = 12;
        },
        (file) => {
          file.telemetry.samples[0].tick = 24;
        },
        (file) => {
          file.telemetry.samples[0].tick = 36;
        },
        (file) => {
          file.telemetry.samples[0].fromTick = 18;
        },
        (file) => {
          file.telemetry.samples[1].fromTick = 48;
        },
        (file) => {
          file.telemetry.samples[1].population = 1601;
        },
        (file) => {
          file.telemetry.samples[1].population = -1;
        },
        (file) => {
          file.telemetry.samples[1].population = 1.5;
        },
        (file) => {
          file.telemetry.samples[1].food = WIDTH * HEIGHT + 1;
        },
        (file) => {
          file.telemetry.samples[1].food = -1;
        },
        (file) => {
          file.telemetry.samples[1].food = '0';
        },
        (file) => {
          file.telemetry.samples[1].cellCounts = [1];
        },
        (file) => {
          file.telemetry.samples[1].cellCounts = null;
        },
        (file) => {
          file.telemetry.samples[1].cellCounts = [1, 0, 0, 0, 0, 0, 0];
        },
        (file) => {
          file.telemetry.samples[1].cellCounts = [0, 0, 0, 0, 0, 0];
        },
        (file) => {
          file.telemetry.samples[1].cellCounts = [17, 0, 0, 0, 0, 0];
        },
        (file) => {
          file.telemetry.samples[1].cellCounts[0] = 25601;
        },
        (file) => {
          file.telemetry.samples[1].cellCounts[0] = -1;
        },
        (file) => {
          file.telemetry.samples[1].cellCounts[0] = 0.5;
        },
        (file) => {
          file.telemetry.samples[1].cellCounts[0] = null;
        },
        (file) => {
          file.telemetry.samples[1].population = 0;
          file.telemetry.samples[1].cellCounts.fill(0);
        },
        (file) => {
          file.telemetry.pending.births = 1;
        },
        (file) => {
          file.telemetry.samples[0].births = 1;
        },
        (file) => {
          file.telemetry.samples[1].deaths.age = 1;
        },
        (file) => {
          file.telemetry.samples[1].deaths.energy = 1;
        },
        (file) => {
          file.telemetry.samples[1].deaths.manual = 1;
        },
      ];
    for (const mutate of mutations) {
      const invalid = structuredClone(saved);
      mutate(invalid);
      expect(() => Ecosystem.load(JSON.stringify(invalid)), mutate.toString()).toThrow('telemetry');
      expect(world.save()).toEqual(saved);
    }
    const boundaryMissing = legacy(29, false),
      file = Ecosystem.load(JSON.stringify(boundaryMissing)).save();
    file.tick = 30;
    expect(() => Ecosystem.load(JSON.stringify(file))).toThrow('telemetry');
  });

  it.each([
    ['meanPreference', -Number.MIN_VALUE],
    ['meanPreference', adjacent(1, 1)],
    ['meanPreference', '0.5'],
    ['meanPreference', null],
    ['meanPreference', -0.1],
    ['meanTolerance', adjacent(0.12, -1)],
    ['meanTolerance', adjacent(0.6, 1)],
    ['meanTolerance', 0.1],
    ['meanTolerance', 0.7],
    ['meanTolerance', null],
    ['meanTolerance', '0.3'],
  ] as const)(
    'strictly rejects historical %s=%s, including adjacent-invalid values, without snapping',
    (field, value) => {
      const saved = recorded().save();
      for (const index of [0, 1]) {
        const invalid: any = structuredClone(saved);
        invalid.telemetry.samples[index][field] = value;
        expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
      }
    },
  );

  it('requires null empty means and independently validates every current genome trait', () => {
    const world = empty();
    advance(world, 30);
    for (const field of ['meanPreference', 'meanTolerance'] as const) {
      const invalid = world.save();
      invalid.telemetry.samples[0][field] = field === 'meanPreference' ? 0 : 0.3;
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('telemetry');
    }
    for (const [trait, value] of [
      ['preference', -Number.MIN_VALUE],
      ['preference', adjacent(1, 1)],
      ['tolerance', adjacent(0.12, -1)],
      ['tolerance', adjacent(0.6, 1)],
    ] as const) {
      const invalid = colony(2, 0.3).save();
      invalid.organisms[0].genome[trait] = value;
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow('organism');
    }
  });
});

describe('whole-world persistence', () => {
  it('restores every organism, terrain, counters and RNG state and continues identically', () => {
    const w = new Ecosystem();
    for (let i = 0; i < 100; i++) w.step();
    expect(w.spawn(founder(1), 2, 10)).toBeDefined();
    expect(w.spawn(founder(2), 2, 25)).toBeDefined();
    w.shock('heat');
    const saved = w.save();
    expect(saved.organisms.length).toBeGreaterThan(1);
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
