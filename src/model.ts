export const WIDTH = 240;
export const HEIGHT = 156;
export const LIMIT = 1600;
export const TELEMETRY_INTERVAL_TICKS = 30;
export const TELEMETRY_CAPACITY = 180;
export const WORLD_MAX_BYTES = 2_500_000;
export const WORLD_VERSION = 8;
export const LINEAGE_SUMMARY_CAPACITY = 256;
export const LINEAGE_EVENT_CAPACITY = 512;
export const INTERVENTION_CAPACITY = 128;
export const MANUAL_CAPACITY = 32;
export const STROKE_COMMAND_CAPACITY = 4096;
export const PREFERENCE_ENDPOINTS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;
export type PreferenceBins = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export interface AdaptationObservation {
  preferenceBins: PreferenceBins;
  stressedOrganisms: number;
}
export const COLORS = [
  '#090f16',
  '#284b3b',
  '#374250',
  '#edae57',
  '#66db8b',
  '#58bce5',
  '#ed7085',
  '#a38ae4',
  '#dfebda',
];
export const CELL_NAMES = ['Mouth', 'Leaf', 'Motor', 'Stinger', 'Armor', 'Eye'];
export type CellType = 3 | 4 | 5 | 6 | 7 | 8;
export interface Cell {
  x: number;
  y: number;
  type: CellType;
}
export interface Genome {
  cells: Cell[];
  preference: number;
  tolerance: number;
  tempo: number;
}
export type LineageOrigin = 'founder' | 'mutation' | 'manual' | 'legacy-unknown';
export interface LivingLineage {
  id: number;
  origin: LineageOrigin;
  createdTick: number | null;
  parentId: number | null;
  liveCount: number;
  peakCount: number;
  peakKind: 'lifetime' | 'since-origin';
  extinctTick: number | null;
}
export interface LineageSummary extends LivingLineage {
  admittedTick: number;
  foundingGenome: Genome | null;
  genomeStatus: 'retained' | 'pruned' | 'legacy-unknown';
}
export type LineageEvent =
  | {
      kind: 'created';
      id: number;
      tick: number;
      origin: Exclude<LineageOrigin, 'legacy-unknown'>;
      parentId: number | null;
    }
  | { kind: 'extinct'; id: number; tick: number };
