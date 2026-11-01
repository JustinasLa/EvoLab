import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { sensoryDirection } from '../src/sensory';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { sameInherited } from '../src/lineage';
import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  Random,
  cloneGenome,
  index,
  positions,
  validBehavior,
  validGenome,
  mutate,
  type Behavior,
  type Genome,
  type Cell,
  type Reaction,
} from '../src/model';

const body: Cell[] = [
  { x: 0, y: 0, type: 8 },
  { x: 0, y: 1, type: 3 },
  { x: 1, y: 1, type: 5 },
];
const active = (reactions = {}): Behavior => ({
  version: 2,
  mode: 'evolved',
  reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee', ...reactions },
});
const genome = (cells = body, behavior = active()): Genome => ({
  cells,
  behavior,
  preference: 0.5,
  tolerance: 0.2,
  tempo: 2,
});
const scene = (cells = body, reactions = {}, x = 60, y = 60, rotation = 0) => {
  const world = new Ecosystem(
    { ...DEFAULTS, seed: 42, nutrients: 0, mutation: 0, climate: 0 },
    false,
  );
  const mover = world.spawn(
    genome(cells, active(reactions)),
    x,
    y,
    undefined,
    undefined,
    rotation,
  )!;
  mover.age = 1;
  mover.direction = rotation;
  return { world, mover };
};
const step = (world: Ecosystem, count = 1) => {
  for (let i = 0; i < count; i++) world.step();
};

