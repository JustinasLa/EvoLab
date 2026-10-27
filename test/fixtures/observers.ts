import assert from 'node:assert/strict';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, type CellType, type WorldFile } from '../../src/model';

export function observerWorld(population = 6, maximal = false): WorldFile {
  const world = new Ecosystem(
    { ...DEFAULTS, seed: 4294967295, mutation: 0, nutrients: 0, climate: 0 },
    false,
  );
  world.nextId = 999_998_000;
  world.nextSpecies = 1_000_000_000;
  for (let position = 0; position < population; position++) {
    const organism = world.spawn(
      {
        cells: Array.from({ length: 16 }, (_, cell) => ({
          x: cell % 4,
          y: Math.floor(cell / 4),
          type: (3 + ((cell + (position % 6)) % 6)) as CellType,
        })),
        preference: 0.12345678901234568 + (position % 6) / 10,
        tolerance: 0.3456789012345679,
        tempo: 12,
      },
      maximal ? (position % 60) * 4 : position * 36,
      Math.floor(position / 60) * 4,
      999_999_990 + (position % (maximal ? 5 : 6)),
    );
    assert.ok(organism);
    organism.energy = maximal ? 80000.12345678901 : 40.123456789012344;
    organism.generation = maximal ? 999_999_999 : 999_999_990;
    organism.children = maximal ? 999_999_999 : 7;
    organism.ancestry = Array.from({ length: 8 }, (_, ancestor) => 999_999_980 + ancestor);
  }
  world.births = world.deaths = 999_999_999;
  for (let tick = 0; tick < 30; tick++) world.step();
  assert.equal(world.organisms.size, population);
  for (let point = 0; point < 128; point++) {
    const outcome = world.paint('food', point, 155, 0, {
      cells: [{ x: 0, y: 0, type: 3 }],
      preference: 0.5,
      tolerance: 0.3,
      tempo: 2,
    });
    assert.ok(world.recordPaint(outcome, 'food', 0, point, 155, null));
  }
  const saved = world.save(),
    sample = saved.telemetry.samples[0],
    origin = maximal ? 999_994_590 : 0;
  saved.tick = origin + 5400;
  saved.telemetry.originTick = saved.telemetry.adaptationOriginTick = origin;
  saved.telemetry.samples = Array.from({ length: 180 }, (_, interval) => ({
    ...structuredClone(sample),
    fromTick: origin + interval * 30,
    tick: origin + (interval + 1) * 30,
  }));
  saved.telemetry.pending.fromTick = saved.tick;
  if (maximal) {
    for (const organism of saved.organisms) organism.age = 100000;
    for (const flow of [...saved.telemetry.samples, saved.telemetry.pending]) {
      flow.births = 1_000_000;
      flow.deaths = { age: 1_000_000, energy: 1_000_000, manual: 1_000_000 };
      for (const key of Object.keys(flow.energy) as (keyof typeof flow.energy)[])
        flow.energy[key] = 123456789.12345679;
    }
    saved.settings.mutation = 0.39999999999999997;
    saved.settings.nutrients = 20;
    saved.settings.climate = 0.9999999999999999;
    saved.eventUntil = 1_000_000_000;
    saved.eventOffset = -0.32;
  }
  saved.interventions.originSettings = { ...saved.settings };
  saved.interventions.prefixSettings = { ...saved.settings };
  return saved;
}

export function extendedObserverWorld(file: WorldFile, surface: string): WorldFile {
  const extended = structuredClone(file),
    extension = (bytes: number) => ({
      label: 'observerExtension',
      nested: [{ payload: 'é'.repeat(bytes / 2), coordinates: [1, { retained: true }] }],
    }),
    attach = (value: object, bytes: number) =>
      Object.assign(value, { observerExtension: extension(bytes) });
  if (surface === 'settings' || surface === 'all') attach(extended.settings, 131072);
  for (const organism of extended.organisms) {
    if (surface === 'organism' || surface === 'all') attach(organism, 16384);
    if (surface === 'genome' || surface === 'all') attach(organism.genome, 16384);
    if (surface === 'cell' || surface === 'all')
      for (const cell of organism.genome.cells) attach(cell, 6144);
  }
  return extended;
}

export function withoutObserverExtensions(file: WorldFile): WorldFile {
  const remove = <Value extends object>(value: Value): Value => {
    const { observerExtension: _extension, ...known } = value as Value & {
      observerExtension?: unknown;
    };
    return known as Value;
  };
  return {
    ...file,
    settings: remove(file.settings),
    organisms: file.organisms.map((organism) => ({
      ...remove(organism),
      genome: { ...remove(organism.genome), cells: organism.genome.cells.map(remove) },
    })),
  };
}
