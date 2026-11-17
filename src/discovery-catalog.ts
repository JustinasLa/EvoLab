import { founder, type Genome, type Settings, type TerrainRecipe } from './model';
import { DISCOVERY_EVIDENCE } from './discovery-evidence';
import {
  DISCOVERY_FORMAT,
  DISCOVERY_VERSION,
  type DiscoveryBranch,
  type DiscoveryRecipe,
  type DiscoveryStart,
} from './discovery-recipes';

export type DiscoveryDraft = Omit<DiscoveryRecipe, 'starts' | 'branches'> & {
  starts: Omit<DiscoveryStart, 'checkpoint'>[];
  branches: Omit<DiscoveryBranch, 'reference'>[];
};

const SEED = 42;
const SETTINGS: Settings = { seed: SEED, mutation: 0.12, nutrients: 5, climate: 0.8 };
const OPEN: TerrainRecipe = { version: 1, preset: 'open-field', seed: null };
const RULES = { id: 'evolab-drift-cellular', version: 13, worldVersion: 21 } as const;
const common = {
  format: DISCOVERY_FORMAT,
  version: DISCOVERY_VERSION,
  revision: 1,
  rules: RULES,
  seed: SEED,
  sampleInterval: 30,
} as const;
const scene = (
  id: string,
  label: string,
  food: DiscoveryStart['food'],
  designs: Genome[],
  placements: [number, number, number][],
): Omit<DiscoveryStart, 'checkpoint'> => ({
  id,
  label,
  settings: { ...SETTINGS },
  terrain: { ...OPEN },
  nutrientCycle: false,
  biologicalShade: false,
  food,
  designs,
  placements: placements.map(([design, x, y]) => ({ design, x, y })),
});
const FIXED_SEED =
  'One fixed seed is a deterministic illustration, not evidence across independent runs; repeat with batches before generalizing.';

// Producers with preference 0.3, 0.5 or 0.7 and narrow (0.15) or broad (0.45) tolerance.
const thermalDesigns = [0.3, 0.5, 0.7].flatMap((preference) =>
  [0.15, 0.45].map((tolerance) => ({ ...founder(0, preference), tolerance })),
);
const plant = founder(0),
  grazer = founder(1),
  armoredGrazer: Genome = { ...founder(1), cells: [...founder(1).cells, { x: 0, y: 1, type: 7 }] },
  stinger = founder(2);
const ring = [0, 1, 2, 3, 4, 5, 6, 7].map((k): [number, number] => [
  Math.round(120 + 26 * Math.cos((k * Math.PI) / 4)),
  Math.round(78 + 26 * Math.sin((k * Math.PI) / 4)),
]);
const preySites = [
  [108, 70],
  [132, 70],
  [108, 86],
  [132, 86],
  [116, 64],
  [124, 92],
  [104, 78],
  [136, 78],
];
const armorPlacements = (predators: boolean): [number, number, number][] => [
  ...ring.map(([x, y]): [number, number, number] => [0, x, y]),
  ...preySites.map(([x, y], i): [number, number, number] => [i % 2 ? 2 : 1, x, y]),
  ...(predators
    ? ([
        [3, 112, 78],
        [3, 128, 78],
      ] as [number, number, number][])
    : []),
];