export interface LineageArchiveState {
  version: 1;
  originKind: 'fresh' | 'legacy-import';
  originTick: number;
  summariesPruned: boolean;
  eventsPruned: boolean;
  eventsEvictedThroughTick: number | null;
  living: LivingLineage[];
  summaries: LineageSummary[];
  events: LineageEvent[];
}
export interface Organism {
  id: number;
  species: number;
  x: number;
  y: number;
  rotation: number;
  direction: number;
  age: number;
  energy: number;
  generation: number;
  children: number;
  ancestry: number[];
  genome: Genome;
}
export interface Settings {
  seed: number;
  mutation: number;
  nutrients: number;
  climate: number;
}
export interface TerrainRecipe {
  version: 1;
  preset: 'open-field' | 'porous-ridges' | 'chambered-refuges';
  seed: number | null;
}
export const DEFAULTS: Settings = { seed: 42, mutation: 0.12, nutrients: 5, climate: 0.8 };
export type RefugeTool = 'warm' | 'cool' | 'erase-temperature';
export type Tool = 'inspect' | 'pan' | 'food' | 'wall' | 'erase' | 'plant' | RefugeTool;
export interface RefugePlane {
  version: 1;
  enabled: boolean;
  units: Int8Array;
}
export interface RefugeField extends RefugePlane {
  nonzeroCells: number;
}
export interface RefugeFile {
  version: 1;
  enabled: boolean;
  cells: [number, number][];
}
export interface RefugeSummary {
  version: 1;
  enabled: boolean;
  nonzeroCells: number;
  capacity: 4096;
  unitsPerNormalized: 100;
  minimumUnits: number;
  maximumUnits: number;
  sumUnits: number;
}
export interface RefugeBrush {
  rulesVersion: 1;
  tool: RefugeTool;
  radius: number;
  units: number;
}
export interface Species {
  id: number;
  count: number;
  generation: number;
  genome: Genome;
  name: string;
}
export interface Stats {
  tick: number;
  population: number;
  species: number;
  births: number;
  deaths: number;
  generation: number;
  food: number;
  season: string;
  event: string;
  top: Species[];
}
export interface Frame {
  terrain: TerrainRecipe;
  thermalRefuges: RefugePlane;
  cells: Uint8Array;
  ids: Int32Array;
  stats: Stats;
  climate: number;
  offset: number;
  telemetry: TelemetryState;
  interventions: InterventionState;
}
export type DeathCause = 'age' | 'energy' | 'manual';
export type TraitMean = number | null;
export interface DeathCounts {
  age: number;
  energy: number;
  manual: number;
}
export interface EnergyLedger {
  leavesGained: number;
  mouthsGained: number;
  movementSpent: number;
  upkeepSpent: number;
  climateUpkeepSpent: number;
  reproductionSpent: number;
  offspringGranted: number;
  stingsGained: number;
  stingsDrained: number;
}
export interface TelemetryFlow {
  births: number;
  deaths: DeathCounts;
  energy: EnergyLedger;
}
export interface TelemetrySampleV1 extends TelemetryFlow {
  fromTick: number;
  tick: number;
  population: number;
  food: number;
  cellCounts: [number, number, number, number, number, number];
  meanPreference: TraitMean;
  meanTolerance: TraitMean;
}
export interface TelemetrySample extends TelemetrySampleV1 {
  adaptation: AdaptationObservation | null;
}
export interface TelemetryStateV1 {
  version: 1;
  intervalTicks: 30;
  originTick: number;
  samples: TelemetrySampleV1[];
  pending: TelemetryFlow & { fromTick: number };
}
export interface TelemetryState extends Omit<TelemetryStateV1, 'version' | 'samples'> {
  version: 2;
  adaptationOriginTick: number;
  samples: TelemetrySample[];
}
export interface DeathRecord {
  tick: number;
  cause: DeathCause;
}
export type ExtinctionCause = DeathCause | 'empty-import';
export interface ExtinctionSummary {
  tick: number;
  cause: ExtinctionCause;
}
export interface PlaybackState {
  paused: boolean;
  pauseOnExtinction: boolean;
  extinction: ExtinctionSummary | null;
}
export interface RetainedWorldState {
  state: ControlState;
  telemetry: TelemetrySnapshot;
}
export type Speed = 1 | 4 | 12;
export function nextSessionId(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER)
    throw new Error('Session counter exhausted. Restart the worker.');
  return value + 1;
}
export type WorldPresentation = Pick<Frame, 'stats' | 'climate' | 'offset' | 'terrain'> & {
  thermalRefuges: RefugeSummary;
  anchorTemperature: number | null;
  anchorRefugeUnits: number;
};
export type HabitatFrame = Omit<Frame, 'telemetry' | 'interventions'>;
export interface DisplayView {
  epoch: number;
  enabled: boolean;
  visible: boolean;
}
export interface TargetRun {
  id: number;
  fromTick: number;
  targetTick: number;
  status: 'running' | 'suspended' | 'reached' | 'cancelled' | 'extinct';
  stoppedTick: number | null;
}
export interface TickRate {
  value: number | null;
  elapsedMs: number;
  completedTicks: number;
  context: 'visible' | 'hidden';
  status: 'warming' | 'measured' | 'paused' | 'timing-gap';
}
export interface ControlState {
  replacementId: number;
  revision: number;
  world: WorldPresentation;
  selected: Organism | null;
  settings: Settings;
  speed: Speed;
  playback: PlaybackState;
  target: TargetRun | null;
  display: DisplayView;
  rate: TickRate;
}
export interface TelemetrySnapshot {
  revision: number;
  tick: number;
  telemetry: TelemetryState;
  interventions: InterventionState;
}
export interface AcceptedTelemetrySource extends TelemetrySnapshot {
  runId: number;
  replacementId: number;
}
export type CommandPayload =
  | { type: 'start'; settings: Settings; display: DisplayView; terrain: TerrainRecipe }
  | { type: 'load'; text: string }
  | { type: 'pause' | 'resume' | 'step' | 'save' }
  | { type: 'snapshot'; display: boolean }
  | { type: 'run-to'; targetTick: number }
  | { type: 'cancel-target'; targetId: number }
  | { type: 'speed'; value: Speed }
  | { type: 'pause-on-extinction'; value: boolean }
  | { type: 'display-view'; view: DisplayView }
  | { type: 'settings'; settings: Partial<Pick<Settings, 'mutation' | 'nutrients' | 'climate'>> }
  | { type: 'inspect'; x: number; y: number }
  | {
      type: 'paint';
      tool: 'food' | 'wall' | 'erase' | 'plant';
      x: number;
      y: number;
      radius: number;
      genome: Genome;
      strokeId?: number;
    }
  | { type: 'clear-walls'; action: 'clear' }
  | { type: 'regenerate-walls'; action: 'regenerate'; recipe: TerrainRecipe; resolvedSeed: number }
  | ({ type: 'paint-refuge'; x: number; y: number; strokeId: number } & RefugeBrush)
  | { type: 'refuge-mode'; rulesVersion: 1; enabled: boolean }
  | { type: 'clear-refuges'; rulesVersion: 1 }
  | { type: 'shock'; kind: 'cold' | 'heat' }
  | {
      type: 'begin-stroke';
      strokeId: number;
      tool: StrokeTool;
      radius: number;
      rulesVersion?: 1;
      units?: number;
    }
  | { type: 'end-stroke'; strokeId: number }
  | { type: 'export-measurements'; format: MeasurementFormat };
