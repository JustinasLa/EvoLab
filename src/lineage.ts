import {
  LIMIT,
  LINEAGE_SUMMARY_CAPACITY,
  LINEAGE_EVENT_CAPACITY,
  integer,
  validGenome,
  type Genome,
  type Organism,
  type LivingLineage,
  type LineageOrigin,
  type LineageSummary,
  type LineageEvent,
  type LineageArchiveState,
} from './model';

const metadataKeys = [
  'id',
  'origin',
  'createdTick',
  'parentId',
  'liveCount',
  'peakCount',
  'peakKind',
  'extinctTick',
] as const;
const summaryKeys = [...metadataKeys, 'admittedTick', 'foundingGenome', 'genomeStatus'];
const createdKeys = ['kind', 'id', 'tick', 'origin', 'parentId'];
const extinctKeys = ['kind', 'id', 'tick'];
const archiveKeys = [
  'version',
  'originKind',
  'originTick',
  'summariesPruned',
  'eventsPruned',
  'eventsEvictedThroughTick',
  'living',
  'summaries',
  'events',
];
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function requireArchive(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid ecosystem lineage archive.');
}
function metadata(row: LivingLineage): LivingLineage {
  return {
    id: row.id,
    origin: row.origin,
    createdTick: row.createdTick,
    parentId: row.parentId,
    liveCount: row.liveCount,
    peakCount: row.peakCount,
    peakKind: row.peakKind,
    extinctTick: row.extinctTick,
  };
}
function inherited(genome: Genome): Genome {
  return {
    cells: genome.cells.map(({ x, y, type }) => ({ x, y, type })),
    preference: genome.preference,
    tolerance: genome.tolerance,
    tempo: genome.tempo,
  };
}
export function sameInherited(first: Genome, second: Genome): boolean {
  return (
    Object.is(first.preference, second.preference) &&
    Object.is(first.tolerance, second.tolerance) &&
    Object.is(first.tempo, second.tempo) &&
    first.cells.length === second.cells.length &&
    first.cells.every((cell, position) => {
      const other = second.cells[position];
      return cell.x === other.x && cell.y === other.y && cell.type === other.type;
    })
  );
}

