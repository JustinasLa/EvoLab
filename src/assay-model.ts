import { BLUEPRINT_MAX_BYTES, parseBlueprint, type BlueprintFile } from './blueprint';
import { BATCH_MAX_TICKS } from './batch-model';
import { COMPARISON_MAX_TICKS, EXPERIMENT_RULES_VERSION } from './experiment-model';
import {
  HEIGHT,
  WIDTH,
  WORLD_MAX_BYTES,
  WORLD_VERSION,
  exactDataRecord,
  integer,
  type Genome,
  type Settings,
  type TerrainRecipe,
} from './model';
import { sha256 } from './sha256';

/**
 * Single-blueprint assay fixtures: isolated, seeded trial worlds that evaluate one
 * inherited design. Recipes describe what to run; they never contain an organism's
 * acquired state, and they never edit the sandbox.
 */
export const ASSAY_RECIPE_FORMAT = 'evolab-drift-assay-recipe';
export const ASSAY_RECIPE_VERSION = 1;
export const ASSAY_FIXTURE_VERSION = 1;
export const ASSAY_MAX_FIXTURES = 4;
export const ASSAY_MAX_SEEDS = 4;
/** The issue-level per-trial ceiling; the existing comparison horizon is tighter. */
export const ASSAY_REQUESTED_TRIAL_TICKS = 5000;
export const ASSAY_MAX_TRIAL_TICKS = Math.min(ASSAY_REQUESTED_TRIAL_TICKS, COMPARISON_MAX_TICKS);
/** Aggregate engine-tick budget shared with seeded batches. */
export const ASSAY_MAX_TOTAL_TICKS = BATCH_MAX_TICKS;
// A blueprint string can expand sixfold when escaped in the outer JSON.
export const ASSAY_RECIPE_MAX_BYTES = BLUEPRINT_MAX_BYTES * 6 + 8192;
export const ASSAY_ENDPOINT_MAX_BYTES = 2048;
/**
 * Conservative upper estimate for the one trial engine active at a time: every
 * per-cell plane (food, walls, occupancy, painted temperature and shade, biological
 * shade and both nutrient planes = 17 bytes per cell), plus three world-cap-sized
 * allowances for live organisms/lineage records, the endpoint save and its string.
 */
export const ASSAY_ENGINE_ESTIMATE_BYTES = 17 * WIDTH * HEIGHT + 3 * WORLD_MAX_BYTES;
export const ASSAY_MEMORY_BUDGET_BYTES = 16_000_000;

export type AssayFixtureId =
  'limited-food' | 'thermal-exposure' | 'obstacle-navigation' | 'stinger-contact';
export type AssayMeasurement =
  | 'subject-survival-tick'
  | 'energy-ledger'
  | 'offspring'
  | 'lineage-descendants-at-horizon'
  | 'food-eaten'
  | 'food-remaining'
  | 'stressed-ticks'
  | 'neighbour-chamber-entry-tick'
  | 'stings-received'
  | 'energy-drained-by-stings';
/** Inclusive rectangle [x0, y0, x1, y1] in world cells. */
export type AssayRectangle = readonly [number, number, number, number];
export interface AssayFoodLattice {
  /** Lattice spacing in cells, anchored at each region's top-left corner. */
  step: number;
  regions: readonly AssayRectangle[];
  exclude: readonly AssayRectangle[];
}
export interface AssayFixture {
  id: AssayFixtureId;
  version: typeof ASSAY_FIXTURE_VERSION;
  label: string;
  settings: Omit<Settings, 'seed'>;
  terrain: TerrainRecipe;
  /** Rotation 0; initial energy is the ordinary placement grant of 8 + cell count. */
  subject: { x: number; y: number; rotation: 0; energy: 'placement-grant' };
  food: AssayFoodLattice;
  pellets: number;
  /** Stationary one-cell stinger touching the subject's easternmost cell. */
  antagonist: { placement: 'east-contact'; genome: Genome } | null;
  schedule: readonly { tick: number; intervention: 'heat' | 'cold' }[];
  modes: { nutrientCycle: boolean; biologicalShade: boolean };
  measurements: readonly AssayMeasurement[];
}

