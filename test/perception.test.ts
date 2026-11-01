import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, WIDTH, index, positions, Random, type Genome, type Cell } from '../src/model';

const cells: Cell[] = [
  { x: 0, y: 0, type: 8 },
  { x: 1, y: 0, type: 5 },
  { x: 1, y: 1, type: 3 },
];
const genome = (parts = cells): Genome => ({
  cells: parts,
  preference: 0.5,
  tolerance: 0.2,
  tempo: 2,
  behavior: {
    version: 2,
    mode: 'evolved',
    reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
  },
});
function scene(parts = cells, x = 60, y = 60, rotation = 0) {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0, mutation: 0.4 }, false),
    mover = world.spawn(genome(parts), x, y, undefined, undefined, rotation)!;
  mover.age = 1;
  mover.direction = 0;
  mover.energy = 100;
  world.selectPerception(mover.id);
  return { world, mover };
}

describe('selected actual perception ownership', () => {
  it.each(['food', 'wall', 'harmless', 'dangerous', 'self', 'range'] as const)(
    'records first %s occlusion and actual reaction without resensing',
    (kind) => {
      const { world, mover } = scene(
        kind === 'self' ? [...cells, { x: 0, y: -1, type: 7 }] : cells,
      );
      const hit = index(60, 57);
      if (kind === 'food') world.food[hit] = 1;
      if (kind === 'wall') world.walls[hit] = 1;
      if (kind === 'harmless' || kind === 'dangerous')
        world.spawn(genome([{ x: 0, y: 0, type: kind === 'dangerous' ? 6 : 7 }]), 60, 57);
      const rng = world.random.state;
      expect(world.perception()).toBeNull();
      world.step();
      const trace = world.perception()!,
        ray = trace.rays[0];
      expect(trace).toMatchObject({
        id: mover.id,
        tick: 1,
        moved: true,
        finalDirection: mover.direction,
        finalRotation: mover.rotation,
      });
      expect(ray).toMatchObject({ eye: 0, origin: index(60, 60), heading: 0, stop: kind });
      const distance = kind === 'self' ? 1 : kind === 'range' ? 5 : 3;
      expect(ray.cells).toEqual(Array.from({ length: distance }, (_, i) => index(60, 59 - i)));
      expect(ray.reaction).toBe(
        kind === 'range' || kind === 'self'
          ? null
          : kind === 'food'
            ? 'chase'
            : kind === 'harmless'
              ? 'ignore'
              : 'flee',
      );
      expect(trace.chosenEye).toBe(
        kind === 'self' || kind === 'range' || kind === 'harmless' ? null : 0,
      );
      expect(world.random.state).toBe(rng);
      const retained = world.perception();
      trace.rays[0].cells.length = 0;
      trace.direction = 999;
      world.selectPerception(mover.id);
      expect(world.perception()).toEqual(retained);
      world.step(); // ineligible tempo: keep the exact original decision
      expect(world.perception()).toEqual(retained);
      world.selectPerception(0);
      expect(world.perception()).toBeNull();
    },
  );

  it.each([0, 1, 2, 3])(
    'records rotated, wrapped visited cells and first-hit ignore in heading %s',
    (rotation) => {
      const { world, mover } = scene(cells, 0, 0, rotation),
        [dx, dy] = [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ][rotation];
      if (mover.genome.behavior.mode !== 'evolved') throw new Error('test table');
      mover.genome.behavior.reactions.wall = 'ignore';
      world.walls[index(dx * 3, dy * 3)] = 1;
      world.food[index(dx * 4, dy * 4)] = 1;
      world.step();
      expect(world.perception()!.rays[0]).toEqual({
        eye: 0,
        origin: 0,
        heading: rotation,
        cells: [1, 2, 3].map((r) => index(dx * r, dy * r)),
        stop: 'wall',
        reaction: 'ignore',
      });
      expect(world.perception()!.chosenEye).toBeNull();
    },
  );

  it('distinguishes a chosen sensory direction from blocked translation and the actual fallback', () => {
    const { world } = scene();
    world.food[index(60, 57)] = 1;
    world.walls[index(61, 59)] = 1;
    const rng = new Random(world.random.state),
      fallback = rng.int(4);
    world.step();
    expect(world.perception()).toMatchObject({
      chosenEye: 0,
      direction: 3,
      moved: false,
      finalDirection: fallback,
      finalRotation: 1,
    });
    expect(world.random.state).toBe(rng.state);
    expect(world.save().telemetry.pending.energy.movementSpent).toBeCloseTo(0.03, 12);
  });

  it('records feeding before sensing and holds at most sixteen rays / eighty visits', () => {
    const { world, mover } = scene([
      { x: 0, y: 0, type: 8 },
      { x: 1, y: 0, type: 5 },
      { x: 1, y: -1, type: 3 },
    ]);
    world.food[index(60, 59)] = 1;
    world.step();
    expect(world.perception()!.rays[0].stop).toBe('range');
    expect(world.save().telemetry.pending.energy.mouthsGained).toBeCloseTo(2.2, 12);
    const many: Cell[] = Array.from({ length: 15 }, (_, i) => ({
      x: i % 5,
      y: Math.floor(i / 5),
      type: 8,
    }));
    many.push({ x: 0, y: 3, type: 5 });
    const crowded = scene(many);
    for (let tick = 0; tick < 100; tick++) crowded.world.step();
    const trace = crowded.world.perception()!;
    expect(trace.rays.length).toBeLessThanOrEqual(16);
    expect(trace.rays.reduce((sum, ray) => sum + ray.cells.length, 0)).toBeLessThanOrEqual(80);
    expect(mover.genome.cells).toHaveLength(3);
  });

  it('never allocates retained traces for unselected, passive or ineligible bodies; clears death and replacement', () => {
    const { world, mover } = scene();
    world.selectPerception(0);
    world.step();
    expect(world.perception()).toBeNull();
    world.selectPerception(mover.id);
    world.step();
    expect(world.perception()).toBeNull();
    world.step();
    expect(world.perception()).not.toBeNull();
    const other = world.spawn(genome([{ x: 0, y: 0, type: 8 }]), 90, 90)!;
    world.selectPerception(other.id);
    world.step();
    expect(world.perception()).toBeNull();
    const unsighted = world.spawn(genome([{ x: 0, y: 0, type: 5 }]), 120, 90)!;
    world.selectPerception(unsighted.id);
    world.step();
    world.step();
    expect(world.perception()).toBeNull();
    world.selectPerception(mover.id);
    world.step();
    world.step();
    expect(world.perception()).not.toBeNull();
    expect(Ecosystem.load(JSON.stringify(world.save())).perception()).toBeNull();
    world.kill(mover, 'manual');
    expect(world.perception()).toBeNull();
    world.selectPerception(999);
    expect(world.perception()).toBeNull();
    const passive = world.spawn(
      { ...genome(), behavior: { version: 1, mode: 'legacy' } },
      150,
      90,
    )!;
    world.selectPerception(passive.id);
    for (let tick = 0; tick < 12; tick++) world.step();
    expect(world.perception()).toBeNull();
  });

  it('keeps complete seeded ecology identical through selection changes, paused observation and save/load', () => {
    const { world: observed, mover } = scene();
    observed.food[index(60, 56)] = 1;
    const control = Ecosystem.load(JSON.stringify(observed.save()));
    for (let tick = 0; tick < 180; tick++) {
      const before = observed.save();
      observed.perception();
      observed.presentation(mover.id);
      expect(observed.save()).toEqual(before);
      if (tick % 7 === 0) observed.selectPerception(tick % 14 ? mover.id : 0);
      observed.step();
      control.step();
      expect(observed.save()).toEqual(control.save());
    }
    expect(JSON.stringify(observed.save())).not.toContain('Perception');
    expect(positions(mover).every((p) => p >= 0 && p < WIDTH * 156)).toBe(true);
  });
});
