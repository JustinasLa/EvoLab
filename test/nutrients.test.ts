import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  WORLD_VERSION,
  founder,
  index,
  positions,
  type Genome,
} from '../src/model';
import {
  createNutrients,
  nutrientFile,
  nutrientSummary,
  parseNutrients,
  recycleNutrients,
  validateNutrients,
  NUTRIENT_TOTAL,
  ORGANISM_ENERGY_LIMIT,
  storedEnergy,
} from '../src/nutrients';
import { nutrientDescription, nutrientMarkup } from '../src/nutrient-view';
import { measurementEnvelope } from '../src/measurement-export';

const genome = (type: 3 | 4 | 5 | 6 = 4): Genome => ({
  cells: [{ x: 0, y: 0, type }],
  preference: 0.5,
  tolerance: 0.2,
  tempo: 2,
  behavior: { version: 1, mode: 'legacy' },
});
const habitat = (seed = false) =>
  new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 20 }, seed, {
    nutrientCycle: true,
    terrain: { version: 1, preset: 'open-field', seed: null },
  });
function summary(world: Ecosystem) {
  return nutrientSummary(world.nutrientCycle!, world.organisms.values(), world.food);
}
function check(world: Ecosystem) {
  expect(summary(world).total).toBe(NUTRIENT_TOTAL);
  validateNutrients(world.nutrientCycle!, world.organisms.values(), world.food);
  expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
}