export type OrdinaryCommand = CommandPayload & { runId: number; commandId: number };
export interface FlowAck {
  type: 'flow-ack';
  runId: number;
  channel: 'progress' | 'display';
  sequence: number;
}
export type WorkerCommand = OrdinaryCommand | FlowAck;
export type WorkerResponse = (
  | {
      type: 'progress';
      runId: number;
      sequence: number;
      state: ControlState;
      telemetry?: TelemetrySnapshot;
    }
  | {
      type: 'frame';
      runId: number;
      sequence: number;
      viewEpoch: number;
      state: ControlState;
      frame: HabitatFrame;
      selectedId: number;
    }
  | {
      type: 'control';
      runId: number;
      commandId: number;
      state: ControlState;
      telemetry?: TelemetrySnapshot;
      operation?: string;
    }
  | {
      type: 'loaded';
      runId: number;
      commandId: number;
      state: ControlState;
      telemetry: TelemetrySnapshot;
      operation?: string;
    }
  | {
      type: 'saved';
      operation?: 'save';
      runId: number;
      commandId: number;
      state: ControlState;
      text: string;
      completedTick: number;
      seed: number;
      byteLength: number;
    }
  | {
      type: 'measurement-exported';
      operation: 'export-measurements';
      runId: number;
      commandId: number;
      state: ControlState;
      text: string;
      format: MeasurementFormat;
      completedTick: number;
      seed: number;
      byteLength: number;
    }
  | {
      type: 'manual-result';
      operation: ManualOperation;
      runId: number;
      commandId: number;
      state: ControlState;
      telemetry?: TelemetrySnapshot;
      strokeId?: number;
      status: 'applied' | 'no-op' | 'rejected';
      completedTick: number;
      rowSequence: number | null;
    }
  | {
      type: 'error';
      runId: number;
      commandId?: number;
      operation?: string;
      format?: MeasurementFormat;
      strokeId?: number;
      code:
        | 'invalid-command'
        | 'stale-run'
        | 'invalid-target'
        | 'target-busy'
        | 'load-failed'
        | 'save-failed'
        | 'fatal';
      message: string;
      fatal?: true;
      recovery?: RetainedWorldState;
    }
) & {
  action?: string;
  recipe?: TerrainRecipe;
  resolvedSeed?: number;
  rulesVersion?: number;
  tool?: string;
  units?: number;
  radius?: number;
  x?: number;
  y?: number;
  enabled?: boolean;
  terrain?: TerrainRecipe;
  detail?: TerrainDetail;
  nonzeroCells?: number;
  changedCells?: number;
  saturatedCells?: number;
};
export type LoadFailureResponse = Extract<WorkerResponse, { type: 'error' }> & {
  recovery: RetainedWorldState;
};
export function observedGenome(genome: Genome): Genome {
  return {
    cells: genome.cells.map(({ x, y, type }) => ({ x, y, type })),
    preference: genome.preference,
    tolerance: genome.tolerance,
    tempo: genome.tempo,
  };
}
export function observedSettings(settings: Settings): Settings {
  return {
    seed: settings.seed,
    mutation: settings.mutation,
    nutrients: settings.nutrients,
    climate: settings.climate,
  };
}
export function observedOrganism(organism: Organism): Organism {
  return {
    id: organism.id,
    species: organism.species,
    x: organism.x,
    y: organism.y,
    rotation: organism.rotation,
    direction: organism.direction,
    age: organism.age,
    energy: organism.energy,
    generation: organism.generation,
    children: organism.children,
    ancestry: Array.from(organism.ancestry),
    genome: observedGenome(organism.genome),
  };
}
export interface WorldEcology {
  settings: Settings;
  random: number;
  tick: number;
  births: number;
  deaths: number;
  nextId: number;
  nextSpecies: number;
  eventUntil: number;
  eventOffset: number;
  food: number[];
  walls: number[];
  organisms: Organism[];
}
export interface WorldFile extends WorldEcology {
  version: typeof WORLD_VERSION;
  lineageArchive: LineageArchiveState;
  thermalRefuges: RefugeFile;
  terrain: TerrainRecipe;
  telemetry: TelemetryState;
  interventions: InterventionState;
}
export interface WorldFileV7 extends WorldEcology {
  version: 7;
  thermalRefuges: RefugeFile;
  terrain: TerrainRecipe;
  telemetry: TelemetryState;
  interventions: InterventionState;
}
export interface WorldFileV6 extends WorldEcology {
  version: 6;
  terrain: TerrainRecipe;
  telemetry: TelemetryState;
  interventions: InterventionStateV2;
}
export interface WorldFileV5 extends WorldEcology {
  version: 5;
  telemetry: TelemetryState;
  interventions: InterventionStateV1;
}
export type WorldFileV4 = WorldEcology & { version: 4; telemetry: TelemetryState };
export type WorldFileV3 = WorldEcology & {
  version: 3;
  telemetry: TelemetryStateV1;
};
export type LegacyWorldFile = WorldEcology & {
  version: 2;
};
export type PaintTool = 'food' | 'wall' | 'erase';
export type StrokeTool = PaintTool | RefugeTool;
export type SettingKey = 'mutation' | 'nutrients' | 'climate';
export type SettingsPatch = Partial<Pick<Settings, SettingKey>>;
export interface Coordinate {
  x: number;
  y: number;
}
export interface ClimateEvent {
  offset: number;
  until: number;
}
export interface PaintDetail {
  tool: PaintTool;
  radius: number;
  first: Coordinate;
  last: Coordinate;
  successfulCommands: number;
  changedBrushCells: number;
  removedOrganisms: number;
}
export interface PlacementDetail extends Coordinate {
  organismId: number;
  speciesId: number;
  bodyCells: number;
  preference: number;
  tolerance: number;
  tempo: number;
}
export type InterventionEffectV1 =
  | { kind: 'paint'; detail: PaintDetail }
  | { kind: 'placement'; detail: PlacementDetail }
  | {
      kind: 'settings';
      detail: { changes: Partial<Record<SettingKey, { before: number; after: number }>> };
    }
  | { kind: 'shock'; detail: { kind: 'cold' | 'heat'; before: ClimateEvent; after: ClimateEvent } };
