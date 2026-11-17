import { Ecosystem } from './ecosystem';
import {
  validExperimentIntervention,
  type ExperimentIntervention,
} from './experiment-interventions';
import {
  COMPARISON_MAX_SAMPLES,
  COMPARISON_MAX_TICKS,
  COMPARISON_SAMPLE_INTERVAL,
  EXPERIMENT_RULES_VERSION,
  RECIPE_MAX_BYTES,
} from './experiment-model';
import {
  finite,
  HEIGHT,
  integer,
  LIMIT,
  validGenome,
  validSettings,
  WIDTH,
  WORLD_MAX_BYTES,
  WORLD_VERSION,
  type Genome,
  type Settings,
  type TerrainRecipe,
} from './model';
import { sha256 } from './sha256';
import { validTerrain } from './terrain';

export const DISCOVERY_FORMAT = 'evolab-drift-discovery';
export const DISCOVERY_VERSION = 1;
export const DISCOVERY_RECIPE_COUNT = 3;
export const DISCOVERY_MAX_BRANCHES = 2;
export const DISCOVERY_MAX_HORIZON = 10_000;
// The existing checkpoint comparison limit (3600 ticks from the source) is stricter.
export const DISCOVERY_MAX_TICKS = Math.min(DISCOVERY_MAX_HORIZON, COMPARISON_MAX_TICKS);
export const DISCOVERY_MAX_BYTES = 65_536;
// Combined retained text for one session: recipe, starting and final checkpoints.
export const DISCOVERY_MEMORY_BUDGET = RECIPE_MAX_BYTES;
export const DISCOVERY_MAX_DESIGNS = 6;
export const DISCOVERY_MAX_PLACEMENTS = 32;
export const DISCOVERY_MAX_FOOD = 8;
export const DISCOVERY_MAX_FOOD_RADIUS = 16;

export const DISCOVERY_MEASURES = Object.freeze([
  'population',
  'births',
  'deaths',
  'food',
  'meanPreference',
  'meanTolerance',
  'stressedFraction',
  'leafBearers',
  'grazers',
  'armoredGrazers',
  'stingerBearers',
] as const);
export type DiscoveryMeasure = (typeof DISCOVERY_MEASURES)[number];
export type DiscoveryObservation = { tick: number } & Record<
  Exclude<DiscoveryMeasure, 'meanPreference' | 'meanTolerance' | 'stressedFraction'>,
  number
> &
  Record<'meanPreference' | 'meanTolerance' | 'stressedFraction', number | null>;

export interface DiscoveryExtinction {
  tick: number;
  cause: string;
}
export interface DiscoveryStart {
  id: string;
  label: string;
  settings: Settings;
  terrain: TerrainRecipe;
  nutrientCycle: false;
  biologicalShade: false;
  food: { x: number; y: number; radius: number }[];
  designs: Genome[];
  placements: { design: number; x: number; y: number }[];
  checkpoint: { tick: 0; population: number; bytes: number; sha256: string };
}
export interface DiscoveryReference {
  runtime: string;
  samples: number;
  samplesSha256: string;
  endpoint: DiscoveryObservation;
  extinction: DiscoveryExtinction | null;
  checkpointSha256: string;
}
export interface DiscoveryBranch {
  id: string;
  label: string;
  start: string;
  intervention: ExperimentIntervention;
  reference: DiscoveryReference;
}
export interface DiscoveryRecipe {
  format: typeof DISCOVERY_FORMAT;
  version: typeof DISCOVERY_VERSION;
  id: string;
  revision: number;
  title: string;
  question: string;
  controls: string[];
  outcomes: { measure: DiscoveryMeasure; meaning: string }[];
  limitations: string[];
  rules: { id: 'evolab-drift-cellular'; version: number; worldVersion: number };
  seed: number;
  interventionTick: number;
  horizonTick: number;
  sampleInterval: number;
  starts: DiscoveryStart[];
  branches: DiscoveryBranch[];
}
export type DiscoveryOutcome =
  'completed' | 'extinct' | 'incomplete' | 'unsupported-rules' | 'missing-evidence';