describe('active behavior2 forward rays in the real ecology', () => {
  it.each([0, 1, 2, 3])(
    'uses the actual asymmetric eye origin and rotation %s, with no sensory RNG draws',
    (rotation) => {
      const { world, mover } = scene(body, {}, 60, 60, rotation),
        rays = [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ],
        [dx, dy] = rays[rotation],
        before = world.random.state;
      world.food[index(60 + dx * 5, 60 + dy * 5)] = 1;
      step(world);
      expect([mover.x, mover.y, mover.direction, mover.rotation]).toEqual([
        60 + dx,
        60 + dy,
        (rotation + 3) % 4,
        rotation,
      ]);
      expect(world.random.state).toBe(before);
      expect(world.save().telemetry.pending.energy.movementSpent).toBeCloseTo(0.03, 12);
    },
  );
  it.each([0, 1, 2, 3])('casts from a non-anchor eye after body rotation %s', (rotation) => {
    const cells: Cell[] = [
      { x: 0, y: 0, type: 3 },
      { x: 1, y: 0, type: 5 },
      { x: 1, y: -1, type: 8 },
    ];
    const { world, mover } = scene(cells, {}, 60, 60, rotation),
      [dx, dy] = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ][rotation];
    const [ox, oy] = [
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ][rotation];
    world.food[index(60 + ox + dx * 3, 60 + oy + dy * 3)] = 1;
    step(world);
    expect(mover.direction).toBe((rotation + 3) % 4);
    expect([mover.x, mover.y]).toEqual([60 + dx, 60 + dy]);
  });
  it('feeds before evaluating the current ray', () => {
    const { world, mover } = scene([
      { x: 0, y: 0, type: 8 },
      { x: 1, y: 0, type: 5 },
      { x: 1, y: -1, type: 3 },
    ]);
    world.food[index(60, 59)] = 1;
    step(world);
    expect(world.save().telemetry.pending.energy.mouthsGained).toBeCloseTo(2.2, 12);
    expect([mover.x, mover.y, mover.direction]).toEqual([61, 60, 0]);
  });
  it.each([true, false])(
    'sees then-current sequential occupancy: target moves first=%s',
    (targetFirst) => {
      const world = new Ecosystem(
        { ...DEFAULTS, seed: 42, nutrients: 0, mutation: 0, climate: 0 },
        false,
      );
      const target = () =>
        world.spawn(
          genome([
            { x: 0, y: 0, type: 8 },
            { x: 1, y: 0, type: 5 },
          ]),
          60,
          58,
          undefined,
          undefined,
          1,
        )!;
      const observer = () => world.spawn(genome(body, active({ harmless: 'flee' })), 60, 60)!;
      const [other, mover] = targetFirst
        ? [target(), observer()]
        : (() => {
            const o = observer();
            return [target(), o];
          })();
      other.age = mover.age = 1;
      other.direction = mover.direction = 0;
      world.food[index(63, 58)] = 1;
      step(world);
      expect(mover.direction).toBe(targetFirst ? 0 : 1);
      expect([other.x, other.y]).toEqual([61, 58]);
    },
  );
  it.each([
    [0, 0, 0],
    [WIDTH - 1, 40, 1],
    [40, HEIGHT - 1, 2],
    [0, 40, 3],
  ])('wraps both ray and whole-body movement from %s,%s facing %s', (x, y, rotation) => {
    const { world, mover } = scene(body, {}, x, y, rotation),
      [dx, dy] = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ][rotation];
    world.food[index(x + dx * 3, y + dy * 3)] = 1;
    step(world);
    expect([mover.x, mover.y]).toEqual([(x + dx + WIDTH) % WIDTH, (y + dy + HEIGHT) % HEIGHT]);
    expect(mover.direction).toBe((rotation + 3) % 4);
  });
  it('caps sight at five and retains travel heading when nothing reacts', () => {
    const { world, mover } = scene();
    world.food[index(60, 54)] = 1;
    step(world);
    expect([mover.x, mover.y, mover.direction]).toEqual([61, 60, 0]);
  });
  it.each(['wall', 'ignored harmless', 'self'] as const)(
    'the first %s occludes food behind it',
    (obstruction) => {
      const cells = obstruction === 'self' ? [...body, { x: 0, y: -1, type: 7 as const }] : body;
      const { world, mover } = scene(cells, { wall: 'ignore' });
      if (obstruction === 'wall') world.walls[index(60, 59)] = 1;
      if (obstruction === 'ignored harmless')
        world.spawn(genome([{ x: 0, y: 0, type: 7 }]), 60, 59);
      world.food[index(60, 57)] = 1;
      step(world);
      expect([mover.x, mover.y, mover.direction]).toEqual([61, 60, 0]);
    },
  );
  it.each(['ignore', 'chase', 'flee'] as Reaction[])(
    'applies inherited wall %s and charges blocked/successful attempts',
    (wall) => {
      const { world, mover } = scene(body, { wall });
      world.walls[index(60, 59)] = 1;
      world.food[index(60, 57)] = 1;
      const before = world.random.state,
        random = new Random(1);
      random.state = before;
      const blockedDirection = random.int(4);
      step(world);
      expect(mover.direction).toBe(wall === 'chase' ? blockedDirection : wall === 'flee' ? 1 : 0);
      expect(mover.rotation).toBe(wall === 'chase' ? 1 : 0);
      expect(world.random.state).toBe(wall === 'chase' ? random.state : before);
      expect(world.save().telemetry.pending.energy.movementSpent).toBeCloseTo(0.03, 12);
    },
  );
  it('keeps rotation when both translation and the fallback quarter-turn are blocked', () => {
    const { world, mover } = scene(body, { wall: 'chase' });
    world.walls[index(60, 59)] = 1;
    world.walls[index(59, 61)] = 1;
    step(world);
    expect([mover.x, mover.y, mover.rotation]).toEqual([60, 60, 0]);
    expect(world.save().telemetry.pending.energy.movementSpent).toBeCloseTo(0.03, 12);
  });
  it.each([false, true])(
    'classifies the whole current organism: stinger present=%s even behind visible armor',
    (dangerous) => {
      const { world, mover } = scene(body, { harmless: 'chase' });
      world.spawn(
        genome([
          { x: 0, y: 0, type: 7 },
          { x: 1, y: 0, type: dangerous ? 6 : 7 },
        ]),
        60,
        57,
      );
      step(world);
      expect(mover.direction).toBe(dangerous ? 1 : 3);
    },
  );
  it.each([
    { distance: 1, dangerous: true, expected: 1 },
    { distance: 1, dangerous: false, expected: 1 },
    { distance: 2, dangerous: true, expected: 3 },
  ])(
    'resolves distance then category across eyes: $distance / $dangerous',
    ({ distance, dangerous, expected }) => {
      const { world, mover } = scene(
        [
          { x: 0, y: 0, type: 8 },
          { x: 1, y: 0, type: 8 },
          { x: 0, y: 1, type: 5 },
        ],
        { harmless: 'flee' },
      );
      world.food[index(60, 59)] = 1;
      world.spawn(genome([{ x: 0, y: 0, type: dangerous ? 6 : 7 }]), 61, 60 - distance);
      step(world);
      expect(mover.direction).toBe(expected);
    },
  );
  it('breaks equal category ties by inherited eye index, with fixed common world heading', () => {
    const { world, mover } = scene([
      { x: 1, y: 0, type: 8 },
      { x: 0, y: 0, type: 8 },
      { x: 0, y: 1, type: 5 },
    ]);
    world.food[index(60, 58)] = 1;
    world.food[index(61, 58)] = 1;
    const before = world.random.state;
    expect(sensoryDirection(mover, world)).toBe(3);
    step(world);
    expect(mover.direction).toBe(3);
    expect(world.random.state).toBe(before);
  });
  it('uses wall, organism, food precedence for hypothetical internal overlaps', () => {
    const { world, mover } = scene(body, { wall: 'flee', harmless: 'chase', food: 'flee' });
    const other = world.spawn(genome([{ x: 0, y: 0, type: 7 }]), 60, 58)!;
    world.food[index(60, 58)] = 1;
    expect(sensoryDirection(mover, world)).toBe(3);
    world.walls[index(60, 58)] = 1;
    expect(sensoryDirection(mover, world)).toBe(1);
    world.walls[index(60, 58)] = 0;
    world.kill(other, 'manual');
    expect(sensoryDirection(mover, world)).toBe(1);
  });
  it.each([false, true])('evaluates only at the motor cadence, motor=%s', (motor) => {
    const cells = body.map((cell) =>
        cell.type === 5 ? { ...cell, type: motor ? (5 as const) : (7 as const) } : cell,
      ),
      { world, mover } = scene(cells);
    mover.age = 0;
    world.food[index(60, 58)] = 1;
    step(world);
    expect([mover.x, mover.y, mover.direction]).toEqual([60, 60, 0]);
    expect(world.save().telemetry.pending.energy.movementSpent).toBe(0);
    step(world);
    expect(mover.y).toBe(motor ? 59 : 60);
  });
  it('preserves unsighted motor RNG and energy exactly against a passive twin', () => {
    const cells = body.map((cell) => (cell.type === 8 ? { ...cell, type: 7 as const } : cell)),
      { world, mover } = scene(cells);
    const saved = world.save();
    for (const o of saved.organisms) o.genome.behavior = { version: 1, mode: 'legacy' };
    for (const row of saved.lineageArchive.summaries)
      row.foundingGenome!.behavior = { version: 1, mode: 'legacy' };
    const passive = Ecosystem.load(JSON.stringify(saved));
    step(world, 20);
    step(passive, 20);
    expect(world.random.state).toBe(passive.random.state);
    expect([mover.x, mover.y, mover.direction, mover.rotation, mover.energy]).toEqual(
      (() => {
        const p = passive.organisms.get(mover.id)!;
        return [p.x, p.y, p.direction, p.rotation, p.energy];
      })(),
    );
  });
  it('food chase creates genuine mouth gain and parent-funded births against equal ignore/flee controls', () => {
    for (const reaction of ['chase', 'ignore', 'flee'] as const) {
      const { world, mover } = scene(
        [
          { x: 0, y: 0, type: 8 },
          { x: 1, y: 0, type: 5 },
          { x: 1, y: -1, type: 3 },
        ],
        { food: reaction },
      );
      mover.age = 28;
      mover.energy = 17.95;
      mover.direction = 0;
      world.food[index(60, 58)] = 1;
      step(world, 5);
      const ledger = world.save().telemetry.pending.energy;
      expect(ledger.mouthsGained).toBeCloseTo(reaction === 'chase' ? 2.2 : 0, 12);
      expect(world.births).toBe(reaction === 'chase' ? 1 : 0);
      expect(mover.children).toBe(world.births);
      expect(ledger.reproductionSpent).toBe(reaction === 'chase' ? 9.5 : 0);
      expect(ledger.offspringGranted).toBe(reaction === 'chase' ? 7.5 : 0);
      expect(mover.energy).toBeCloseTo(
        17.95 -
          ledger.upkeepSpent -
          ledger.movementSpent +
          ledger.mouthsGained -
          ledger.reproductionSpent,
        12,
      );
      if (reaction === 'chase') {
        const child = world.organisms.get(2)!;
        expect(child.energy).toBe(7.5);
        expect(child.genome.behavior).toEqual(mover.genome.behavior);
        expect(child.genome.behavior).not.toBe(mover.genome.behavior);
      }
      const loaded = Ecosystem.load(JSON.stringify(world.save()));
      step(world, 50);
      step(loaded, 50);
      expect(world.save()).toEqual(loaded.save());
    }
  });
  it('retreat avoids a later real sting while a no-motor twin pays contact drain', () => {
    const outcomes = [];
    for (const motor of [true, false]) {
      const { world, mover } = scene(
        body.map((c) => (c.type === 5 && !motor ? { ...c, type: 7 } : c)),
      );
      const predator = world.spawn(
        genome([
          { x: 0, y: 0, type: 6 },
          { x: 1, y: 0, type: 7 },
        ]),
        60,
        59,
      )!;
      predator.age = 0;
      mover.energy = 100;
      step(world, 4);
      const ledger = world.save().telemetry.pending.energy;
      outcomes.push(ledger.stingsDrained);
      expect(ledger.stingsGained).toBeCloseTo(motor ? 0 : 0.65, 12);
      expect(mover.energy).toBeCloseTo(
        100 - 0.012 * 3 * 4 - ledger.movementSpent - ledger.stingsDrained,
        12,
      );
    }
    expect(outcomes).toEqual([0, 2.5]);
  });
  it('mutates detached active tables while keeping passive direction and inheritance identities', () => {
    const source = genome();
    for (let seed = 1; seed <= 30; seed++)
      expect(mutate(source, new Random(seed)).behavior).not.toEqual(source.behavior);
    expect(source.behavior).toEqual(active());
    const { world, mover } = scene();
    expect(
      sameInherited(
        mover.genome,
        genome(body, {
          version: 1,
          mode: 'evolved',
          reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
        }),
      ),
    ).toBe(false);
    expect(
      sensoryDirection({ ...mover, genome: genome(body, { version: 1, mode: 'legacy' }) }, world),
    ).toBe(mover.direction);
    expect(
      sensoryDirection(
        {
          ...mover,
          genome: genome(body, {
            version: 1,
            mode: 'evolved',
            reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
          }),
        },
        world,
      ),
    ).toBe(mover.direction);
  });
});

