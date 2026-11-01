import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { storedSensoryGenome, syntheticHistoricalWorld } from './fixtures/sensory-legacy';
import {
  DEFAULTS,
  WORLD_MAX_BYTES,
  WORLD_VERSION,
  founder,
  type MeasurementSource,
} from '../src/model';
import {
  MEASUREMENT_COLUMNS,
  checkedMeasurementText,
  measurementCsvCell,
  measurementEnvelope,
  serializeMeasurements,
} from '../src/measurement-export';

function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && character === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index++;
    } else cell += character;
  }
  expect(quoted).toBe(false);
  expect(row).toEqual([]);
  expect(cell).toBe('');
  return rows;
}
function restore(envelope: any): any {
  for (const path of envelope.negativeZeroPaths) {
    const components = path.split('/').slice(1),
      field = components.pop()!;
    let parent = envelope;
    for (const component of components) parent = parent[component];
    expect(parent[field] === 0).toBe(true);
    parent[field] = -0;
  }
  return envelope;
}
function decode(text: string): any {
  const [header, ...records] = csv(text);
  const expected = [
    'record_type',
    'record_index',
    'births',
    'deaths.age',
    'deaths.energy',
    'deaths.manual',
    'energy.leavesGained',
    'energy.mouthsGained',
    'energy.movementSpent',
    'energy.upkeepSpent',
    'energy.climateUpkeepSpent',
    'energy.reproductionSpent',
    'energy.offspringGranted',
    'energy.stingsGained',
    'energy.stingsDrained',
    'fromTick',
    'tick',
    'population',
    'food',
    'cellCounts.0',
    'cellCounts.1',
    'cellCounts.2',
    'cellCounts.3',
    'cellCounts.4',
    'cellCounts.5',
    'meanPreference',
    'meanTolerance',
    'adaptation_status',
    'adaptation.preferenceBins.0',
    'adaptation.preferenceBins.1',
    'adaptation.preferenceBins.2',
    'adaptation.preferenceBins.3',
    'adaptation.preferenceBins.4',
    'adaptation.preferenceBins.5',
    'adaptation.preferenceBins.6',
    'adaptation.preferenceBins.7',
    'adaptation.preferenceBins.8',
    'adaptation.preferenceBins.9',
    'adaptation.stressedOrganisms',
    'manual.sequence',
    'manual.origin',
    'manual.kind',
    'manual.firstTick',
    'manual.lastTick',
    'metadata_json',
  ];
  expect(header).toEqual(expected);
  expect(MEASUREMENT_COLUMNS).toEqual(expected);
  const literal = (value: string) => {
    expect(value.startsWith('s:')).toBe(true);
    return value.slice(2);
  };
  let result: any;
  for (const record of records) {
    expect(record).toHaveLength(header.length);
    const cells = Object.fromEntries(header.map((column, index) => [column, record[index]])),
      type = literal(cells.record_type);
    if (type === 'metadata') {
      result = JSON.parse(literal(cells.metadata_json));
      expect(cells.record_index).toBe('0');
      result.telemetry.samples = [];
      result.interventions.entries = [];
    } else if (type === 'intervention') {
      expect(Number(cells.record_index)).toBe(result.interventions.entries.length);
      result.interventions.entries.push({
        sequence: Number(cells['manual.sequence']),
        origin: literal(cells['manual.origin']),
        kind: literal(cells['manual.kind']),
        firstTick: Number(cells['manual.firstTick']),
        lastTick: Number(cells['manual.lastTick']),
        detail: JSON.parse(literal(cells.metadata_json)),
      });
    } else {
      const item: any = {};
      for (const [column, value] of Object.entries(cells)) {
        if (
          !value ||
          ['record_type', 'record_index', 'adaptation_status', 'metadata_json'].includes(column)
        )
          continue;
        const parts = column.split('.'),
          field = parts.pop()!;
        let parent = item;
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index],
            array = part === 'cellCounts' || part === 'preferenceBins';
          parent = parent[part] ??= array ? [] : {};
        }
        parent[field] = value === 'null' ? null : Number(value);
      }
      if (type === 'sample') {
        expect(Number(cells.record_index)).toBe(result.telemetry.samples.length);
        if (literal(cells.adaptation_status) === 'legacy-unknown') item.adaptation = null;
        result.telemetry.samples.push(item);
      } else {
        expect(type).toBe('pending');
        expect(cells.record_index).toBe('0');
        for (const column of ['tick', 'population', 'food', 'meanPreference', 'adaptation_status'])
          expect(cells[column]).toBe('');
        result.telemetry.pending = item;
      }
    }
  }
  return restore(result);
}

