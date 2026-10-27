import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, WORLD_MAX_BYTES, founder, type MeasurementSource } from '../src/model';
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
    const { interventions: _log, ...saved } = world.save(),
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
