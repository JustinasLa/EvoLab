import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startAssayTrial, startFixtureTrial, seedFoodLattice, type AssayTrial } from '../src/assay';
import {
  ASSAY_ENGINE_ESTIMATE_BYTES,
  ASSAY_FIXTURES,
  ASSAY_FIXTURE_DIGESTS,
  ASSAY_FIXTURE_IDS,
  ASSAY_MAX_TOTAL_TICKS,
  ASSAY_MAX_TRIAL_TICKS,
  ASSAY_MEMORY_BUDGET_BYTES,
  ASSAY_RECIPE_MAX_BYTES,
  AssayRecipeError,
  createAssayRecipe,
  encodeAssayRecipe,
  readAssayRecipe,
  validateAssayRecipe,
  type AssayFixture,
  type AssayFixtureId,
  type AssayRecipe,
} from '../src/assay-model';
import { serializeBlueprint } from '../src/blueprint';
import { DEFAULT_DORMANCY } from '../src/dormancy';
import { Ecosystem } from '../src/ecosystem';
import { EXPERIMENT_INTERVENTIONS } from '../src/experiment-interventions';
import { EXPERIMENT_RULES_VERSION } from '../src/experiment-model';
import { defaultLifeHistory } from '../src/life-history';
import { founder, index, WIDTH, WORLD_VERSION, type Genome } from '../src/model';
import { newController } from '../src/neural';
import { NUTRIENT_TOTAL, validateNutrients } from '../src/nutrients';
import { sha256 } from '../src/sha256';
import { storedSensoryGenome } from './fixtures/sensory-legacy';

const blueprint = (genome: Genome = founder(0), name = 'Assay subject') =>
  serializeBlueprint({ name, description: '', genome });
const neutral = { nutrientCycle: false, biologicalShade: false };
const recipe = (
  overrides: Partial<Parameters<typeof createAssayRecipe>[0]> = {},
): ReturnType<typeof createAssayRecipe> =>
  createAssayRecipe({
    blueprint: blueprint(),
    fixtures: [...ASSAY_FIXTURE_IDS],
    seeds: [1, 2, 3, 4],
    horizonTicks: 600,
    ecology: neutral,
    ...overrides,
  });
const rejection = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AssayRecipeError);
    return { problem: (error as AssayRecipeError).problem, message: (error as Error).message };
  }
  throw new Error('expected rejection');
};
const clock = () => 0;
const run = (trial: AssayTrial) => {
  let progress = trial.advance(clock);
  while (!progress.done) progress = trial.advance(clock);
  return trial.endpoint()!;
};
const trialOf = (
  id: AssayFixtureId,
  seed = 1,
  options: { genome?: Genome; horizonTicks?: number; ecology?: typeof neutral } = {},
) =>
  startAssayTrial(
    recipe({
      blueprint: blueprint(options.genome),
      fixtures: [id],
      seeds: [seed],
      horizonTicks: options.horizonTicks ?? 600,
      ecology: options.ecology ?? neutral,
    }).recipe,
    id,
    seed,
  );
const latticePoints = (fixture: AssayFixture): number[] => {
  const points: number[] = [];
  for (const [x0, y0, x1, y1] of fixture.food.regions)
    for (let y = y0; y <= y1; y += fixture.food.step)
      for (let x = x0; x <= x1; x += fixture.food.step)
        if (!fixture.food.exclude.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d))
          points.push(index(x, y));
  return points.sort((a, b) => a - b);
};

describe('synchronous SHA-256 provenance', () => {
  it('matches the FIPS vectors and node:crypto for multi-block and non-ASCII text', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    for (const text of ['λ🌱 é', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000), blueprint()])
      expect(sha256(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });
});

