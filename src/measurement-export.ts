import {
  INTERVENTION_CAPACITY,
  TELEMETRY_CAPACITY,
  TELEMETRY_INTERVAL_TICKS,
  WORLD_MAX_BYTES,
  knownSettings,
  type MeasurementFormat,
  type MeasurementSource,
  type TelemetryFlow,
} from './model';

const ENERGY_FIELDS = [
  'leavesGained',
  'mouthsGained',
  'movementSpent',
  'upkeepSpent',
  'climateUpkeepSpent',
  'reproductionSpent',
  'offspringGranted',
  'stingsGained',
  'stingsDrained',
] as const;
export const MEASUREMENT_COLUMNS = [
  'record_type',
  'record_index',
  'births',
  'deaths.age',
  'deaths.energy',
  'deaths.manual',
  ...ENERGY_FIELDS.map((field) => `energy.${field}`),
  'fromTick',
  'tick',
  'population',
  'food',
  ...Array.from({ length: 6 }, (_, index) => `cellCounts.${index}`),
  'meanPreference',
  'meanTolerance',
  'adaptation_status',
  ...Array.from({ length: 10 }, (_, index) => `adaptation.preferenceBins.${index}`),
  'adaptation.stressedOrganisms',
  'manual.sequence',
  'manual.origin',
  'manual.kind',
  'manual.firstTick',
  'manual.lastTick',
  'metadata_json',
] as const;