describe('finite nutrient ecology', () => {
  it('keeps ecological-role observation passive under the enabled resource costs', () => {
    const world = habitat(true),
      reference = Ecosystem.load(JSON.stringify(world.save()));
    world.observeRoles();
    for (let tick = 0; tick < 40; tick++) {
      world.step();
      reference.step();
    }
    expect(world.save()).toEqual(reference.save());
    expect(world.roleSnapshot()).toBeDefined();
  });
  it('initializes once, charges the founder, exposes detached fields and records units', () => {
    const world = habitat(true);
    expect(summary(world)).toMatchObject({
      minerals: NUTRIENT_TOTAL - 5,
      biomass: 5,
      food: 0,
      detritus: 0,
      total: NUTRIENT_TOTAL,
      budget: null,
    });
    const frame = world.frame();
    frame.nutrientCycle!.minerals.fill(0);
    expect(summary(world).minerals).toBe(NUTRIENT_TOTAL - 5);
    expect(world.presentation().nutrientCycle).toEqual(summary(world));
    expect(measurementEnvelope(world.measurements()).snapshot.nutrientCycle).toEqual(
      summary(world),
    );
    expect(nutrientDescription(summary(world), 0)).toContain('No completed tick');
    expect(nutrientDescription(undefined, 0)).toContain('Disabled');
    expect(nutrientMarkup()).toContain('next reseed');
    world.step();
    expect(nutrientDescription(summary(world), 1)).toContain('Last completed tick 1');
    check(world);
  });
  it('keeps disabled legacy ecology and RNG byte-identical to the version-15 migration', () => {
    const legacy = new Ecosystem();
    const state = legacy.save();
    const { nutrientCycle: _omitted, ...previous } = state;
    const migrated = Ecosystem.load(JSON.stringify({ ...previous, version: 15 }));
    for (let tick = 0; tick < 75; tick++) {
      legacy.step();
      migrated.step();
    }
    expect(migrated.save()).toEqual(legacy.save());
    expect(migrated.nutrientCycle).toBeNull();
    expect(parseNutrients(null, 0)).toBeNull();
  });
  it('funds real food, depletes leaves, gates sunlight and recycles eaten nutrients', () => {
    const world = habitat();
    const leaf = world.spawn(genome(), 10, 10)!;
    const source = index(10, 10);
    const available = world.nutrientCycle!.minerals[source];
    for (let tick = 0; tick < 31; tick++) world.step();
    expect(world.nutrientCycle!.minerals[source]).toBeLessThan(available);
    expect(summary(world).food).toBeGreaterThan(0);
    expect(world.nutrientCycle!.budget!.dissipated).toBeGreaterThan(0);
    check(world);
    const minerals = world.nutrientCycle!.minerals;
    minerals[0] += minerals[source];
    minerals[source] = 0;
    const energy = leaf.energy;
    world.tick = 32;
    world.step();
    expect(leaf.energy).toBeCloseTo(energy - 0.012);
    world.kill(leaf, 'manual');
    expect(summary(world).detritus).toBe(1);
    const food = world.food.findIndex(Boolean);
    const target = index((food % WIDTH) + 1, Math.floor(food / WIDTH));
    minerals[0]--;
    minerals[target]++;
    const mouth = world.spawn(genome(3), (food % WIDTH) + 1, Math.floor(food / WIDTH))!;
    const mouthPosition = positions(mouth)[0],
      before = minerals[mouthPosition];
    world.step();
    expect(minerals[mouthPosition]).toBeGreaterThan(before);
    expect(world.save().telemetry.pending.energy.mouthsGained).toBeGreaterThan(0);
    check(world);
  });
  it('rejects unaffordable full footprints, then funds birth and corpse deposition exactly once', () => {
    const world = habitat();
    const position = index(20, 20),
      cycle = world.nutrientCycle!;
    cycle.minerals[0] += cycle.minerals[position];
    cycle.minerals[position] = 0;
    expect(world.spawn(genome(), 20, 20)).toBeUndefined();
    expect(summary(world).biomass).toBe(0);
    const parent = world.spawn(founder(0), 100, 80)!;
    parent.age = 32;
    parent.energy = 100;
    world.step();
    expect(world.births).toBe(1);
    expect(summary(world).biomass).toBe(10);
    world.kill(parent, 'age');
    const after = summary(world);
    world.kill(parent, 'age');
    expect(summary(world)).toEqual(after);
    expect(after.detritus).toBe(5);
    check(world);
  });
  it('conserves matter through food painting, movement, erase, walls and regeneration', () => {
    const world = habitat();
    const mover = world.spawn(genome(5), 20, 20)!;
    world.paint('food', 21, 20, 0, genome());
    world.paint('food', 21, 20, 0, genome());
    expect(summary(world).food).toBe(1);
    expect(world.move(mover, 1, 0)).toBe(true);
    expect(summary(world).detritus).toBe(1);
    world.paint('food', 22, 20, 0, genome());
    world.spawn(genome(), 22, 20);
    expect(summary(world).detritus).toBe(2);
    world.paint('food', 30, 30, 0, genome());
    world.paint('wall', 30, 30, 0, genome());
    expect(summary(world).detritus).toBe(3);
    world.paint('food', 40, 40, 0, genome());
    world.paint('erase', 40, 40, 0, genome());
    world.paint('erase', 21, 20, 0, genome());
    expect(summary(world).detritus).toBe(5);
    world.paint('food', 50, 50, 8, genome());
    world.changeTerrain('regenerate', { version: 1, preset: 'porous-ridges', seed: null });
    check(world);
    world.changeTerrain('clear');
    world.step();
    check(world);
  });
  it('caps enabled energy and prevents stings from extracting nonexistent energy', () => {
    const world = habitat();
    const predator = world.spawn(genome(6), 40, 40)!,
      victim = world.spawn(genome(3), 41, 40)!;
    predator.age = 3;
    victim.energy = 0.1;
    world.step();
    expect(victim.energy).toBeLessThanOrEqual(0);
    expect(world.save().telemetry.pending.energy.stingsGained).toBeCloseTo(0.026);
    check(world);
    const leaf = world.spawn(genome(), 80, 80)!;
    leaf.energy = ORGANISM_ENERGY_LIMIT;
    world.step();
    expect(leaf.energy).toBeLessThanOrEqual(ORGANISM_ENERGY_LIMIT);
    check(world);
  });
  it('decays without energy or RNG, transports in all paired phases and wraps, with wall barriers', () => {
    const cycle = createNutrients(),
      walls = new Uint8Array(WIDTH * HEIGHT);
    cycle.minerals.fill(0);
    cycle.detritus[0] = 4;
    walls[0] = 1;
    recycleNutrients(cycle, walls, 1);
    recycleNutrients(cycle, walls, 32);
    expect(cycle.detritus[0]).toBe(4);
    walls[0] = 0;
    recycleNutrients(cycle, walls, 64);
    expect(cycle.detritus[0]).toBe(3);
    cycle.minerals[0] = 20;
    recycleNutrients(cycle, walls, 128);
    expect(cycle.minerals[index(0, HEIGHT - 1)]).toBe(1);
    recycleNutrients(cycle, walls, 192);
    expect(cycle.minerals[WIDTH - 1]).toBe(1);
    recycleNutrients(cycle, walls, 224);
    expect(cycle.minerals[WIDTH]).toBe(1);
  });
  it('continues empty-world recycling and bounded stored energy with deterministic saves', () => {
    const world = habitat(true);
    const body = [...world.organisms.values()][0];
    world.kill(body, 'manual');
    const random = world.random.state;
    for (let tick = 0; tick < 128; tick++) world.step();
    expect(summary(world)).toMatchObject({
      biomass: 0,
      detritus: 0,
      food: 0,
      total: NUTRIENT_TOTAL,
      energy: 0,
    });
    expect(world.random.state).toBe(random);
    expect(storedEnergy([], world.food)).toBe(0);
    check(world);
    expect(world.save().version).toBe(WORLD_VERSION);
  });
});