describe('assay fixtures', () => {
  it('declares four frozen, versioned fixtures with digested definitions', () => {
    expect(ASSAY_FIXTURE_IDS).toEqual([
      'limited-food',
      'thermal-exposure',
      'obstacle-navigation',
      'stinger-contact',
    ]);
    for (const id of ASSAY_FIXTURE_IDS) {
      const fixture = ASSAY_FIXTURES[id];
      expect(fixture.id).toBe(id);
      expect(fixture.version).toBe(1);
      expect(Object.isFrozen(fixture) && Object.isFrozen(fixture.food.regions[0])).toBe(true);
      expect(fixture.settings.mutation).toBe(0);
      expect(fixture.subject).toEqual({ x: 120, y: 78, rotation: 0, energy: 'placement-grant' });
      expect(latticePoints(fixture)).toHaveLength(fixture.pellets);
      expect(fixture.measurements.slice(0, 4)).toEqual([
        'subject-survival-tick',
        'energy-ledger',
        'offspring',
        'lineage-descendants-at-horizon',
      ]);
      expect(ASSAY_FIXTURE_DIGESTS[id]).toBe(sha256(JSON.stringify(fixture)));
    }
    expect(() => ((ASSAY_FIXTURES['limited-food'] as any).pellets = 1)).toThrow(TypeError);
    expect(ASSAY_FIXTURES['thermal-exposure'].modes.biologicalShade).toBe(false);
    expect(ASSAY_FIXTURES['stinger-contact'].antagonist?.genome.cells).toEqual([
      { x: 0, y: 0, type: 6 },
    ]);
  });
});

