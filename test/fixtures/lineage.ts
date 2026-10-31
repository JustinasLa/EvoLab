import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, WIDTH, type Genome, type WorldFile, type LineageSummary } from '../../src/model';
import { advance, legacyV5, legacyV7 } from './telemetry';

export const admissionGenome = (): Genome => ({
  cells: [{ x: 0, y: 0, type: 7 }],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 2,
  behavior: { version: 1 as const, mode: 'legacy' as const },
});

export function sameTickLineages(): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
  for (let position = 0; position < 256; position++)
    world.spawn(admissionGenome(), position % WIDTH, Math.floor(position / WIDTH));
  return world;
}

export function omittedNewestAdmission(): WorldFile {
  const world = sameTickLineages();
  const oldest = world.lineageSnapshot().summaries[0];
  world.spawn(admissionGenome(), 40, 40);
  const saved = world.save();
  saved.lineageArchive.summaries.pop();
  saved.lineageArchive.summaries.unshift(oldest);
  return saved;
}

export function retainedAdjacentExtinction(): Ecosystem {
  const world = sameTickLineages();
  world.spawn(admissionGenome(), 40, 40);
  world.kill(world.organisms.get(2)!, 'manual');
  return world;
}

export function impossibleReadmission(): WorldFile {
  const saved = retainedAdjacentExtinction().save();
  const summary = saved.lineageArchive.summaries.shift()!;
  summary.genomeStatus = 'pruned';
  summary.foundingGenome = null;
  summary.admittedTick = 0;
  saved.lineageArchive.summaries.push(summary);
  return saved;
}

export function contradictoryPruning(legacy: boolean): WorldFile {
  let world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
  world.spawn(admissionGenome(), 40, 40);
  if (legacy) world = Ecosystem.load(JSON.stringify(legacyV5(world.save())));
  advance(world, 90);
  world.kill([...world.organisms.values()][0], 'manual');
  const saved = world.save(),
    summary = saved.lineageArchive.summaries[0];
  summary.admittedTick = 90;
  summary.foundingGenome = null;
  summary.genomeStatus = legacy ? 'legacy-unknown' : 'pruned';
  return saved;
}

export function falsePruningClaim(): WorldFile {
  const saved = sameTickLineages().save();
  saved.lineageArchive.summariesPruned = true;
  return saved;
}

export function prunedCreationOrder(parent = true): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
  for (let position = 0; position < 256; position++)
    world.spawn(
      admissionGenome(),
      position % WIDTH,
      Math.floor(position / WIDTH),
      undefined,
      position === 3 && parent ? world.organisms.get(3) : undefined,
    );
  for (const organism of [...world.organisms.values()].reverse()) world.kill(organism, 'manual');
  for (let index = 0; index < 2; index++)
    world.kill(world.spawn(admissionGenome(), 40, 40)!, 'manual');
  return world;
}

export function reversedPrunedParent(): WorldFile {
  const saved = prunedCreationOrder().save();
  [saved.lineageArchive.summaries[0], saved.lineageArchive.summaries[1]] = [
    saved.lineageArchive.summaries[1],
    saved.lineageArchive.summaries[0],
  ];
  return saved;
}

export function readmittedParentOrder(legacy = false): Ecosystem {
  let world = sameTickLineages();
  if (legacy) {
    world = Ecosystem.load(JSON.stringify(legacyV7(world.save())));
    advance(world, 1);
  }
  const parent = world.organisms.get(1)!;
  world.spawn(admissionGenome(), 40, 40, undefined, parent);
  world.kill(parent, 'manual');
  for (let species = 260; species >= 254; species--)
    world.kill(
      [...world.organisms.values()].find((organism) => organism.species === species)!,
      'manual',
    );
  for (let admission = 0; admission < 254; admission++)
    world.kill(world.spawn(admissionGenome(), 80, 80)!, 'manual');
  return world;
}

export function reversedReadmittedParent(legacy = false): WorldFile {
  const saved = readmittedParentOrder(legacy).save();
  [saved.lineageArchive.summaries[0], saved.lineageArchive.summaries[1]] = [
    saved.lineageArchive.summaries[1],
    saved.lineageArchive.summaries[0],
  ];
  return saved;
}

