import { HEIGHT, WIDTH, type DeathCause } from './model';

export const SPATIAL_VERSION = 1;
export const SPATIAL_BIN_TILES = 16;
export const SPATIAL_WINDOW_TICKS = 300;
export const SPATIAL_COMPLETED_WINDOWS = 6;
/** Counts are events; energy channels are the engine's abstract energy units. */
export const SPATIAL_CHANNELS = [
  'births',
  'starvationDeaths',
  'ageDeaths',
  'manualRemovals',
  'feedings',
  'feedingEnergy',
  'attacks',
  'attackDrained',
  'attackGained',
] as const;
export type SpatialChannel = (typeof SPATIAL_CHANNELS)[number];
export type SpatialTotals = Record<SpatialChannel, number>;
export type SpatialStartReason = 'enabled' | 'world-replaced';

const CHANNEL = Object.fromEntries(SPATIAL_CHANNELS.map((name, at) => [name, at])) as Record<
  SpatialChannel,
  number
>;
const DEATH: Record<DeathCause, SpatialChannel> = {
  energy: 'starvationDeaths',
  age: 'ageDeaths',
  manual: 'manualRemovals',
};

/**
 * Fixed memory and work bounds derived from world dimensions. Each recorded
 * event costs one bin lookup and at most three array additions; one window
 * rotation per 300 ticks clears `valuesPerWindow` numbers.
 */
export function spatialBudget(width = WIDTH, height = HEIGHT) {
  const columns = Math.ceil(width / SPATIAL_BIN_TILES),
    rows = Math.ceil(height / SPATIAL_BIN_TILES),
    bins = columns * rows,
    valuesPerWindow = bins * SPATIAL_CHANNELS.length,
    windows = SPATIAL_COMPLETED_WINDOWS + 1;
  return {
    columns,
    rows,
    bins,
    edgeColumnTiles: width - (columns - 1) * SPATIAL_BIN_TILES,
    edgeRowTiles: height - (rows - 1) * SPATIAL_BIN_TILES,
    valuesPerWindow,
    windows,
    bytes: windows * (valuesPerWindow + SPATIAL_CHANNELS.length) * Float64Array.BYTES_PER_ELEMENT,
    maxWritesPerEvent: 3,
    rotationClearsPerWindow: valuesPerWindow + SPATIAL_CHANNELS.length,
  };
}

export interface SpatialWindow {
  /** Ecological ticks fromTick + 1 .. toTick; manual removals at world ticks fromTick .. toTick - 1. */
  fromTick: number;
  toTick: number;
  throughTick: number;
  complete: boolean;
  partial: boolean;
  /** Channel-major: values[channel * bins + bin], bin = row * columns + column. */
  values: Float64Array;
  /** Running window totals, summed in event order like the telemetry ledger. */
  totals: SpatialTotals;
}
export interface SpatialSnapshot {
  version: typeof SPATIAL_VERSION;
  width: number;
  height: number;
  binTiles: typeof SPATIAL_BIN_TILES;
  columns: number;
  rows: number;
  windowTicks: typeof SPATIAL_WINDOW_TICKS;
  channels: readonly SpatialChannel[];
  coverageStartTick: number;
  startReason: SpatialStartReason;
  tick: number;
  evictedWindows: number;
  evictedThroughTick: number | null;
  /** Oldest first; the last window is the pending one. */
  windows: SpatialWindow[];
}
export type SpatialSummary = Omit<SpatialSnapshot, 'windows'> & {
  windows: (Omit<SpatialWindow, 'values'> & { activeBins: number })[];
};

interface Slot {
  fromTick: number;
  toTick: number;
  values: Float64Array;
  totals: Float64Array;
}

