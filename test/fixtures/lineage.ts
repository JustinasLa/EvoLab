import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, WIDTH, type Genome, type WorldFile } from '../../src/model';
import { advance, legacyV5 } from './telemetry';

export const admissionGenome = (): Genome => ({
  cells: [{ x: 0, y: 0, type: 7 }],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 2,
});

export function sameTickLineages(): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
  for (let position = 0; position < 256; position++)
    world.spawn(admissionGenome(), position % WIDTH, Math.floor(position / WIDTH));
  return world;
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
