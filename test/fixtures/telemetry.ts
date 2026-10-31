import assert from 'node:assert/strict';
import { Ecosystem } from '../../src/ecosystem';
import { syntheticHistoricalWorld } from './sensory-legacy';
import {
  DEFAULTS,
  WIDTH,
  type WorldFile,
  type WorldFileV3,
  type WorldFileV4,
  type WorldFileV5,
  type WorldFileV6,
  type WorldFileV7,
  type WorldFileV8,
  type WorldFileV9,
} from '../../src/model';

export function advance(world: Ecosystem, ticks: number): void {
  for (let tick = 0; tick < ticks; tick++) world.step();
}

export const ecology = ({ telemetry: _telemetry, ...saved }: WorldFile | WorldFileV5) => saved;

export function colony(
  count: number,
  tolerance: number,
  preference = 0.5,
  telemetry = true,
): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false, {
    telemetry,
  });
  for (let organism = 0; organism < count; organism++)
    assert.ok(
      world.spawn(
        {
          behavior: { version: 1 as const, mode: 'legacy' as const },
          cells: [{ x: 0, y: 0, type: 7 }],
          preference,
          tolerance,
          tempo: 2,
        },
        organism % WIDTH,
        Math.floor(organism / WIDTH),
      ),
    );
  return world;
}

export function legacyV3(saved: WorldFile): WorldFileV3 {
  const {
    interventions: _interventions,
    terrain: _terrain,
    thermalRefuges: _thermalRefuges,
    lineageArchive: _lineageArchive,
    ...historical
  } = ecology(syntheticHistoricalWorld(saved));
  return {
    ...historical,
    version: 3,
    telemetry: {
      version: 1,
      intervalTicks: 30,
      originTick: saved.telemetry.originTick,
      samples: saved.telemetry.samples.map(({ adaptation: _adaptation, ...sample }) => sample),
      pending: saved.telemetry.pending,
    },
  };
}
export function legacyV4(saved: WorldFile): WorldFileV4 {
  const {
    interventions: _interventions,
    lineageArchive: _lineageArchive,
    terrain: _terrain,
    thermalRefuges: _thermalRefuges,
    ...historical
  } = syntheticHistoricalWorld(saved);
  return { ...historical, version: 4 };
}
export function legacyV5(saved: WorldFile): WorldFileV5 {
  const {
    terrain: _terrain,
    thermalRefuges: _thermalRefuges,
    lineageArchive: _lineageArchive,
    interventions,
    ...historical
  } = syntheticHistoricalWorld(saved);
  assert.ok(
    interventions.entries.every(
      (entry) => entry.kind !== 'terrain' && !entry.kind.startsWith('refuge-'),
    ),
  );
  return {
    ...historical,
    version: 5,
    interventions: {
      ...interventions,
      version: 1,
      entries: interventions.entries as WorldFileV5['interventions']['entries'],
    },
  };
}
export function legacyV6(saved: WorldFile): WorldFileV6 {
  const {
    thermalRefuges: _thermalRefuges,
    lineageArchive: _lineageArchive,
    interventions,
    ...historical
  } = syntheticHistoricalWorld(saved);
  assert.ok(interventions.entries.every((entry) => !entry.kind.startsWith('refuge-')));
  return {
    ...historical,
    terrain: structuredClone(saved.terrain),
    version: 6,
    interventions: {
      ...interventions,
      version: 2,
      entries: interventions.entries as WorldFileV6['interventions']['entries'],
    },
  };
}
export function legacyV7(saved: WorldFile): WorldFileV7 {
  const { lineageArchive: _lineageArchive, ...historical } = syntheticHistoricalWorld(saved);
  return {
    ...historical,
    terrain: structuredClone(saved.terrain),
    thermalRefuges: structuredClone(saved.thermalRefuges),
    interventions: {
      ...structuredClone(saved.interventions),
      version: 3,
      entries: structuredClone(
        saved.interventions.entries,
      ) as WorldFileV7['interventions']['entries'],
    },
    version: 7,
  };
}

export function legacyV8(saved: WorldFile): WorldFileV8 {
  const archive = structuredClone(saved.lineageArchive);
  for (const row of archive.summaries) {
    if (row.foundingGenome) {
      assert.deepEqual(row.foundingGenome.behavior, { version: 1, mode: 'legacy' });
      assert.equal(row.foundingGenome.legacyExtensions, undefined);
      assert.ok(row.foundingGenome.cells.every((cell) => cell.legacyExtensions === undefined));
      const { behavior: _behavior, ...genome } = row.foundingGenome;
      row.foundingGenome = genome as typeof row.foundingGenome;
    }
  }
  return { ...legacyV7(saved), version: 8, lineageArchive: archive };
}

export function legacyV9(saved: WorldFile): WorldFileV9 {
  const { shadeHabitats: _shadeHabitats, ...retained } = structuredClone(saved);
  assert.ok(retained.interventions.entries.every((row) => !row.kind.startsWith('shade-')));
  return {
    ...retained,
    version: 9,
    interventions: {
      ...retained.interventions,
      version: 3,
      entries: retained.interventions.entries as WorldFileV9['interventions']['entries'],
    },
  };
}
