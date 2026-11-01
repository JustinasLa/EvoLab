import type { AttemptChannel } from './mutation-evidence';
import { mutatePropensity } from './mutation';
import {
  legacyMutation,
  mutateWithPolicy,
  sameMutationPolicy,
  validMutationPolicy,
  type MutationPolicy,
} from './mutation';
import { sensoryDirection } from './sensory';
import {
  emptyShade,
  parseShade,
  shadeFile,
  shadeDab,
  validShadeBrush,
  shadeSummary,
  selectedLeafLight,
} from './shade';
import { DEFAULT_TERRAIN, generateTerrain, sameTerrain, validTerrain } from './terrain';
import {
  emptyRefuges,
  activeRefugeUnits,
  parseRefuges,
  refugeFile,
  refugeSummary,
  refugeDab,
  validRefugeBrush,
  localTemperature,
} from './refuges';
import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  LIMIT,
  TELEMETRY_INTERVAL_TICKS,
  TELEMETRY_CAPACITY,
  WORLD_MAX_BYTES,
  WORLD_VERSION,
  INTERVENTION_CAPACITY,
  STROKE_COMMAND_CAPACITY,
  knownSettings,
  PREFERENCE_ENDPOINTS,
  Random,
  index,
  positions,
  founder,
  validGenome,
  validHistoricalGenome,
  migrateHistoricalGenome,
  cloneGenome,
  validSettings,
  finite,
  integer,
  speciesName,
  observedGenome,
  type RefugeBrush,
  type ShadeBrush,
  type WorldFileV14,
  type WorldFileV13,
  type WorldFileV12,
  type WorldFileV11,
  type WorldFileV10,
  type WorldFileV9,
  type Cell,
  type Genome,
  type Organism,
  type Perception,
  type Settings,
  type WorldFile,
  type Frame,
  type WorldPresentation,
  type Species,
  type Tool,
  type DeathRecord,
  type LegacyWorldFile,
  type WorldFileV3,
  type WorldFileV4,
  type WorldFileV5,
  type HistoricalGenome,
  type WorldFileV6,
  type TerrainRecipe,
  type TerrainDetail,
  type WorldFileV7,
  type WorldFileV8,
  type LineageArchiveState,
  type InterventionState,
  type InterventionEffect,
  type InterventionEntry,
  type PaintOutcome,
  type PaintTool,
  type SettingsPatch,
  type SettingKey,
  type MeasurementSource,
  type PreferenceBins,
  type DeathCause,
  type EnergyLedger,
  type TelemetryFlow,
  type TelemetrySample,
  type TelemetryState,
} from './model';
import { LineageArchive, sameInherited } from './lineage';
type LineageTransition =
  { kind: 'founder' | 'manual' | 'clone' } | { kind: 'mutation'; parentId: number };
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
function metabolicPosition(organism: Organism, cell: Cell): number {
  switch (organism.rotation) {
    case 0:
      return index(organism.x + cell.x, organism.y + cell.y);
    case 1:
      return index(organism.x - cell.y, organism.y + cell.x);
    case 2:
      return index(organism.x - cell.x, organism.y - cell.y);
    default:
      return index(organism.x + cell.y, organism.y - cell.x);
  }
}
function emptyFlow(): TelemetryFlow {
  return {
    births: 0,
    deaths: { age: 0, energy: 0, manual: 0 },
    energy: {
      leavesGained: 0,
      mouthsGained: 0,
      movementSpent: 0,
      upkeepSpent: 0,
      climateUpkeepSpent: 0,
      reproductionSpent: 0,
      offspringGranted: 0,
      stingsGained: 0,
      stingsDrained: 0,
    },
  };
}
function emptyTelemetry(tick: number): TelemetryState {
  return {
    version: 2,
    intervalTicks: TELEMETRY_INTERVAL_TICKS,
    originTick: tick,
    adaptationOriginTick: tick,
    samples: [],
    pending: { ...emptyFlow(), fromTick: tick },
  };
}
function traitBits(value: number, view: DataView): bigint {
  view.setFloat64(0, value === 0 ? 0 : value, false);
  return view.getBigUint64(0, false);
}
function traitUnits(bits: bigint): bigint {
  const exponent = (bits >> 52n) & 0x7ffn;
  const fraction = bits & ((1n << 52n) - 1n);
  return exponent === 0n ? fraction : ((1n << 52n) + fraction) << (exponent - 1n);
}
function traitMean(
  sum: bigint,
  population: number,
  minimum: number,
  maximum: number,
  view: DataView,
): number | null {
  if (population === 0) return null;
  const count = BigInt(population);
  let low = traitBits(minimum, view),
    high = traitBits(maximum, view),
    lower = low;
  while (low <= high) {
    const middle = (low + high) >> 1n;
    if (traitUnits(middle) * count <= sum) {
      lower = middle;
      low = middle + 1n;
    } else high = middle - 1n;
  }
  if (traitUnits(lower) * count !== sum) {
    const midpoint = count * (traitUnits(lower) + traitUnits(lower + 1n));
    if (2n * sum > midpoint || (2n * sum === midpoint && (lower & 1n) !== 0n)) lower++;
  }
  view.setBigUint64(0, lower, false);
  return view.getFloat64(0, false);
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validFlow(value: Record<string, unknown>): boolean {
  const deaths = value.deaths,
    energy = value.energy;
  return (
    integer(value.births, 0, 1e9) &&
    exactKeys(deaths, ['age', 'energy', 'manual']) &&
    Object.values(deaths).every((count) => integer(count, 0, 1e9)) &&
    exactKeys(energy, Object.keys(emptyFlow().energy)) &&
    Object.values(energy).every((amount) => finite(amount, 0, 1e9)) &&
    (energy.climateUpkeepSpent as number) <= (energy.upkeepSpent as number) + 1e-6 &&
    (energy.offspringGranted as number) <= (energy.reproductionSpent as number) + 1e-6
  );
}
function validTelemetry(
  value: unknown,
  tick: number,
  births: number,
  deaths: number,
  version: 1 | 2,
): boolean {
  if (
    !exactKeys(value, [
      'version',
      'intervalTicks',
      'originTick',
      'samples',
      'pending',
      ...(version === 2 ? ['adaptationOriginTick'] : []),
    ]) ||
    value.version !== version ||
    value.intervalTicks !== TELEMETRY_INTERVAL_TICKS ||
    !integer(value.originTick, 0, tick) ||
    !Array.isArray(value.samples) ||
    (version === 2 && !integer(value.adaptationOriginTick, value.originTick as number, tick))
  )
    return false;
  const boundary = Math.floor(tick / TELEMETRY_INTERVAL_TICKS),
    elapsed = boundary - Math.floor(value.originTick / TELEMETRY_INTERVAL_TICKS),
    length = Math.min(TELEMETRY_CAPACITY, elapsed),
    pendingStart = elapsed ? boundary * TELEMETRY_INTERVAL_TICKS : value.originTick;
  if (
    value.samples.length !== length ||
    !exactKeys(value.pending, ['births', 'deaths', 'energy', 'fromTick']) ||
    value.pending.fromTick !== pendingStart ||
    !validFlow(value.pending)
  )
    return false;
  let countedBirths = value.pending.births as number,
    countedDeaths = Object.values(value.pending.deaths as Record<string, number>).reduce(
      (total, count) => total + count,
      0,
    );
  for (const [sampleIndex, sample] of value.samples.entries()) {
    const sampleTick = (boundary - length + sampleIndex + 1) * TELEMETRY_INTERVAL_TICKS;
    if (
      !exactKeys(sample, [
        'births',
        'deaths',
        'energy',
        'fromTick',
        'tick',
        'population',
        'food',
        'cellCounts',
        'meanPreference',
        'meanTolerance',
        ...(version === 2 ? ['adaptation'] : []),
      ]) ||
      sample.tick !== sampleTick ||
      sample.fromTick !== Math.max(value.originTick, sampleTick - TELEMETRY_INTERVAL_TICKS) ||
      !validFlow(sample) ||
      !integer(sample.population, 0, LIMIT) ||
      !integer(sample.food, 0, WIDTH * HEIGHT) ||
      !Array.isArray(sample.cellCounts) ||
      sample.cellCounts.length !== 6 ||
      !sample.cellCounts.every((count) => integer(count, 0, LIMIT * 16))
    )
      return false;
    if (version === 2) {
      const adaptation = sample.adaptation;
      if (sampleTick <= (value.adaptationOriginTick as number)) {
        if (adaptation !== null) return false;
      } else if (
        !exactKeys(adaptation, ['preferenceBins', 'stressedOrganisms']) ||
        !Array.isArray(adaptation.preferenceBins) ||
        adaptation.preferenceBins.length !== 10 ||
        !Array.from(adaptation.preferenceBins).every((count) => integer(count, 0, LIMIT)) ||
        adaptation.preferenceBins.reduce((total, count: number) => total + count, 0) !==
          sample.population ||
        !integer(adaptation.stressedOrganisms, 0, sample.population)
      )
        return false;
    }
    const cells = sample.cellCounts.reduce((total, count: number) => total + count, 0);
    if (
      cells < sample.population ||
      cells > sample.population * 16 ||
      (sample.population === 0
        ? sample.meanPreference !== null || sample.meanTolerance !== null
        : !finite(sample.meanPreference, 0, 1) || !finite(sample.meanTolerance, 0.12, 0.6))
    )
      return false;
    countedBirths += sample.births as number;
    countedDeaths += Object.values(sample.deaths as Record<string, number>).reduce(
      (total, count) => total + count,
      0,
    );
  }
  return countedBirths <= births && countedDeaths <= deaths;
}
function emptyInterventions(settings: Settings, tick = 0, legacy = false): InterventionState {
  return {
    version: 5,
    originTick: tick,
    originKind: legacy ? 'legacy-import' : 'fresh',
    originSettings: knownSettings(settings),
    totalEntries: 0,
    evictedThroughTick: null,
    prefixSettings: knownSettings(settings),
    entries: [],
  };
}
function brushCells(radius: number): number {
  let count = 0;
  for (let vertical = -radius; vertical <= radius; vertical++)
    for (let horizontal = -radius; horizontal <= radius; horizontal++)
      if (horizontal * horizontal + vertical * vertical <= radius * radius) count++;
  return count;
}
function validInterventions(
  value: unknown,
  file:
    | WorldFile
    | WorldFileV14
    | WorldFileV13
    | WorldFileV12
    | WorldFileV11
    | WorldFileV10
    | WorldFileV9
    | WorldFileV8
    | WorldFileV7
    | WorldFileV6
    | WorldFileV5,
): boolean {
  const settingKeys = ['seed', 'mutation', 'nutrients', 'climate'];
  const settingsMatch = (left: Settings, right: Settings): boolean =>
    settingKeys.every((key) => left[key as keyof Settings] === right[key as keyof Settings]);
  if (
    !exactKeys(value, [
      'version',
      'originTick',
      'originKind',
      'originSettings',
      'totalEntries',
      'evictedThroughTick',
      'prefixSettings',
      'entries',
    ]) ||
    value.version !==
      (file.version === 13 || file.version === 14 || file.version === WORLD_VERSION
        ? 5
        : file.version === 10 || file.version === 11 || file.version === 12
          ? 4
          : file.version === 7 || file.version === 8 || file.version === 9
            ? 3
            : file.version === 6
              ? 2
              : 1) ||
    !integer(value.originTick, 0, file.tick) ||
    !['fresh', 'legacy-import'].includes(value.originKind as string) ||
    (value.originKind === 'fresh' && value.originTick !== 0) ||
    !exactKeys(value.originSettings, settingKeys) ||
    !validSettings(value.originSettings) ||
    !exactKeys(value.prefixSettings, settingKeys) ||
    !validSettings(value.prefixSettings) ||
    !integer(value.totalEntries, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(value.entries) ||
    value.entries.length !== Math.min(INTERVENTION_CAPACITY, value.totalEntries)
  )
    return false;
  const evicted = value.totalEntries - value.entries.length;
  if (
    evicted === 0
      ? value.evictedThroughTick !== null ||
        !settingsMatch(value.originSettings, value.prefixSettings)
      : !integer(value.evictedThroughTick, value.originTick, file.tick)
  )
    return false;
  const replay = { ...value.prefixSettings };
  if (replay.seed !== file.settings.seed || value.originSettings.seed !== replay.seed) return false;
  let previousTick = (value.evictedThroughTick as number | null) ?? value.originTick,
    previousShock: { offset: number; until: number } | undefined,
    previousTerrain: TerrainRecipe | undefined;
  const coordinate = (point: unknown): boolean =>
    exactKeys(point, ['x', 'y']) &&
    integer(point.x, 0, WIDTH - 1) &&
    integer(point.y, 0, HEIGHT - 1);
  const event = (candidate: unknown): candidate is { offset: number; until: number } =>
    exactKeys(candidate, ['offset', 'until']) &&
    finite(candidate.offset, -0.32, 0.32) &&
    integer(candidate.until, 0, 1e9);
  for (const [index, row] of value.entries.entries()) {
    if (
      !exactKeys(row, ['sequence', 'origin', 'kind', 'firstTick', 'lastTick', 'detail']) ||
      row.sequence !== evicted + index + 1 ||
      row.origin !== 'manual' ||
      !integer(row.firstTick, previousTick, file.tick) ||
      !integer(row.lastTick, row.firstTick, file.tick)
    )
      return false;
    const detail = row.detail;
    previousTick = row.lastTick;
    if (
      (row.kind === 'refuge-paint' &&
        (file.version === 7 ||
          file.version === 8 ||
          file.version === 9 ||
          file.version === 10 ||
          file.version === 11 ||
          file.version === 12 ||
          file.version === 13 ||
          file.version === 14 ||
          file.version === WORLD_VERSION)) ||
      (row.kind === 'shade-paint' &&
        (file.version === 10 ||
          file.version === 11 ||
          file.version === 12 ||
          file.version === 13 ||
          file.version === 14 ||
          file.version === WORLD_VERSION))
    ) {
      if (
        !exactKeys(detail, [
          'rulesVersion',
          'tool',
          'units',
          'radius',
          'first',
          'last',
          'successfulCommands',
          'changedBrushCells',
        ]) ||
        !(row.kind === 'shade-paint' ? validShadeBrush(detail) : validRefugeBrush(detail)) ||
        !coordinate(detail.first) ||
        !coordinate(detail.last) ||
        !integer(detail.successfulCommands, 1, STROKE_COMMAND_CAPACITY) ||
        !integer(
          detail.changedBrushCells,
          detail.successfulCommands,
          detail.successfulCommands * brushCells(detail.radius as number),
        )
      )
        return false;
    } else if (row.kind === 'paint') {
      if (
        !exactKeys(detail, [
          'tool',
          'radius',
          'first',
          'last',
          'successfulCommands',
          'changedBrushCells',
          'removedOrganisms',
        ]) ||
        !['food', 'wall', 'erase'].includes(detail.tool as string) ||
        !integer(detail.radius, 0, 8) ||
        !coordinate(detail.first) ||
        !coordinate(detail.last) ||
        !integer(detail.successfulCommands, 1, STROKE_COMMAND_CAPACITY)
      )
        return false;
      const maximum = detail.successfulCommands * brushCells(detail.radius);
      if (
        !integer(detail.changedBrushCells, 0, maximum) ||
        !integer(detail.removedOrganisms, 0, maximum) ||
        detail.successfulCommands > detail.changedBrushCells + detail.removedOrganisms ||
        (detail.tool !== 'erase' &&
          (detail.removedOrganisms !== 0 || detail.changedBrushCells === 0))
      )
        return false;
    } else {
      if (row.firstTick !== row.lastTick) return false;
      if (
        (row.kind === 'refuge-mode' &&
          (file.version === 7 ||
            file.version === 8 ||
            file.version === 9 ||
            file.version === 10 ||
            file.version === 11 ||
            file.version === 12 ||
            file.version === 13 ||
            file.version === 14 ||
            file.version === WORLD_VERSION)) ||
        (row.kind === 'shade-mode' &&
          (file.version === 10 ||
            file.version === 11 ||
            file.version === 12 ||
            file.version === 13 ||
            file.version === 14 ||
            file.version === WORLD_VERSION))
      ) {
        if (
          !exactKeys(detail, ['rulesVersion', 'before', 'after']) ||
          detail.rulesVersion !== 1 ||
          typeof detail.before !== 'boolean' ||
          typeof detail.after !== 'boolean' ||
          detail.before === detail.after
        )
          return false;
      } else if (
        (row.kind === 'refuge-clear' &&
          (file.version === 7 ||
            file.version === 8 ||
            file.version === 9 ||
            file.version === 10 ||
            file.version === 11 ||
            file.version === 12 ||
            file.version === 13 ||
            file.version === 14 ||
            file.version === WORLD_VERSION)) ||
        (row.kind === 'shade-clear' &&
          (file.version === 10 ||
            file.version === 11 ||
            file.version === 12 ||
            file.version === 13 ||
            file.version === 14 ||
            file.version === WORLD_VERSION))
      ) {
        if (
          !exactKeys(detail, ['rulesVersion', 'removedCells']) ||
          detail.rulesVersion !== 1 ||
          !integer(detail.removedCells, 1, 4096)
        )
          return false;
      } else if (row.kind === 'placement') {
        if (
          !exactKeys(detail, [
            'x',
            'y',
            'organismId',
            'speciesId',
            'bodyCells',
            'preference',
            'tolerance',
            'tempo',
          ]) ||
          !integer(detail.x, 0, WIDTH - 1) ||
          !integer(detail.y, 0, HEIGHT - 1) ||
          !integer(detail.organismId, 1, file.nextId - 1) ||
          !integer(detail.speciesId, 1, file.nextSpecies - 1) ||
          !integer(detail.bodyCells, 1, 16) ||
          !finite(detail.preference, 0, 1) ||
          !finite(detail.tolerance, 0.12, 0.6) ||
          !integer(detail.tempo, 2, 12)
        )
          return false;
      } else if (
        row.kind === 'mutation-policy' &&
        (file.version === 13 || file.version === 14 || file.version === WORLD_VERSION)
      ) {
        if (
          !exactKeys(detail, ['before', 'after']) ||
          !validMutationPolicy(detail.before) ||
          !validMutationPolicy(detail.after) ||
          sameMutationPolicy(detail.before, detail.after)
        )
          return false;
      } else if (row.kind === 'settings') {
        if (
          !exactKeys(detail, ['changes']) ||
          !detail.changes ||
          typeof detail.changes !== 'object' ||
          Array.isArray(detail.changes)
        )
          return false;
        const changes = detail.changes as Record<string, unknown>,
          keys = Object.keys(changes);
        if (!keys.length || keys.some((key) => !['mutation', 'nutrients', 'climate'].includes(key)))
          return false;
        for (const key of keys) {
          const change = changes[key],
            field = key as SettingKey;
          if (
            !exactKeys(change, ['before', 'after']) ||
            change.before !== replay[field] ||
            change.before === change.after ||
            !validSettings({ ...replay, [field]: change.before }) ||
            !validSettings({ ...replay, [field]: change.after })
          )
            return false;
          replay[field] = change.after as number;
        }
      } else if (
        row.kind === 'terrain' &&
        (file.version === 6 ||
          file.version === 7 ||
          file.version === 8 ||
          file.version === 9 ||
          file.version === 10 ||
          file.version === 11 ||
          file.version === 12 ||
          file.version === 13 ||
          file.version === 14 ||
          file.version === WORLD_VERSION)
      ) {
        if (
          !exactKeys(detail, [
            'action',
            'before',
            'after',
            'addedWalls',
            'removedWalls',
            'removedFood',
            'protectedCells',
          ]) ||
          !['clear', 'regenerate'].includes(detail.action as string) ||
          !validTerrain(detail.before) ||
          !validTerrain(detail.after) ||
          !integer(detail.addedWalls, 0, WIDTH * HEIGHT) ||
          !integer(detail.removedWalls, 0, WIDTH * HEIGHT - detail.addedWalls) ||
          !integer(detail.removedFood, 0, detail.addedWalls) ||
          !integer(detail.protectedCells, 0, LIMIT * 16) ||
          (previousTerrain && !sameTerrain(previousTerrain, detail.before))
        )
          return false;
        const unchanged = sameTerrain(detail.before, detail.after);
        if (
          detail.action === 'clear'
            ? !unchanged ||
              detail.addedWalls !== 0 ||
              detail.removedFood !== 0 ||
              detail.protectedCells !== 0 ||
              detail.removedWalls === 0
            : unchanged &&
              detail.addedWalls === 0 &&
              detail.removedWalls === 0 &&
              detail.removedFood === 0
        )
          return false;
        previousTerrain = detail.after;
      } else if (row.kind === 'shock') {
        if (
          !exactKeys(detail, ['kind', 'before', 'after']) ||
          !['cold', 'heat'].includes(detail.kind as string) ||
          !event(detail.before) ||
          !event(detail.after) ||
          detail.after.offset !== (detail.kind === 'cold' ? -0.32 : 0.32) ||
          detail.after.until !== row.firstTick + 900 ||
          (detail.before.offset === detail.after.offset &&
            detail.before.until === detail.after.until) ||
          (previousShock &&
            (previousShock.offset !== detail.before.offset ||
              previousShock.until !== detail.before.until))
        )
          return false;
        previousShock = detail.after;
      } else return false;
    }
  }
  if (
    file.version === 7 ||
    file.version === 8 ||
    file.version === 9 ||
    file.version === 10 ||
    file.version === 11 ||
    file.version === 12 ||
    file.version === 13 ||
    file.version === 14 ||
    file.version === WORLD_VERSION
  ) {
    let enabled = file.thermalRefuges.enabled;
    for (let position = value.entries.length - 1; position >= 0; position--) {
      const row = value.entries[position];
      if (row.kind === 'refuge-mode') {
        if (row.detail.after !== enabled) return false;
        enabled = row.detail.before;
      } else if (row.kind === 'refuge-paint' && !enabled) return false;
    }
  }
  if (
    file.version === 10 ||
    file.version === 11 ||
    file.version === 12 ||
    file.version === 13 ||
    file.version === 14 ||
    file.version === WORLD_VERSION
  ) {
    let enabled = file.shadeHabitats.enabled;
    for (let position = value.entries.length - 1; position >= 0; position--) {
      const row = value.entries[position];
      if (row.kind === 'shade-mode') {
        if (row.detail.after !== enabled) return false;
        enabled = row.detail.before;
      } else if (row.kind === 'shade-paint' && !enabled) return false;
    }
  }
  if (file.version === 13 || file.version === 14 || file.version === WORLD_VERSION) {
    let policy = file.mutationPolicy;
    for (const row of [...value.entries].reverse())
      if (row.kind === 'mutation-policy') {
        if (!sameMutationPolicy(row.detail.after, policy)) return false;
        policy = row.detail.before;
      }
  }
  return (
    settingsMatch(replay, file.settings) &&
    (!previousTerrain ||
      ((file.version === 6 ||
        file.version === 7 ||
        file.version === 8 ||
        file.version === 9 ||
        file.version === 10 ||
        file.version === 11 ||
        file.version === 12 ||
        file.version === 13 ||
        file.version === 14 ||
        file.version === WORLD_VERSION) &&
        sameTerrain(previousTerrain, file.terrain))) &&
    (!previousShock ||
      (previousShock.offset === file.eventOffset && previousShock.until === file.eventUntil))
  );
}
export class Ecosystem {
  random: Random;
  settings: Settings;
  terrain: TerrainRecipe;
  thermalRefuges = emptyRefuges();
  shadeHabitats = emptyShade();
  mutationPolicy: MutationPolicy = legacyMutation();
  organisms = new Map<number, Organism>();
  food = new Uint8Array(WIDTH * HEIGHT);
  walls = new Uint8Array(WIDTH * HEIGHT);
  occupied = new Int32Array(WIDTH * HEIGHT);
  tick = 0;
  births = 0;
  deaths = 0;
  nextId = 1;
  nextSpecies = 5;
  eventUntil = 0;
  eventOffset = 0;
  lastDeath: DeathRecord | null = null;
  private telemetry = emptyTelemetry(0);
  private interventions: InterventionState;
  private readonly recording: boolean;
  private readonly lineageRecording: boolean;
  private lineage = new LineageArchive();
  private perceptionId = 0;
  private lastPerception: Perception | null = null;
  selectPerception(id: number): void {
    const next = this.organisms.has(id) ? id : 0;
    if (next !== this.perceptionId) this.lastPerception = null;
    this.perceptionId = next;
  }
  perception(): Perception | null {
    return structuredClone(this.lastPerception);
  }
  constructor(
    settings: Settings = DEFAULTS,
    seed = true,
    options: { telemetry?: boolean; lineage?: boolean; terrain?: TerrainRecipe } = {},
  ) {
    if (!validTerrain(options.terrain ?? DEFAULT_TERRAIN)) throw new Error('Invalid wall recipe.');
    this.recording = options.telemetry !== false;
    this.lineageRecording = options.lineage !== false;
    this.settings = structuredClone(settings);
    this.terrain = { ...(options.terrain ?? DEFAULT_TERRAIN) };
    this.interventions = emptyInterventions(settings);
    this.random = new Random(settings.seed);
    if (seed) this.seed();
  }
  private recordEnergy(field: keyof EnergyLedger, amount: number): void {
    if (this.recording) this.telemetry.pending.energy[field] += amount;
  }
  populationObservation() {
    const view = new DataView(new ArrayBuffer(8)),
      preferenceBins: PreferenceBins = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      cellCounts: TelemetrySample['cellCounts'] = [0, 0, 0, 0, 0, 0];
    let preference = 0n,
      tolerance = 0n,
      stressedOrganisms = 0;
    for (const organism of this.organisms.values()) {
      const genome = organism.genome;
      if (!finite(genome.preference, 0, 1) || !finite(genome.tolerance, 0.12, 0.6))
        throw new Error('Invalid telemetry source trait.');
      preference += traitUnits(traitBits(genome.preference, view));
      tolerance += traitUnits(traitBits(genome.tolerance, view));
      let bin = 0;
      while (bin < 9 && genome.preference >= PREFERENCE_ENDPOINTS[bin]) bin++;
      preferenceBins[bin]++;
      const local = localTemperature(
        organism.x,
        organism.y,
        this.tick,
        this.settings.climate,
        this.tick < this.eventUntil ? this.eventOffset : 0,
        this.thermalRefuges,
      );
      if (Math.max(0, Math.abs(local - genome.preference) - genome.tolerance) > 0)
        stressedOrganisms++;
      for (const cell of genome.cells) cellCounts[cell.type - 3]++;
    }
    return {
      cellCounts,
      meanPreference: traitMean(preference, this.organisms.size, 0, 1, view),
      meanTolerance: traitMean(tolerance, this.organisms.size, 0.12, 0.6, view),
      adaptation: { preferenceBins, stressedOrganisms },
    };
  }
  private observe(): void {
    if (!this.recording || this.tick % TELEMETRY_INTERVAL_TICKS !== 0) return;
    const sample: TelemetrySample = {
      ...this.telemetry.pending,
      tick: this.tick,
      population: this.organisms.size,
      food: this.food.reduce((total, value) => total + (value ? 1 : 0), 0),
      ...this.populationObservation(),
    };
    if (this.telemetry.samples.length === TELEMETRY_CAPACITY) this.telemetry.samples.shift();
    this.telemetry.samples.push(sample);
    this.telemetry.pending = { ...emptyFlow(), fromTick: this.tick };
  }
  telemetrySnapshot(): TelemetryState {
    return this.recording ? structuredClone(this.telemetry) : emptyTelemetry(this.tick);
  }
  requireInterventionCapacity(continuing = false): void {
    if (!continuing && this.interventions.totalEntries === Number.MAX_SAFE_INTEGER)
      throw new Error('Manual history sequence limit reached. World preserved.');
  }
  appendIntervention(effect: InterventionEffect): number {
    this.requireInterventionCapacity();
    if (this.interventions.entries.length === INTERVENTION_CAPACITY) {
      const removed = this.interventions.entries.shift()!;
      this.interventions.evictedThroughTick = removed.lastTick;
      if (removed.kind === 'settings')
        for (const [key, change] of Object.entries(removed.detail.changes))
          this.interventions.prefixSettings[key as SettingKey] = change!.after;
    }
    const sequence = ++this.interventions.totalEntries;
    this.interventions.entries.push({
      ...structuredClone(effect),
      sequence,
      origin: 'manual',
      firstTick: this.tick,
      lastTick: this.tick,
    });
    return sequence;
  }
  recordPaint(
    outcome: PaintOutcome,
    tool: PaintTool,
    radius: number,
    x: number,
    y: number,
    sequence: number | null,
  ): number | null {
    if (!outcome.changedBrushCells && !outcome.removedOrganisms) return sequence;
    const latest = this.interventions.entries.at(-1);
    if (sequence !== null && latest?.sequence === sequence && latest.kind === 'paint') {
      latest.lastTick = this.tick;
      latest.detail.last = { x, y };
      latest.detail.successfulCommands++;
      latest.detail.changedBrushCells += outcome.changedBrushCells;
      latest.detail.removedOrganisms += outcome.removedOrganisms;
      return sequence;
    }
    return this.appendIntervention({
      kind: 'paint',
      detail: {
        tool,
        radius,
        first: { x, y },
        last: { x, y },
        successfulCommands: 1,
        changedBrushCells: outcome.changedBrushCells,
        removedOrganisms: outcome.removedOrganisms,
      },
    });
  }
  changeMutationPolicy(policy: MutationPolicy): number | null {
    if (!validMutationPolicy(policy)) throw new Error('Invalid mutation policy.');
    if (sameMutationPolicy(this.mutationPolicy, policy)) return null;
    const after = structuredClone(policy),
      before = structuredClone(this.mutationPolicy);
    this.requireInterventionCapacity();
    this.mutationPolicy = after;
    return this.appendIntervention({
      kind: 'mutation-policy',
      detail: { before, after: structuredClone(after) },
    });
  }
  changeSettings(patch: SettingsPatch): number | null {
    const next = { ...this.settings, ...patch };
    if (
      !validSettings(next) ||
      Object.keys(patch).some((key) => !['mutation', 'nutrients', 'climate'].includes(key))
    )
      throw new Error('Invalid manual settings patch.');
    const changes: Extract<InterventionEffect, { kind: 'settings' }>['detail']['changes'] = {};
    for (const key of ['mutation', 'nutrients', 'climate'] as const)
      if (next[key] !== this.settings[key])
        changes[key] = { before: this.settings[key], after: next[key] };
    if (!Object.keys(changes).length) return null;
    this.requireInterventionCapacity();
    this.settings = next;
    return this.appendIntervention({ kind: 'settings', detail: { changes } });
  }
  changeRefugeMode(enabled: boolean): number | null {
    if (typeof enabled !== 'boolean') throw new Error('Invalid painted temperature mode.');
    const before = this.thermalRefuges.enabled;
    if (before === enabled) return null;
    this.requireInterventionCapacity();
    const sequence = this.appendIntervention({
      kind: 'refuge-mode',
      detail: { rulesVersion: 1, before, after: enabled },
    });
    this.thermalRefuges.enabled = enabled;
    return sequence;
  }
  paintRefuge(brush: RefugeBrush, x: number, y: number, sequence: number | null = null) {
    const candidate = refugeDab(this.thermalRefuges, brush, x, y);
    if (!candidate.changedBrushCells)
      return {
        rowSequence: null,
        changedBrushCells: 0,
        nonzeroCells: this.thermalRefuges.nonzeroCells,
      };
    const latest = this.interventions.entries.at(-1),
      continuing =
        sequence !== null &&
        latest?.sequence === sequence &&
        latest.kind === 'refuge-paint' &&
        latest.detail.tool === brush.tool &&
        latest.detail.units === brush.units &&
        latest.detail.radius === brush.radius;
    this.requireInterventionCapacity(continuing);
    let rowSequence: number;
    if (continuing) {
      if (latest.detail.successfulCommands === STROKE_COMMAND_CAPACITY)
        throw new Error('Painted temperature stroke exhausted.');
      latest.lastTick = this.tick;
      latest.detail.last = { x, y };
      latest.detail.successfulCommands++;
      latest.detail.changedBrushCells += candidate.changedBrushCells;
      rowSequence = sequence;
    } else
      rowSequence = this.appendIntervention({
        kind: 'refuge-paint',
        detail: {
          ...brush,
          first: { x, y },
          last: { x, y },
          successfulCommands: 1,
          changedBrushCells: candidate.changedBrushCells,
        },
      });
    for (const [position, units] of candidate.changes) this.thermalRefuges.units[position] = units;
    this.thermalRefuges.nonzeroCells = candidate.nonzeroCells;
    return {
      rowSequence,
      changedBrushCells: candidate.changedBrushCells,
      nonzeroCells: candidate.nonzeroCells,
    };
  }
  clearRefuges() {
    const removedCells = this.thermalRefuges.nonzeroCells;
    if (!removedCells) return { rowSequence: null, removedCells: 0, nonzeroCells: 0 };
    this.requireInterventionCapacity();
    const rowSequence = this.appendIntervention({
      kind: 'refuge-clear',
      detail: { rulesVersion: 1, removedCells },
    });
    this.thermalRefuges.units.fill(0);
    this.thermalRefuges.nonzeroCells = 0;
    return { rowSequence, removedCells, nonzeroCells: 0 };
  }
  changeShadeMode(enabled: boolean): number | null {
    if (typeof enabled !== 'boolean') throw new Error('Invalid painted shade mode.');
    const before = this.shadeHabitats.enabled;
    if (before === enabled) return null;
    this.requireInterventionCapacity();
    const sequence = this.appendIntervention({
      kind: 'shade-mode',
      detail: { rulesVersion: 1, before, after: enabled },
    });
    this.shadeHabitats.enabled = enabled;
    return sequence;
  }
  paintShade(brush: ShadeBrush, x: number, y: number, sequence: number | null = null) {
    const latest = this.interventions.entries.at(-1);
    if (
      sequence !== null &&
      (latest?.sequence !== sequence ||
        latest.kind !== 'shade-paint' ||
        latest.detail.rulesVersion !== brush.rulesVersion ||
        latest.detail.tool !== brush.tool ||
        latest.detail.units !== brush.units ||
        latest.detail.radius !== brush.radius)
    )
      throw new Error('Invalid painted shade stroke continuation.');
    const candidate = shadeDab(this.shadeHabitats, brush, x, y);
    if (!candidate.changedBrushCells)
      return {
        rowSequence: null,
        changedBrushCells: 0,
        nonzeroCells: this.shadeHabitats.nonzeroCells,
      };
    const continuing = sequence !== null && latest?.kind === 'shade-paint';
    this.requireInterventionCapacity(continuing);
    let rowSequence: number;
    if (continuing) {
      if (latest.detail.successfulCommands === STROKE_COMMAND_CAPACITY)
        throw new Error('Painted shade stroke exhausted.');
      latest.lastTick = this.tick;
      latest.detail.last = { x, y };
      latest.detail.successfulCommands++;
      latest.detail.changedBrushCells += candidate.changedBrushCells;
      rowSequence = sequence;
    } else
      rowSequence = this.appendIntervention({
        kind: 'shade-paint',
        detail: {
          rulesVersion: 1,
          tool: brush.tool,
          units: brush.units,
          radius: brush.radius,
          first: { x, y },
          last: { x, y },
          successfulCommands: 1,
          changedBrushCells: candidate.changedBrushCells,
        },
      });
    for (const [position, units] of candidate.changes) this.shadeHabitats.units[position] = units;
    this.shadeHabitats.nonzeroCells = candidate.nonzeroCells;
    return {
      rowSequence,
      changedBrushCells: candidate.changedBrushCells,
      nonzeroCells: candidate.nonzeroCells,
    };
  }
  clearShade() {
    const removedCells = this.shadeHabitats.nonzeroCells;
    if (!removedCells) return { rowSequence: null, removedCells: 0, nonzeroCells: 0 };
    this.requireInterventionCapacity();
    const rowSequence = this.appendIntervention({
      kind: 'shade-clear',
      detail: { rulesVersion: 1, removedCells },
    });
    this.shadeHabitats.units.fill(0);
    this.shadeHabitats.nonzeroCells = 0;
    return { rowSequence, removedCells, nonzeroCells: 0 };
  }
  measurements(openStrokeSequence: number | null = null): MeasurementSource {
    return {
      snapshot: {
        mutationPolicy: structuredClone(this.mutationPolicy),
        worldVersion: WORLD_VERSION,
        terrain: { ...this.terrain },
        thermalRefuges: refugeSummary(this.thermalRefuges),
        shadeHabitats: shadeSummary(this.shadeHabitats),
        completedTick: this.tick,
        seed: this.settings.seed,
        settings: knownSettings(this.settings),
        event: { offset: this.eventOffset, until: this.eventUntil },
        openStrokeSequence,
      },
      telemetry: this.telemetrySnapshot(),
      interventions: structuredClone(this.interventions),
    };
  }
  private seed(): void {
    this.walls.set(generateTerrain(this.terrain, this.settings.seed));
    this.random.state = (this.settings.seed + Math.imul(14, 0x6d2b79f5)) | 0;
    const genome = founder(0),
      x = WIDTH / 2,
      y = HEIGHT / 2;
    for (const position of positions({ genome, x, y, rotation: 0 })) this.walls[position] = 0;
    this.insert(genome, x, y, 1, undefined, 0, { kind: 'founder' });
  }
  changeTerrain(
    action: 'clear' | 'regenerate',
    recipe: TerrainRecipe = this.terrain,
  ): { detail: TerrainDetail; rowSequence: number | null } {
    if (!['clear', 'regenerate'].includes(action) || !validTerrain(recipe))
      throw new Error('Invalid wall action or recipe.');
    const walls =
      action === 'clear'
        ? new Uint8Array(WIDTH * HEIGHT)
        : generateTerrain(recipe, this.settings.seed);
    const detail: TerrainDetail = {
      action,
      before: { ...this.terrain },
      after: { ...(action === 'clear' ? this.terrain : recipe) },
      addedWalls: 0,
      removedWalls: 0,
      removedFood: 0,
      protectedCells: 0,
    };
    for (let cell = 0; cell < walls.length; cell++) {
      if (walls[cell] && this.occupied[cell]) {
        walls[cell] = 0;
        detail.protectedCells++;
      }
      if (walls[cell] && !this.walls[cell]) detail.addedWalls++;
      if (!walls[cell] && this.walls[cell]) detail.removedWalls++;
      if (walls[cell] && this.food[cell]) detail.removedFood++;
    }
    if (
      !detail.addedWalls &&
      !detail.removedWalls &&
      !detail.removedFood &&
      sameTerrain(detail.before, detail.after)
    )
      return { detail, rowSequence: null };
    this.requireInterventionCapacity();
    const rowSequence = this.appendIntervention({ kind: 'terrain', detail });
    this.walls.set(walls);
    if (action === 'regenerate')
      for (let cell = 0; cell < walls.length; cell++) if (walls[cell]) this.food[cell] = 0;
    this.terrain = { ...detail.after };
    return { detail, rowSequence };
  }
  canPlace(o: Pick<Organism, 'x' | 'y' | 'rotation' | 'genome'>, ignore = 0): boolean {
    return positions(o).every(
      (i) => !this.walls[i] && (!this.occupied[i] || this.occupied[i] === ignore),
    );
  }
  spawn(
    genome: Genome,
    x: number,
    y: number,
    species?: number,
    parent?: Organism,
    rotation = 0,
  ): Organism | undefined {
    const allocated = species === undefined;
    if (allocated) species = this.nextSpecies++;
    if (parent) {
      if (this.organisms.get(parent.id) !== parent) return;
      if (!allocated && (species !== parent.species || !sameInherited(genome, parent.genome)))
        return;
    } else if (
      !allocated &&
      ![...this.organisms.values()].some(
        (organism) => organism.species === species && sameInherited(genome, organism.genome),
      )
    )
      return;
    return this.insert(
      genome,
      x,
      y,
      species!,
      parent,
      rotation,
      allocated
        ? parent
          ? { kind: 'mutation', parentId: parent.species }
          : { kind: 'manual' }
        : { kind: 'clone' },
    );
  }
  private insert(
    genome: Genome,
    x: number,
    y: number,
    species: number,
    parent: Organism | undefined,
    rotation: number,
    transition: LineageTransition,
    ecological = false,
  ): Organism | undefined {
    if (this.organisms.size >= LIMIT) return;
    const o: Organism = {
      id: this.nextId,
      species,
      x: (x + WIDTH) % WIDTH,
      y: (y + HEIGHT) % HEIGHT,
      rotation,
      direction: this.random.int(4),
      age: 0,
      energy: 8 + genome.cells.length,
      generation: parent ? parent.generation + 1 : 0,
      children: 0,
      ancestry: parent
        ? parent.species === species
          ? [...parent.ancestry]
          : [...parent.ancestry, parent.species].slice(-8)
        : [],
      genome: ecological ? genome : cloneGenome(genome),
    };
    if (!this.canPlace(o)) return;
    // Ecological inputs are existing validated genomes or their bounded mutation.
    // Read-only occupancy checks need no copy; admitted offspring own a full one.
    if (ecological) o.genome = structuredClone(genome);
    this.nextId++;
    this.organisms.set(o.id, o);
    for (const i of positions(o)) {
      this.occupied[i] = o.id;
      this.food[i] = 0;
    }
    if (this.lineageRecording)
      this.lineage.birth(
        o,
        this.tick,
        transition.kind,
        transition.kind === 'mutation' ? transition.parentId : null,
      );
    return o;
  }
  kill(o: Organism, cause: DeathCause): void {
    for (const i of positions(o)) {
      this.occupied[i] = 0;
      this.food[i] = 1;
    }
    const removed = this.organisms.delete(o.id);
    if (o.id === this.perceptionId) this.selectPerception(0);
    this.deaths++;
    this.lastDeath = { tick: this.tick, cause };
    if (this.recording) this.telemetry.pending.deaths[cause]++;
    if (removed && this.lineageRecording) this.lineage.death(o, this.tick);
  }
  move(o: Organism, dx: number, dy: number, rotation = o.rotation): boolean {
    const target = {
      ...o,
      x: (o.x + dx + WIDTH) % WIDTH,
      y: (o.y + dy + HEIGHT) % HEIGHT,
      rotation,
    };
    if (!this.canPlace(target, o.id)) return false;
    for (const i of positions(o)) this.occupied[i] = 0;
    Object.assign(o, { x: target.x, y: target.y, rotation });
    for (const i of positions(o)) {
      this.occupied[i] = o.id;
      this.food[i] = 0;
    }
    return true;
  }
  step(): void {
    this.tick++;
    const daylight = 0.65 + 0.35 * Math.sin(this.tick / 180),
      shadeUnits = this.shadeHabitats.enabled ? this.shadeHabitats.units : null;
    for (const o of [...this.organisms.values()]) {
      if (!this.organisms.has(o.id)) continue;
      o.age++;
      const temp = localTemperature(
        o.x,
        o.y,
        this.tick,
        this.settings.climate,
        this.tick < this.eventUntil ? this.eventOffset : 0,
        this.thermalRefuges,
      );
      const stress = Math.max(0, Math.abs(temp - o.genome.preference) - o.genome.tolerance);
      const upkeep = 0.012 + Math.max(0, o.genome.tolerance - 0.2) * 0.025;
      let before = o.energy;
      o.energy -= (upkeep + stress * 0.2) * o.genome.cells.length;
      this.recordEnergy('upkeepSpent', before - o.energy);
      this.recordEnergy(
        'climateUpkeepSpent',
        (Math.max(0, o.genome.tolerance - 0.2) * 0.025 + stress * 0.2) * o.genome.cells.length,
      );
      for (const cell of o.genome.cells) {
        const type = cell.type;
        if (type === 4) {
          before = o.energy;
          const activeUnits = shadeUnits ? shadeUnits[metabolicPosition(o, cell)] : 0;
          if (activeUnits === 0) o.energy += 0.04 * daylight * (1 - stress);
          else o.energy += 0.04 * daylight * (1 - stress) * ((16 - activeUnits) / 16);
          this.recordEnergy('leavesGained', o.energy - before);
          const foodChance =
            activeUnits === 0
              ? (this.settings.nutrients / 100) * daylight * (1 - stress)
              : (this.settings.nutrients / 100) *
                daylight *
                (1 - stress) *
                ((16 - activeUnits) / 16);
          if (this.random.next() < foodChance) {
            const p = metabolicPosition(o, cell),
              [dx, dy] = DIRECTIONS[this.random.int(4)],
              n = index((p % WIDTH) + dx, Math.floor(p / WIDTH) + dy);
            if (!this.occupied[n] && !this.walls[n]) this.food[n] = 1;
          }
        }
        if (type === 3 || type === 6) {
          const p = metabolicPosition(o, cell),
            x = p % WIDTH,
            y = Math.floor(p / WIDTH);
          for (const [dx, dy] of DIRECTIONS) {
            const n = index(x + dx, y + dy);
            if (type === 3 && this.food[n]) {
              this.food[n] = 0;
              before = o.energy;
              o.energy += 2.2;
              this.recordEnergy('mouthsGained', o.energy - before);
            }
            const victim = this.organisms.get(this.occupied[n]);
            if (type === 6 && victim && victim.id !== o.id && o.age % 4 === 0) {
              const cell = positions(victim).indexOf(n);
              if (victim.genome.cells[cell].type !== 7) {
                const victimBefore = victim.energy;
                victim.energy -= 2.5;
                this.recordEnergy('stingsDrained', victimBefore - victim.energy);
                before = o.energy;
                o.energy += 0.65;
                this.recordEnergy('stingsGained', o.energy - before);
              }
            }
          }
        }
      }
      if (o.genome.cells.some((c) => c.type === 5) && o.age % o.genome.tempo === 0) {
        let perception: Perception | undefined;
        if (o.genome.cells.some((c) => c.type === 8)) {
          if (o.genome.behavior.version === 2) {
            if (o.id === this.perceptionId)
              perception = {
                id: o.id,
                tick: this.tick,
                rays: [],
                chosenEye: null,
                direction: o.direction,
                moved: false,
                finalDirection: o.direction,
                finalRotation: o.rotation,
              };
            o.direction = sensoryDirection(o, this, perception);
            if (perception) perception.direction = o.direction;
          } else {
            let best = -Infinity,
              direction = o.direction;
            for (let d = 0; d < 4; d++) {
              const [dx, dy] = DIRECTIONS[d];
              let score = this.random.next() * 0.3;
              for (let r = 1; r <= 5; r++) {
                const p = index(o.x + dx * r, o.y + dy * r);
                score += this.food[p] / r;
                if (this.walls[p]) score -= 1 / r;
                const seen = this.organisms.get(this.occupied[p]);
                if (seen && seen.id !== o.id)
                  score += (o.genome.cells.some((c) => c.type === 6) ? 0.3 : -0.25) / r;
              }
              if (score > best) {
                best = score;
                direction = d;
              }
            }
            o.direction = direction;
          }
        } else if (this.random.next() < 0.12) o.direction = this.random.int(4);
        const [dx, dy] = DIRECTIONS[o.direction];
        const moved = this.move(o, dx, dy);
        if (!moved) {
          o.direction = this.random.int(4);
          this.move(o, 0, 0, (o.rotation + 1) % 4);
        }
        if (perception) {
          perception.moved = moved;
          perception.finalDirection = o.direction;
          perception.finalRotation = o.rotation;
          this.lastPerception = perception;
        }
        before = o.energy;
        o.energy -= 0.03;
        this.recordEnergy('movementSpent', before - o.energy);
      }
      if (o.energy <= 0 || o.age > 900 + o.genome.cells.length * 75) {
        this.kill(o, o.energy <= 0 ? 'energy' : 'age');
        continue;
      }
      if (
        o.age > 30 &&
        o.age % 11 === 0 &&
        o.energy > o.genome.cells.length * 3 + 9 &&
        this.organisms.size < LIMIT
      ) {
        const attempted =
          this.random.next() <
          (o.genome.mutationPropensity === undefined
            ? this.settings.mutation
            : this.settings.mutation * o.genome.mutationPropensity);
        const channels: AttemptChannel[] = [];
        const observe = this.lineageRecording
          ? (channel: string) => channels.push(channel as AttemptChannel)
          : undefined;
        let genome = attempted
          ? mutateWithPolicy(o.genome, this.random, this.mutationPolicy, observe)
          : o.genome;
        const inherited = mutatePropensity(genome, this.random, observe);
        const changed =
          !Object.is(inherited.mutationPropensity, o.genome.mutationPropensity) ||
          (attempted &&
            (this.mutationPolicy.mode === 'legacy' || !sameInherited(genome, o.genome)));
        genome = inherited;
        let born: Organism | undefined;
        let placementAttempts = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          placementAttempts++;
          const [dx, dy] = DIRECTIONS[this.random.int(4)],
            distance = 3 + this.random.int(5);
          const child = this.insert(
            genome,
            o.x + dx * distance,
            o.y + dy * distance,
            changed ? this.nextSpecies : o.species,
            o,
            this.random.int(4),
            changed ? { kind: 'mutation', parentId: o.species } : { kind: 'clone' },
            true,
          );
          if (child) {
            born = child;
            if (changed) this.nextSpecies++;
            child.energy = genome.cells.length * 1.5 + 3;
            before = o.energy;
            o.energy -= child.energy + 2;
            this.recordEnergy('reproductionSpent', before - o.energy);
            this.recordEnergy('offspringGranted', child.energy);
            o.children++;
            this.births++;
            if (this.recording) this.telemetry.pending.births++;
            break;
          }
        }
        if (this.lineageRecording)
          this.lineage.reproduction({
            id: o.species,
            tick: this.tick,
            parentOrganismId: o.id,
            parentGenome: o.genome,
            gate: attempted,
            channels,
            placementAttempts,
            childOrganismId: born?.id ?? null,
            childLineageId: born?.species ?? null,
            childGenome: born?.genome ?? null,
          });
      }
    }
    this.observe();
  }
  paint(tool: Tool, x: number, y: number, radius: number, genome: Genome): PaintOutcome {
    if (tool === 'plant') {
      const placed = this.spawn(genome, x, y);
      return {
        changedBrushCells: 0,
        removedOrganisms: 0,
        placement: placed
          ? {
              x: placed.x,
              y: placed.y,
              organismId: placed.id,
              speciesId: placed.species,
              bodyCells: placed.genome.cells.length,
              preference: placed.genome.preference,
              tolerance: placed.genome.tolerance,
              tempo: placed.genome.tempo,
            }
          : null,
      };
    }
    const before: [number, number, number][] = [];
    for (let vertical = -radius; vertical <= radius; vertical++)
      for (let horizontal = -radius; horizontal <= radius; horizontal++)
        if (horizontal * horizontal + vertical * vertical <= radius * radius) {
          const position = index(x + horizontal, y + vertical);
          before.push([position, this.food[position], this.walls[position]]);
        }
    const victims = new Set<number>();
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++)
        if (dx * dx + dy * dy <= radius * radius) {
          const p = index(x + dx, y + dy);
          if (tool === 'erase') {
            if (this.occupied[p]) victims.add(this.occupied[p]);
            this.food[p] = 0;
            this.walls[p] = 0;
          }
          if (tool === 'food' && !this.walls[p] && !this.occupied[p]) this.food[p] = 1;
          if (tool === 'wall' && !this.occupied[p]) {
            this.walls[p] = 1;
            this.food[p] = 0;
          }
        }
    for (const id of victims) {
      this.kill(this.organisms.get(id)!, 'manual');
    }
    if (tool === 'erase')
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++)
          if (dx * dx + dy * dy <= radius * radius) this.food[index(x + dx, y + dy)] = 0;
    return {
      placement: null,
      removedOrganisms: victims.size,
      changedBrushCells: before.filter(
        ([position, food, wall]) => this.food[position] !== food || this.walls[position] !== wall,
      ).length,
    };
  }
  shock(kind: 'cold' | 'heat'): void {
    this.eventOffset = kind === 'cold' ? -0.32 : 0.32;
    this.eventUntil = this.tick + 900;
  }
  presentation(selected = 0, includeLineage = false): WorldPresentation {
    const species = new Map<number, Species>();
    const memberships = new Map<number, number[]>();
    let generation = 0,
      food = 0;
    for (let i = 0; i < this.food.length; i++) {
      if (this.food[i]) food++;
    }
    for (const o of this.organisms.values()) {
      const s = species.get(o.species);
      if (s) {
        s.count++;
        s.generation = Math.max(s.generation, o.generation);
      } else
        species.set(o.species, {
          id: o.species,
          count: 1,
          generation: o.generation,
          genome: o.genome,
          name: speciesName(o.genome),
        });
      if (includeLineage) {
        const ids = memberships.get(o.species);
        if (ids) ids.push(o.id);
        else memberships.set(o.species, [o.id]);
      }
      generation = Math.max(generation, o.generation);
    }
    const organism = this.organisms.get(selected);
    const offset = this.tick < this.eventUntil ? this.eventOffset : 0;
    let lineage: WorldPresentation['lineage'];
    if (includeLineage) {
      const archive = this.lineageSnapshot();
      for (const summary of archive.summaries)
        if (summary.foundingGenome) summary.foundingGenome = observedGenome(summary.foundingGenome);
      lineage = {
        archive,
        current: [...species.values()].map((row) => ({
          ...row,
          organismIds: memberships.get(row.id)!,
          genome: observedGenome(row.genome),
        })),
      };
    }
    return {
      ...(lineage ? { lineage } : {}),
      ...(organism ? { selectedBaseline: this.lineage.baseline(organism.species) } : {}),
      terrain: { ...this.terrain },
      thermalRefuges: refugeSummary(this.thermalRefuges),
      shadeHabitats: shadeSummary(this.shadeHabitats),
      mutationPolicy: structuredClone(this.mutationPolicy),
      selectedLeafLight: selectedLeafLight(this.shadeHabitats, organism ?? null),
      anchorTemperature: organism
        ? localTemperature(
            organism.x,
            organism.y,
            this.tick,
            this.settings.climate,
            offset,
            this.thermalRefuges,
          )
        : null,
      anchorRefugeUnits: organism
        ? activeRefugeUnits(this.thermalRefuges, organism.x, organism.y)
        : 0,
      offset,
      climate: this.settings.climate,
      stats: {
        tick: this.tick,
        population: this.organisms.size,
        species: species.size,
        births: this.births,
        deaths: this.deaths,
        generation,
        food,
        season: ['Vernal drift', 'Warm season', 'Cooling drift', 'Cold season'][
          Math.floor(this.tick / 900) % 4
        ],
        event:
          this.tick < this.eventUntil
            ? `${this.eventOffset < 0 ? 'Cold snap' : 'Heatwave'} · ${this.eventUntil - this.tick} ticks`
            : 'Drifting climate',
        top: [...species.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
          .map((row) => ({
            ...row,
            genome: observedGenome(row.genome),
          })),
      },
    };
  }
  interventionSnapshot(): InterventionState {
    return structuredClone(this.interventions);
  }
  display(
    presentation: Pick<Frame, 'stats' | 'climate' | 'offset'>,
  ): Omit<Frame, 'telemetry' | 'interventions'> {
    const cells = new Uint8Array(this.food.length),
      ids = this.occupied.slice();
    for (let position = 0; position < cells.length; position++)
      cells[position] = this.walls[position] ? 2 : this.food[position] ? 1 : 0;
    for (const organism of this.organisms.values())
      positions(organism).forEach((position, cell) => {
        cells[position] = organism.genome.cells[cell].type;
      });
    return {
      cells,
      ids,
      stats: presentation.stats,
      climate: presentation.climate,
      offset: presentation.offset,
      terrain: { ...this.terrain },
      thermalRefuges: {
        version: 1,
        enabled: this.thermalRefuges.enabled,
        units: this.thermalRefuges.units.slice(),
      },
      shadeHabitats: {
        version: 1,
        enabled: this.shadeHabitats.enabled,
        units: this.shadeHabitats.units.slice(),
      },
    };
  }
  frame(): Frame {
    return {
      ...this.display(this.presentation()),
      telemetry: this.telemetrySnapshot(),
      interventions: this.interventionSnapshot(),
    };
  }
  lineageSnapshot(): LineageArchiveState {
    return (
      this.lineageRecording
        ? this.lineage
        : LineageArchive.legacy(this.organisms.values(), this.tick)
    ).snapshot();
  }
  save(): WorldFile {
    const food: number[] = [],
      walls: number[] = [];
    for (let cell = 0; cell < this.food.length; cell++) {
      if (this.food[cell]) food.push(cell);
      if (this.walls[cell]) walls.push(cell);
    }
    return {
      version: WORLD_VERSION,
      mutationPolicy: structuredClone(this.mutationPolicy),
      terrain: { ...this.terrain },
      thermalRefuges: refugeFile(this.thermalRefuges),
      shadeHabitats: shadeFile(this.shadeHabitats),
      lineageArchive: this.lineageSnapshot(),
      telemetry: this.telemetrySnapshot(),
      interventions: structuredClone(this.interventions),
      settings: structuredClone(this.settings),
      random: this.random.state,
      tick: this.tick,
      births: this.births,
      deaths: this.deaths,
      nextId: this.nextId,
      nextSpecies: this.nextSpecies,
      eventUntil: this.eventUntil,
      eventOffset: this.eventOffset,
      food,
      walls,
      organisms: structuredClone([...this.organisms.values()]),
    };
  }
  static load(text: string): Ecosystem {
    if (
      text.length > WORLD_MAX_BYTES ||
      new TextEncoder().encode(text).byteLength > WORLD_MAX_BYTES
    )
      throw new Error('World file exceeds 2.5 MB.');
    const parsed: unknown = JSON.parse(text);
    const f = parsed as
      | WorldFile
      | WorldFileV14
      | WorldFileV13
      | WorldFileV12
      | WorldFileV11
      | WorldFileV10
      | WorldFileV9
      | WorldFileV8
      | WorldFileV7
      | WorldFileV6
      | WorldFileV5
      | WorldFileV4
      | WorldFileV3
      | LegacyWorldFile;
    if (
      !f ||
      typeof f !== 'object' ||
      (f.version !== 2 &&
        f.version !== 3 &&
        f.version !== 4 &&
        f.version !== 5 &&
        f.version !== 6 &&
        f.version !== 7 &&
        f.version !== 8 &&
        f.version !== 9 &&
        f.version !== 10 &&
        f.version !== 11 &&
        f.version !== 12 &&
        f.version !== 13 &&
        f.version !== 14 &&
        f.version !== WORLD_VERSION) ||
      !validSettings(f.settings) ||
      !integer(f.random, -2147483648, 4294967295) ||
      !integer(f.tick, 0, 1e9) ||
      !integer(f.births, 0, 1e9) ||
      !integer(f.deaths, 0, 1e9) ||
      !integer(f.nextId, 1, 1e9) ||
      !integer(f.nextSpecies, 1, 1e9) ||
      !integer(f.eventUntil, 0, 1e9) ||
      !finite(f.eventOffset, -0.32, 0.32) ||
      !Array.isArray(f.organisms) ||
      f.organisms.length > LIMIT
    )
      throw new Error(
        'Not a valid EvoLab ecosystem (version 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 or 15).',
      );
    if (
      (f.version === 6 ||
        f.version === 7 ||
        f.version === 8 ||
        f.version === 9 ||
        f.version === 10 ||
        f.version === 11 ||
        f.version === 12 ||
        f.version === 13 ||
        f.version === 14 ||
        f.version === WORLD_VERSION) &&
      !validTerrain(f.terrain)
    )
      throw new Error('Invalid ecosystem wall recipe.');
    const thermalRefuges =
      f.version === 7 ||
      f.version === 8 ||
      f.version === 9 ||
      f.version === 10 ||
      f.version === 11 ||
      f.version === 12 ||
      f.version === 13 ||
      f.version === 14 ||
      f.version === WORLD_VERSION
        ? parseRefuges(f.thermalRefuges)
        : emptyRefuges();
    const shadeHabitats =
      f.version === 10 ||
      f.version === 11 ||
      f.version === 12 ||
      f.version === 13 ||
      f.version === 14 ||
      f.version === WORLD_VERSION
        ? parseShade(f.shadeHabitats)
        : emptyShade();
    if (
      f.version !== 2 &&
      !validTelemetry(f.telemetry, f.tick, f.births, f.deaths, f.version === 3 ? 1 : 2)
    )
      throw new Error('Invalid ecosystem telemetry.');
    if (
      (f.version === 13 || f.version === 14 || f.version === WORLD_VERSION) &&
      !validMutationPolicy(f.mutationPolicy)
    )
      throw new Error('Invalid mutation policy.');
    if (
      (f.version === 5 ||
        f.version === 6 ||
        f.version === 7 ||
        f.version === 8 ||
        f.version === 9 ||
        f.version === 10 ||
        f.version === 11 ||
        f.version === 12 ||
        f.version === 13 ||
        f.version === 14 ||
        f.version === WORLD_VERSION) &&
      !validInterventions(f.interventions, f)
    )
      throw new Error('Invalid ecosystem manual intervention history.');
    const world = new Ecosystem(f.settings, false, {
      terrain:
        f.version === 6 ||
        f.version === 7 ||
        f.version === 8 ||
        f.version === 9 ||
        f.version === 10 ||
        f.version === 11 ||
        f.version === 12 ||
        f.version === 13 ||
        f.version === 14 ||
        f.version === WORLD_VERSION
          ? f.terrain
          : DEFAULT_TERRAIN,
    });
    world.thermalRefuges = thermalRefuges;
    world.shadeHabitats = shadeHabitats;
    world.mutationPolicy =
      f.version === 13 || f.version === 14 || f.version === WORLD_VERSION
        ? structuredClone(f.mutationPolicy)
        : legacyMutation();
    for (const [field, array] of [
      ['food', world.food],
      ['walls', world.walls],
    ] as const) {
      const values = f[field];
      if (
        !Array.isArray(values) ||
        values.length > WIDTH * HEIGHT ||
        !values.every((i) => integer(i, 0, WIDTH * HEIGHT - 1)) ||
        ((f.version === 6 ||
          f.version === 7 ||
          f.version === 8 ||
          f.version === 9 ||
          f.version === 10 ||
          f.version === 11 ||
          f.version === 12 ||
          f.version === 13 ||
          f.version === 14 ||
          f.version === WORLD_VERSION) &&
          new Set(values).size !== values.length)
      )
        throw new Error('Invalid world terrain.');
      for (const i of values) array[i] = 1;
    }
    for (const o of f.organisms) {
      if (
        !o ||
        !integer(o.id, 1, f.nextId - 1) ||
        world.organisms.has(o.id) ||
        !integer(o.species, 1, f.nextSpecies - 1) ||
        !integer(o.x, 0, WIDTH - 1) ||
        !integer(o.y, 0, HEIGHT - 1) ||
        !integer(o.rotation, 0, 3) ||
        !integer(o.direction, 0, 3) ||
        !integer(o.age, 0, 100000) ||
        !finite(o.energy, -1000, 100000) ||
        !integer(o.generation, 0, 1e9) ||
        !integer(o.children, 0, 1e9) ||
        !Array.isArray(o.ancestry) ||
        o.ancestry.length > 8 ||
        !o.ancestry.every((s) => integer(s, 1, f.nextSpecies - 1)) ||
        !(f.version === 9 ||
        f.version === 10 ||
        f.version === 11 ||
        f.version === 12 ||
        f.version === 13 ||
        f.version === 14 ||
        f.version === WORLD_VERSION
          ? validGenome(
              o.genome,
              f.version === 11 ||
                f.version === 12 ||
                f.version === 13 ||
                f.version === 14 ||
                f.version === WORLD_VERSION,
              f.version === 14 || f.version === WORLD_VERSION,
            )
          : validHistoricalGenome(o.genome))
      )
        throw new Error('Invalid or overlapping organism.');
      const organism: Organism = structuredClone({
        ...o,
        genome:
          f.version === 9 ||
          f.version === 10 ||
          f.version === 11 ||
          f.version === 12 ||
          f.version === 13 ||
          f.version === 14 ||
          f.version === WORLD_VERSION
            ? cloneGenome(o.genome as Genome)
            : migrateHistoricalGenome(o.genome as HistoricalGenome),
      });
      if (!world.canPlace(organism)) throw new Error('Invalid or overlapping organism.');
      world.organisms.set(o.id, organism);
      for (const p of positions(organism)) {
        world.occupied[p] = o.id;
        world.food[p] = 0;
      }
    }
    for (let i = 0; i < world.food.length; i++) if (world.walls[i]) world.food[i] = 0;
    Object.assign(world, {
      tick: f.tick,
      births: f.births,
      deaths: f.deaths,
      nextId: f.nextId,
      nextSpecies: f.nextSpecies,
      eventUntil: f.eventUntil,
      eventOffset: f.eventOffset,
    });
    world.random.state = f.random;
    world.interventions =
      f.version === 5 ||
      f.version === 6 ||
      f.version === 7 ||
      f.version === 8 ||
      f.version === 9 ||
      f.version === 10 ||
      f.version === 11 ||
      f.version === 12 ||
      f.version === 13 ||
      f.version === 14 ||
      f.version === WORLD_VERSION
        ? { ...structuredClone(f.interventions), version: 5 }
        : emptyInterventions(f.settings, f.tick, true);
    world.telemetry =
      f.version === 2
        ? emptyTelemetry(f.tick)
        : f.version === 3
          ? {
              ...structuredClone(f.telemetry),
              version: 2,
              adaptationOriginTick: f.tick,
              samples: f.telemetry.samples.map((sample) => ({
                ...structuredClone(sample),
                adaptation: null,
              })),
            }
          : structuredClone(f.telemetry);
    world.lineage =
      f.version === 9 ||
      f.version === 10 ||
      f.version === 11 ||
      f.version === 12 ||
      f.version === 13 ||
      f.version === 14 ||
      f.version === WORLD_VERSION ||
      f.version === 8
        ? LineageArchive.load(
            f.lineageArchive,
            world.organisms.values(),
            f.tick,
            f.nextSpecies,
            f.version === 8,
            f.version === 11 ||
              f.version === 12 ||
              f.version === 13 ||
              f.version === 14 ||
              f.version === WORLD_VERSION,
            f.version === 14 || f.version === WORLD_VERSION,
            f.version === WORLD_VERSION,
            f.nextId,
          )
        : LineageArchive.legacy(world.organisms.values(), f.tick);
    return world;
  }
}