export interface TerrainDetail {
  action: 'clear' | 'regenerate';
  before: TerrainRecipe;
  after: TerrainRecipe;
  addedWalls: number;
  removedWalls: number;
  removedFood: number;
  protectedCells: number;
}
export type InterventionEffectV2 =
  InterventionEffectV1 | { kind: 'terrain'; detail: TerrainDetail };
export interface RefugePaintDetail extends RefugeBrush {
  first: Coordinate;
  last: Coordinate;
  successfulCommands: number;
  changedBrushCells: number;
}
export type RefugeEffect =
  | { kind: 'refuge-mode'; detail: { rulesVersion: 1; before: boolean; after: boolean } }
  | { kind: 'refuge-paint'; detail: RefugePaintDetail }
  | { kind: 'refuge-clear'; detail: { rulesVersion: 1; removedCells: number } };
export type InterventionEffect = InterventionEffectV2 | RefugeEffect;
export type InterventionEntryV1 = InterventionEffectV1 & {
  sequence: number;
  origin: 'manual';
  firstTick: number;
  lastTick: number;
};
export type InterventionEntryV2 =
  | InterventionEntryV1
  | (Extract<InterventionEffectV2, { kind: 'terrain' }> & {
      sequence: number;
      origin: 'manual';
      firstTick: number;
      lastTick: number;
    });
