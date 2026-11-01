import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  Random,
  cloneGenome,
  founder,
  observedGenome,
  validGenome,
  type Genome,
} from '../src/model';
import { sameInherited } from '../src/lineage';
import {
  legacyMutation,
  mutatePropensity,
  weightedMutation,
  type MutationPolicy,
} from '../src/mutation';
import { genomeDiff } from '../src/organism-view';
import { organismHtml } from '../src/view';
import { historicalArchive, legacyV7 } from './fixtures/telemetry';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';

function source(value?: number): Genome {
  const genome = founder(0);
  genome.cells = [{ x: 0, y: 0, type: 7 }];
  if (value !== undefined) genome.mutationPropensity = value;
  genome.legacyExtensions = [['mutationPropensity', [['string', 'opaque predecessor data']]]];
  return genome;
}
function birth(
  seed: number,
  value?: number,
  mutation = 0.4,
  policy: MutationPolicy = legacyMutation(),
) {
  const world = new Ecosystem({ ...DEFAULTS, mutation, nutrients: 0, climate: 0 }, false);
  world.changeMutationPolicy(policy);
  const parent = world.spawn(source(value), 60, 60)!;
  parent.age = 32;
  parent.energy = 20;
  world.random.state = seed;
  world.step();
  return { world, parent, child: [...world.organisms.values()].find((o) => o.generation === 1)! };
}