export class LineageArchive {
  private living = new Map<number, LivingLineage>();
  private summaries = new Map<number, LineageSummary>();
  private events: LineageEvent[] = [];
  private summariesPruned = false;
  private eventsPruned = false;
  private eventsEvictedThroughTick: number | null = null;
  constructor(
    private readonly originKind: LineageArchiveState['originKind'] = 'fresh',
    private readonly originTick = 0,
  ) {}
  private admit(summary: LineageSummary): void {
    if (this.summaries.size === LINEAGE_SUMMARY_CAPACITY) {
      this.summaries.delete(this.summaries.keys().next().value!);
      this.summariesPruned = true;
    }
    this.summaries.set(summary.id, summary);
  }
  private append(event: LineageEvent): void {
    if (this.events.length === LINEAGE_EVENT_CAPACITY) {
      this.eventsEvictedThroughTick = this.events.shift()!.tick;
      this.eventsPruned = true;
    }
    this.events.push(event);
  }
  birth(
    organism: Organism,
    tick: number,
    origin: Exclude<LineageOrigin, 'legacy-unknown'> | 'clone',
    parentId: number | null,
  ): void {
    if (origin === 'clone') {
      const row = this.living.get(organism.species)!;
      row.liveCount++;
      row.peakCount = Math.max(row.peakCount, row.liveCount);
      const summary = this.summaries.get(row.id);
      if (summary) Object.assign(summary, metadata(row));
      return;
    }
    const row: LivingLineage = {
      id: organism.species,
      origin,
      createdTick: tick,
      parentId,
      liveCount: 1,
      peakCount: 1,
      peakKind: 'lifetime',
      extinctTick: null,
    };
    this.living.set(row.id, row);
    this.admit({
      ...row,
      admittedTick: tick,
      foundingGenome: inherited(organism.genome),
      genomeStatus: 'retained',
    });
    this.append({ kind: 'created', id: row.id, tick, origin, parentId });
  }
  death(organism: Organism, tick: number): void {
    const row = this.living.get(organism.species)!;
    row.liveCount--;
    if (!row.liveCount) row.extinctTick = tick;
    const summary = this.summaries.get(row.id);
    if (summary) Object.assign(summary, metadata(row));
    if (!row.liveCount) {
      if (!summary)
        this.admit({
          ...row,
          admittedTick: tick,
          foundingGenome: null,
          genomeStatus: row.origin === 'legacy-unknown' ? 'legacy-unknown' : 'pruned',
        });
      this.append({ kind: 'extinct', id: row.id, tick });
      this.living.delete(row.id);
    }
  }
  snapshot(): LineageArchiveState {
    return structuredClone({
      version: 1,
      originKind: this.originKind,
      originTick: this.originTick,
      summariesPruned: this.summariesPruned,
      eventsPruned: this.eventsPruned,
      eventsEvictedThroughTick: this.eventsEvictedThroughTick,
      living: [...this.living.values()].sort((first, second) => first.id - second.id),
      summaries: [...this.summaries.values()],
      events: this.events,
    });
  }
  static legacy(organisms: Iterable<Organism>, tick: number): LineageArchive {
    const archive = new LineageArchive('legacy-import', tick);
    for (const organism of organisms) {
      const previous = archive.living.get(organism.species);
      if (previous) {
        previous.liveCount++;
        previous.peakCount++;
      } else
        archive.living.set(organism.species, {
          id: organism.species,
          origin: 'legacy-unknown',
          createdTick: null,
          parentId: null,
          liveCount: 1,
          peakCount: 1,
          peakKind: 'since-origin',
          extinctTick: null,
        });
    }
    for (const row of archive.living.values())
      archive.admit({
        ...row,
        admittedTick: tick,
        foundingGenome: null,
        genomeStatus: 'legacy-unknown',
      });
    return archive;
  }
  static load(
    value: unknown,
    organisms: Iterable<Organism>,
    tick: number,
    nextSpecies: number,
  ): LineageArchive {
    const state = validateArchive(value, organisms, tick, nextSpecies);
    const archive = new LineageArchive(state.originKind, state.originTick);
    archive.living = new Map(state.living.map((row) => [row.id, row]));
    archive.summaries = new Map(state.summaries.map((row) => [row.id, row]));
    archive.events = state.events;
    archive.summariesPruned = state.summariesPruned;
    archive.eventsPruned = state.eventsPruned;
    archive.eventsEvictedThroughTick = state.eventsEvictedThroughTick;
    return archive;
  }
}

