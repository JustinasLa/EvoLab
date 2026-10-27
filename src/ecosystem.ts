import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  LIMIT,
  TELEMETRY_INTERVAL_TICKS,
  TELEMETRY_CAPACITY,
  WORLD_MAX_BYTES,
  INTERVENTION_CAPACITY,
  STROKE_COMMAND_CAPACITY,
  knownSettings,
  PREFERENCE_ENDPOINTS,
  Random,
  index,
  positions,
  founder,
  mutate,
  validGenome,
  validSettings,
  finite,
  integer,
  speciesName,
  observedGenome,
  temperature,
  type Genome,
  type Organism,
  type Settings,
  type WorldFile,
  type Frame,
  type Species,
  type Tool,
  type DeathRecord,
  type LegacyWorldFile,
  type WorldFileV3,
  type WorldFileV4,
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
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
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
    version: 1,
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
function validInterventions(value: unknown, file: WorldFile): value is InterventionState {
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
    value.version !== 1 ||
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
    previousShock: { offset: number; until: number } | undefined;
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
    if (row.kind === 'paint') {
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
      if (row.kind === 'placement') {
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
  return (
    settingsMatch(replay, file.settings) &&
    (!previousShock ||
      (previousShock.offset === file.eventOffset && previousShock.until === file.eventUntil))
  );
}
export class Ecosystem {
  random: Random;
  settings: Settings;
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
  constructor(settings: Settings = DEFAULTS, seed = true, options: { telemetry?: boolean } = {}) {
    this.recording = options.telemetry !== false;
    this.settings = { ...settings };
    this.interventions = emptyInterventions(settings);
    this.random = new Random(settings.seed);
    if (seed) this.seed();
  }
  private recordEnergy(field: keyof EnergyLedger, amount: number): void {
    if (this.recording) this.telemetry.pending.energy[field] += amount;
  }
  private observe(): void {
    if (!this.recording || this.tick % TELEMETRY_INTERVAL_TICKS !== 0) return;
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
      const local = temperature(
        organism.x,
        organism.y,
        this.tick,
        this.settings.climate,
        this.tick < this.eventUntil ? this.eventOffset : 0,
      );
      if (Math.max(0, Math.abs(local - genome.preference) - genome.tolerance) > 0)
        stressedOrganisms++;
      for (const cell of genome.cells) cellCounts[cell.type - 3]++;
    }
    const sample: TelemetrySample = {
      ...this.telemetry.pending,
      tick: this.tick,
      population: this.organisms.size,
      food: this.food.reduce((total, value) => total + (value ? 1 : 0), 0),
      cellCounts,
      meanPreference: traitMean(preference, this.organisms.size, 0, 1, view),
      meanTolerance: traitMean(tolerance, this.organisms.size, 0.12, 0.6, view),
      adaptation: { preferenceBins, stressedOrganisms },
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
  measurements(openStrokeSequence: number | null = null): MeasurementSource {
    return {
      snapshot: {
        worldVersion: 5,
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
  seed(): void {
    // Porous mineral ridges partition habitats without sealing them off.
    for (let i = 0; i < 7; i++) {
      const x = 20 + this.random.int(WIDTH - 40),
        y = 15 + this.random.int(HEIGHT - 30);
      for (let j = -9; j <= 9; j++)
        if (Math.abs(j) > 2) {
          const p = index(x + j, y + Math.round(Math.sin(j / 3) * 2));
          this.walls[p] = 1;
          this.food[p] = 0;
        }
    }
    const genome = founder(0),
      x = WIDTH / 2,
      y = HEIGHT / 2;
    for (const position of positions({ genome, x, y, rotation: 0 })) this.walls[position] = 0;
    this.spawn(genome, x, y, 1);
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
    species = this.nextSpecies++,
    parent?: Organism,
    rotation = 0,
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
      genome: structuredClone(genome),
    };
    if (!this.canPlace(o)) return;
    this.nextId++;
    this.organisms.set(o.id, o);
    for (const i of positions(o)) {
      this.occupied[i] = o.id;
      this.food[i] = 0;
    }
    return o;
  }
  kill(o: Organism, cause: DeathCause): void {
    for (const i of positions(o)) {
      this.occupied[i] = 0;
      this.food[i] = 1;
    }
    this.organisms.delete(o.id);
    this.deaths++;
    this.lastDeath = { tick: this.tick, cause };
    if (this.recording) this.telemetry.pending.deaths[cause]++;
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
    const daylight = 0.65 + 0.35 * Math.sin(this.tick / 180);
    for (const o of [...this.organisms.values()]) {
      if (!this.organisms.has(o.id)) continue;
      o.age++;
      const temp = temperature(
        o.x,
        o.y,
        this.tick,
        this.settings.climate,
        this.tick < this.eventUntil ? this.eventOffset : 0,
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
      const places = positions(o);
      for (let c = 0; c < o.genome.cells.length; c++) {
        const type = o.genome.cells[c].type,
          p = places[c],
          x = p % WIDTH,
          y = Math.floor(p / WIDTH);
        if (type === 4) {
          before = o.energy;
          o.energy += 0.04 * daylight * (1 - stress);
          this.recordEnergy('leavesGained', o.energy - before);
          if (this.random.next() < (this.settings.nutrients / 100) * daylight * (1 - stress)) {
            const [dx, dy] = DIRECTIONS[this.random.int(4)],
              n = index(x + dx, y + dy);
            if (!this.occupied[n] && !this.walls[n]) this.food[n] = 1;
          }
        }
        if (type === 3 || type === 6)
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
      if (o.genome.cells.some((c) => c.type === 5) && o.age % o.genome.tempo === 0) {
        if (o.genome.cells.some((c) => c.type === 8)) {
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
        } else if (this.random.next() < 0.12) o.direction = this.random.int(4);
        const [dx, dy] = DIRECTIONS[o.direction];
        if (!this.move(o, dx, dy)) {
          o.direction = this.random.int(4);
          this.move(o, 0, 0, (o.rotation + 1) % 4);
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
        const changed = this.random.next() < this.settings.mutation;
        const genome = changed ? mutate(o.genome, this.random) : o.genome;
        for (let attempt = 0; attempt < 3; attempt++) {
          const [dx, dy] = DIRECTIONS[this.random.int(4)],
            distance = 3 + this.random.int(5);
          const child = this.spawn(
            genome,
            o.x + dx * distance,
            o.y + dy * distance,
            changed ? this.nextSpecies : o.species,
            o,
            this.random.int(4),
          );
          if (child) {
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
  presentation(): Pick<Frame, 'stats' | 'climate' | 'offset'> {
    const species = new Map<number, Species>();
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
          genome: observedGenome(o.genome),
          name: speciesName(o.genome),
        });
      generation = Math.max(generation, o.generation);
    }
    return {
      offset: this.tick < this.eventUntil ? this.eventOffset : 0,
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
        top: [...species.values()].sort((a, b) => b.count - a.count).slice(0, 5),
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
    return { cells, ids, ...presentation };
  }
  frame(): Frame {
    return {
      ...this.display(this.presentation()),
      telemetry: this.telemetrySnapshot(),
      interventions: this.interventionSnapshot(),
    };
  }
  save(): WorldFile {
    const food: number[] = [],
      walls: number[] = [];
    for (let cell = 0; cell < this.food.length; cell++) {
      if (this.food[cell]) food.push(cell);
      if (this.walls[cell]) walls.push(cell);
    }
    return {
      version: 5,
      telemetry: this.telemetrySnapshot(),
      interventions: structuredClone(this.interventions),
      settings: { ...this.settings },
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
    const f = parsed as WorldFile | WorldFileV4 | WorldFileV3 | LegacyWorldFile;
    if (
      !f ||
      typeof f !== 'object' ||
      (f.version !== 2 && f.version !== 3 && f.version !== 4 && f.version !== 5) ||
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
      throw new Error('Not a valid EvoLab ecosystem (version 2, 3, 4 or 5).');
    if (
      f.version !== 2 &&
      !validTelemetry(f.telemetry, f.tick, f.births, f.deaths, f.version === 3 ? 1 : 2)
    )
      throw new Error('Invalid ecosystem telemetry.');
    if (f.version === 5 && !validInterventions(f.interventions, f))
      throw new Error('Invalid ecosystem manual intervention history.');
    const world = new Ecosystem(f.settings, false);
    for (const [field, array] of [
      ['food', world.food],
      ['walls', world.walls],
    ] as const) {
      const values = f[field];
      if (
        !Array.isArray(values) ||
        values.length > WIDTH * HEIGHT ||
        !values.every((i) => integer(i, 0, WIDTH * HEIGHT - 1))
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
        !validGenome(o.genome) ||
        !world.canPlace(o)
      )
        throw new Error('Invalid or overlapping organism.');
      world.organisms.set(o.id, structuredClone(o));
      for (const p of positions(o)) {
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
      f.version === 5
        ? structuredClone(f.interventions)
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
    return world;
  }
}
