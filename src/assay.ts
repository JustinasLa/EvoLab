import { Ecosystem } from './ecosystem';
import { EXPERIMENT_INTERVENTIONS } from './experiment-interventions';
import { COMPARISON_BATCH_TICKS } from './experiment-model';
import { index, type Genome, type Organism } from './model';
import { nutrientSummary } from './nutrients';
import { sha256 } from './sha256';
import { generateTerrain } from './terrain';
import {
  ASSAY_FIXTURES,
  ASSAY_FIXTURE_DIGESTS,
  validateAssayRecipe,
  type AssayEcology,
  type AssayFixture,
  type AssayFixtureId,
  type AssayFoodLattice,
  type AssayRecipe,
} from './assay-model';

export type AssayStatus =
  'horizon' | 'extinct' | 'blocked-initialization' | 'unsupported' | 'cancelled';
export interface AssayEndpoint {
  fixture: AssayFixtureId;
  seed: number;
  status: AssayStatus;
  tick: number;
  reason: string | null;
  subjectAlive: boolean;
  subjectLineageLiving: number;
  population: number;
  checkpointSha256: string | null;
}
interface PlacedOrganism {
  id: number;
  species: number;
  x: number;
  y: number;
  rotation: number;
  direction: number;
  energy: number;
  cells: number;
}
export interface AssayInitialization {
  fixture: AssayFixtureId;
  fixtureSha256: string;
  seed: number;
  blueprintSha256: string;
  subject: PlacedOrganism;
  antagonist: PlacedOrganism | null;
  walls: number;
  food: { pellets: number; energy: number };
  energy: { subject: number; antagonist: number; food: number; total: number };
  nutrients: { total: number; minerals: number; foodDebited: number; bodiesDebited: number } | null;
}
export interface AssayProgress {
  tick: number;
  horizonTick: number;
  done: boolean;
}
export interface AssayTrial {
  readonly initialization: AssayInitialization | null;
  /** The isolated trial world, for read-only measurement; null once disposed. */
  readonly world: Ecosystem | null;
  advance(now: () => number): AssayProgress;
  endpoint(): AssayEndpoint | null;
  cancel(): AssayEndpoint;
  dispose(): void;
}

const placed = (o: Organism): PlacedOrganism => ({
  id: o.id,
  species: o.species,
  x: o.x,
  y: o.y,
  rotation: o.rotation,
  direction: o.direction,
  energy: o.energy,
  cells: o.genome.cells.length,
});

/** Places one pellet on each free lattice point; any blocked point aborts initialization. */
export function seedFoodLattice(world: Ecosystem, lattice: AssayFoodLattice): number {
  const inside = ([x0, y0, x1, y1]: readonly number[], x: number, y: number) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;
  let pellets = 0;
  for (const region of lattice.regions)
    for (let y = region[1]; y <= region[3]; y += lattice.step)
      for (let x = region[0]; x <= region[2]; x += lattice.step) {
        if (lattice.exclude.some((rectangle) => inside(rectangle, x, y))) continue;
        const position = index(x, y);
        if (
          world.walls[position] ||
          world.occupied[position] ||
          world.food[position] ||
          (world.nutrientCycle && world.nutrientCycle.minerals[position] < 1)
        )
          throw new Error(`Food lattice point (${x}, ${y}) is not free.`);
        if (world.nutrientCycle) world.nutrientCycle.minerals[position]--;
        world.food[position] = 1;
        pellets++;
      }
  return pellets;
}

/**
 * Runs one fixture for an exact inherited genome. Exported for engine tests;
 * recipes only reach the frozen, digest-checked fixtures through `startAssayTrial`.
 */