describe('assay recipe validation and budgets', () => {
  it('records exact blueprint bytes, hash, fixture provenance, totals and memory preflight', () => {
    const text = blueprint(founder(2), 'λ hunter');
    const assay = recipe({ blueprint: text, horizonTicks: 1800 });
    expect(assay.supported).toBe(true);
    expect(assay.recipe.rules).toEqual({
      id: 'evolab-drift-cellular',
      version: EXPERIMENT_RULES_VERSION,
      worldVersion: WORLD_VERSION,
    });
    expect(assay.recipe.subject).toEqual({
      blueprint: text,
      bytes: new TextEncoder().encode(text).byteLength,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    expect(assay.recipe.fixtures).toEqual(
      ASSAY_FIXTURE_IDS.map((id) => ({ id, version: 1, sha256: ASSAY_FIXTURE_DIGESTS[id] })),
    );
    expect(assay.blueprint.genome).toEqual(founder(2));
    expect(assay.plan.trialCount).toBe(16);
    expect(assay.plan.trials.slice(0, 5)).toEqual([
      { fixture: 'limited-food', seed: 1 },
      { fixture: 'limited-food', seed: 2 },
      { fixture: 'limited-food', seed: 3 },
      { fixture: 'limited-food', seed: 4 },
      { fixture: 'thermal-exposure', seed: 1 },
    ]);
    expect(assay.plan.ticksPerTrial).toBe(1800);
    expect(assay.plan.totalTicks).toBe(ASSAY_MAX_TOTAL_TICKS);
    const encoded = encodeAssayRecipe(assay.recipe);
    expect(assay.plan.memory).toEqual({
      engineBytes: ASSAY_ENGINE_ESTIMATE_BYTES,
      recipeBytes: new TextEncoder().encode(encoded).byteLength,
      endpointBytes: 16 * 2048,
      totalBytes:
        ASSAY_ENGINE_ESTIMATE_BYTES + new TextEncoder().encode(encoded).byteLength + 16 * 2048,
      budgetBytes: ASSAY_MEMORY_BUDGET_BYTES,
    });
    expect(assay.plan.memory.totalBytes).toBeLessThan(ASSAY_MEMORY_BUDGET_BYTES);
    expect(readAssayRecipe(encoded)).toEqual(assay);
    expect(ASSAY_MAX_TRIAL_TICKS).toBe(3600);
  });

  it('rejects excess budgets with planned totals', () => {
    const excess = rejection(() => recipe({ horizonTicks: 1801 }));
    expect(excess.problem).toBe('budget');
    expect(excess.message).toMatch(
      /^This assay plans 28816 engine ticks and about \d+ bytes; the limits are 28800 ticks and 16000000 bytes\.$/,
    );
    expect(recipe({ fixtures: ['limited-food'], horizonTicks: 3600 }).plan.totalTicks).toBe(14_400);
    for (const horizonTicks of [0, 3601, 5000, 1.5])
      expect(rejection(() => recipe({ fixtures: ['limited-food'], horizonTicks })).problem).toBe(
        'budget',
      );
    expect(rejection(() => recipe({ seeds: [1, 2, 3, 4, 5] })).problem).toBe('budget');
    const five = recipe().recipe;
    five.fixtures.push({ ...five.fixtures[0] });
    expect(rejection(() => validateAssayRecipe(five)).problem).toBe('budget');
    const huge = JSON.stringify({ padding: 'x'.repeat(ASSAY_RECIPE_MAX_BYTES) });
    expect(rejection(() => readAssayRecipe(huge)).problem).toBe('budget');
    expect(
      rejection(() => readAssayRecipe('é'.repeat(ASSAY_RECIPE_MAX_BYTES / 2 + 1))).problem,
    ).toBe('budget');
    expect(rejection(() => readAssayRecipe(42 as any)).problem).toBe('budget');
  });

  it('rejects bad blueprints, organism state and mismatched provenance', () => {
    const valid = recipe().recipe;
    const tamper = (change: (copy: AssayRecipe) => void) => {
      const copy = structuredClone(valid);
      change(copy);
      return rejection(() => validateAssayRecipe(copy));
    };
    expect(tamper((copy) => (copy.subject.sha256 = '0'.repeat(64))).problem).toBe('blueprint');
    expect(tamper((copy) => copy.subject.bytes++).problem).toBe('blueprint');
    const withText = (text: string) => rejection(() => recipe({ blueprint: text }));
    expect(withText('not json')).toEqual({
      problem: 'blueprint',
      message:
        'Invalid subject blueprint: Could not parse this blueprint. Choose a valid JSON file.',
    });
    const disconnected = JSON.parse(blueprint());
    disconnected.genome.cells = [
      { x: 0, y: 0, type: 3 },
      { x: 3, y: 3, type: 4 },
    ];
    expect(withText(JSON.stringify(disconnected)).problem).toBe('blueprint');
    // A selected organism's acquired state is not a blueprint.
    const world = new Ecosystem();
    const organism = [...world.organisms.values()][0];
    expect(withText(JSON.stringify(organism)).problem).toBe('blueprint');
    const withEnergy = { ...JSON.parse(blueprint()), energy: organism.energy };
    expect(withText(JSON.stringify(withEnergy)).problem).toBe('blueprint');
    const reserves = JSON.parse(blueprint());
    reserves.genome.reserves = { stored: 3, dormant: true };
    expect(withText(JSON.stringify(reserves)).problem).toBe('blueprint');
    expect(rejection(() => recipe({ blueprint: 7 as any })).problem).toBe('format');
    // Opaque preserved traits would be dropped by execution, so they are rejected.
    expect(withText(blueprint(storedSensoryGenome()))).toEqual({
      problem: 'unsupported',
      message:
        'The subject blueprint carries preserved opaque traits that the assay engine cannot execute; it is rejected rather than run without them.',
    });
    const cellOpaque = { ...founder(0) };
    cellOpaque.cells = cellOpaque.cells.map((cell, position) =>
      position ? cell : { ...cell, legacyExtensions: [['note', [['string', 'opaque']]]] as any },
    );
    expect(withText(blueprint(cellOpaque)).problem).toBe('unsupported');
  });

  it('rejects malformed recipes, fixture references, seeds and unsupported mode combinations', () => {
    const valid = recipe().recipe;
    const tamper = (change: (copy: any) => void) => {
      const copy = structuredClone(valid) as any;
      change(copy);
      return rejection(() => validateAssayRecipe(copy)).problem;
    };
    expect(rejection(() => validateAssayRecipe(null)).problem).toBe('format');
    expect(tamper((copy) => (copy.extra = 1))).toBe('format');
    expect(tamper((copy) => (copy.format = 'evolab-drift-batch'))).toBe('format');
    expect(tamper((copy) => (copy.version = 2))).toBe('format');
    expect(tamper((copy) => (copy.rules.id = 'other'))).toBe('format');
    expect(tamper((copy) => (copy.rules.version = 0))).toBe('format');
    expect(tamper((copy) => (copy.rules.worldVersion = 'x'))).toBe('format');
    expect(tamper((copy) => (copy.subject.energy = 10))).toBe('format');
    expect(tamper((copy) => (copy.ecology.nutrientCycle = 'yes'))).toBe('format');
    expect(tamper((copy) => (copy.ecology.biologicalShade = 1))).toBe('format');
    expect(tamper((copy) => delete copy.ecology.biologicalShade)).toBe('format');
    expect(tamper((copy) => (copy.fixtures = {}))).toBe('format');
    expect(tamper((copy) => (copy.seeds = 'all'))).toBe('format');
    expect(tamper((copy) => (copy.fixtures = []))).toBe('format');
    expect(tamper((copy) => (copy.seeds = []))).toBe('format');
    expect(tamper((copy) => (copy.fixtures[1] = { ...copy.fixtures[0] }))).toBe('format');
    expect(tamper((copy) => (copy.fixtures[0].id = 'sandbox'))).toBe('format');
    expect(tamper((copy) => (copy.fixtures[0].id = 'toString'))).toBe('format');
    expect(tamper((copy) => (copy.fixtures[0].id = 5))).toBe('format');
    expect(tamper((copy) => (copy.fixtures[0].extra = true))).toBe('format');
    expect(tamper((copy) => (copy.fixtures[0].version = 2))).toBe('unsupported');
    expect(tamper((copy) => (copy.fixtures[0].sha256 = sha256('older')))).toBe('unsupported');
    for (const seeds of [[-1], [0x100000000], [1.5], [1, 1], ['1']])
      expect(tamper((copy) => (copy.seeds = seeds))).toBe('format');
    expect(rejection(() => readAssayRecipe('{')).problem).toBe('format');
    expect(rejection(() => recipe({ fixtures: ['sandbox' as AssayFixtureId] })).problem).toBe(
      'format',
    );
    expect(rejection(() => recipe({ fixtures: 'all' as any })).problem).toBe('format');
    expect(
      rejection(() =>
        recipe({
          fixtures: ['limited-food', 'thermal-exposure'],
          ecology: { nutrientCycle: true, biologicalShade: true },
        }),
      ),
    ).toEqual({
      problem: 'unsupported',
      message:
        'Fixture thermal-exposure does not support the requested ecological mode combination.',
    });
    expect(
      recipe({
        fixtures: ['thermal-exposure'],
        ecology: { nutrientCycle: true, biologicalShade: false },
      }).supported,
    ).toBe(true);
    for (const id of ['limited-food', 'obstacle-navigation', 'stinger-contact'] as const)
      expect(
        recipe({ fixtures: [id], ecology: { nutrientCycle: true, biologicalShade: true } }).plan
          .trialCount,
      ).toBe(4);
  });

  it('accepts recipes declared under other rules but resolves their trials as unsupported', () => {
    const older = structuredClone(recipe().recipe);
    older.rules.version = EXPERIMENT_RULES_VERSION - 1;
    expect(validateAssayRecipe(older).supported).toBe(false);
    const trial = startAssayTrial(older, 'limited-food', 1);
    const expected = {
      fixture: 'limited-food',
      seed: 1,
      status: 'unsupported',
      tick: 0,
      reason: `Recipe rules ${EXPERIMENT_RULES_VERSION - 1} / world ${WORLD_VERSION} are not this runtime's rules; trials are not run under substitute rules.`,
      subjectAlive: false,
      subjectLineageLiving: 0,
      population: 0,
      checkpointSha256: null,
    };
    expect(trial.endpoint()).toEqual(expected);
    expect(trial.initialization).toBeNull();
    expect(trial.world).toBeNull();
    expect(trial.advance(clock)).toEqual({ tick: 0, horizonTick: 0, done: true });
    expect(trial.cancel()).toEqual(expected);
    trial.dispose();
    const otherWorld = structuredClone(recipe().recipe);
    otherWorld.rules.worldVersion = WORLD_VERSION + 1;
    expect(startAssayTrial(otherWorld, 'stinger-contact', 4).endpoint()!.status).toBe(
      'unsupported',
    );
    expect(() => startAssayTrial(recipe({ seeds: [1] }).recipe, 'limited-food', 2)).toThrow(
      'That fixture and seed are not part of this assay recipe.',
    );
    expect(() =>
      startAssayTrial(recipe({ fixtures: ['limited-food'] }).recipe, 'stinger-contact', 1),
    ).toThrow('That fixture and seed are not part of this assay recipe.');
  });
});

describe('assay trial initialization', () => {
  it.each(ASSAY_FIXTURE_IDS)('initializes %s resources and placement exactly', (id) => {
    const fixture = ASSAY_FIXTURES[id];
    const genome = founder(0);
    const trial = trialOf(id, 7, { genome });
    const init = trial.initialization!;
    const save = trial.world!.save();
    expect(init.fixture).toBe(id);
    expect(init.fixtureSha256).toBe(ASSAY_FIXTURE_DIGESTS[id]);
    expect(init.blueprintSha256).toBe(sha256(blueprint(genome)));
    expect(init.seed).toBe(7);
    expect(save.tick).toBe(0);
    expect(save.settings).toEqual({ seed: 7, mutation: 0, ...fixture.settings });
    expect(save.terrain).toEqual(fixture.terrain);
    expect(save.food).toEqual(latticePoints(fixture));
    expect(init.food).toEqual({ pellets: fixture.pellets, energy: fixture.pellets * 2.2 });
    expect(init.walls).toBe(save.walls.length);
    expect(init.walls).toBe(id === 'obstacle-navigation' ? 1212 : 0);
    expect(init.subject).toMatchObject({ x: 120, y: 78, rotation: 0, cells: 5, energy: 13 });
    expect(save.organisms[0].genome).toEqual(genome);
    expect(save.organisms[0]).toMatchObject({ age: 0, generation: 0, children: 0, ancestry: [] });
    if (id === 'stinger-contact') {
      // founder(0)'s easternmost cell is (1, 0): the stinger touches it at (122, 78).
      expect(init.antagonist).toMatchObject({ x: 122, y: 78, cells: 1, energy: 9 });
      expect(save.organisms[1].genome).toEqual(fixture.antagonist!.genome);
      expect(init.energy).toEqual({
        subject: 13,
        antagonist: 9,
        food: 72 * 2.2,
        total: 22 + 72 * 2.2,
      });
    } else {
      expect(init.antagonist).toBeNull();
      expect(save.organisms).toHaveLength(1);
      expect(init.energy.total).toBe(13 + fixture.pellets * 2.2);
    }
    expect(init.nutrients).toBeNull();
    expect(trial.endpoint()).toBeNull();
    // The initial world is a complete, loadable checkpoint.
    expect(Ecosystem.load(JSON.stringify(save)).save()).toEqual(save);
  });

  it('places the subject reproducibly; seeds vary only engine random state', () => {
    const first = trialOf('obstacle-navigation', 11),
      again = trialOf('obstacle-navigation', 11),
      other = trialOf('obstacle-navigation', 12);
    expect(again.initialization).toEqual(first.initialization);
    expect(again.world!.save()).toEqual(first.world!.save());
    const { direction: _a, ...placement } = first.initialization!.subject;
    const { direction: _b, ...otherPlacement } = other.initialization!.subject;
    expect(otherPlacement).toEqual(placement);
    expect(other.world!.save().food).toEqual(first.world!.save().food);
    expect(other.world!.save().walls).toEqual(first.world!.save().walls);
    expect(other.world!.random.state).not.toBe(first.world!.random.state);
    // Food lies only in the neighbouring chambers, beyond the walls at x = 90 and x = 150.
    expect(first.world!.save().food.every((p) => p % WIDTH < 90 || p % WIDTH > 150)).toBe(true);
  });

  it('debits food and body matter from the finite nutrient endowment', () => {
    const genome = founder(2);
    for (const id of ['limited-food', 'stinger-contact'] as const) {
      const trial = trialOf(id, 3, {
        genome,
        ecology: { nutrientCycle: true, biologicalShade: id === 'stinger-contact' },
      });
      const init = trial.initialization!;
      const bodies = genome.cells.length + (id === 'stinger-contact' ? 1 : 0);
      expect(init.nutrients).toEqual({
        total: NUTRIENT_TOTAL,
        minerals: NUTRIENT_TOTAL - 72 - bodies,
        foodDebited: 72,
        bodiesDebited: bodies,
      });
      const world = trial.world!;
      validateNutrients(world.nutrientCycle!, world.organisms.values(), world.food);
      for (const position of world.save().food)
        expect(world.nutrientCycle!.minerals[position]).toBe(3);
      expect(world.biologicalShade.enabled).toBe(id === 'stinger-contact');
      const save = world.save();
      expect(Ecosystem.load(JSON.stringify(save)).save()).toEqual(save);
    }
  });

  it('declares blocked initialization instead of moving the subject or dropping resources', () => {
    const navigation = ASSAY_FIXTURES['obstacle-navigation'];
    const provenance = { fixtureSha256: 'test', blueprintSha256: 'test' };
    const blocked = (fixture: AssayFixture, ecology = neutral) =>
      startFixtureTrial(fixture, founder(0), 1, ecology, 100, provenance);
    const wall = blocked({ ...navigation, subject: { ...navigation.subject, x: 90 } });
    expect(wall.endpoint()).toEqual({
      fixture: 'obstacle-navigation',
      seed: 1,
      status: 'blocked-initialization',
      tick: 0,
      reason: 'The subject footprint is blocked at the fixture placement.',
      subjectAlive: false,
      subjectLineageLiving: 0,
      population: 0,
      checkpointSha256: null,
    });
    expect(wall.initialization).toBeNull();
    expect(wall.world).toBeNull();
    expect(wall.advance(clock)).toEqual({ tick: 0, horizonTick: 100, done: true });
    expect(wall.cancel().status).toBe('blocked-initialization');
    // The antagonist touches x + 2; put that cell on the wall column x = 90.
    const walls = trialOf('obstacle-navigation').world!.walls;
    let row = 60;
    while (!walls[index(90, row)]) row++;
    const stinger = blocked({
      ...ASSAY_FIXTURES['stinger-contact'],
      terrain: navigation.terrain,
      subject: { ...navigation.subject, x: 88, y: row },
    });
    expect(stinger.endpoint()!.reason).toBe(
      'The fixed antagonist is blocked at its contact placement.',
    );
    expect(blocked({ ...navigation, pellets: 125 }).endpoint()!.reason).toBe(
      'Fixture declares 125 pellets but placed 126.',
    );
    expect(
      blocked({
        ...navigation,
        food: { step: 6, regions: [[84, 58, 96, 58]], exclude: [] },
      }).endpoint()!.reason,
    ).toBe('Food lattice point (90, 58) is not free.');
  });

  it('refuses occupied, food-bearing or depleted lattice points', () => {
    const lattice = { step: 1, regions: [[10, 10, 10, 10] as const], exclude: [] };
    const world = new Ecosystem({ seed: 1, mutation: 0, nutrients: 5, climate: 0 }, false, {
      nutrientCycle: true,
    });
    world.nutrientCycle!.minerals[index(10, 10)] = 0;
    expect(() => seedFoodLattice(world, lattice)).toThrow(
      'Food lattice point (10, 10) is not free.',
    );
    world.nutrientCycle!.minerals[index(10, 10)] = 1;
    expect(seedFoodLattice(world, lattice)).toBe(1);
    expect(world.nutrientCycle!.minerals[index(10, 10)]).toBe(0);
    expect(() => seedFoodLattice(world, lattice)).toThrow('is not free');
    const occupied = new Ecosystem({ seed: 1, mutation: 0, nutrients: 5, climate: 0 }, false);
    occupied.spawn(founder(0), 10, 10);
    expect(() => seedFoodLattice(occupied, lattice)).toThrow('is not free');
  });
});

// founder(0) with armor on its easternmost cell, which the fixed stinger cannot drain.
const armored = (): Genome => {
  const genome = founder(0);
  return {
    ...genome,
    cells: genome.cells.map((cell) => (cell.x === 1 ? { ...cell, type: 7 } : cell)),
  };
};

describe('assay trial endpoints', () => {
  it.each(ASSAY_FIXTURE_IDS)(
    'reaches a deterministic %s endpoint identical to the direct engine',
    (id) => {
      const horizonTicks = id === 'thermal-exposure' ? 1830 : 240;
      const genome = id === 'stinger-contact' ? armored() : founder(0);
      const first = trialOf(id, 5, { genome, horizonTicks });
      const checkpoint = JSON.stringify(first.world!.save());
      const endpoint = run(first);
      expect(endpoint.status).toBe('horizon');
      expect(endpoint.tick).toBe(horizonTicks);
      expect(endpoint.reason).toBeNull();
      // The original subject reaches its age limit (900 + 5 × 75) before tick 1830.
      expect(endpoint.subjectAlive).toBe(horizonTicks < 1275);
      expect(endpoint.subjectLineageLiving).toBe(
        endpoint.population - (id === 'stinger-contact' ? 1 : 0),
      );
      expect(endpoint.subjectLineageLiving).toBeGreaterThan(0);
      expect(endpoint.checkpointSha256).toBe(sha256(JSON.stringify(first.world!.save())));
      // Replaying the same trial yields the identical endpoint.
      expect(run(trialOf(id, 5, { genome, horizonTicks }))).toEqual(endpoint);
      // The trial's bookkeeping is read-only: the bare engine reaches the same state.
      const direct = Ecosystem.load(checkpoint);
      while (direct.tick < horizonTicks) {
        for (const event of ASSAY_FIXTURES[id].schedule)
          if (event.tick === direct.tick)
            EXPERIMENT_INTERVENTIONS[event.intervention].apply(direct);
        direct.step();
      }
      expect(sha256(JSON.stringify(direct.save()))).toBe(endpoint.checkpointSha256);
      expect(run(trialOf(id, 6, { genome, horizonTicks })).checkpointSha256).not.toBe(
        endpoint.checkpointSha256,
      );
      if (id === 'thermal-exposure') {
        const shocks = first
          .world!.interventionSnapshot()
          .entries.filter((row) => row.kind === 'shock');
        expect(shocks.map((row) => [row.firstTick, (row.detail as any).kind])).toEqual([
          [0, 'heat'],
          [1800, 'cold'],
        ]);
        expect(first.world!.eventOffset).toBe(-0.32);
      }
    },
  );

  it('declares extinction separately, with the extinction tick', () => {
    const mouth: Genome = { ...founder(0), cells: [{ x: 0, y: 0, type: 3 }] };
    const trial = trialOf('limited-food', 2, { genome: mouth, horizonTicks: 1000 });
    const endpoint = run(trial);
    expect(endpoint).toMatchObject({
      status: 'extinct',
      reason: 'No organism of the subject lineage remains.',
      subjectAlive: false,
      subjectLineageLiving: 0,
      population: 0,
    });
    expect(endpoint.tick).toBeGreaterThan(500);
    expect(endpoint.tick).toBeLessThan(1000);
    expect(trial.world!.lastDeath).toEqual({ tick: endpoint.tick, cause: 'energy' });
    // The one-cell corpse becomes food beside the 72 untouched pellets.
    expect(trial.world!.save().food).toHaveLength(73);
  });

  it('drains an unarmored subject through the fixed stinger contact', () => {
    const trial = trialOf('stinger-contact', 9, { horizonTicks: 600 });
    const endpoint = run(trial);
    expect(endpoint).toMatchObject({ status: 'extinct', subjectAlive: false, population: 1 });
    expect(endpoint.tick).toBeLessThan(60);
    const ledger = trial.world!.telemetrySnapshot().pending.energy;
    expect(ledger.stingsDrained).toBeGreaterThanOrEqual(13);
    expect(ledger.stingsGained).toBeGreaterThan(0);
  });

  it('follows new subject species through ancestry and excludes the antagonist', () => {
    const food = ASSAY_FIXTURES['limited-food'];
    const mutating = { ...food, settings: { ...food.settings, mutation: 0.4, nutrients: 5 } };
    const provenance = { fixtureSha256: 'test', blueprintSha256: 'test' };
    const trial = startFixtureTrial(mutating, founder(0), 9, neutral, 900, provenance);
    const endpoint = run(trial);
    const living = [...trial.world!.organisms.values()];
    expect(new Set(living.map((organism) => organism.species)).size).toBeGreaterThan(1);
    expect(endpoint.subjectLineageLiving).toBe(living.length);
    const stinger = ASSAY_FIXTURES['stinger-contact'];
    const contact = startFixtureTrial(
      { ...stinger, settings: { ...stinger.settings, mutation: 0.4 } },
      armored(),
      9,
      neutral,
      600,
      provenance,
    );
    const antagonist = contact.initialization!.antagonist!;
    const contacted = run(contact);
    expect(contact.world!.organisms.has(antagonist.id)).toBe(true);
    expect(contacted.population).toBeGreaterThan(2);
    expect(contacted.subjectLineageLiving).toBe(contacted.population - 1);
  });

  it('composes with neural, dormancy and life-history subjects in finite-nutrient worlds', () => {
    const genome: Genome = {
      ...founder(1),
      controller: newController(1),
      dormancy: { ...DEFAULT_DORMANCY },
      lifeHistory: defaultLifeHistory(),
    };
    const ecology = { nutrientCycle: true, biologicalShade: false };
    const endpoint = run(trialOf('thermal-exposure', 8, { genome, ecology, horizonTicks: 300 }));
    expect(['horizon', 'extinct']).toContain(endpoint.status);
    expect(run(trialOf('thermal-exposure', 8, { genome, ecology, horizonTicks: 300 }))).toEqual(
      endpoint,
    );
    const trial = trialOf('thermal-exposure', 8, { genome, ecology, horizonTicks: 300 });
    expect(trial.world!.organisms.get(trial.initialization!.subject.id)!.genome).toEqual(genome);
  });

  it('time-slices, cancels as a separate outcome and refuses use after disposal', () => {
    const trial = trialOf('limited-food', 4, { horizonTicks: 600 });
    let time = 0;
    expect(trial.advance(() => (time += 10))).toEqual({ tick: 1, horizonTick: 600, done: false });
    expect(trial.advance(clock)).toEqual({ tick: 13, horizonTick: 600, done: false });
    const cancelled = trial.cancel();
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      tick: 13,
      reason: 'Cancelled before the horizon.',
      subjectAlive: true,
      subjectLineageLiving: 1,
    });
    expect(cancelled.checkpointSha256).toBe(sha256(JSON.stringify(trial.world!.save())));
    expect(trial.cancel()).toEqual(cancelled);
    expect(trial.advance(clock)).toEqual({ tick: 13, horizonTick: 600, done: true });
    const endpoint = trial.endpoint()!;
    endpoint.status = 'horizon';
    expect(trial.endpoint()!.status).toBe('cancelled');
    const init = trial.initialization!;
    init.subject.x = 0;
    expect(trial.initialization!.subject.x).toBe(120);
    trial.dispose();
    expect(trial.world).toBeNull();
    expect(() => trial.advance(clock)).toThrow('Assay trial was disposed.');
  });
});