describe('explicit inherited mutation propensity', () => {
  it('validates finite bounded own scalars and detaches projections without acquiring opaque names', () => {
    for (const value of [undefined, 0, -0, 0.4, 1]) {
      const g = source(value);
      expect(validGenome(g)).toBe(true);
      expect(validGenome(g, true, false)).toBe(value === undefined);
      expect(cloneGenome(g)).toEqual(g);
      expect(Object.is(cloneGenome(g).mutationPropensity, value)).toBe(true);
      expect(observedGenome(g).mutationPropensity).toBe(value);
      expect(observedGenome(g).legacyExtensions).toBeUndefined();
      expect(sameInherited(g, cloneGenome(g))).toBe(true);
    }
    for (const value of [null, undefined, '0', NaN, Infinity, -Number.MIN_VALUE, 1.00000001]) {
      const g = { ...source(), mutationPropensity: value };
      expect(validGenome(g)).toBe(false);
      expect(() => cloneGenome(g as Genome)).toThrow('Invalid inherited genome');
    }
    expect(sameInherited(source(), source(0))).toBe(false);
    expect(sameInherited(source(0), source(1))).toBe(false);
  });

  it('uses an independent fixed self trial with exact draw counts and bounded deltas', () => {
    for (const value of [undefined, 0, 0.5, 1]) {
      let changed = 0,
        unchanged = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const rng = new Random((seed * 2654435761) >>> 0),
          oracle = new Random((seed * 2654435761) >>> 0),
          g = source(value);
        const trial = value === undefined ? 1 : oracle.next();
        const expected =
          trial < 0.05 ? Math.max(0, Math.min(1, value! + (oracle.next() - 0.5) * 0.2)) : value;
        const result = mutatePropensity(g, rng);
        expect(result.mutationPropensity).toBe(expected);
        expect(rng.state).toBe(oracle.state);
        expect(g).toEqual(source(value));
        if (expected !== value) changed++;
        else unchanged++;
      }
      expect(unchanged).toBeGreaterThan(0);
      expect(changed > 0).toBe(value !== undefined);
    }
  });

  it.each([legacyMutation(), weightedMutation()])(
    'uses actual parent-funded births with policy $mode at zero, cap and intermediate values',
    (policy) => {
      for (const value of [0, 0.5, 1]) {
        let inherited = 0,
          changed = 0,
          ordinary = 0;
        for (let seed = 1; seed <= 240; seed++) {
          const { world, parent, child } = birth((seed * 2654435761) >>> 0, value, 0.4, policy);
          expect(child).toBeTruthy();
          expect(parent.genome).toEqual(source(value));
          const difference = child.genome.mutationPropensity! - value;
          expect(Math.abs(difference)).toBeLessThanOrEqual(0.1 + Number.EPSILON);
          expect(child.genome.mutationPropensity).toBeGreaterThanOrEqual(0);
          expect(child.genome.mutationPropensity).toBeLessThanOrEqual(1);
          if (difference === 0) inherited++;
          else changed++;
          const restored = cloneGenome(child.genome);
          restored.mutationPropensity = value;
          if (!sameInherited(restored, parent.genome)) ordinary++;
          expect(child.genome.legacyExtensions).toEqual(parent.genome.legacyExtensions);
          expect(child.genome.legacyExtensions).not.toBe(parent.genome.legacyExtensions);
          expect(child.genome).not.toBe(parent.genome);
          const ledger = world.telemetry.pending.energy;
          expect(ledger.offspringGranted).toBe(child.genome.cells.length * 1.5 + 3);
          expect(ledger.reproductionSpent).toBe(ledger.offspringGranted + 2);
          expect(parent.energy).toBeCloseTo(20 - ledger.upkeepSpent - ledger.reproductionSpent, 10);
          expect(world.births).toBe(1);
          expect(parent.children).toBe(1);
          expect(child.generation).toBe(1);
          if (difference !== 0) expect(child.species).not.toBe(parent.species);
          if (child.species === parent.species)
            expect(sameInherited(child.genome, parent.genome)).toBe(true);
        }
        expect(inherited).toBeGreaterThan(0);
        expect(changed).toBeGreaterThan(0);
        expect(ordinary > 0).toBe(value !== 0);
      }
    },
  );

  it('allows independent self changes at global zero and no ordinary mutation at zero multiplier', () => {
    const policy = weightedMutation();
    for (const key of Object.keys(policy.weights) as (keyof typeof policy.weights)[])
      policy.weights[key] = 0;
    for (const [value, rate] of [
      [0, 0.4],
      [0.5, 0],
      [1, 0.4],
    ]) {
      let changed = 0;
      for (let seed = 1; seed <= 240; seed++) {
        const { child } = birth((seed * 2654435761) >>> 0, value, rate, policy);
        const restored = cloneGenome(child.genome);
        restored.mutationPropensity = value;
        expect(restored).toEqual(source(value));
        if (child.genome.mutationPropensity !== value) changed++;
      }
      expect(changed).toBeGreaterThan(0);
    }
  });

  it('retains exact global-mode continuation through predecessor migration with both policies', () => {
    for (const policy of [legacyMutation(), weightedMutation()]) {
      const { world } = birth(7, undefined, 0.4, policy);
      const file = world.save(),
        predecessor = {
          ...file,
          version: 13,
          lineageArchive: historicalArchive(file.lineageArchive),
        };
      const loaded = Ecosystem.load(JSON.stringify(predecessor));
      const expected = structuredClone(file);
      expected.lineageArchive.mutationOriginTick = file.tick;
      expected.lifeHistoryLog.originTick = file.tick;
      expected.lineageArchive.events = expected.lineageArchive.events.filter(
        (event) => event.kind !== 'reproduction',
      );
      expect(loaded.save()).toEqual(expected);
      for (let tick = 0; tick < 120; tick++) {
        world.step();
        loaded.step();
        const { lineageArchive: _prior, lifeHistoryLog: _priorLife, ...prior } = loaded.save();
        const { lineageArchive: _current, lifeHistoryLog: _currentLife, ...current } = world.save();
        expect(prior).toEqual(current);
      }
    }
  });

  it('round-trips complete enabled worlds and blueprints with exact future inheritance', () => {
    const { world } = birth(92321, 0.6);
    const loaded = Ecosystem.load(JSON.stringify(world.save()));
    for (let tick = 0; tick < 150; tick++) {
      world.step();
      loaded.step();
      expect(loaded.save()).toEqual(world.save());
    }
    for (const value of [undefined, 0, 1]) {
      const text = serializeBlueprint({
        name: 'Propensity',
        description: '',
        genome: source(value),
      });
      expect(JSON.parse(text).version).toBe(5);
      expect(parseBlueprint(text).genome).toEqual(source(value));
      for (const version of [2, 3]) {
        const old = { ...JSON.parse(text), version };
        if (value === undefined)
          expect(parseBlueprint(JSON.stringify(old)).genome).toEqual(source());
        else expect(() => parseBlueprint(JSON.stringify(old))).toThrow();
      }
    }
  });

  it('rejects malformed alive/extinct founding traits and predecessor acquisition before replacement', () => {
    const { world } = birth(92321, 0.5),
      before = world.save();
    for (const value of [-0.001, 1.001, null, '0.2']) {
      const file = structuredClone(before) as any;
      file.organisms[0].genome.mutationPropensity = value;
      expect(() => Ecosystem.load(JSON.stringify(file))).toThrow();
      expect(world.save()).toEqual(before);
    }
    for (const version of [9, 10, 11, 12, 13]) {
      const file = structuredClone(before) as any;
      file.version = version;
      file.interventions.version = version === 9 ? 3 : version === 13 ? 5 : 4;
      expect(() => Ecosystem.load(JSON.stringify(file))).toThrow();
    }
    const extinct = new Ecosystem({ ...DEFAULTS }, false);
    const parent = extinct.spawn(source(0.5), 60, 60)!;
    extinct.paint('erase', parent.x, parent.y, 0, source());
    const file = extinct.save();
    file.lineageArchive.summaries[0].foundingGenome!.mutationPropensity = -1;
    expect(() => Ecosystem.load(JSON.stringify(file))).toThrow('lineage archive');
    file.lineageArchive.summaries[0].foundingGenome!.mutationPropensity = 0.5;
    (file as any).version = 13;
    expect(() => Ecosystem.load(JSON.stringify(file))).toThrow('lineage archive');
  });

  it('keeps historical and native opaque propensity names separate from the new owned field', () => {
    const oldWorld = new Ecosystem({ ...DEFAULTS }, false);
    oldWorld.spawn(source(), 60, 60);
    const historical = legacyV7(oldWorld.save());
    historical.organisms[0].genome.mutationPropensity = { old: ['opaque', -0] };
    const loaded = Ecosystem.load(JSON.stringify(historical));
    expect(loaded.save().organisms[0].genome.mutationPropensity).toBeUndefined();
    expect(loaded.save().organisms[0].genome.legacyExtensions).toContainEqual([
      'mutationPropensity',
      [
        ['object', ['old']],
        ['array', 2],
        ['string', 'opaque'],
        ['number', 0],
      ],
    ]);
    const complete = loaded.save();
    expect(Ecosystem.load(JSON.stringify(complete)).save()).toEqual(complete);
    const native = {
      ...oldWorld.save(),
      version: 13,
      lineageArchive: historicalArchive(oldWorld.save().lineageArchive),
    };
    const migrated = Ecosystem.load(JSON.stringify(native));
    expect(migrated.save()).toEqual(oldWorld.save());
    expect(migrated.save().organisms[0].genome.legacyExtensions).toEqual(source().legacyExtensions);
  });

  it('displays exact enabled and disabled inspector and retained endpoint values without scoring', () => {
    const { world, parent } = birth(7, 0.5);
    expect(organismHtml(parent, world.frame())).toContain('inherited multiplier 0.5');
    const baseline = {
      relation: 'own-lineage' as const,
      lineageId: parent.species,
      status: 'retained' as const,
      genome: source(0),
    };
    expect(genomeDiff(parent.genome, baseline)).toContain('inherited multiplier 0.5');
    expect(genomeDiff(parent.genome, baseline)).toContain('<td>0.5</td>');
    delete parent.genome.mutationPropensity;
    expect(organismHtml(parent, world.frame())).toContain('Global rate');
    expect(genomeDiff(parent.genome, baseline)).toContain('global (disabled)');
  });

  it('spends mutation trials without births or energy grants when placement is blocked', () => {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
    const parent = world.spawn(source(0), 60, 60)!;
    parent.age = 32;
    parent.energy = 20;
    world.walls.fill(1);
    world.walls[60 + 60 * 240] = 0;
    const before = world.random.state;
    world.step();
    expect(world.births).toBe(0);
    expect(parent.children).toBe(0);
    expect(world.organisms.size).toBe(1);
    expect(world.telemetry.pending.energy.reproductionSpent).toBe(0);
    expect(world.telemetry.pending.energy.offspringGranted).toBe(0);
    expect(world.random.state).not.toBe(before);
    expect(parent.genome).toEqual(source(0));
  });
});