export const DISCOVERY_OUTCOMES: Readonly<Record<DiscoveryOutcome, string>> = Object.freeze({
  completed: 'The branch reached its horizon with at least one living organism.',
  extinct: 'Every organism died; the world kept its tick-aligned evidence and was not rescued.',
  incomplete: 'The branch stopped before its horizon, for example after cancellation.',
  'unsupported-rules':
    'The recipe was recorded for other ecosystem rules or world version and is not run.',
  'missing-evidence': 'Required tick-aligned samples are absent or malformed; nothing is inferred.',
});

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const keys = (value: unknown, names: string): value is Record<string, any> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value: unknown, low: number, high: number): value is unknown[] =>
  Array.isArray(value) && integer(value.length, low, high);
const fail = (message: string): never => {
  throw new Error(`Invalid discovery recipe: ${message}.`);
};

export function validDiscoveryObservation(value: unknown): value is DiscoveryObservation {
  if (!keys(value, ['tick', ...DISCOVERY_MEASURES].join(','))) return false;
  const counts = ['population', 'leafBearers', 'grazers', 'armoredGrazers', 'stingerBearers'];
  return (
    integer(value.tick, 0, DISCOVERY_MAX_HORIZON) &&
    counts.every((key) => integer(value[key], 0, value.population)) &&
    integer(value.population, 0, LIMIT) &&
    value.armoredGrazers <= value.grazers &&
    integer(value.births, 0, 1e9) &&
    integer(value.deaths, 0, 1e9) &&
    integer(value.food, 0, WIDTH * HEIGHT) &&
    (value.population === 0
      ? value.meanPreference === null &&
        value.meanTolerance === null &&
        value.stressedFraction === null
      : finite(value.meanPreference, 0, 1) &&
        finite(value.meanTolerance, 0.12, 0.6) &&
        finite(value.stressedFraction, 0, 1))
  );
}

function validStart(start: unknown, seed: number): asserts start is DiscoveryStart {
  if (
    !keys(
      start,
      'id,label,settings,terrain,nutrientCycle,biologicalShade,food,designs,placements,checkpoint',
    )
  )
    fail('starting state fields');
  const value = start as Record<string, any>;
  if (!text(value.id, 48) || !SLUG.test(value.id) || !text(value.label, 80))
    fail('starting state identity');
  if (
    !keys(value.settings, 'seed,mutation,nutrients,climate') ||
    !validSettings(value.settings) ||
    value.settings.seed !== seed ||
    !validTerrain(value.terrain) ||
    value.nutrientCycle !== false ||
    value.biologicalShade !== false
  )
    fail('declared settings');
  if (
    !list(value.food, 0, DISCOVERY_MAX_FOOD) ||
    value.food.some(
      (stroke) =>
        !keys(stroke, 'x,y,radius') ||
        !integer((stroke as any).x, 0, WIDTH - 1) ||
        !integer((stroke as any).y, 0, HEIGHT - 1) ||
        !integer((stroke as any).radius, 1, DISCOVERY_MAX_FOOD_RADIUS),
    )
  )
    fail('food strokes');
  if (
    !list(value.designs, 1, DISCOVERY_MAX_DESIGNS) ||
    value.designs.some((design) => !validGenome(design, false, false, false, false, false, false))
  )
    fail('designs must be complete passive legacy genomes');
  if (
    !list(value.placements, 1, DISCOVERY_MAX_PLACEMENTS) ||
    value.placements.some(
      (placement) =>
        !keys(placement, 'design,x,y') ||
        !integer((placement as any).design, 0, value.designs.length - 1) ||
        !integer((placement as any).x, 0, WIDTH - 1) ||
        !integer((placement as any).y, 0, HEIGHT - 1),
    ) ||
    value.designs.some((_: Genome, design: number) =>
      value.placements.every((placement: { design: number }) => placement.design !== design),
    )
  )
    fail('placements');
  const checkpoint = value.checkpoint;
  if (
    !keys(checkpoint, 'tick,population,bytes,sha256') ||
    checkpoint.tick !== 0 ||
    !integer(checkpoint.population, 1, value.placements.length) ||
    !integer(checkpoint.bytes, 1, WORLD_MAX_BYTES) ||
    typeof checkpoint.sha256 !== 'string' ||
    !HASH.test(checkpoint.sha256)
  )
    fail('checkpoint provenance');
}