describe('bounded retained measurement codec', () => {
  it.each([true, false])(
    'projects only strict shade capture metadata and history4 for mode %s',
    (enabled) => {
      const world = new Ecosystem(DEFAULTS, false);
      world.changeShadeMode(true);
      const first = world.paintShade({ rulesVersion: 1, tool: 'shade', units: 8, radius: 0 }, 0, 0);
      world.paintShade({ rulesVersion: 1, tool: 'shade', units: 16, radius: 0 }, 1, 0);
      world.changeShadeMode(enabled);
      (world.settings as any).secretOpaque = 'unmeasured shade opaque';
      const before = world.save(),
        source = world.measurements(first.rowSequence);
      const json = restore(JSON.parse(serializeMeasurements(source, 'json').text));
      expect(decode(serializeMeasurements(source, 'csv').text)).toEqual(json);
      expect(json).toMatchObject({
        version: 6,
        rules: { version: 5 },
        snapshot: {
          worldVersion: 12,
          shadeHabitats: {
            version: 1,
            enabled,
            nonzeroCells: 2,
            capacity: 4096,
            unitsPerFullLight: 16,
            minimumStoredLightUnits: 0,
            maximumStoredLightUnits: 16,
            sumShadeUnits: 24,
          },
        },
        interventions: { version: 4 },
      });
      expect(Object.keys(json.snapshot.shadeHabitats)).toEqual([
        'version',
        'enabled',
        'nonzeroCells',
        'capacity',
        'unitsPerFullLight',
        'minimumStoredLightUnits',
        'maximumStoredLightUnits',
        'sumShadeUnits',
      ]);
      expect(JSON.stringify(json)).not.toContain('unmeasured shade opaque');
      expect(json.snapshot.shadeHabitats).not.toHaveProperty('cells');
      expect(json.snapshot.shadeHabitats).not.toHaveProperty('units');
      source.snapshot.shadeHabitats.nonzeroCells = 4096;
      json.interventions.entries.length = 0;
      expect(world.save()).toEqual(before);
    },
  );
  it.each(['legacy-json', 'evolved-json', 'legacy-csv', 'evolved-csv'])(
    'observes the current world without changing inherited data: %s',
    (variant) => {
      const world = new Ecosystem({ ...DEFAULTS, nutrients: 0 }, false),
        genome = storedSensoryGenome();
      if (variant.startsWith('legacy')) genome.behavior = { version: 1, mode: 'legacy' };
      world.spawn(genome, 30, 30)!.energy = 100;
      for (let tick = 0; tick < 90; tick++) world.step();
      const before = world.save(),
        format = variant.endsWith('json') ? 'json' : 'csv';
      const source = world.measurements(),
        envelope = measurementEnvelope(source);
      const serialized = serializeMeasurements(source, format);
      expect(serialized.byteLength).toBe(new TextEncoder().encode(serialized.text).length);
      expect(envelope.snapshot.worldVersion).toBe(11);
      expect(envelope).toMatchObject({
        version: 6,
        rules: { version: 5 },
        telemetry: { version: 2 },
        interventions: { version: 4 },
      });
      expect(serialized.text).not.toContain('native-B5');
      expect(serialized.text).not.toContain('legacyExtensions');
      expect(world.save()).toEqual(before);
      expect(Ecosystem.load(JSON.stringify(before)).save()).toEqual(before);
    },
  );
  it('reports the current complete-world version without changing measurement format or adding lineage replay', () => {
    const world = new Ecosystem();
    const source = world.measurements();
    const envelope = measurementEnvelope(source);
    expect(source.snapshot.worldVersion).toBe(WORLD_VERSION);
    expect(world.save().version).toBe(WORLD_VERSION);
    expect(envelope.version).toBe(5);
    expect(envelope.telemetry).toEqual(world.save().telemetry);
    expect(envelope.interventions).toEqual(world.save().interventions);
    expect(envelope).not.toHaveProperty('lineageArchive');
    expect(JSON.parse(serializeMeasurements(source, 'json').text)).not.toHaveProperty(
      'lineageArchive',
    );
  });
  it.each([
    [false, false],
    [true, false],
    [true, true],
    [false, true],
  ])(
    'curates thermal mode=%s, paint=%s and all distinct manual details identically in JSON and CSV',
    (enabled, painted) => {
      const world = new Ecosystem();
      (world.settings as any).thermalRefuges = { privateOpaqueValue: true };
      world.changeRefugeMode(true);
      world.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 4 }, 0, 0);
      world.paintRefuge({ rulesVersion: 1, tool: 'cool', radius: 0, units: -8 }, 1, 0);
      if (!painted) world.clearRefuges();
      world.changeRefugeMode(enabled);
      const before = world.save(),
        source = world.measurements(),
        json = restore(JSON.parse(serializeMeasurements(source, 'json').text)),
        decoded = decode(serializeMeasurements(source, 'csv').text);
      expect(decoded).toEqual(json);
      expect(json).toMatchObject({
        version: 6,
        rules: { version: 5 },
        snapshot: {
          worldVersion: 12,
          thermalRefuges: {
            version: 1,
            enabled,
            nonzeroCells: painted ? 2 : 0,
            capacity: 4096,
            unitsPerNormalized: 100,
            minimumUnits: painted ? -8 : 0,
            maximumUnits: painted ? 4 : 0,
            sumUnits: painted ? -4 : 0,
          },
        },
        interventions: { version: 4 },
      });
      expect(Object.keys(json.snapshot.thermalRefuges)).toEqual([
        'version',
        'enabled',
        'nonzeroCells',
        'capacity',
        'unitsPerNormalized',
        'minimumUnits',
        'maximumUnits',
        'sumUnits',
      ]);
      expect(json.snapshot.settings).toEqual(DEFAULTS);
      expect(json.interventions.entries.map((entry: any) => entry.kind)).toContain('refuge-mode');
      expect(json.interventions.entries.map((entry: any) => entry.kind)).toContain('refuge-paint');
      if (!painted)
        expect(json.interventions.entries.map((entry: any) => entry.kind)).toContain(
          'refuge-clear',
        );
      expect(json.windows.interpretation).toContain(
        'not historical modes, thermal dose or leaf exposure',
      );
      source.snapshot.thermalRefuges.nonzeroCells = 4096;
      source.interventions.entries.length = 0;
      expect(world.save()).toEqual(before);
    },
  );
  it('uses envelope4 and exact terrain metadata/detail without expanding numeric settings or changing CSV columns', () => {
    const world = new Ecosystem();
    (world.settings as any).retained = { literal: 'unmeasured opaque value' };
    world.changeTerrain('clear');
    world.changeTerrain('regenerate', { version: 1, preset: 'open-field', seed: -0 });
    const source = world.measurements(),
      envelope = measurementEnvelope(source);
    expect(envelope.version).toBe(5);
    expect(envelope.rules.version).toBe(4);
    expect(envelope.snapshot.worldVersion).toBe(11);
    expect(envelope.snapshot.terrain).toEqual(world.terrain);
    expect(envelope.snapshot.settings).toEqual(DEFAULTS);
    expect(envelope.negativeZeroPaths).toContain('/snapshot/terrain/seed');
    const encoded = serializeMeasurements(source, 'csv');
    expect(csv(encoded.text)[0]).toEqual([...MEASUREMENT_COLUMNS]);
    expect(encoded.text).not.toContain('unmeasured opaque value');
    const details = csv(encoded.text).filter((row) => row[0] === 's:intervention');
    expect(details).toHaveLength(2);
    expect(decode(encoded.text).interventions).toEqual(source.interventions);
    envelope.snapshot.terrain.seed = 99;
    expect(Object.is(world.terrain.seed, -0)).toBe(true);
  });
  it.each([
    '',
    's:literal',
    'comma,quote"',
    'a\r\nb\tc\0\\',
    'λ🐟',
    '=1+2',
    '+SUM(A1)',
    '-1+2',
    '@A1',
    "'formula",
    ' \t\r\n=hidden',
  ])('quotes and reversibly tags literal text %j', (text) => {
    expect(csv(`${measurementCsvCell(text)}\r\n`)).toEqual([[`s:${text}`]]);
  });
  it('preserves numeric spellings independently from text protection', () => {
    expect(
      csv(
        [null, -0, 0, -0.32, Number.MIN_VALUE, 1.2345678901234567, 1e100]
          .map(measurementCsvCell)
          .join(',') + '\r\n',
      )[0],
    ).toEqual(['null', '-0', '0', '-0.32', '5e-324', '1.2345678901234567', '1e+100']);
  });
  it('exports an empty fresh run without inventing an initial sample', () => {
    const world = new Ecosystem(),
      before = JSON.stringify(world.save()),
      source = world.measurements();
    const actual = measurementEnvelope(source);
    expect(actual.windows.samples).toEqual({
      recordingOriginTick: 0,
      firstRetainedFromTick: null,
      firstRetainedTick: null,
      lastRetainedTick: null,
      retainedCount: 0,
      capacity: 180,
      evictedCount: 0,
      beforeOrigin: 'not-recorded',
    });
    expect(actual.windows.manual).toMatchObject({
      retainedCount: 0,
      totalEntries: 0,
      evictedCount: 0,
      firstSequence: null,
      lastSequence: null,
      firstEffectTick: null,
      lastEffectTick: null,
    });
    expect(actual.windows.settings).toMatchObject({
      originPhase: 'before-first-ecological-tick',
      prefixPhase: 'before-first-ecological-tick',
      unknownBeforeTick: null,
      unknownEvictedPrefix: false,
    });
    expect(decode(serializeMeasurements(source, 'csv').text)).toEqual(actual);
    expect(JSON.parse(serializeMeasurements(source, 'json').text)).toEqual(actual);
    expect(csv(serializeMeasurements(source, 'csv').text)).toHaveLength(3);
    expect(JSON.stringify(world.save())).toBe(before);
  });
  it('roundtrips every retained field, null, numeric sign, row order and pending same-tick edit', () => {
    const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0 }, false);
    for (let tick = 0; tick < 60; tick++) world.step();
    world.changeSettings({ mutation: 0.2, nutrients: 3, climate: 0.4 });
    const outcome = world.paint('food', 10, 10, 0, founder(0));
    const sequence = world.recordPaint(outcome, 'food', 0, 10, 10, null);
    const source = world.measurements(sequence);
    source.telemetry.samples[0].adaptation = null;
    source.telemetry.adaptationOriginTick = 30;
    source.telemetry.samples[0].meanPreference = -0;
    source.telemetry.samples[0].meanTolerance = 0.12345678901234567;
    source.telemetry.pending.energy.stingsDrained = Number.MIN_VALUE;
    source.snapshot.event.offset = -0;
    const actual = measurementEnvelope(source);
    expect(actual.negativeZeroPaths).toEqual([
      '/snapshot/event/offset',
      '/telemetry/samples/0/meanPreference',
    ]);
    expect(restore(JSON.parse(serializeMeasurements(source, 'json').text))).toEqual(actual);
    expect(decode(serializeMeasurements(source, 'csv').text)).toEqual(actual);
    expect(
      Object.is(
        decode(serializeMeasurements(source, 'csv').text).telemetry.samples[0].meanPreference,
        -0,
      ),
    ).toBe(true);
    expect(actual.windows.adaptation).toEqual({
      originTick: 30,
      legacyRetainedCount: 1,
      firstMeasuredRetainedTick: 60,
    });
    expect(actual.snapshot.openStrokeSequence).toBe(sequence);
    expect(actual.windows.pending).toEqual({
      fromTick: 60,
      throughTick: 60,
      completeSample: false,
      includesSameTickPostBoundaryEdits: true,
    });
    source.snapshot.settings.seed = 99;
    expect(actual.snapshot.settings.seed).toBe(42);
  });
  it('labels legacy origin and both evicted windows without attaching current settings to old rows', () => {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
    for (let tick = 0; tick < 5460; tick++) world.step();
    for (let index = 0; index < 130; index++) world.changeSettings({ nutrients: (index % 2) + 1 });
    const actual = measurementEnvelope(world.measurements());
    expect(actual.windows.samples).toMatchObject({
      retainedCount: 180,
      evictedCount: 2,
      firstRetainedFromTick: 60,
      firstRetainedTick: 90,
      lastRetainedTick: 5460,
    });
    expect(actual.windows.manual).toMatchObject({
      retainedCount: 128,
      evictedCount: 2,
      firstSequence: 3,
      lastSequence: 130,
    });
    expect(actual.windows.settings).toMatchObject({
      prefixPhase: 'after-manual-entry',
      unknownEvictedPrefix: true,
    });
    expect(csv(serializeMeasurements(world.measurements(), 'csv').text)).toHaveLength(311);
    expect(decode(serializeMeasurements(world.measurements(), 'csv').text)).toEqual(actual);
    const { interventions: _log, ...saved } = syntheticHistoricalWorld(world.save()),
      legacy = Ecosystem.load(JSON.stringify({ ...saved, version: 4 }));
    const imported = measurementEnvelope(legacy.measurements());
    expect(imported.windows.settings).toMatchObject({
      originPhase: 'after-completed-tick',
      prefixPhase: 'after-completed-tick',
      unknownBeforeTick: 5460,
    });
    expect(imported.windows.manual.originKind).toBe('legacy-import');
    expect(imported.telemetry).toEqual(actual.telemetry);
    expect(decode(serializeMeasurements(legacy.measurements(), 'csv').text)).toEqual(imported);
  });
  it('checks final UTF-8 bytes at the exact cap without trimming or fallback', () => {
    expect(checkedMeasurementText('x'.repeat(WORLD_MAX_BYTES)).byteLength).toBe(WORLD_MAX_BYTES);
    expect(checkedMeasurementText('é'.repeat(WORLD_MAX_BYTES / 2)).byteLength).toBe(
      WORLD_MAX_BYTES,
    );
    expect(() => checkedMeasurementText('x'.repeat(WORLD_MAX_BYTES + 1))).toThrow('2.5 MB');
    expect(() => checkedMeasurementText('é'.repeat(WORLD_MAX_BYTES / 2) + 'a')).toThrow('2.5 MB');
  });
  it('rejects nonfinite measurements and malformed unbounded signed-zero sidecars instead of repairing them', () => {
    const source = new Ecosystem().measurements();
    source.telemetry.pending.energy.leavesGained = Infinity;
    expect(() => measurementEnvelope(source)).toThrow('Nonfinite');
    source.telemetry.pending.energy.leavesGained = NaN;
    expect(() => measurementEnvelope(source)).toThrow('Nonfinite');
    source.telemetry.pending.energy.leavesGained = 0;
    (source.telemetry as any)['x'.repeat(129)] = -0;
    expect(() => measurementEnvelope(source)).toThrow('sidecar');
    delete (source.telemetry as any)['x'.repeat(129)];
    (source.telemetry as any).invalid = Array(12289).fill(-0);
    expect(() => measurementEnvelope(source as MeasurementSource)).toThrow('sidecar');
  });
});
