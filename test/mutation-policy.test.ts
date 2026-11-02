import { historicalArchive } from './fixtures/telemetry';
import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  Random,
  cloneGenome,
  founder,
  mutate,
  validGenome,
  WORLD_VERSION,
  type Genome,
} from '../src/model';
import {
  MUTATION_CHANNELS,
  legacyMutation,
  mutateWithPolicy,
  sameMutationPolicy,
  validMutationPolicy,
  weightedMutation,
  type MutationChannel,
} from '../src/mutation';
import { sameInherited } from '../src/lineage';
import { measurementEnvelope } from '../src/measurement-export';

function only(channel?: MutationChannel, weight = 100) {
  const policy = weightedMutation();
  for (const key of MUTATION_CHANNELS) policy.weights[key] = key === channel ? weight : 0;
  return policy;
}
function genome(): Genome {
  const g = founder(0);
  g.cells = [
    { x: 0, y: 0, type: 3 },
    { x: 1, y: 0, type: 7 },
    { x: 2, y: 0, type: 7 },
  ];
  g.behavior = {
    version: 2,
    mode: 'evolved',
    reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
  };
  g.legacyExtensions = [['opaque', [['number', '-0']]]];
  return g;
}
function birth(seed: number, policy = weightedMutation(), source = genome()) {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0, mutation: 0.4 }, false);
  world.changeMutationPolicy(policy);
  const parent = world.spawn(source, 60, 60)!;
  parent.age = 32;
  parent.energy = 40;
  world.random.state = seed;
  return { world, parent };
}