function validReference(value: unknown, recipe: Record<string, any>): void {
  const samples = discoverySampleTicks(recipe.horizonTick).length;
  if (
    !keys(value, 'runtime,samples,samplesSha256,endpoint,extinction,checkpointSha256') ||
    !text(value.runtime, 120) ||
    value.samples !== samples ||
    typeof value.samplesSha256 !== 'string' ||
    !HASH.test(value.samplesSha256) ||
    typeof value.checkpointSha256 !== 'string' ||
    !HASH.test(value.checkpointSha256) ||
    !validDiscoveryObservation(value.endpoint) ||
    value.endpoint.tick !== recipe.horizonTick ||
    (value.extinction === null
      ? value.endpoint.population === 0
      : !keys(value.extinction, 'tick,cause') ||
        !integer(value.extinction.tick, 1, recipe.horizonTick) ||
        !['age', 'energy'].includes(value.extinction.cause) ||
        value.endpoint.population !== 0)
  )
    fail('reference endpoint evidence');
}

/** Sample ticks shared with checkpoint comparisons: every 30 ticks plus the horizon. */
export function discoverySampleTicks(horizonTick: number): number[] {
  const ticks: number[] = [];
  for (let tick = 0; tick < horizonTick; tick += COMPARISON_SAMPLE_INTERVAL) ticks.push(tick);
  ticks.push(horizonTick);
  return ticks;
}

export interface DiscoveryBudget {
  engines: number;
  engineTicks: number;
  samples: number;
  retainedBytes: number;
}
/** Preflight of one session's bounded work and retained serialized state. */
export function discoveryBudget(recipe: DiscoveryRecipe): DiscoveryBudget {
  return {
    engines: recipe.branches.length,
    engineTicks: recipe.branches.length * recipe.horizonTick,
    samples: recipe.branches.length * discoverySampleTicks(recipe.horizonTick).length,
    retainedBytes:
      new TextEncoder().encode(JSON.stringify(recipe)).byteLength +
      recipe.starts.reduce((total, start) => total + start.checkpoint.bytes, 0) +
      recipe.branches.length * WORLD_MAX_BYTES,
  };
}