describe('complete nutrient import validation', () => {
  it('round trips exact arrays and rejects missing, malformed, excessive and inconsistent fields', () => {
    const cycle = createNutrients();
    expect(parseNutrients(nutrientFile(cycle), 0)).toEqual(cycle);
    const mutations: ((value: any) => void)[] = [
      (value) => {
        value.version = 2;
      },
      (value) => {
        value.extra = true;
      },
      (value) => {
        value.minerals.pop();
      },
      (value) => {
        value.detritus.push(0);
      },
      (value) => {
        value.minerals[0] = -1;
      },
      (value) => {
        value.minerals[0] = 0.5;
      },
      (value) => {
        value.detritus[0] = NUTRIENT_TOTAL + 1;
      },
      (value) => {
        value.budget = {};
      },
    ];
    for (const mutate of mutations) {
      const value = nutrientFile(cycle);
      mutate(value);
      expect(() => parseNutrients(value, 0)).toThrow();
    }
    expect(() => parseNutrients(undefined, 0)).toThrow();
    expect(() => parseNutrients(nutrientFile(cycle), 1)).toThrow('Missing');
    const world = habitat(true);
    world.step();
    const saved = world.save();
    saved.nutrientCycle!.budget!.after++;
    expect(() => Ecosystem.load(JSON.stringify(saved))).toThrow('budget');
    saved.nutrientCycle = nutrientFile(cycle);
    saved.nutrientCycle.budget = world.nutrientCycle!.budget;
    expect(() => Ecosystem.load(JSON.stringify(saved))).toThrow('conservation');
    const oversized = world.save();
    oversized.nutrientCycle!.minerals = Array(1_300_000).fill(0);
    expect(() => Ecosystem.load(JSON.stringify(oversized))).toThrow('2.5 MB');
    const overenergy = world.save();
    overenergy.organisms[0].energy = 1001;
    expect(() => Ecosystem.load(JSON.stringify(overenergy))).toThrow('energy bound');
  });
  it('rejects food hidden under terrain or bodies instead of silently destroying matter', () => {
    const world = habitat(true),
      saved = world.save();
    saved.food.push(positions(saved.organisms[0])[0]);
    expect(() => Ecosystem.load(JSON.stringify(saved))).toThrow('overlaps a body');
    saved.food = [0];
    saved.walls = [0];
    expect(() => Ecosystem.load(JSON.stringify(saved))).toThrow('overlaps a wall');
  });
});