describe('bounded opt-in mutation policy', () => {
  it('validates exact bounded records and distinguishes policies without coercion', () => {
    for (const valid of [legacyMutation(), weightedMutation(), only(), only('add')])
      expect(validMutationPolicy(valid)).toBe(true);
    for (const invalid of [
      null,
      false,
      [],
      {},
      { version: 2, mode: 'legacy' },
      { version: 1, mode: 'other' },
      { ...legacyMutation(), weights: {} },
      { ...weightedMutation(), extra: 0 },
      { ...weightedMutation(), weights: [] },
      { ...weightedMutation(), weights: {} },
      ...[-1, 101, 0.5, NaN, Infinity, '1'].map((value) => ({
        ...weightedMutation(),
        weights: { ...weightedMutation().weights, add: value },
      })),
    ])
      expect(validMutationPolicy(invalid)).toBe(false);
    expect(sameMutationPolicy(legacyMutation(), weightedMutation())).toBe(false);
    expect(sameMutationPolicy(weightedMutation(), legacyMutation())).toBe(false);
    expect(sameMutationPolicy(weightedMutation(), weightedMutation())).toBe(true);
    expect(sameMutationPolicy(only('add'), only('remove'))).toBe(false);
  });
  it('retains the literal legacy RNG and result for passive and active genomes', () => {
    for (const source of [founder(0), genome()])
      for (let seed = 0; seed < 100; seed++) {
        const a = new Random(seed),
          b = new Random(seed);
        expect(mutateWithPolicy(source, a, legacyMutation())).toEqual(mutate(source, b));
        expect(a.state).toBe(b.state);
      }
  });
  it('normalizes eligible weights only, excludes passive reactions, and detaches zero-weight clones without draws', () => {
    const source = genome(),
      zero = only(),
      random = new Random(17),
      copy = mutateWithPolicy(source, random, zero);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(random.state).toBe(17);
    for (const passive of [
      founder(0),
      { ...genome(), behavior: { ...genome().behavior, version: 1 as const } },
    ]) {
      const rng = new Random(17);
      expect(mutateWithPolicy(passive, rng, only('reactions'))).toEqual(passive);
      expect(rng.state).toBe(17);
    }
    const scaled = weightedMutation();
    for (const key of MUTATION_CHANNELS) scaled.weights[key] *= 17;
    for (let seed = 0; seed < 100; seed++) {
      const a = new Random(seed),
        b = new Random(seed);
      expect(mutateWithPolicy(source, a, weightedMutation())).toEqual(
        mutateWithPolicy(source, b, scaled),
      );
      expect(a.state).toBe(b.state);
      const withPassiveReaction = only('preference');
      withPassiveReaction.weights.reactions = 100;
      const c = new Random(seed),
        d = new Random(seed);
      expect(mutateWithPolicy(founder(0), c, withPassiveReaction)).toEqual(
        mutateWithPolicy(founder(0), d, only('preference')),
      );
      expect(c.state).toBe(d.state);
    }
  });
  it('keeps topology/trait bounds without fallback, including failed add/remove and clamped scalar attempts', () => {
    const one = { ...genome(), cells: [{ x: 0, y: 0, type: 3 as const }] };
    const full = {
      ...genome(),
      cells: Array.from({ length: 16 }, (_, i) => ({
        x: i % 4,
        y: Math.floor(i / 4),
        type: 3 as const,
      })),
    };
    for (const [source, policy] of [
      [one, only('remove')],
      [full, only('add')],
    ] as const)
      for (let seed = 0; seed < 10; seed++)
        expect(mutateWithPolicy(source, new Random(seed), policy)).toEqual(source);
    for (const key of MUTATION_CHANNELS)
      for (let seed = 0; seed < 200; seed++) {
        const source = genome();
        if (seed % 2) {
          source.preference = 1;
          source.tolerance = 0.6;
          source.tempo = 12;
        } else {
          source.preference = 0;
          source.tolerance = 0.12;
          source.tempo = 2;
        }
        expect(validGenome(mutateWithPolicy(source, new Random(seed), only(key)))).toBe(true);
      }
    let source = full;
    for (let seed = 0; seed < 1000; seed++) {
      source = mutateWithPolicy(source, new Random(seed), weightedMutation());
      expect(validGenome(source)).toBe(true);
    }
  });
  it.each(MUTATION_CHANNELS)(
    'changes only enabled %s through genuine parent-funded births with fixed seeds',
    (channel) => {
      let differences = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const { world, parent } = birth(seed, only(channel)),
          before = cloneGenome(parent.genome);
        world.step();
        if (world.births === 0) continue;
        const child = [...world.organisms.values()][1];
        expect(parent.genome).toEqual(before);
        const expected = cloneGenome(child.genome);
        if (['add', 'remove', 'change'].includes(channel)) expected.cells = before.cells;
        else if (channel === 'reactions') expected.behavior = before.behavior;
        else
          expected[channel as 'preference' | 'tolerance' | 'tempo'] =
            before[channel as 'preference' | 'tolerance' | 'tempo'];
        expect(expected).toEqual(before);
        const changed = !sameInherited(before, child.genome);
        differences += Number(changed);
        if (channel === 'add') {
          expect(child.genome.cells.slice(0, before.cells.length)).toEqual(before.cells);
          expect(child.genome.cells.length).toBe(before.cells.length + Number(changed));
        } else if (channel === 'remove') {
          expect(child.genome.cells.length).toBe(before.cells.length - Number(changed));
          for (const cell of child.genome.cells) expect(before.cells).toContainEqual(cell);
        } else if (channel === 'change') {
          expect(child.genome.cells.map(({ x, y }) => ({ x, y }))).toEqual(
            before.cells.map(({ x, y }) => ({ x, y })),
          );
          expect(
            child.genome.cells.filter((cell, i) => cell.type !== before.cells[i].type),
          ).toHaveLength(Number(changed));
        }
        expect(child.species === parent.species).toBe(!changed);
        expect(child.ancestry).toEqual(changed ? [parent.species] : []);
        expect(child.energy).toBe(child.genome.cells.length * 1.5 + 3);
        expect(world.telemetrySnapshot().pending.energy.reproductionSpent).toBe(child.energy + 2);
        expect(parent.energy).toBeLessThan(40 - child.energy - 2);
        expect(validGenome(child.genome)).toBe(true);
      }
      expect(differences).toBeGreaterThan(0);
    },
  );
  it('makes actual clonal births when all channels or passive reaction eligibility are disabled', () => {
    for (const [policy, source] of [
      [only(), genome()],
      [only('reactions'), { ...genome(), behavior: { ...genome().behavior, version: 1 as const } }],
      [
        only('reactions'),
        { ...genome(), behavior: { version: 1 as const, mode: 'legacy' as const } },
      ],
    ] as const) {
      const { world, parent } = birth(7, policy, source);
      const before = cloneGenome(parent.genome);
      world.step();
      expect(world.births).toBe(1);
      const child = [...world.organisms.values()][1];
      expect(child.genome).toEqual(before);
      expect(child.species).toBe(parent.species);
      const reference = new Random(7);
      reference.next();
      for (let i = 0; i < 4; i++) reference.int(4);
      expect(world.random.state).toBe(reference.state);
    }
  });
  it('allows reproduction to fail without manufacturing evidence or energy', () => {
    const { world, parent } = birth(7, only('reactions'));
    world.walls.fill(1);
    for (const c of parent.genome.cells) world.walls[(parent.y + c.y) * 240 + parent.x + c.x] = 0;
    const before = world.lineageSnapshot(),
      energy = parent.energy;
    world.step();
    expect(world.births).toBe(0);
    expect(world.nextId).toBe(2);
    const observed = world.lineageSnapshot();
    expect({
      ...observed,
      events: observed.events.filter((event) => event.kind !== 'reproduction'),
    }).toEqual(before);
    expect(observed.events.at(-1)).toMatchObject({
      kind: 'reproduction',
      outcome: 'failed-placement',
      childGenome: null,
    });
    expect(parent.energy).toBeLessThan(energy);
    expect(world.telemetrySnapshot().pending.energy.reproductionSpent).toBe(0);
  });
  it('persists manual policy changes, full metadata, and exact ecological continuation', () => {
    const { world } = birth(7, only('preference'));
    const start = world.save(),
      rng = world.random.state;
    expect(world.changeMutationPolicy(only('preference'))).toBeNull();
    expect(world.save()).toEqual(start);
    const policy = only('tolerance');
    expect(world.changeMutationPolicy(policy)).toBe(2);
    policy.weights.add = 50;
    expect(world.mutationPolicy).toEqual(only('tolerance'));
    expect(world.random.state).toBe(rng);
    expect(world.tick).toBe(0);
    expect(() => world.changeMutationPolicy({ version: 9 } as any)).toThrow(
      'Invalid mutation policy',
    );
    const saved = world.save();
    (saved.settings as any).mutationPolicy = { opaque: 'retained' };
    const a = Ecosystem.load(JSON.stringify(saved)),
      b = Ecosystem.load(JSON.stringify(saved));
    expect(a.save()).toEqual(saved);
    for (let tick = 0; tick < 100; tick++) {
      a.step();
      b.step();
    }
    expect(a.save()).toEqual(b.save());
    const envelope = measurementEnvelope(a.measurements());
    expect(envelope.snapshot.mutationPolicy).toEqual(only('tolerance'));
    expect(envelope.interventions.version).toBe(5);
    expect(WORLD_VERSION).toBe(16);
  });
  it('migrates world12 with exact legacy continuity and retained opaque settings, excluding ignored root names', () => {
    const old = new Ecosystem({ ...DEFAULTS, mutation: 0.4 }).save() as any;
    old.version = 12;
    old.lineageArchive = historicalArchive(old.lineageArchive);
    old.interventions.version = 4;
    old.mutationPolicy = { unowned: 'ignored' };
    old.settings.mutationPolicy = { unowned: 'retained' };
    const migrated = Ecosystem.load(JSON.stringify(old));
    expect(migrated.mutationPolicy).toEqual(legacyMutation());
    expect(migrated.random.state).toBe(old.random);
    expect((migrated.settings as any).mutationPolicy).toEqual(old.settings.mutationPolicy);
    const twin = Ecosystem.load(JSON.stringify(migrated.save()));
    for (let i = 0; i < 100; i++) {
      migrated.step();
      twin.step();
    }
    expect(migrated.save()).toEqual(twin.save());
    old.interventions.entries = [
      {
        sequence: 1,
        origin: 'manual',
        kind: 'mutation-policy',
        firstTick: 0,
        lastTick: 0,
        detail: { before: legacyMutation(), after: only() },
      },
    ];
    old.interventions.totalEntries = 1;
    expect(() => Ecosystem.load(JSON.stringify(old))).toThrow('history');
  });
  it('validates complete policy/history before import, including reverse chains and eviction', () => {
    const { world } = birth(7);
    world.changeMutationPolicy(only('add'));
    const saved = world.save();
    const corrupt = [
      (x: any) => delete x.mutationPolicy,
      (x: any) => (x.mutationPolicy.weights.add = -1),
      (x: any) => (x.interventions.version = 4),
      (x: any) => (x.interventions.entries[0].detail.extra = 0),
      (x: any) => (x.interventions.entries[0].detail.before = { version: 2, mode: 'legacy' }),
      (x: any) => (x.interventions.entries[0].detail.after = legacyMutation()),
      (x: any) => (x.interventions.entries.at(-1).detail.after = only('remove')),
    ];
    for (const damage of corrupt) {
      const candidate = structuredClone(saved);
      damage(candidate);
      expect(() => Ecosystem.load(JSON.stringify(candidate))).toThrow();
      expect(world.save()).toEqual(saved);
    }
    for (let i = 0; i < 140; i++) world.changeMutationPolicy(i % 2 ? only('add') : only('remove'));
    expect(world.interventionSnapshot().entries.length).toBe(128);
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    const file = world.save();
    file.interventions.totalEntries = Number.MAX_SAFE_INTEGER;
    for (const [i, row] of file.interventions.entries.entries())
      row.sequence = Number.MAX_SAFE_INTEGER - 127 + i;
    const exhausted = Ecosystem.load(JSON.stringify(file)),
      before = exhausted.save();
    expect(() => exhausted.changeMutationPolicy(only('tempo'))).toThrow();
    expect(exhausted.save()).toEqual(before);
  });
});