export function measurementEnvelope(source: MeasurementSource) {
  const { telemetry, interventions: manual } = source,
    { completedTick } = source.snapshot,
    samples = telemetry.samples,
    first = samples[0],
    last = samples.at(-1),
    firstEntry = manual.entries[0],
    lastEntry = manual.entries.at(-1),
    evicted = manual.totalEntries - manual.entries.length;
  const envelope = {
    format: 'evolab-drift-measurements',
    version: 9,
    rules: { id: 'evolab-drift-cellular', version: 8 },
    snapshot: {
      ...(source.snapshot.nutrientCycle
        ? { nutrientCycle: structuredClone(source.snapshot.nutrientCycle) }
        : {}),
      worldVersion: source.snapshot.worldVersion,
      mutationPolicy: structuredClone(source.snapshot.mutationPolicy),
      terrain: { ...source.snapshot.terrain },
      thermalRefuges: { ...source.snapshot.thermalRefuges },
      shadeHabitats: { ...source.snapshot.shadeHabitats },
      completedTick,
      seed: source.snapshot.seed,
      settings: knownSettings(source.snapshot.settings),
      event: { offset: source.snapshot.event.offset, until: source.snapshot.event.until },
      openStrokeSequence: source.snapshot.openStrokeSequence,
    },
    windows: {
      samples: {
        recordingOriginTick: telemetry.originTick,
        firstRetainedFromTick: first?.fromTick ?? null,
        firstRetainedTick: first?.tick ?? null,
        lastRetainedTick: last?.tick ?? null,
        retainedCount: samples.length,
        capacity: TELEMETRY_CAPACITY,
        evictedCount:
          Math.floor(completedTick / TELEMETRY_INTERVAL_TICKS) -
          Math.floor(telemetry.originTick / TELEMETRY_INTERVAL_TICKS) -
          samples.length,
        beforeOrigin: 'not-recorded',
      },
      adaptation: {
        originTick: telemetry.adaptationOriginTick,
        legacyRetainedCount: samples.filter(
          (sample) => sample.tick <= telemetry.adaptationOriginTick,
        ).length,
        firstMeasuredRetainedTick:
          samples.find((sample) => sample.tick > telemetry.adaptationOriginTick)?.tick ?? null,
      },
      manual: {
        originTick: manual.originTick,
        originKind: manual.originKind,
        retainedCount: manual.entries.length,
        capacity: INTERVENTION_CAPACITY,
        totalEntries: manual.totalEntries,
        evictedCount: evicted,
        evictedThroughTick: manual.evictedThroughTick,
        firstSequence: firstEntry?.sequence ?? null,
        lastSequence: lastEntry?.sequence ?? null,
        firstEffectTick: firstEntry?.firstTick ?? null,
        lastEffectTick: lastEntry?.lastTick ?? null,
        coverage: 'applied-portions-only',
      },
      settings: {
        scope: 'capture-and-declared-anchors-not-per-sample',
        originPhase:
          manual.originKind === 'fresh' ? 'before-first-ecological-tick' : 'after-completed-tick',
        prefixPhase: evicted
          ? 'after-manual-entry'
          : manual.originKind === 'fresh'
            ? 'before-first-ecological-tick'
            : 'after-completed-tick',
        unknownBeforeTick: manual.originKind === 'fresh' ? null : manual.originTick,
        unknownEvictedPrefix: evicted > 0,
      },
      pending: {
        fromTick: telemetry.pending.fromTick,
        throughTick: completedTick,
        completeSample: false,
        includesSameTickPostBoundaryEdits: true,
      },
      interpretation:
        'Artificial-life observations, not causal history or a complete replay file. Painted temperature and shade metadata describe the capture, not historical modes, thermal dose or leaf exposure. Complete fields require a world Save; imported prior paint history may be unknown.',
    },
    telemetry: structuredClone(telemetry),
    interventions: structuredClone(manual),
    negativeZeroPaths: [] as string[],
  };
  function visit(value: unknown, path: string): void {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Nonfinite measurement; no download created.');
      if (Object.is(value, -0)) {
        if (path.length > 128 || envelope.negativeZeroPaths.length >= 12288)
          throw new Error('Measurement numeric sidecar exceeds its bound.');
        envelope.negativeZeroPaths.push(path);
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}/${key}`);
    }
  }
  visit(envelope, '');
  envelope.negativeZeroPaths.sort();
  return envelope;
}

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
export function measurementCsvCell(value: string | number | null): string {
  return quote(
    typeof value === 'string'
      ? `s:${value}`
      : value === null
        ? 'null'
        : Object.is(value, -0)
          ? '-0'
          : String(value),
  );
}

export function checkedMeasurementText(text: string): { text: string; byteLength: number } {
  if (text.length > WORLD_MAX_BYTES)
    throw new Error('Measurements exceed 2.5 MB; no download created.');
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > WORLD_MAX_BYTES)
    throw new Error('Measurements exceed 2.5 MB; no download created.');
  return { text, byteLength };
}

export function serializeMeasurements(source: MeasurementSource, format: MeasurementFormat) {
  const envelope = measurementEnvelope(source);
  if (format === 'json') return checkedMeasurementText(JSON.stringify(envelope));
  const records = [MEASUREMENT_COLUMNS.map(quote).join(',')];
  function row(type: string, index: number, cells: Record<string, string | number | null>): void {
    const values = { record_type: type, record_index: index, ...cells };
    records.push(
      MEASUREMENT_COLUMNS.map((column) =>
        Object.hasOwn(values, column)
          ? measurementCsvCell(values[column as keyof typeof values])
          : '""',
      ).join(','),
    );
  }
  const { samples: _samples, pending: _pending, ...telemetry } = envelope.telemetry,
    { entries: _entries, ...interventions } = envelope.interventions;
  row('metadata', 0, { metadata_json: JSON.stringify({ ...envelope, telemetry, interventions }) });
  function flows(flow: TelemetryFlow): Record<string, number> {
    return {
      births: flow.births,
      'deaths.age': flow.deaths.age,
      'deaths.energy': flow.deaths.energy,
      'deaths.manual': flow.deaths.manual,
      ...Object.fromEntries(ENERGY_FIELDS.map((field) => [`energy.${field}`, flow.energy[field]])),
    };
  }
  envelope.telemetry.samples.forEach((sample, index) =>
    row('sample', index, {
      ...flows(sample),
      fromTick: sample.fromTick,
      tick: sample.tick,
      population: sample.population,
      food: sample.food,
      ...Object.fromEntries(
        sample.cellCounts.map((count, index) => [`cellCounts.${index}`, count]),
      ),
      meanPreference: sample.meanPreference,
      meanTolerance: sample.meanTolerance,
      adaptation_status: sample.adaptation ? 'observed' : 'legacy-unknown',
      ...Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `adaptation.preferenceBins.${index}`,
          sample.adaptation?.preferenceBins[index] ?? null,
        ]),
      ),
      'adaptation.stressedOrganisms': sample.adaptation?.stressedOrganisms ?? null,
    }),
  );
  row('pending', 0, {
    ...flows(envelope.telemetry.pending),
    fromTick: envelope.telemetry.pending.fromTick,
  });
  envelope.interventions.entries.forEach((entry, index) =>
    row('intervention', index, {
      'manual.sequence': entry.sequence,
      'manual.origin': entry.origin,
      'manual.kind': entry.kind,
      'manual.firstTick': entry.firstTick,
      'manual.lastTick': entry.lastTick,
      metadata_json: JSON.stringify(entry.detail),
    }),
  );
  return checkedMeasurementText(`${records.join('\r\n')}\r\n`);
}