const COMMON: readonly AssayMeasurement[] = [
  'subject-survival-tick',
  'energy-ledger',
  'offspring',
  'lineage-descendants-at-horizon',
];
const NEUTRAL = { mutation: 0, nutrients: 5, climate: 0 } as const;
const OPEN_FIELD: TerrainRecipe = { version: 1, preset: 'open-field', seed: null };
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2, rotation: 0, energy: 'placement-grant' } as const;
// 9 × 9 lattice points every 4 cells around the subject, minus the 3 × 3 inside its ±4 box.
const RING: AssayFoodLattice = {
  step: 4,
  regions: [[104, 62, 136, 94]],
  exclude: [[116, 74, 124, 82]],
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const ASSAY_FIXTURES: Readonly<Record<AssayFixtureId, AssayFixture>> = freeze({
  'limited-food': {
    id: 'limited-food',
    version: ASSAY_FIXTURE_VERSION,
    label: 'Limited food: 72 pellets, no leaf food production',
    settings: { ...NEUTRAL, nutrients: 0 },
    terrain: OPEN_FIELD,
    subject: CENTER,
    food: RING,
    pellets: 72,
    antagonist: null,
    schedule: [],
    modes: { nutrientCycle: true, biologicalShade: true },
    measurements: [...COMMON, 'food-eaten', 'food-remaining'],
  },
  'thermal-exposure': {
    id: 'thermal-exposure',
    version: ASSAY_FIXTURE_VERSION,
    label: 'Heat then cold: +0.32 at tick 0, −0.32 at tick 1800 (900 ticks each)',
    settings: NEUTRAL,
    terrain: OPEN_FIELD,
    subject: CENTER,
    food: RING,
    pellets: 72,
    antagonist: null,
    schedule: [
      { tick: 0, intervention: 'heat' },
      { tick: 1800, intervention: 'cold' },
    ],
    // Armor-cast cooling would alter the declared uniform exposure.
    modes: { nutrientCycle: true, biologicalShade: false },
    measurements: [...COMMON, 'stressed-ticks'],
  },
  'obstacle-navigation': {
    id: 'obstacle-navigation',
    version: ASSAY_FIXTURE_VERSION,
    label: 'Obstacle navigation: food only beyond the walls of the starting chamber',
    settings: NEUTRAL,
    // Terrain seed 98 centres the 59 × 51 interior of chamber (91–149, 53–103) on the subject.
    terrain: { version: 1, preset: 'chambered-refuges', seed: 98 },
    subject: CENTER,
    food: {
      step: 6,
      regions: [
        [36, 58, 84, 98],
        [156, 58, 204, 98],
      ],
      exclude: [],
    },
    pellets: 126,
    antagonist: null,
    schedule: [],
    modes: { nutrientCycle: true, biologicalShade: true },
    measurements: [...COMMON, 'neighbour-chamber-entry-tick', 'food-eaten'],
  },
  'stinger-contact': {
    id: 'stinger-contact',
    version: ASSAY_FIXTURE_VERSION,
    label: 'Fixed stinger contact: one stationary stinger beside the subject',
    settings: NEUTRAL,
    terrain: OPEN_FIELD,
    subject: CENTER,
    food: RING,
    pellets: 72,
    antagonist: {
      placement: 'east-contact',
      genome: {
        cells: [{ x: 0, y: 0, type: 6 }],
        preference: 0.5,
        tolerance: 0.3,
        tempo: 5,
        behavior: { version: 1, mode: 'legacy' },
      },
    },
    schedule: [],
    modes: { nutrientCycle: true, biologicalShade: true },
    measurements: [...COMMON, 'stings-received', 'energy-drained-by-stings'],
  },
});
export const ASSAY_FIXTURE_IDS = Object.freeze(Object.keys(ASSAY_FIXTURES) as AssayFixtureId[]);
/** Provenance digest of each complete fixture definition. */
export const ASSAY_FIXTURE_DIGESTS: Readonly<Record<AssayFixtureId, string>> = Object.freeze(
  Object.fromEntries(
    ASSAY_FIXTURE_IDS.map((id) => [id, sha256(JSON.stringify(ASSAY_FIXTURES[id]))]),
  ) as Record<AssayFixtureId, string>,
);

export interface AssayEcology {
  nutrientCycle: boolean;
  biologicalShade: boolean;
}
export interface AssayRecipe {
  format: typeof ASSAY_RECIPE_FORMAT;
  version: typeof ASSAY_RECIPE_VERSION;
  rules: { id: 'evolab-drift-cellular'; version: number; worldVersion: number };
  subject: { blueprint: string; bytes: number; sha256: string };
  fixtures: { id: AssayFixtureId; version: number; sha256: string }[];
  seeds: number[];
  horizonTicks: number;
  ecology: AssayEcology;
}
export interface AssayPlan {
  trials: { fixture: AssayFixtureId; seed: number }[];
  trialCount: number;
  ticksPerTrial: number;
  totalTicks: number;
  memory: {
    engineBytes: number;
    recipeBytes: number;
    endpointBytes: number;
    totalBytes: number;
    budgetBytes: number;
  };
}
export interface ValidatedAssay {
  recipe: AssayRecipe;
  blueprint: BlueprintFile;
  plan: AssayPlan;
  /** False when the recipe was declared under different rules or world format. */
  supported: boolean;
}
export type AssayRecipeProblem = 'format' | 'blueprint' | 'unsupported' | 'budget';
export class AssayRecipeError extends Error {
  constructor(
    readonly problem: AssayRecipeProblem,
    message: string,
  ) {
    super(message);
    this.name = 'AssayRecipeError';
  }
}

const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
const fail = (problem: AssayRecipeProblem, message: string): never => {
  throw new AssayRecipeError(problem, message);
};
const opaque = (genome: Genome): boolean =>
  Object.hasOwn(genome, 'legacyExtensions') ||
  genome.cells.some((cell) => Object.hasOwn(cell, 'legacyExtensions'));

export function validateAssayRecipe(value: unknown): ValidatedAssay {
  if (
    !exactDataRecord(value, [
      'format',
      'version',
      'rules',
      'subject',
      'fixtures',
      'seeds',
      'horizonTicks',
      'ecology',
    ]) ||
    value.format !== ASSAY_RECIPE_FORMAT ||
    value.version !== ASSAY_RECIPE_VERSION ||
    !exactDataRecord(value.rules, ['id', 'version', 'worldVersion']) ||
    value.rules.id !== 'evolab-drift-cellular' ||
    !integer(value.rules.version, 1, 1e6) ||
    !integer(value.rules.worldVersion, 1, 1e6) ||
    !exactDataRecord(value.subject, ['blueprint', 'bytes', 'sha256']) ||
    typeof value.subject.blueprint !== 'string' ||
    !exactDataRecord(value.ecology, ['nutrientCycle', 'biologicalShade']) ||
    typeof value.ecology.nutrientCycle !== 'boolean' ||
    typeof value.ecology.biologicalShade !== 'boolean' ||
    !Array.isArray(value.fixtures) ||
    !Array.isArray(value.seeds)
  )
    fail('format', 'Not a valid EvoLab assay recipe (format 1).');
  const input = value as unknown as AssayRecipe;
  const text = input.subject.blueprint;
  if (input.subject.bytes !== bytes(text) || input.subject.sha256 !== sha256(text))
    fail('blueprint', 'Subject blueprint bytes or SHA-256 do not match the recorded provenance.');
  let blueprint: BlueprintFile;
  try {
    blueprint = parseBlueprint(text);
  } catch (error) {
    throw new AssayRecipeError(
      'blueprint',
      `Invalid subject blueprint: ${(error as Error).message}`,
    );
  }
  if (opaque(blueprint.genome))
    fail(
      'unsupported',
      'The subject blueprint carries preserved opaque traits that the assay engine cannot execute; it is rejected rather than run without them.',
    );
  if (input.fixtures.length < 1 || input.seeds.length < 1)
    fail('format', 'An assay needs at least one fixture and one seed.');
  if (input.fixtures.length > ASSAY_MAX_FIXTURES || input.seeds.length > ASSAY_MAX_SEEDS)
    fail(
      'budget',
      `An assay is limited to ${ASSAY_MAX_FIXTURES} fixtures and ${ASSAY_MAX_SEEDS} seeds.`,
    );
  const seen = new Set<string>();
  for (const fixture of input.fixtures) {
    if (
      !exactDataRecord(fixture, ['id', 'version', 'sha256']) ||
      typeof fixture.id !== 'string' ||
      !Object.hasOwn(ASSAY_FIXTURES, fixture.id) ||
      seen.has(fixture.id)
    )
      fail('format', 'Assay fixtures must be distinct known fixture references.');
    const definition = ASSAY_FIXTURES[fixture.id as AssayFixtureId];
    seen.add(definition.id);
    if (
      fixture.version !== definition.version ||
      fixture.sha256 !== ASSAY_FIXTURE_DIGESTS[definition.id]
    )
      fail(
        'unsupported',
        `Fixture ${definition.id} differs from this runtime's version ${definition.version}.`,
      );
    if (
      (input.ecology.nutrientCycle && !definition.modes.nutrientCycle) ||
      (input.ecology.biologicalShade && !definition.modes.biologicalShade)
    )
      fail(
        'unsupported',
        `Fixture ${definition.id} does not support the requested ecological mode combination.`,
      );
  }
  if (
    input.seeds.some((seed) => !integer(seed, 0, 0xffffffff)) ||
    new Set(input.seeds).size !== input.seeds.length
  )
    fail('format', 'Assay seeds must be distinct unsigned 32-bit integers.');
  if (!integer(input.horizonTicks, 1, ASSAY_MAX_TRIAL_TICKS))
    fail('budget', `Each assay trial runs 1–${ASSAY_MAX_TRIAL_TICKS} ticks.`);
  const recipe: AssayRecipe = {
    format: ASSAY_RECIPE_FORMAT,
    version: ASSAY_RECIPE_VERSION,
    rules: { ...input.rules },
    subject: { ...input.subject },
    fixtures: input.fixtures.map((fixture) => ({ ...fixture })),
    seeds: [...input.seeds],
    horizonTicks: input.horizonTicks,
    ecology: { ...input.ecology },
  };
  const trialCount = recipe.fixtures.length * recipe.seeds.length;
  const recipeBytes = bytes(JSON.stringify(recipe));
  const endpointBytes = trialCount * ASSAY_ENDPOINT_MAX_BYTES;
  const plan: AssayPlan = {
    trials: recipe.fixtures.flatMap((fixture) =>
      recipe.seeds.map((seed) => ({ fixture: fixture.id, seed })),
    ),
    trialCount,
    ticksPerTrial: recipe.horizonTicks,
    totalTicks: trialCount * recipe.horizonTicks,
    memory: {
      engineBytes: ASSAY_ENGINE_ESTIMATE_BYTES,
      recipeBytes,
      endpointBytes,
      totalBytes: ASSAY_ENGINE_ESTIMATE_BYTES + recipeBytes + endpointBytes,
      budgetBytes: ASSAY_MEMORY_BUDGET_BYTES,
    },
  };
  if (
    plan.totalTicks > ASSAY_MAX_TOTAL_TICKS ||
    recipeBytes > ASSAY_RECIPE_MAX_BYTES ||
    plan.memory.totalBytes > ASSAY_MEMORY_BUDGET_BYTES
  )
    fail(
      'budget',
      `This assay plans ${plan.totalTicks} engine ticks and about ${plan.memory.totalBytes} bytes; the limits are ${ASSAY_MAX_TOTAL_TICKS} ticks and ${ASSAY_MEMORY_BUDGET_BYTES} bytes.`,
    );
  return {
    recipe,
    blueprint,
    plan,
    supported:
      recipe.rules.version === EXPERIMENT_RULES_VERSION &&
      recipe.rules.worldVersion === WORLD_VERSION,
  };
}

/** Builds a recipe from exact blueprint text under the current rules. */
export function createAssayRecipe(input: {
  blueprint: string;
  fixtures: AssayFixtureId[];
  seeds: number[];
  horizonTicks: number;
  ecology: AssayEcology;
}): ValidatedAssay {
  return validateAssayRecipe({
    format: ASSAY_RECIPE_FORMAT,
    version: ASSAY_RECIPE_VERSION,
    rules: {
      id: 'evolab-drift-cellular',
      version: EXPERIMENT_RULES_VERSION,
      worldVersion: WORLD_VERSION,
    },
    subject: {
      blueprint: input.blueprint,
      bytes: typeof input.blueprint === 'string' ? bytes(input.blueprint) : 0,
      sha256: typeof input.blueprint === 'string' ? sha256(input.blueprint) : '',
    },
    fixtures: Array.isArray(input.fixtures)
      ? input.fixtures.map((id) => ({
          id,
          version: ASSAY_FIXTURES[id]?.version ?? 0,
          sha256: ASSAY_FIXTURE_DIGESTS[id] ?? '',
        }))
      : input.fixtures,
    seeds: input.seeds,
    horizonTicks: input.horizonTicks,
    ecology: input.ecology,
  });
}

export function readAssayRecipe(text: string): ValidatedAssay {
  if (
    typeof text !== 'string' ||
    text.length > ASSAY_RECIPE_MAX_BYTES ||
    bytes(text) > ASSAY_RECIPE_MAX_BYTES
  )
    fail('budget', 'Assay recipes must be 106,496 bytes or smaller.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AssayRecipeError(
      'format',
      'Could not parse this assay recipe. Choose a valid JSON file.',
    );
  }
  return validateAssayRecipe(value);
}

export const encodeAssayRecipe = (recipe: AssayRecipe): string =>
  JSON.stringify(validateAssayRecipe(recipe).recipe);