/** Pure structural validation. It neither builds worlds nor touches any random state. */
export function validateDiscoveryRecipe(value: unknown): DiscoveryRecipe {
  if (
    !keys(
      value,
      'format,version,id,revision,title,question,controls,outcomes,limitations,rules,seed,interventionTick,horizonTick,sampleInterval,starts,branches',
    )
  )
    fail('fields');
  const recipe = value as Record<string, any>;
  if (recipe.format !== DISCOVERY_FORMAT || recipe.version !== DISCOVERY_VERSION) fail('format');
  if (!text(recipe.id, 48) || !SLUG.test(recipe.id) || !integer(recipe.revision, 1, 1e6))
    fail('identity');
  if (
    !text(recipe.title, 80) ||
    !text(recipe.question, 300) ||
    ![recipe.controls, recipe.limitations].every(
      (items) => list(items, 1, 8) && items.every((item) => text(item, 300)),
    ) ||
    !list(recipe.outcomes, 1, DISCOVERY_MEASURES.length) ||
    recipe.outcomes.some(
      (outcome) =>
        !keys(outcome, 'measure,meaning') ||
        !DISCOVERY_MEASURES.includes((outcome as any).measure) ||
        !text((outcome as any).meaning, 300),
    ) ||
    new Set(recipe.outcomes.map((outcome: any) => outcome.measure)).size !== recipe.outcomes.length
  )
    fail('question, controls, outcomes or limitations');
  if (
    !keys(recipe.rules, 'id,version,worldVersion') ||
    recipe.rules.id !== 'evolab-drift-cellular' ||
    !integer(recipe.rules.version, 1, 1e6) ||
    !integer(recipe.rules.worldVersion, 1, 1e6)
  )
    fail('rules provenance');
  if (
    !integer(recipe.seed, 0, 0xffffffff) ||
    !integer(recipe.horizonTick, 1, DISCOVERY_MAX_TICKS) ||
    !integer(recipe.interventionTick, 0, recipe.horizonTick - 1) ||
    recipe.sampleInterval !== COMPARISON_SAMPLE_INTERVAL
  )
    fail(`seed or ticks (horizon 1–${DISCOVERY_MAX_TICKS}, intervention before it)`);
  if (!list(recipe.starts, 1, DISCOVERY_MAX_BRANCHES)) fail('starting states');
  for (const start of recipe.starts) validStart(start, recipe.seed);
  const starts = recipe.starts.map((start: DiscoveryStart) => start.id);
  if (new Set(starts).size !== starts.length) fail('duplicate starting states');
  if (!list(recipe.branches, 1, DISCOVERY_MAX_BRANCHES)) fail('at most two branches');
  for (const branch of recipe.branches) {
    if (
      !keys(branch, 'id,label,start,intervention,reference') ||
      !text(branch.id, 48) ||
      !SLUG.test(branch.id) ||
      !text(branch.label, 80) ||
      !starts.includes(branch.start) ||
      !validExperimentIntervention(branch.intervention)
    )
      fail('branch');
    validReference(branch.reference, recipe);
  }
  const branches = recipe.branches as DiscoveryBranch[];
  if (
    new Set(branches.map((branch) => branch.id)).size !== branches.length ||
    new Set(branches.map((branch) => `${branch.start}|${branch.intervention}`)).size !==
      branches.length ||
    starts.some((id: string) => branches.every((branch) => branch.start !== id))
  )
    fail('branches must be distinct and use every starting state');
  if (new TextEncoder().encode(JSON.stringify(recipe)).byteLength > DISCOVERY_MAX_BYTES)
    fail('recipe exceeds 64 KiB');
  const budget = discoveryBudget(recipe as DiscoveryRecipe);
  if (
    budget.engines > DISCOVERY_MAX_BRANCHES ||
    budget.engineTicks > DISCOVERY_MAX_BRANCHES * COMPARISON_MAX_TICKS ||
    budget.samples > DISCOVERY_MAX_BRANCHES * COMPARISON_MAX_SAMPLES ||
    budget.retainedBytes > DISCOVERY_MEMORY_BUDGET
  )
    fail('combined session budget');
  return recipe as DiscoveryRecipe;
}

export function readDiscoveryRecipe(source: string): DiscoveryRecipe {
  if (
    typeof source !== 'string' ||
    source.length > DISCOVERY_MAX_BYTES ||
    new TextEncoder().encode(source).byteLength > DISCOVERY_MAX_BYTES
  )
    throw new Error('Discovery recipe exceeds 64 KiB.');
  return validateDiscoveryRecipe(JSON.parse(source));
}

export function validateDiscoveryCatalog(recipes: readonly unknown[]): void {
  if (!Array.isArray(recipes) || recipes.length !== DISCOVERY_RECIPE_COUNT)
    throw new Error('The discovery catalog holds exactly three recipes.');
  const ids = recipes.map((recipe) => validateDiscoveryRecipe(recipe).id);
  if (new Set(ids).size !== ids.length) throw new Error('Discovery recipe IDs must be unique.');
}

export function discoverySupported(recipe: DiscoveryRecipe): boolean {
  return (
    recipe.rules.version === EXPERIMENT_RULES_VERSION && recipe.rules.worldVersion === WORLD_VERSION
  );
}

/** Builds a starting state with the real engine, without checking recorded provenance. */
export function discoveryCheckpoint(start: DiscoveryStart): string {
  const world = new Ecosystem(start.settings, false, { terrain: start.terrain });
  for (const stroke of start.food)
    world.paint('food', stroke.x, stroke.y, stroke.radius, start.designs[0]);
  for (const [position, placement] of start.placements.entries())
    if (!world.spawn(start.designs[placement.design], placement.x, placement.y))
      throw new Error(`Discovery placement ${position + 1} does not fit its starting state.`);
  return JSON.stringify(world.save());
}