export class SpatialObserver {
  readonly budget: ReturnType<typeof spatialBudget>;
  private completed: Slot[] = [];
  private pending: Slot;
  private tick: number;
  private evictedWindows = 0;
  private evictedThroughTick: number | null = null;
  constructor(
    private readonly coverageStartTick: number,
    private readonly startReason: SpatialStartReason,
    private readonly width = WIDTH,
    private readonly height = HEIGHT,
  ) {
    this.budget = spatialBudget(width, height);
    this.tick = coverageStartTick;
    this.pending = this.slot(coverageStartTick);
  }
  private slot(fromTick: number, reuse?: Slot): Slot {
    const toTick = (Math.floor(fromTick / SPATIAL_WINDOW_TICKS) + 1) * SPATIAL_WINDOW_TICKS;
    if (reuse) {
      reuse.values.fill(0);
      reuse.totals.fill(0);
      return Object.assign(reuse, { fromTick, toTick });
    }
    return {
      fromTick,
      toTick,
      values: new Float64Array(this.budget.valuesPerWindow),
      totals: new Float64Array(SPATIAL_CHANNELS.length),
    };
  }
  /** Call after every completed logical tick; never on pause, render or inspection. */
  endTick(tick: number): void {
    this.tick = tick;
    if (tick < this.pending.toTick) return;
    this.completed.push(this.pending);
    const evicted =
      this.completed.length > SPATIAL_COMPLETED_WINDOWS ? this.completed.shift() : undefined;
    if (evicted) {
      this.evictedWindows++;
      this.evictedThroughTick = evicted.toTick;
    }
    this.pending = this.slot(tick, evicted);
  }
  private add(position: number, channel: SpatialChannel, amount: number): void {
    const x = position % this.width,
      y = Math.floor(position / this.width),
      bin =
        Math.floor(y / SPATIAL_BIN_TILES) * this.budget.columns + Math.floor(x / SPATIAL_BIN_TILES);
    this.pending.values[CHANNEL[channel] * this.budget.bins + bin] += amount;
    this.pending.totals[CHANNEL[channel]] += amount;
  }
  /** Successful reproductive birth at the offspring's wrapped origin cell. */
  birth(position: number): void {
    this.add(position, 'births', 1);
  }
  /** Removal at the organism's wrapped origin; manual erasure is kept separate. */
  death(position: number, cause: DeathCause): void {
    this.add(position, DEATH[cause], 1);
  }
  /** Actual food intake at the eating mouth cell. */
  feeding(position: number, energy: number): void {
    this.add(position, 'feedings', 1);
    this.add(position, 'feedingEnergy', energy);
  }
  /** Real stinger transfer at the contacted target tile. */
  attack(position: number, drained: number, gained: number): void {
    this.add(position, 'attacks', 1);
    this.add(position, 'attackDrained', drained);
    this.add(position, 'attackGained', gained);
  }
  private header(slot: Slot, complete: boolean): Omit<SpatialWindow, 'values'> {
    const throughTick = complete ? slot.toTick : this.tick;
    return {
      fromTick: slot.fromTick,
      toTick: slot.toTick,
      throughTick,
      complete,
      partial: throughTick - slot.fromTick < SPATIAL_WINDOW_TICKS,
      totals: Object.fromEntries(
        SPATIAL_CHANNELS.map((name, at) => [name, slot.totals[at]]),
      ) as SpatialTotals,
    };
  }
  private slots(): [Slot, boolean][] {
    return [...this.completed.map((slot): [Slot, boolean] => [slot, true]), [this.pending, false]];
  }
  private meta(): Omit<SpatialSnapshot, 'windows'> {
    return {
      version: SPATIAL_VERSION,
      width: this.width,
      height: this.height,
      binTiles: SPATIAL_BIN_TILES,
      columns: this.budget.columns,
      rows: this.budget.rows,
      windowTicks: SPATIAL_WINDOW_TICKS,
      channels: SPATIAL_CHANNELS,
      coverageStartTick: this.coverageStartTick,
      startReason: this.startReason,
      tick: this.tick,
      evictedWindows: this.evictedWindows,
      evictedThroughTick: this.evictedThroughTick,
    };
  }
  /** Detached copy of every retained window, including bin arrays. */
  snapshot(): SpatialSnapshot {
    return {
      ...this.meta(),
      windows: this.slots().map(([slot, complete]) => ({
        ...this.header(slot, complete),
        values: slot.values.slice(),
      })),
    };
  }
  /** Bin-free summary for the page; bins stay in the worker in this slice. */
  summary(): SpatialSummary {
    const bins = this.budget.bins;
    return {
      ...this.meta(),
      windows: this.slots().map(([slot, complete]) => {
        let activeBins = 0;
        for (let bin = 0; bin < bins; bin++)
          for (let channel = 0; channel < SPATIAL_CHANNELS.length; channel++)
            if (slot.values[channel * bins + bin] !== 0) {
              activeBins++;
              break;
            }
        return { ...this.header(slot, complete), activeBins };
      }),
    };
  }
}

/** Bin index of a wrapped world tile, for tests and later inspection slices. */
export function spatialBin(x: number, y: number, width = WIDTH): number {
  return (
    Math.floor(y / SPATIAL_BIN_TILES) * Math.ceil(width / SPATIAL_BIN_TILES) +
    Math.floor(x / SPATIAL_BIN_TILES)
  );
}