describe('successor envelopes preserve permanent passive meaning', () => {
  it('accepts all 81 active tables, clones and round-trips complete state', () => {
    const actions = ['ignore', 'chase', 'flee'] as const;
    for (let encoded = 0; encoded < 81; encoded++) {
      const behavior = active();
      if (behavior.mode !== 'evolved') throw new Error('test table');
      ['food', 'wall', 'harmless', 'dangerous'].forEach(
        (category, i) =>
          (behavior.reactions[category as keyof typeof behavior.reactions] =
            actions[Math.floor(encoded / 3 ** i) % 3]),
      );
      const source = genome(body, behavior);
      expect(validGenome(source)).toBe(true);
      expect(validGenome(source, false)).toBe(false);
      const copy = cloneGenome(source);
      expect(copy).toEqual(source);
      expect(copy.behavior).not.toBe(source.behavior);
      const blueprint = parseBlueprint(
        serializeBlueprint({ name: 'Active', description: '', genome: source }),
      );
      expect(blueprint.version).toBe(3);
      expect(blueprint.genome).toEqual(source);
      const { world } = scene(body, behavior.reactions);
      expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    }
  });
  it.each(['living', 'extinct'] as const)(
    'old worlds reject active %s genomes, including complete final archive validation',
    (boundary) => {
      const { world, mover } = scene();
      if (boundary === 'extinct') world.kill(mover, 'manual');
      const snapshot = world.save();
      for (const version of [9, 10]) {
        const old = {
          ...snapshot,
          version,
          interventions: { ...snapshot.interventions, version: version === 9 ? 3 : 4 },
        };
        expect(() => Ecosystem.load(JSON.stringify(old))).toThrow(
          boundary === 'living' ? 'organism' : 'lineage archive',
        );
      }
      expect(world.save()).toEqual(snapshot);
      const invalid = structuredClone(snapshot),
        target =
          boundary === 'living'
            ? invalid.organisms[0].genome
            : invalid.lineageArchive.summaries[0].foundingGenome!;
      (target.behavior as any).reactions.dangerous = 'attack';
      expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow();
      expect(world.save()).toEqual(snapshot);
    },
  );
  it('blueprint2 rejects active tables while passive predecessor tables migrate unchanged', () => {
    const current = JSON.parse(
      serializeBlueprint({ name: 'Active', description: '', genome: genome() }),
    );
    expect(() => parseBlueprint(JSON.stringify({ ...current, version: 2 }))).toThrow(
      'Blueprint needs',
    );
    current.genome.behavior.version = 1;
    expect(parseBlueprint(JSON.stringify({ ...current, version: 2 })).genome).toEqual(
      current.genome,
    );
    expect(validBehavior({ version: 2, mode: 'legacy' })).toBe(false);
    expect(validBehavior(active(), false)).toBe(false);
  });
});