/** Rebuilds one declared starting state and verifies its bytes and SHA-256 before use. */
export function buildDiscoveryStart(recipe: DiscoveryRecipe, startId: string): string {
  validateDiscoveryRecipe(recipe);
  if (!discoverySupported(recipe))
    throw new Error(
      `Recipe ${recipe.id} was recorded for rules ${recipe.rules.version}/world ${recipe.rules.worldVersion}; this build runs ${EXPERIMENT_RULES_VERSION}/${WORLD_VERSION}.`,
    );
  const start = recipe.starts.find((candidate) => candidate.id === startId);
  if (!start) throw new Error('Unknown discovery starting state.');
  const checkpoint = discoveryCheckpoint(start),
    bytes = new TextEncoder().encode(checkpoint).byteLength;
  if (bytes !== start.checkpoint.bytes || sha256(checkpoint) !== start.checkpoint.sha256)
    throw new Error('Discovery starting state differs from its recorded SHA-256 provenance.');
  const world = Ecosystem.load(checkpoint);
  if (world.tick !== 0 || world.organisms.size !== start.checkpoint.population)
    throw new Error('Discovery starting state differs from its recorded population.');
  return checkpoint;
}

/** Read-only measurement; it consumes no random state and changes no ecosystem field. */
export function observeDiscovery(world: Ecosystem): DiscoveryObservation {
  const observation = world.populationObservation();
  let leafBearers = 0,
    grazers = 0,
    armoredGrazers = 0,
    stingerBearers = 0,
    food = 0;
  for (const organism of world.organisms.values()) {
    const types = new Set(organism.genome.cells.map((cell) => cell.type));
    if (types.has(4)) leafBearers++;
    if (types.has(6)) stingerBearers++;
    if (types.has(3) && !types.has(4) && !types.has(6)) {
      grazers++;
      if (types.has(7)) armoredGrazers++;
    }
  }
  for (const value of world.food) food += value ? 1 : 0;
  const population = world.organisms.size;
  return {
    tick: world.tick,
    population,
    births: world.births,
    deaths: world.deaths,
    food,
    meanPreference: observation.meanPreference,
    meanTolerance: observation.meanTolerance,
    stressedFraction: population ? observation.adaptation.stressedOrganisms / population : null,
    leafBearers,
    grazers,
    armoredGrazers,
    stingerBearers,
  };
}

export interface DiscoveryEvidence {
  samples: DiscoveryObservation[];
  extinction: DiscoveryExtinction | null;
}
/** Classifies a branch's evidence without inferring any value that was not observed. */
export function classifyDiscoveryBranch(
  recipe: DiscoveryRecipe,
  branchId: string,
  evidence: DiscoveryEvidence | null,
): DiscoveryOutcome {
  if (!recipe.branches.some((branch) => branch.id === branchId))
    throw new Error('Unknown discovery branch.');
  if (!discoverySupported(recipe)) return 'unsupported-rules';
  const ticks = discoverySampleTicks(recipe.horizonTick);
  if (
    !keys(evidence, 'samples,extinction') ||
    !list(evidence.samples, 1, ticks.length) ||
    evidence.samples.some(
      (sample, i) => !validDiscoveryObservation(sample) || sample.tick !== ticks[i],
    )
  )
    return 'missing-evidence';
  const last = evidence.samples.at(-1)!;
  if (evidence.extinction !== null) {
    if (
      !keys(evidence.extinction, 'tick,cause') ||
      !integer(evidence.extinction.tick, 1, last.tick) ||
      evidence.samples.some(
        (sample) => sample.tick >= evidence.extinction!.tick && sample.population !== 0,
      )
    )
      return 'missing-evidence';
    return 'extinct';
  }
  if (evidence.samples.some((sample) => sample.population === 0)) return 'missing-evidence';
  return last.tick === recipe.horizonTick ? 'completed' : 'incomplete';
}