export const DISCOVERY_DRAFTS: readonly DiscoveryDraft[] = [
  {
    ...common,
    id: 'climate-shock-specialists',
    title: 'Temperature specialists under a heatwave',
    question:
      'When a 900-tick heatwave arrives, which inherited temperature preferences and tolerances remain among the producers, and does the population recover by the horizon?',
    controls: [
      'Twelve founder producers: preference 0.3, 0.5 or 0.7, each with narrow (0.15) or broad (0.45) tolerance, two of each.',
      'Branch control runs unchanged; branch heatwave applies the existing +0.32 heatwave for 900 ticks at tick 600.',
      'Seed 42, open field, mutation 0.12, nutrients 5, climate 0.8; optional nutrient and biological shade models disabled.',
    ],
    outcomes: [
      { measure: 'population', meaning: 'Living organisms at each 30-tick sample.' },
      { measure: 'meanPreference', meaning: 'Mean inherited preferred temperature (0–1).' },
      { measure: 'meanTolerance', meaning: 'Mean inherited temperature tolerance (0.12–0.6).' },
      {
        measure: 'stressedFraction',
        meaning: 'Share of organisms outside their tolerance at their current position.',
      },
      { measure: 'deaths', meaning: 'Cumulative deaths from age or energy.' },
    ],
    limitations: [
      FIXED_SEED,
      'Broad tolerance costs extra upkeep; the climate field drifts, so local exposure differs by position and time.',
      'Mutation keeps changing traits; mean values describe survivors, not a selection coefficient.',
    ],
    interventionTick: 600,
    horizonTick: 2400,
    starts: [
      scene(
        'thermal-mix',
        'Twelve producers with six temperature strategies',
        [],
        thermalDesigns,
        [0, 1].flatMap((row) =>
          thermalDesigns.map((_, i): [number, number, number] => [i, 60 + i * 24, 50 + row * 56]),
        ),
      ),
    ],
    branches: [
      { id: 'control', label: 'No climate event', start: 'thermal-mix', intervention: 'none' },
      {
        id: 'heatwave',
        label: 'Heatwave at tick 600',
        start: 'thermal-mix',
        intervention: 'heat',
      },
    ],
  },
  {
    ...common,
    id: 'armor-stinger-contact',
    title: 'Armor against stinger contact',
    question:
      'Do grazers carrying an extra armor cell keep a larger share of the grazer population when stinger predators are present than when they are absent?',
    controls: [
      'Both branches start with eight ring producers, a painted food disc and eight grazers: four plain, four with one extra armor cell.',
      'Branch with-stingers adds two stinger predators; branch without-stingers is otherwise identical. No event is applied (intervention none at tick 0).',
      'Seed 42, open field, mutation 0.12, nutrients 5, climate 0.8; optional nutrient and biological shade models disabled.',
    ],
    outcomes: [
      { measure: 'grazers', meaning: 'Organisms with a mouth but no leaf or stinger.' },
      { measure: 'armoredGrazers', meaning: 'Grazers carrying at least one armor cell.' },
      { measure: 'stingerBearers', meaning: 'Organisms carrying at least one stinger cell.' },
      { measure: 'population', meaning: 'All living organisms, including producers.' },
      { measure: 'food', meaning: 'Cells holding food.' },
    ],
    limitations: [
      FIXED_SEED,
      'Armor blocks a sting only on the armored cell itself; the extra cell also raises upkeep and the reproduction threshold.',
      'Stingers drain any neighbor, including producers and other predators; mutation can add or remove armor in descendants.',
    ],
    interventionTick: 0,
    horizonTick: 1200,
    starts: [
      scene(
        'stingers',
        'Producers, mixed grazers and two stinger predators',
        [{ x: 120, y: 78, radius: 16 }],
        [plant, grazer, armoredGrazer, stinger],
        armorPlacements(true),
      ),
      scene(
        'no-stingers',
        'Producers and mixed grazers without predators',
        [{ x: 120, y: 78, radius: 16 }],
        [plant, grazer, armoredGrazer],
        armorPlacements(false),
      ),
    ],
    branches: [
      {
        id: 'with-stingers',
        label: 'Stinger predators present',
        start: 'stingers',
        intervention: 'none',
      },
      {
        id: 'without-stingers',
        label: 'No stinger predators',
        start: 'no-stingers',
        intervention: 'none',
      },
    ],
  },
  {
    ...common,
    id: 'leaf-mouth-shade',
    title: 'Grazers that depend on leaf producers',
    question:
      'When the central producers are fully shaded, how do leaf-bearing producers, mouth-only grazers and food respond compared with an unshaded control?',
    controls: [
      'Four central producers, six mouth-only grazers and a painted food disc of radius 14.',
      'Branch control runs unchanged; branch shade applies the existing full-shade disc (radius 8, 197 cells) at the center at tick 300.',
      'Seed 42, open field, mutation 0.12, nutrients 5, climate 0.8; optional nutrient and biological shade models disabled.',
    ],
    outcomes: [
      { measure: 'leafBearers', meaning: 'Organisms carrying at least one leaf cell.' },
      { measure: 'grazers', meaning: 'Organisms with a mouth but no leaf or stinger.' },
      { measure: 'food', meaning: 'Cells holding food.' },
      { measure: 'population', meaning: 'All living organisms.' },
      { measure: 'births', meaning: 'Cumulative births.' },
    ],
    limitations: [
      FIXED_SEED,
      'Shade removes leaf energy and food production only inside the disc; organisms can move or be born outside it.',
      'Painted starting food is a one-time stock; grazers also eat food grown by producers anywhere in reach.',
    ],
    interventionTick: 300,
    horizonTick: 1800,
    starts: [
      scene(
        'producers-grazers',
        'Central producers with surrounding grazers',
        [{ x: 120, y: 78, radius: 14 }],
        [plant, grazer],
        [
          [0, 116, 74],
          [0, 124, 74],
          [0, 116, 82],
          [0, 124, 82],
          [1, 108, 78],
          [1, 132, 78],
          [1, 120, 66],
          [1, 120, 90],
          [1, 110, 68],
          [1, 130, 88],
        ],
      ),
    ],
    branches: [
      { id: 'control', label: 'Full light', start: 'producers-grazers', intervention: 'none' },
      {
        id: 'shade',
        label: 'Central shade at tick 300',
        start: 'producers-grazers',
        intervention: 'shade',
      },
    ],
  },
];

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Immutable catalog: drafts joined with checkpoint and endpoint evidence from the real engine. */
export const DISCOVERY_RECIPES: readonly DiscoveryRecipe[] = freeze(
  DISCOVERY_DRAFTS.map((draft) => {
    const evidence = DISCOVERY_EVIDENCE[draft.id];
    return structuredClone({
      ...draft,
      starts: draft.starts.map((start) => ({ ...start, checkpoint: evidence.starts[start.id] })),
      branches: draft.branches.map((branch) => ({
        ...branch,
        reference: evidence.branches[branch.id],
      })),
    }) as DiscoveryRecipe;
  }),
);
freeze(DISCOVERY_DRAFTS);

export function discoveryRecipe(id: string): DiscoveryRecipe {
  const recipe = DISCOVERY_RECIPES.find((candidate) => candidate.id === id);
  if (!recipe) throw new Error('Unknown discovery recipe.');
  return recipe;
}