export type InterventionEntry =
  | InterventionEntryV2
  | (RefugeEffect & {
      sequence: number;
      origin: 'manual';
      firstTick: number;
      lastTick: number;
    });
export interface InterventionStateV1 {
  version: 1;
  originTick: number;
  originKind: 'fresh' | 'legacy-import';
  originSettings: Settings;
  totalEntries: number;
  evictedThroughTick: number | null;
  prefixSettings: Settings;
  entries: InterventionEntryV1[];
}
export interface InterventionStateV2 extends Omit<InterventionStateV1, 'version' | 'entries'> {
  version: 2;
  entries: InterventionEntryV2[];
}
export interface InterventionState extends Omit<InterventionStateV1, 'version' | 'entries'> {
  version: 3;
  entries: InterventionEntry[];
}
export interface PaintOutcome {
  changedBrushCells: number;
  removedOrganisms: number;
  placement: PlacementDetail | null;
}
export interface MeasurementSource {
  snapshot: {
    worldVersion: typeof WORLD_VERSION;
    terrain: TerrainRecipe;
    thermalRefuges: RefugeSummary;
    completedTick: number;
    seed: number;
    settings: Settings;
    event: ClimateEvent;
    openStrokeSequence: number | null;
  };
  telemetry: TelemetryState;
  interventions: InterventionState;
}
export type MeasurementFormat = 'csv' | 'json';
export type ManualOperation =
  | 'begin-stroke'
  | 'paint'
  | 'settings'
  | 'shock'
  | 'end-stroke'
  | 'clear-walls'
  | 'regenerate-walls'
  | 'refuge-mode'
  | 'paint-refuge'
  | 'clear-refuges';
export type TrackedOperation = ManualOperation | 'export-measurements' | 'save' | 'start' | 'load';
export const knownSettings = ({ seed, mutation, nutrients, climate }: Settings): Settings => ({
  seed,
  mutation,
  nutrients,
  climate,
});
export const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));
export const index = (x: number, y: number): number =>
  (((y % HEIGHT) + HEIGHT) % HEIGHT) * WIDTH + (((x % WIDTH) + WIDTH) % WIDTH);
