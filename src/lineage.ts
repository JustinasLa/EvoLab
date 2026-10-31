import {
  LIMIT,
  LINEAGE_SUMMARY_CAPACITY,
  LINEAGE_EVENT_CAPACITY,
  integer,
  validGenome,
  validHistoricalGenome,
  migrateHistoricalGenome,
  type HistoricalGenome,
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
  // Insertion or archive validation already established the complete contract.
  return structuredClone(genome);
}
export function sameInherited(first: Genome, second: Genome): boolean {
  return (
    first.behavior.mode === second.behavior.mode &&
    (first.behavior.mode !== 'evolved' ||
      second.behavior.mode !== 'evolved' ||
      (first.behavior.reactions.food === second.behavior.reactions.food &&
        first.behavior.reactions.wall === second.behavior.reactions.wall &&
        first.behavior.reactions.harmless === second.behavior.reactions.harmless &&
        first.behavior.reactions.dangerous === second.behavior.reactions.dangerous)) &&
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
    historical = false,
  ): LineageArchive {
    const state = validateArchive(value, organisms, tick, nextSpecies, historical);
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
interface Transition {
  tick: number;
  position: number;
}
function validateArchive(
  value: unknown,
  organisms: Iterable<Organism>,
  tick: number,
  nextSpecies: number,
  historical: boolean,
): LineageArchiveState {
  requireArchive(exact(value, archiveKeys));
  const state = structuredClone(value) as unknown as LineageArchiveState;
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
          (historical
            ? exact(row.foundingGenome, ['cells', 'preference', 'tolerance', 'tempo']) &&
              validHistoricalGenome(row.foundingGenome) &&
              row.foundingGenome.cells.every((cell) => exact(cell, ['x', 'y', 'type']))
            : validGenome(row.foundingGenome)),
      );
      const group = physical.get(row.id);
      if (historical)
        row.foundingGenome = migrateHistoricalGenome(
          row.foundingGenome as unknown as HistoricalGenome,
        );
      if (group) requireArchive(sameInherited(group.genome, row.foundingGenome!));
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
  const transition = (entry: Facts, kind: 'created' | 'extinct'): Transition | undefined => {
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
      position: -1,
    };
  };
  const before = (first: Transition, second: Transition): boolean =>
    first.tick < second.tick ||
    (first.tick === second.tick &&
      ((first.position < 0 && first.position === second.position) ||
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
  const provenBefore = (first: Transition, second: Transition): boolean =>
    first.tick < second.tick || (first.tick === second.tick && first.position < second.position);
  const admissions = new Map<number, Transition[]>();
  for (const [id, entry] of facts) {
    const creation = transition(entry, 'created');
    if (creation) admissions.set(id, [creation]);
    else if (entry.row?.origin === 'legacy-unknown')
      admissions.set(id, [{ tick: state.originTick, position: -2 }]);
  }
  const earliestEviction = new Map<number, number>();
  const initialLineages = [...facts].filter(([, entry]) => !entry.created);
  if (
    state.originKind === 'legacy-import' &&
    !state.eventsPruned &&
    initialLineages.length <= LINEAGE_SUMMARY_CAPACITY
  )
    for (const [id] of initialLineages)
      earliestEviction.set(id, LINEAGE_SUMMARY_CAPACITY - initialLineages.length + 1);
  const retainedAtExtinction = new Set<number>();
  const presenceBound = new Map<number, number>();
  let possibleAdmissions = 0;
  for (const event of state.events) {
    if (event.kind === 'created') {
      possibleAdmissions++;
      earliestEviction.set(event.id, possibleAdmissions + LINEAGE_SUMMARY_CAPACITY);
    } else {
      const eviction = earliestEviction.get(event.id);
      if (eviction !== undefined && possibleAdmissions < eviction)
        retainedAtExtinction.add(event.id);
      else possibleAdmissions++;
    }
    presenceBound.set(event.id, possibleAdmissions);
  }
  if (state.originKind === 'fresh' && !state.eventsPruned)
    requireArchive(!state.summariesPruned || possibleAdmissions > LINEAGE_SUMMARY_CAPACITY);
  for (const [id, bound] of presenceBound)
    if (!summaries.has(id)) requireArchive(bound < possibleAdmissions);
  const extinctions = [...facts.entries()]
    .map(([id, entry]) => ({ id, extinction: transition(entry, 'extinct') }))
    .filter((entry) => entry.extinction !== undefined)
    .sort(
      (first, second) =>
        first.extinction!.tick - second.extinction!.tick ||
        first.extinction!.position - second.extinction!.position,
    );
  const readmissions = new Set<number>();
  for (const { id, extinction } of extinctions) {
    const start = admissions.get(id)?.[0] ?? {
      tick: state.eventsPruned ? state.eventsEvictedThroughTick! : state.originTick,
      position: state.eventsPruned ? -1 : -2,
    };
    let intervening = 0;
    for (const [otherId, transitions] of admissions) {
      if (otherId === id) continue;
      intervening += transitions.filter(
        (admission) => provenBefore(start, admission) && provenBefore(admission, extinction!),
      ).length;
      if (intervening >= LINEAGE_SUMMARY_CAPACITY) {
        readmissions.add(id);
        if (!admissions.has(id)) admissions.set(id, []);
        admissions.get(id)!.push(extinction!);
        break;
      }
    }
  }
  let minimumAdmission: Transition | undefined;
  for (const summary of state.summaries)
    if (
      summary.genomeStatus === 'pruned' ||
      (summary.origin === 'legacy-unknown' && summary.admittedTick !== state.originTick) ||
      readmissions.has(summary.id)
    ) {
      const start = admissions.get(summary.id)![0];
      if (!minimumAdmission || provenBefore(minimumAdmission, start)) minimumAdmission = start;
    }
  let omittedAdmission: Transition | undefined;
  for (const [id, transitions] of admissions)
    if (!summaries.has(id))
      for (const admission of transitions)
        if (
          !omittedAdmission ||
          admission.tick > omittedAdmission.tick ||
          (admission.tick === omittedAdmission.tick &&
            admission.position > omittedAdmission.position)
        )
          omittedAdmission = admission;
  let previousAdmission: Transition | undefined;
  const finalAdmissions = new Map<number, Transition>();
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
      (readmissions.has(summary.id) ||
        [previousAdmission, omittedAdmission, minimumAdmission].some(
          (admission) => admission?.tick === state.originTick && admission.position > -2,
        ));
    const admission =
      initialLegacy && !readmittedLegacy
        ? { tick: state.originTick, position: -2 }
        : transition(entry, summary.genomeStatus === 'retained' ? 'created' : 'extinct')!;
    if (summary.genomeStatus !== 'retained' && (!initialLegacy || readmittedLegacy))
      requireArchive(!retainedAtExtinction.has(summary.id));
    if (minimumAdmission) requireArchive(before(minimumAdmission, admission));
    if (readmissions.has(summary.id))
      requireArchive(
        summary.genomeStatus !== 'retained' && summary.admittedTick === summary.extinctTick,
      );
    if (previousAdmission) requireArchive(before(previousAdmission, admission));
    if (omittedAdmission) requireArchive(before(omittedAdmission, admission));
    finalAdmissions.set(summary.id, admission);
    // Keep the last provable position across intervening uncertain admissions.
    previousAdmission = admission;
  }
  for (const [id, entry] of facts) {
    const parentId = entry.row?.parentId ?? entry.created?.parentId;
    if (parentId === undefined || parentId === null) continue;
    const summary = state.summaries.find((row) => row.id === id),
      parent = state.summaries.find((row) => row.id === parentId);
    if (parent?.genomeStatus === 'retained') {
      requireArchive(summary?.genomeStatus === 'retained');
      requireArchive(state.summaries.indexOf(parent) < state.summaries.indexOf(summary));
    } else if (
      summary?.genomeStatus === 'retained' &&
      parent &&
      finalAdmissions.get(parent.id)!.position !== -2
    )
      requireArchive(state.summaries.indexOf(summary) < state.summaries.indexOf(parent));
  }
  const ambiguous = (summary: LineageSummary): boolean =>
    summary.origin === 'legacy-unknown' &&
    summary.admittedTick === state.originTick &&
    summary.extinctTick === state.originTick &&
    state.summariesPruned;
  for (const [index, summary] of state.summaries.entries()) {
    if (ambiguous(summary)) continue;
    const start = finalAdmissions.get(summary.id)!;
    const protectedIds = new Set(
      state.summaries
        .slice(0, index + 1)
        .filter((row) => !ambiguous(row))
        .map((row) => row.id),
    );
    const later = new Map<number, Transition[]>();
    for (const [id, transitions] of admissions) {
      const following = transitions.filter((admission) => provenBefore(start, admission));
      if (following.length) later.set(id, following);
    }
    for (const row of state.summaries.slice(index + 1)) {
      if (ambiguous(row)) continue;
      const admission = finalAdmissions.get(row.id)!;
      const following = later.get(row.id) ?? [];
      if (
        !following.some(
          (entry) => entry.tick === admission.tick && entry.position === admission.position,
        )
      )
        following.push(admission);
      later.set(row.id, following);
    }
    const unexplainedPresence = new Set<number>();
    for (const { id, extinction } of extinctions)
      if (provenBefore(start, extinction!) && !protectedIds.has(id) && !later.has(id))
        unexplainedPresence.add(id);
    const available = LINEAGE_SUMMARY_CAPACITY - protectedIds.size;
    const required = [...later.values()].reduce((total, entries) => total + entries.length, 0);
    requireArchive(required + Math.max(0, unexplainedPresence.size - available) <= available);
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
