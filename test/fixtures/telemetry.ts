import assert from 'node:assert/strict';
import { Ecosystem } from '../../src/ecosystem';
import {
  DEFAULTS,
  WIDTH,
  type WorldFile,
  type WorldFileV3,
  type WorldFileV4,
  type WorldFileV5,
} from '../../src/model';

export function advance(world: Ecosystem, ticks: number): void {
  for (let tick = 0; tick < ticks; tick++) world.step();
}

export const ecology = ({ telemetry: _telemetry, ...saved }: WorldFile) => saved;

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
        { cells: [{ x: 0, y: 0, type: 7 }], preference, tolerance, tempo: 2 },
        organism % WIDTH,
        Math.floor(organism / WIDTH),
      ),
    );
  return world;
}

export function legacyV3(saved: WorldFile): WorldFileV3 {
  const { interventions: _interventions, terrain: _terrain, ...historical } = ecology(saved);
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
  const { interventions: _interventions, terrain: _terrain, ...historical } = saved;
  return { ...historical, version: 4 };
}
export function legacyV5(saved: WorldFile): WorldFileV5 {
  const { terrain: _terrain, interventions, ...historical } = saved;
  assert.ok(interventions.entries.every((entry) => entry.kind !== 'terrain'));
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
