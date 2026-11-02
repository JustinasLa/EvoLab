import { WIDTH, HEIGHT, LIMIT, integer, finite, index, type Organism } from './model';

export const NUTRIENT_TOTAL = WIDTH * HEIGHT * 4;
export const ORGANISM_ENERGY_LIMIT = 1000;
export const STORED_ENERGY_LIMIT = LIMIT * ORGANISM_ENERGY_LIMIT + WIDTH * HEIGHT * 2.2;
export interface NutrientBudget {
  tick: number;
  before: number;
  sunlight: number;
  after: number;
  dissipated: number;
}
export interface NutrientPlane {
  minerals: Uint32Array;
  detritus: Uint32Array;
}
export interface NutrientCycle extends NutrientPlane {
  version: 1;
  budget: NutrientBudget | null;
}
export interface NutrientFile {
  version: 1;
  minerals: number[];
  detritus: number[];
  budget: NutrientBudget | null;
}
export interface NutrientSummary {
  minerals: number;
  detritus: number;
  food: number;
  biomass: number;
  total: number;
  initial: number;
  energy: number;
  budget: NutrientBudget | null;
}
export const createNutrients = (): NutrientCycle => ({
  version: 1,
  minerals: new Uint32Array(WIDTH * HEIGHT).fill(4),
  detritus: new Uint32Array(WIDTH * HEIGHT),
  budget: null,
});
export function storedEnergy(organisms: Iterable<Organism>, food: Uint8Array): number {
  let energy = 0;
  for (const organism of organisms) energy += Math.max(0, organism.energy);
  return energy + food.reduce((total, value) => total + value, 0) * 2.2;
}
export function nutrientSummary(
  cycle: NutrientCycle,
  organisms: Iterable<Organism>,
  food: Uint8Array,
): NutrientSummary {
  const living = [...organisms];
  const minerals = cycle.minerals.reduce((total, value) => total + value, 0),
    detritus = cycle.detritus.reduce((total, value) => total + value, 0),
    foodUnits = food.reduce((total, value) => total + value, 0),
    biomass = living.reduce((total, organism) => total + organism.genome.cells.length, 0);
  return {
    minerals,
    detritus,
    food: foodUnits,
    biomass,
    total: minerals + detritus + foodUnits + biomass,
    initial: NUTRIENT_TOTAL,
    energy: storedEnergy(living, food),
    budget: cycle.budget ? { ...cycle.budget } : null,
  };
}
export function recycleNutrients(cycle: NutrientCycle, walls: Uint8Array, tick: number): void {
  if (tick % 32 !== 0) return;
  const phase = (tick / 32 - 1) % 4,
    horizontal = phase < 2,
    parity = phase % 2;
  for (let position = 0; position < walls.length; position++)
    if (!walls[position] && cycle.detritus[position]) {
      cycle.detritus[position]--;
      cycle.minerals[position]++;
    }
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      if ((horizontal ? x : y) % 2 !== parity) continue;
      const source = index(x, y),
        target = index(x + (horizontal ? 1 : 0), y + (horizontal ? 0 : 1));
      if (walls[source] || walls[target]) continue;
      const difference = cycle.minerals[source] - cycle.minerals[target];
      if (Math.abs(difference) < 2) continue;
      const direction = Math.sign(difference);
      cycle.minerals[source] -= direction;
      cycle.minerals[target] += direction;
    }
}
export function nutrientFile(cycle: NutrientCycle): NutrientFile {
  return {
    version: 1,
    minerals: Array.from(cycle.minerals),
    detritus: Array.from(cycle.detritus),
    budget: cycle.budget ? { ...cycle.budget } : null,
  };
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
export function parseNutrients(value: unknown, tick: number): NutrientCycle | null {
  if (value === null) return null;
  if (
    !keys(value, ['version', 'minerals', 'detritus', 'budget']) ||
    value.version !== 1 ||
    ![value.minerals, value.detritus].every(
      (plane) =>
        Array.isArray(plane) &&
        plane.length === WIDTH * HEIGHT &&
        plane.every((units: unknown) => integer(units, 0, NUTRIENT_TOTAL)),
    )
  )
    throw new Error('Invalid nutrient fields.');
  const budget = value.budget;
  if (
    budget !== null &&
    (!keys(budget, ['tick', 'before', 'sunlight', 'after', 'dissipated']) ||
      !integer(budget.tick, 1, tick) ||
      budget.tick !== tick ||
      !finite(budget.before, 0, STORED_ENERGY_LIMIT) ||
      !finite(budget.after, 0, STORED_ENERGY_LIMIT) ||
      !finite(budget.sunlight, 0, LIMIT * 16 * 0.04) ||
      !finite(budget.dissipated, 0, STORED_ENERGY_LIMIT + LIMIT * 16 * 0.04) ||
      Math.abs(budget.before + budget.sunlight - budget.after - budget.dissipated) > 1e-7)
  )
    throw new Error('Invalid nutrient energy budget.');
  if (tick > 0 && budget === null) throw new Error('Missing nutrient energy budget.');
  return {
    version: 1,
    minerals: Uint32Array.from(value.minerals as number[]),
    detritus: Uint32Array.from(value.detritus as number[]),
    budget: budget as NutrientBudget | null,
  };
}
export function validateNutrients(
  cycle: NutrientCycle,
  organisms: Iterable<Organism>,
  food: Uint8Array,
): void {
  const living = [...organisms];
  if (
    nutrientSummary(cycle, living, food).total !== NUTRIENT_TOTAL ||
    living.some((organism) => !finite(organism.energy, 0, ORGANISM_ENERGY_LIMIT))
  )
    throw new Error('Nutrient conservation or energy bound violated.');
}