export function startFixtureTrial(
  fixture: AssayFixture,
  genome: Genome,
  seed: number,
  ecology: AssayEcology,
  horizonTicks: number,
  provenance: { fixtureSha256: string; blueprintSha256: string },
): AssayTrial {
  let world: Ecosystem | null = null;
  let initialization: AssayInitialization | null = null;
  let result: AssayEndpoint | null = null;
  let subjectId = 0;
  let disposed = false;
  const lineage = new Set<number>();
  const finish = (status: AssayStatus, reason: string | null): AssayEndpoint => {
    let living = 0;
    if (world)
      for (const organism of world.organisms.values()) if (lineage.has(organism.species)) living++;
    result = {
      fixture: fixture.id,
      seed,
      status,
      tick: world?.tick ?? 0,
      reason,
      subjectAlive: !!world?.organisms.has(subjectId),
      subjectLineageLiving: living,
      population: world?.organisms.size ?? 0,
      checkpointSha256: world ? sha256(JSON.stringify(world.save())) : null,
    };
    return structuredClone(result);
  };
  try {
    const trial = new Ecosystem({ seed, ...fixture.settings }, false, {
      terrain: fixture.terrain,
      nutrientCycle: ecology.nutrientCycle,
      biologicalShade: ecology.biologicalShade,
    });
    trial.walls.set(generateTerrain(fixture.terrain, seed));
    const subject = trial.spawn(genome, fixture.subject.x, fixture.subject.y);
    if (!subject) throw new Error('The subject footprint is blocked at the fixture placement.');
    subjectId = subject.id;
    lineage.add(subject.species);
    let antagonist: Organism | undefined;
    if (fixture.antagonist) {
      const east = [...genome.cells].sort((a, b) => b.x - a.x || a.y - b.y)[0];
      antagonist = trial.spawn(
        fixture.antagonist.genome,
        subject.x + east.x + 1,
        subject.y + east.y,
      );
      if (!antagonist) throw new Error('The fixed antagonist is blocked at its contact placement.');
    }
    const minerals = trial.nutrientCycle?.minerals.reduce((total, units) => total + units, 0);
    const pellets = seedFoodLattice(trial, fixture.food);
    if (pellets !== fixture.pellets)
      throw new Error(`Fixture declares ${fixture.pellets} pellets but placed ${pellets}.`);
    const energy = {
      subject: subject.energy,
      antagonist: antagonist?.energy ?? 0,
      food: pellets * 2.2,
      total: 0,
    };
    energy.total = energy.subject + energy.antagonist + energy.food;
    const cycle = trial.nutrientCycle;
    initialization = {
      fixture: fixture.id,
      fixtureSha256: provenance.fixtureSha256,
      seed,
      blueprintSha256: provenance.blueprintSha256,
      subject: placed(subject),
      antagonist: antagonist ? placed(antagonist) : null,
      walls: trial.walls.reduce((total, wall) => total + wall, 0),
      food: { pellets, energy: energy.food },
      energy,
      nutrients: cycle
        ? {
            total: nutrientSummary(cycle, trial.organisms.values(), trial.food).total,
            minerals: minerals! - pellets,
            foodDebited: pellets,
            bodiesDebited: subject.genome.cells.length + (antagonist?.genome.cells.length ?? 0),
          }
        : null,
    };
    world = trial;
  } catch (error) {
    finish('blocked-initialization', (error as Error).message);
  }
  const horizonTick = horizonTicks;
  return {
    get initialization() {
      return structuredClone(initialization);
    },
    get world() {
      return world;
    },
    advance(now: () => number): AssayProgress {
      if (disposed) throw new Error('Assay trial was disposed.');
      if (!world || result) return { tick: result!.tick, horizonTick, done: true };
      const began = now();
      for (let count = 0; !result && count < COMPARISON_BATCH_TICKS; count++) {
        for (const event of fixture.schedule)
          if (event.tick === world.tick) EXPERIMENT_INTERVENTIONS[event.intervention].apply(world);
        world.step();
        // Read-only lineage bookkeeping: a new species joins when its parent species
        // (the last ancestry entry) is already in the subject lineage.
        let living = 0;
        for (const organism of world.organisms.values()) {
          const parent = organism.ancestry[organism.ancestry.length - 1];
          if (!lineage.has(organism.species) && parent !== undefined && lineage.has(parent))
            lineage.add(organism.species);
          if (lineage.has(organism.species)) living++;
        }
        if (!living) finish('extinct', 'No organism of the subject lineage remains.');
        else if (world.tick === horizonTick) finish('horizon', null);
        if (now() - began >= 8) break;
      }
      return { tick: world.tick, horizonTick, done: !!result };
    },
    endpoint() {
      return structuredClone(result);
    },
    cancel(): AssayEndpoint {
      return result
        ? structuredClone(result)
        : finish('cancelled', 'Cancelled before the horizon.');
    },
    dispose(): void {
      disposed = true;
      world = null;
      lineage.clear();
    },
  };
}

function unsupported(fixture: AssayFixtureId, seed: number, reason: string): AssayTrial {
  const result: AssayEndpoint = {
    fixture,
    seed,
    status: 'unsupported',
    tick: 0,
    reason,
    subjectAlive: false,
    subjectLineageLiving: 0,
    population: 0,
    checkpointSha256: null,
  };
  return {
    initialization: null,
    world: null,
    advance: () => ({ tick: 0, horizonTick: 0, done: true }),
    endpoint: () => structuredClone(result),
    cancel: () => structuredClone(result),
    dispose: () => {},
  };
}

/** Starts one validated recipe trial. Recipes from other rules resolve as unsupported. */
export function startAssayTrial(
  recipe: AssayRecipe,
  fixtureId: AssayFixtureId,
  seed: number,
): AssayTrial {
  const assay = validateAssayRecipe(recipe);
  if (
    !assay.recipe.fixtures.some((fixture) => fixture.id === fixtureId) ||
    !assay.recipe.seeds.includes(seed)
  )
    throw new Error('That fixture and seed are not part of this assay recipe.');
  if (!assay.supported)
    return unsupported(
      fixtureId,
      seed,
      `Recipe rules ${assay.recipe.rules.version} / world ${assay.recipe.rules.worldVersion} are not this runtime's rules; trials are not run under substitute rules.`,
    );
  return startFixtureTrial(
    ASSAY_FIXTURES[fixtureId],
    assay.blueprint.genome,
    seed,
    assay.recipe.ecology,
    assay.recipe.horizonTicks,
    {
      fixtureSha256: ASSAY_FIXTURE_DIGESTS[fixtureId],
      blueprintSha256: assay.recipe.subject.sha256,
    },
  );
}
