export const WIDTH = 240;
export const HEIGHT = 156;
export const LIMIT = 1600;
export const TELEMETRY_INTERVAL_TICKS = 30;
export const TELEMETRY_CAPACITY = 180;
export const WORLD_MAX_BYTES = 2_500_000;
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
export const DEFAULTS: Settings = { seed: 42, mutation: 0.12, nutrients: 5, climate: 0.8 };
export type Tool = 'inspect' | 'pan' | 'food' | 'wall' | 'erase' | 'plant';
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
  cells: Uint8Array;
  ids: Int32Array;
  stats: Stats;
  climate: number;
  offset: number;
  telemetry: TelemetryState;
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
export type WorldPresentation = Pick<Frame, 'stats' | 'climate' | 'offset'>;
export type HabitatFrame = Pick<Frame, 'cells' | 'ids' | 'stats' | 'climate' | 'offset'>;
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
}
export interface AcceptedTelemetrySource extends TelemetrySnapshot {
  runId: number;
  replacementId: number;
}
export type CommandPayload =
  | { type: 'start'; settings: Settings; display: DisplayView }
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
    }
  | { type: 'shock'; kind: 'cold' | 'heat' };
export type OrdinaryCommand = CommandPayload & { runId: number; commandId: number };
export interface FlowAck {
  type: 'flow-ack';
  runId: number;
  channel: 'progress' | 'display';
  sequence: number;
}
export type WorkerCommand = OrdinaryCommand | FlowAck;
export type WorkerResponse =
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
    }
  | {
      type: 'loaded';
      runId: number;
      commandId: number;
      state: ControlState;
      telemetry: TelemetrySnapshot;
    }
  | { type: 'saved'; runId: number; commandId: number; state: ControlState; text: string }
  | {
      type: 'error';
      runId: number;
      commandId?: number;
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
export interface WorldFile {
  version: 4;
  telemetry: TelemetryState;
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
export type WorldFileV3 = Omit<WorldFile, 'version' | 'telemetry'> & {
  version: 3;
  telemetry: TelemetryStateV1;
};
export type LegacyWorldFile = Omit<WorldFile, 'version' | 'telemetry'> & { version: 2 };
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
): number {
  return clamp(
    0.5 +
      strength *
        (0.27 * Math.sin((x / WIDTH) * Math.PI * 2 - tick / 1100) +
          0.13 * Math.cos((y / HEIGHT) * Math.PI * 2) +
          0.12 * Math.sin(tick / 650)) +
      offset,
    0,
    1,
  );
}