export class Random {
  constructor(public state: number) {
    this.state >>>= 0;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}
export function positions(o: Pick<Organism, 'x' | 'y' | 'rotation' | 'genome'>): number[] {
  return o.genome.cells.map((c) => {
    let x = c.x,
      y = c.y;
    for (let i = 0; i < o.rotation; i++) [x, y] = [-y, x];
    return index(o.x + x, o.y + y);
  });
}
export function connected(cells: Cell[]): boolean {
  if (!cells.length) return false;
  const seen = new Set([`${cells[0].x},${cells[0].y}`]);
  for (let pass = 0; pass < cells.length; pass++)
    for (const a of cells)
      if (seen.has(`${a.x},${a.y}`))
        for (const b of cells)
          if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) seen.add(`${b.x},${b.y}`);
  return seen.size === cells.length;
}
export function validGenome(value: unknown): value is Genome {
  if (!value || typeof value !== 'object') return false;
  const g = value as Genome;
  return (
    Array.isArray(g.cells) &&
    g.cells.length > 0 &&
    g.cells.length <= 16 &&
    g.cells.every(
      (c) =>
        c &&
        Number.isInteger(c.x) &&
        Number.isInteger(c.y) &&
        Math.abs(c.x) <= 4 &&
        Math.abs(c.y) <= 4 &&
        Number.isInteger(c.type) &&
        c.type >= 3 &&
        c.type <= 8,
    ) &&
    new Set(g.cells.map((c) => `${c.x},${c.y}`)).size === g.cells.length &&
    connected(g.cells) &&
    finite(g.preference, 0, 1) &&
    finite(g.tolerance, 0.12, 0.6) &&
    integer(g.tempo, 2, 12)
  );
}
export const finite = (v: unknown, low: number, high: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;
export const integer = (v: unknown, low: number, high: number): v is number =>
  finite(v, low, high) && Number.isInteger(v);
export function validSettings(value: unknown): value is Settings {
  if (!value || typeof value !== 'object') return false;
  const s = value as Settings;
  return (
    integer(s.seed, 0, 4294967295) &&
    finite(s.mutation, 0, 0.4) &&
    integer(s.nutrients, 0, 20) &&
    finite(s.climate, 0, 1)
  );
}
export function founder(kind: number, preference = 0.5): Genome {
  const types: CellType[][] = [
    [3, 4, 4, 4, 4],
    [3, 5, 8, 3],
    [3, 5, 6, 8, 7],
    [3, 3, 5, 7],
  ];
  const xy = [
    [0, 0],
    [-1, 0],
    [0, -1],
    [1, 0],
    [0, 1],
  ];
  return {
    cells: types[kind].map((type, i) => ({ x: xy[i][0], y: xy[i][1], type })),
    preference,
    tolerance: 0.3,
    tempo: kind === 2 ? 3 : 5,
  };
}
export function mutate(source: Genome, random: Random): Genome {
  const g = structuredClone(source);
  const mode = random.int(3);
  if (mode === 0 && g.cells.length < 16) {
    const c = g.cells[random.int(g.cells.length)];
    const [dx, dy] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ][random.int(4)];
    const next: Cell = { x: c.x + dx, y: c.y + dy, type: (3 + random.int(6)) as CellType };
    if (
      Math.abs(next.x) <= 4 &&
      Math.abs(next.y) <= 4 &&
      !g.cells.some((c) => c.x === next.x && c.y === next.y)
    )
      g.cells.push(next);
  } else if (mode === 1 && g.cells.length > 1) {
    const remove = random.int(g.cells.length);
    const rest = g.cells.filter((_, i) => i !== remove);
    if (connected(rest)) g.cells = rest;
  } else g.cells[random.int(g.cells.length)].type = (3 + random.int(6)) as CellType;
  g.preference = clamp(g.preference + (random.next() - 0.5) * 0.18, 0, 1);
  g.tolerance = clamp(g.tolerance + (random.next() - 0.5) * 0.06, 0.12, 0.6);
  g.tempo = clamp(g.tempo + random.int(3) - 1, 2, 12);
  return g;
}
export function speciesName(g: Genome): string {
  if (g.cells.some((c) => c.type === 6)) return 'Hunter';
  if (g.cells.filter((c) => c.type === 4).length >= 2) return 'Bloom';
  return g.cells.some((c) => c.type === 5) ? 'Forager' : 'Rootling';
}
export function temperature(
  x: number,
  y: number,
  tick: number,
  strength: number,
  offset = 0,
  refugeUnits = 0,
): number {
  const raw =
    0.5 +
    strength *
      (0.27 * Math.sin((x / WIDTH) * Math.PI * 2 - tick / 1100) +
        0.13 * Math.cos((y / HEIGHT) * Math.PI * 2) +
        0.12 * Math.sin(tick / 650)) +
    offset;
  return refugeUnits === 0 ? clamp(raw, 0, 1) : clamp(raw + refugeUnits / 100, 0, 1);
}

export function commandEcho(data: Record<string, any>): Record<string, unknown> {
  const keys =
    data.type === 'clear-walls'
      ? ['action']
      : data.type === 'regenerate-walls'
        ? ['action', 'recipe', 'resolvedSeed']
        : data.type === 'refuge-mode'
          ? ['rulesVersion', 'enabled']
          : data.type === 'clear-refuges'
            ? ['rulesVersion']
            : data.type === 'paint-refuge'
              ? ['rulesVersion', 'tool', 'units', 'radius', 'x', 'y']
              : data.type === 'begin-stroke' &&
                  ['warm', 'cool', 'erase-temperature'].includes(data.tool)
                ? ['rulesVersion', 'tool', 'units', 'radius']
                : [];
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]),
  );
}