export function relatedChildMembership(): { world: Ecosystem; displaced: LineageSummary } {
  const world = sameTickLineages(),
    parent = [...world.organisms.values()].find((organism) => organism.species === 260)!;
  world.spawn(admissionGenome(), 40, 40, undefined, parent);
  for (let species = 259; species >= 6; species--)
    world.kill(
      [...world.organisms.values()].find((organism) => organism.species === species)!,
      'manual',
    );
  world.kill(parent, 'manual');
  const displaced = world.lineageSnapshot().summaries.find((row) => row.id === 259)!;
  for (let admission = 0; admission < 254; admission++)
    world.kill(world.spawn(admissionGenome(), 80, 80)!, 'manual');
  return { world, displaced };
}

export function omittedRelatedChild(): WorldFile {
  const { world, displaced } = relatedChildMembership(),
    saved = world.save();
  saved.lineageArchive.summaries = [
    displaced,
    ...saved.lineageArchive.summaries.filter((row) => row.id !== 261),
  ];
  return saved;
}

export function missingFinalExtinction(): WorldFile {
  const saved = prunedCreationOrder(false).save();
  saved.lineageArchive.events.shift();
  saved.lineageArchive.events.push({ kind: 'extinct', id: 1999, tick: 0 });
  saved.nextSpecies = 2000;
  return saved;
}

export function extinctionOccupancyContradiction(): WorldFile {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
  const organism = world.spawn(admissionGenome(), 40, 40)!;
  world.kill(organism, 'manual');
  const original = world.lineageSnapshot().summaries[0];
  advance(world, 100);
  const saved = world.save();
  saved.nextSpecies = 10_000;
  saved.deaths = 1000;
  const retained = [5, 6].map((id) => ({ ...structuredClone(original), id }));
  const readmitted = Array.from({ length: 254 }, (_, offset) => ({
    ...structuredClone(original),
    id: 1000 + offset,
    extinctTick: 11,
    admittedTick: 11,
    foundingGenome: null,
    genomeStatus: 'pruned' as const,
  }));
  saved.lineageArchive = {
    version: 1,
    originKind: 'fresh',
    originTick: 0,
    summariesPruned: true,
    eventsPruned: true,
    eventsEvictedThroughTick: 10,
    living: [],
    summaries: [...retained, ...readmitted],
    events: [
      ...Array.from({ length: 258 }, (_, offset) => ({
        kind: 'extinct' as const,
        id: 3000 + offset,
        tick: 10,
      })),
      ...readmitted.map((row) => ({ kind: 'extinct' as const, id: row.id, tick: 11 })),
    ],
  };
  return saved;
}

/** The next real tick prunes the extinct child's last summary/creation evidence. */
export function relationshipEviction() {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 1, climate: 0, nutrients: 0 }, false);
  const parent = world.spawn(admissionGenome(), 120, 78)!;
  const extinct = world.spawn(admissionGenome(), 122, 78, undefined, parent)!;
  world.kill(extinct, 'manual');
  const retained = world.spawn(admissionGenome(), 124, 78, undefined, parent)!;
  const reproducer = world.spawn(admissionGenome(), 130, 78)!;
  for (let i = 0; i < 254; i++) {
    const filler = world.spawn(admissionGenome(), 10, 10)!;
    world.kill(filler, 'manual');
  }
  for (const organism of [parent, retained, reproducer]) {
    organism.age = 32;
    organism.energy = 30;
  }
  return { world, parent, extinct, retained };
}

/** Three funded births prune one of exactly 41 extinct identities from the event ring. */
export function paginationEviction() {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 1, climate: 0, nutrients: 0 }, false);
  for (let i = 0; i < 41; i++) {
    const extinct = world.spawn(admissionGenome(), 10, 10)!;
    world.kill(extinct, 'manual');
  }
  for (const x of [120, 124, 130]) {
    const reproducer = world.spawn(admissionGenome(), x, 78)!;
    reproducer.age = 32;
    reproducer.energy = 30;
  }
  for (let i = 0; i < 427; i++)
    world.spawn(admissionGenome(), i % WIDTH, 10 + Math.floor(i / WIDTH));
  return world;
}
