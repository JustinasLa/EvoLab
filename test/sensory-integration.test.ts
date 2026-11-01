import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { cloneGenome, founder, validGenome, type Genome } from '../src/model';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { main8Fixture, restoreMain8 } from './fixtures/sensory-main8';
import { storedSensoryGenome } from './fixtures/sensory-legacy';
import { advance } from './fixtures/telemetry';

describe('world9 passive sensory composition with accepted world8 archives', () => {
  for (const seed of [42, 7, 1])
    for (const mutation of [0, 0.12])
      for (const rotation of [0, 1, 2, 3])
        it(`preserves all five genuine main8 endpoints: seed${seed}, mutation${mutation}, rotation${rotation}`, () => {
          const prefix = `seed${seed}-mutation${mutation}-rotation${rotation}`;
          let world = Ecosystem.load(main8Fixture(`${prefix}-initial.json`));
          for (const tick of [1, 30, 90, 300, 1200]) {
            advance(world, tick - world.tick);
            expect(restoreMain8(world.save())).toEqual(
              JSON.parse(main8Fixture(`${prefix}-tick${tick}.json`)),
            );
            if (tick === 90) world = Ecosystem.load(JSON.stringify(world.save()));
          }
        });

  it('migrates genuine known founding genomes, terrain, field and interventions and continues without ecological changes', () => {
    const world = Ecosystem.load(main8Fixture('tick0.json'));
    expect(world.save().lineageArchive.summaries).toHaveLength(3);
    for (const tick of [0, 1, 30, 90, 300, 1200]) {
      advance(world, tick - world.tick);
      expect(restoreMain8(world.save())).toEqual(JSON.parse(main8Fixture(`tick${tick}.json`)));
      expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    }
  });

  it('retains and detaches complete evolved tables and opaque metadata in living and extinct founding genomes', () => {
    const world = new Ecosystem(undefined, false),
      source = storedSensoryGenome();
    const placed = world.spawn(source, 20, 20)!;
    const original = cloneGenome(source);
    source.cells[0].x = 4;
    if (source.behavior.mode === 'evolved') source.behavior.reactions.food = 'ignore';
    expect(world.lineageSnapshot().summaries[0].foundingGenome).toEqual(original);
    world.kill(placed, 'manual');
    const saved = world.save();
    expect(saved.lineageArchive.summaries[0].liveCount).toBe(0);
    expect(saved.lineageArchive.summaries[0].foundingGenome).toEqual(original);
    expect(Ecosystem.load(JSON.stringify(saved)).save()).toEqual(saved);
    saved.lineageArchive.summaries[0].foundingGenome!.legacyExtensions![0][0] = 'changed';
    expect(world.lineageSnapshot().summaries[0].foundingGenome).toEqual(original);
  });

  it.each(['living', 'extinct founding'] as const)(
    'rejects unsupported future behavior3 in a %s genome without changing passive continuation',
    (boundary) => {
      const world = new Ecosystem(undefined, false);
      const placed = world.spawn(storedSensoryGenome(), 20, 20)!;
      if (boundary === 'extinct founding') world.kill(placed, 'manual');
      const before = world.save(),
        candidate = structuredClone(before),
        genome =
          boundary === 'living'
            ? candidate.organisms[0].genome
            : candidate.lineageArchive.summaries[0].foundingGenome!;
      genome.behavior.version = 3 as any;
      expect(validGenome(genome)).toBe(false);
      expect(() => cloneGenome(genome)).toThrow('Invalid inherited genome');
      const blueprint = JSON.parse(
        serializeBlueprint({ name: 'Passive', description: '', genome: storedSensoryGenome() }),
      );
      blueprint.genome = genome;
      expect(() => parseBlueprint(JSON.stringify(blueprint))).toThrow('Blueprint needs');
      expect(() => Ecosystem.load(JSON.stringify(candidate))).toThrow(
        boundary === 'living' ? 'organism' : 'lineage archive',
      );
      expect(world.save()).toEqual(before);
      const control = Ecosystem.load(JSON.stringify(before));
      advance(world, 30);
      advance(control, 30);
      expect(world.save()).toEqual(control.save());
    },
  );

  it.each(['missing', 'action', 'cell', 'opaque'])(
    'rejects a malformed final extinct founding genome before replacement: %s',
    (variant) => {
      const world = new Ecosystem(undefined, false);
      for (const x of [20, 40]) {
        const organism = world.spawn(storedSensoryGenome(), x, 20)!;
        world.kill(organism, 'manual');
      }
      const before = world.save(),
        bad = structuredClone(before);
      const genome = bad.lineageArchive.summaries.at(-1)!.foundingGenome!;
      if (variant === 'missing') delete (genome as Partial<Genome>).behavior;
      if (variant === 'action' && genome.behavior.mode === 'evolved')
        (genome.behavior.reactions as any).food = 'teleport';
      if (variant === 'cell') genome.cells[0].x = 9;
      if (variant === 'opaque') genome.legacyExtensions = [];
      expect(() => Ecosystem.load(JSON.stringify(bad))).toThrow('lineage archive');
      expect(world.save()).toEqual(before);
      advance(world, 1);
      expect(world.tick).toBe(before.tick + 1);
    },
  );

  it('compares semantic tables independently of property order and keeps opaque payloads out of lineage decisions', () => {
    const world = new Ecosystem(undefined, false),
      source = storedSensoryGenome();
    const parent = world.spawn(source, 20, 20)!;
    const clone = cloneGenome(source);
    clone.behavior = {
      mode: 'evolved',
      reactions: { dangerous: 'flee', harmless: 'ignore', wall: 'flee', food: 'chase' },
      version: 1,
    };
    clone.legacyExtensions = [['different', [['null']]]];
    expect(world.spawn(clone, 40, 20, parent.species, parent)).toBeDefined();
    for (const category of ['food', 'wall', 'harmless', 'dangerous'] as const) {
      const different = cloneGenome(clone);
      if (different.behavior.mode === 'evolved')
        different.behavior.reactions[category] =
          'ignore' === different.behavior.reactions[category] ? 'chase' : 'ignore';
      expect(world.spawn(different, 60, 20, parent.species, parent)).toBeUndefined();
    }
    expect(world.spawn(founder(0), 60, 20, parent.species, parent)).toBeUndefined();
  });
});