interface Facts {
  row?: LivingLineage;
  created?: Extract<LineageEvent, { kind: 'created' }>;
  extinct?: Extract<LineageEvent, { kind: 'extinct' }>;
  createdPosition?: number;
  extinctPosition?: number;
}
function validateArchive(
  value: unknown,
  organisms: Iterable<Organism>,
  tick: number,
  nextSpecies: number,
): LineageArchiveState {
  requireArchive(exact(value, archiveKeys));
  const state = value as unknown as LineageArchiveState;
  requireArchive(
    state.version === 1 &&
      (state.originKind === 'fresh' || state.originKind === 'legacy-import') &&
      integer(state.originTick, 0, tick) &&
      (state.originKind !== 'fresh' || state.originTick === 0) &&
      typeof state.summariesPruned === 'boolean' &&
      typeof state.eventsPruned === 'boolean' &&
      Array.isArray(state.living) &&
      state.living.length <= LIMIT &&
      Array.isArray(state.summaries) &&
      state.summaries.length <= LINEAGE_SUMMARY_CAPACITY &&
      Array.isArray(state.events) &&
      state.events.length <= LINEAGE_EVENT_CAPACITY,
  );
  const physical = new Map<number, { count: number; genome: Genome; homogeneous: boolean }>();
  for (const organism of organisms) {
    const group = physical.get(organism.species);
    if (group) {
      group.count++;
      group.homogeneous &&= sameInherited(group.genome, organism.genome);
    } else physical.set(organism.species, { count: 1, genome: organism.genome, homogeneous: true });
  }
  const facts = new Map<number, Facts>();
  const fact = (id: number): Facts => {
    if (!facts.has(id)) facts.set(id, {});
    return facts.get(id)!;
  };
  const validDate = (date: unknown): date is number => integer(date, state.originTick, tick);
  const validOrigin = (
    row: Pick<LivingLineage, 'id' | 'origin' | 'parentId' | 'createdTick'>,
  ): boolean =>
    validDate(row.createdTick) &&
    (row.origin === 'mutation'
      ? integer(row.parentId, 1, row.id - 1)
      : row.parentId === null &&
        (row.origin === 'manual' ||
          (row.origin === 'founder' &&
            row.id === 1 &&
            row.createdTick === 0 &&
            state.originKind === 'fresh')));
  const validateMetadata = (row: LivingLineage): void => {
    requireArchive(
      integer(row.id, 1, nextSpecies - 1) &&
        integer(row.liveCount, 0, LIMIT) &&
        integer(row.peakCount, Math.max(1, row.liveCount), LIMIT) &&
        (row.extinctTick === null || validDate(row.extinctTick)) &&
        (row.liveCount > 0 ? row.extinctTick === null : row.extinctTick !== null) &&
        (row.origin === 'legacy-unknown'
          ? state.originKind === 'legacy-import' &&
            row.createdTick === null &&
            row.parentId === null &&
            row.peakKind === 'since-origin'
          : validOrigin(row) &&
            row.peakKind === 'lifetime' &&
            (row.extinctTick === null || row.extinctTick >= row.createdTick!)),
    );
    const group = physical.get(row.id);
    requireArchive(row.liveCount === (group?.count ?? 0));
    if (group && row.origin !== 'legacy-unknown') requireArchive(group.homogeneous);
    const previous = fact(row.id);
    if (previous.row) requireArchive(metadataKeys.every((key) => previous.row![key] === row[key]));
    previous.row = metadata(row);
  };
  let lastId = 0;
  for (const row of state.living) {
    requireArchive(exact(row, metadataKeys));
    validateMetadata(row);
    requireArchive(row.id > lastId && row.liveCount > 0);
    lastId = row.id;
  }
  requireArchive(state.living.length === physical.size);
  const summaries = new Set<number>();
  let admitted = state.originTick;
  for (const row of state.summaries) {
    requireArchive(exact(row, summaryKeys));
    validateMetadata(row);
    requireArchive(
      !summaries.has(row.id) && validDate(row.admittedTick) && row.admittedTick >= admitted,
    );
    summaries.add(row.id);
    admitted = row.admittedTick;
    if (row.genomeStatus === 'retained') {
      requireArchive(
        row.origin !== 'legacy-unknown' &&
          row.admittedTick === row.createdTick &&
          exact(row.foundingGenome, ['cells', 'preference', 'tolerance', 'tempo']) &&
          validGenome(row.foundingGenome) &&
          row.foundingGenome.cells.every((cell) => exact(cell, ['x', 'y', 'type'])),
      );
      const group = physical.get(row.id);
      if (group) requireArchive(sameInherited(group.genome, row.foundingGenome));
    } else {
      requireArchive(row.foundingGenome === null);
      requireArchive(
        row.genomeStatus === 'legacy-unknown'
          ? row.origin === 'legacy-unknown' &&
              (row.admittedTick === state.originTick ||
                (state.summariesPruned && row.admittedTick === row.extinctTick))
          : row.genomeStatus === 'pruned' &&
              state.summariesPruned &&
              row.origin !== 'legacy-unknown' &&
              row.liveCount === 0 &&
              row.admittedTick === row.extinctTick,
      );
    }
  }
  let eventTick = state.originTick;
  for (const [position, event] of state.events.entries()) {
    requireArchive(exact(event, event?.kind === 'created' ? createdKeys : extinctKeys));
    requireArchive(
      integer(event.id, 1, nextSpecies - 1) && validDate(event.tick) && event.tick >= eventTick,
    );
    eventTick = event.tick;
    const entry = fact(event.id);
    if (event.kind === 'created') {
      requireArchive(!entry.created && validOrigin({ ...event, createdTick: event.tick }));
      entry.created = {
        kind: 'created',
        id: event.id,
        tick: event.tick,
        origin: event.origin,
        parentId: event.parentId,
      };
      entry.createdPosition = position;
    } else {
      requireArchive(event.kind === 'extinct' && !entry.extinct && !physical.has(event.id));
      entry.extinct = { kind: 'extinct', id: event.id, tick: event.tick };
      entry.extinctPosition = position;
    }
  }
  requireArchive(
    state.summariesPruned
      ? state.summaries.length === LINEAGE_SUMMARY_CAPACITY
      : [...facts.keys()].every((id) => summaries.has(id)),
  );
  requireArchive(
    state.eventsPruned
      ? state.events.length === LINEAGE_EVENT_CAPACITY &&
          integer(state.eventsEvictedThroughTick, state.originTick, state.events[0].tick)
      : state.eventsEvictedThroughTick === null,
  );
  const mustHaveEvent = (date: number): boolean =>
    !state.eventsPruned || date > state.eventsEvictedThroughTick!;
  for (const [id, entry] of facts) {
    const { row, created, extinct } = entry;
    if (row) {
      if (row.origin === 'legacy-unknown') requireArchive(!created);
      else {
        if (mustHaveEvent(row.createdTick!)) requireArchive(created);
        if (created)
          requireArchive(
            created.tick === row.createdTick &&
              created.origin === row.origin &&
              created.parentId === row.parentId,
          );
      }
      if (row.extinctTick !== null && mustHaveEvent(row.extinctTick)) requireArchive(extinct);
      if (extinct) requireArchive(extinct.tick === row.extinctTick);
    }
    if (created && !physical.has(id)) requireArchive(extinct);
    if (created && extinct) requireArchive(entry.createdPosition! < entry.extinctPosition!);
    if (extinct && state.originKind === 'fresh' && !state.eventsPruned) requireArchive(created);
  }
  const transition = (
    entry: Facts,
    kind: 'created' | 'extinct',
  ): { tick: number; position: number | null } | undefined => {
    const event = entry[kind];
    if (event)
      return {
        tick: event.tick,
        position: entry[kind === 'created' ? 'createdPosition' : 'extinctPosition']!,
      };
    const date = entry.row?.[kind === 'created' ? 'createdTick' : 'extinctTick'];
    if (date === undefined || date === null) return;
    return {
      tick: date,
      position: state.eventsPruned && date === state.eventsEvictedThroughTick ? -1 : null,
    };
  };
  const before = (
    first: { tick: number; position: number | null },
    second: { tick: number; position: number | null },
  ): boolean =>
    first.tick < second.tick ||
    (first.tick === second.tick &&
      (first.position === null ||
        second.position === null ||
        (first.position < 0 && first.position === second.position) ||
        first.position < second.position));
  for (const entry of facts.values()) {
    const origin = entry.row?.origin ?? entry.created?.origin;
    if (origin !== 'mutation') continue;
    const parentId = entry.row?.parentId ?? entry.created!.parentId!;
    const parent = facts.get(parentId!);
    if (!parent) continue;
    const childCreation = transition(entry, 'created')!;
    const parentCreation = transition(parent, 'created');
    const parentExtinction = transition(parent, 'extinct');
    if (parentCreation) requireArchive(before(parentCreation, childCreation));
    if (parentExtinction) requireArchive(before(childCreation, parentExtinction));
  }
  let previousAdmission: { tick: number; position: number | null } | undefined;
  for (const summary of state.summaries) {
    const entry = facts.get(summary.id)!;
    // Import placeholders precede all observed events, including an evicted prefix.
    // At the import tick an extinct legacy row may instead be a readmission.
    // Choose the earliest possible admission consistent with earlier summaries;
    // genuinely unknown legacy/prefix order must not become invented history.
    const initialLegacy =
      summary.origin === 'legacy-unknown' && summary.admittedTick === state.originTick;
    const readmittedLegacy =
      initialLegacy &&
      state.summariesPruned &&
      summary.extinctTick === state.originTick &&
      previousAdmission?.tick === state.originTick &&
      previousAdmission.position !== null &&
      previousAdmission.position > -2;
    const admission =
      initialLegacy && !readmittedLegacy
        ? { tick: state.originTick, position: -2 }
        : transition(entry, summary.genomeStatus === 'retained' ? 'created' : 'extinct')!;
    if (previousAdmission) requireArchive(before(previousAdmission, admission));
    // Keep the last provable position across intervening uncertain admissions.
    if (admission.position !== null) previousAdmission = admission;
  }
  return {
    version: 1,
    originKind: state.originKind,
    originTick: state.originTick,
    summariesPruned: state.summariesPruned,
    eventsPruned: state.eventsPruned,
    eventsEvictedThroughTick: state.eventsEvictedThroughTick,
    living: state.living.map(metadata),
    summaries: state.summaries.map((row) => ({
      ...metadata(row),
      admittedTick: row.admittedTick,
      foundingGenome: row.foundingGenome === null ? null : inherited(row.foundingGenome),
      genomeStatus: row.genomeStatus,
    })),
    events: state.events.map((event) => ({ ...event })),
  };
}
