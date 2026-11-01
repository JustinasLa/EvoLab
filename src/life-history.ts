import { exactDataRecord, integer, type Genome, type Organism } from './model';

/** Explicit opt-in. Absence permanently retains the historical life-history rules. */
export interface LifeHistory {
  version: 1;
  maturity: number;
  investment: number;
  maintenance: number;
}
export const LIFE_TRAITS = ['maturity', 'investment', 'maintenance'] as const;
export const defaultLifeHistory = (): LifeHistory => ({
  version: 1,
  maturity: 1,
  investment: 1,
  maintenance: 0,
});
export function validLifeHistory(value: unknown): value is LifeHistory {
  return (
    exactDataRecord(value, ['version', ...LIFE_TRAITS]) &&
    value.version === 1 &&
    LIFE_TRAITS.every((key) => integer(value[key], 0, 2))
  );
}
export function sameLifeHistory(a?: LifeHistory, b?: LifeHistory): boolean {
  return a === undefined || b === undefined
    ? a === b
    : LIFE_TRAITS.every((key) => a[key] === b[key]);
}

/** Costs are paid by the parent using its strategy, even when the child mutates. */
export function lifeRules(genome: Pick<Genome, 'cells'> & { lifeHistory?: LifeHistory }) {
  const size = genome.cells.length,
    traits = genome.lifeHistory;
  const grant = (childSize: number) =>
    traits
      ? childSize * (1 + traits.investment * 0.5) + 2 + traits.investment
      : childSize * 1.5 + 3;
  const overhead = traits ? 4 - traits.maturity : 2;
  return {
    maturity: traits ? 15 + traits.maturity * 15 : 30,
    cadence: traits ? 11 + traits.maintenance * 3 : 11,
    ageLimit: 900 + size * 75 + (traits ? traits.maintenance * 300 : 0),
    maintenance: traits ? size * traits.maintenance * 0.004 : 0,
    // One anatomical addition is the maximum birth mutation. Reserve one energy
    // even for that candidate; no mutation retry or post-placement energy grant.
    threshold: traits ? grant(Math.min(16, size + 1)) + overhead + 1 : size * 3 + 9,
    overhead,
    grant,
  };
}

export const LIFE_EVENT_CAPACITY = 128;
export interface LifeEvent {
  tick: number;
  organismId: number;
  lineageId: number;
  kind: 'mature' | import('./model').DeathCause;
  age: number;
  cells: number;
  traits: LifeHistory;
}
export interface LifeHistoryLog {
  version: 1;
  originTick: number;
  maintenanceSpent: number;
  eventsPruned: boolean;
  events: LifeEvent[];
}
export const emptyLifeHistoryLog = (originTick: number): LifeHistoryLog => ({
  version: 1,
  originTick,
  maintenanceSpent: 0,
  eventsPruned: false,
  events: [],
});
/** Observations of opted-in bodies only. This observer consumes no random draws. */
export function recordLifeEvent(
  log: LifeHistoryLog,
  o: Organism,
  tick: number,
  kind: LifeEvent['kind'],
): void {
  if (!o.genome.lifeHistory) return;
  log.events.push({
    tick,
    organismId: o.id,
    lineageId: o.species,
    kind,
    age: o.age,
    cells: o.genome.cells.length,
    traits: { ...o.genome.lifeHistory },
  });
  if (log.events.length > LIFE_EVENT_CAPACITY) {
    log.events.shift();
    log.eventsPruned = true;
  }
}
export function validateLifeHistoryLog(
  value: unknown,
  tick: number,
  nextId: number,
  nextSpecies: number,
  organisms?: Iterable<Organism>,
): LifeHistoryLog {
  if (
    !exactDataRecord(value, [
      'version',
      'originTick',
      'maintenanceSpent',
      'eventsPruned',
      'events',
    ]) ||
    value.version !== 1 ||
    !integer(value.originTick, 0, tick) ||
    typeof value.maintenanceSpent !== 'number' ||
    !Number.isFinite(value.maintenanceSpent) ||
    value.maintenanceSpent < 0 ||
    value.maintenanceSpent > (tick - Number(value.originTick)) * 1600 * 0.128 + 1e-6 ||
    typeof value.eventsPruned !== 'boolean' ||
    !Array.isArray(value.events) ||
    value.events.length > LIFE_EVENT_CAPACITY ||
    (value.eventsPruned && value.events.length !== LIFE_EVENT_CAPACITY)
  )
    throw new Error('Invalid life-history observations.');
  let previous = Number(value.originTick);
  const seen = new Set<string>();
  const living = new Map(Array.from(organisms ?? [], (o) => [o.id, o]));
  const identities = new Map<
    number,
    { lineage: number; traits: LifeHistory; cells: number; dead: boolean }
  >();
  for (const event of value.events) {
    if (
      !exactDataRecord(event, [
        'tick',
        'organismId',
        'lineageId',
        'kind',
        'age',
        'cells',
        'traits',
      ]) ||
      !integer(event.tick, previous, tick) ||
      !integer(event.organismId, 1, nextId - 1) ||
      !integer(event.lineageId, 1, nextSpecies - 1) ||
      !integer(event.age, 0, 100000) ||
      !integer(event.cells, 1, 16) ||
      !validLifeHistory(event.traits) ||
      !['mature', 'age', 'energy', 'manual'].includes(String(event.kind))
    )
      throw new Error('Invalid life-history event.');
    const age = Number(event.age),
      maturity = 15 + 15 * event.traits.maturity,
      limit = 900 + Number(event.cells) * 75 + event.traits.maintenance * 300,
      key = `${event.organismId}:${event.kind === 'mature' ? 'mature' : 'death'}`;
    if (
      (event.kind === 'mature' && age !== maturity + 1) ||
      (event.kind === 'age' && age <= limit) ||
      seen.has(key)
    )
      throw new Error('Inconsistent life-history outcome.');
    const id = Number(event.organismId),
      organism = living.get(id),
      identity = identities.get(id);
    if (
      (organism &&
        (event.kind !== 'mature' ||
          organism.species !== event.lineageId ||
          organism.age < age ||
          organism.genome.cells.length !== event.cells ||
          !sameLifeHistory(organism.genome.lifeHistory, event.traits))) ||
      (identity &&
        (identity.dead ||
          identity.lineage !== event.lineageId ||
          identity.cells !== event.cells ||
          !sameLifeHistory(identity.traits, event.traits)))
    )
      throw new Error('Inconsistent life-history identity.');
    identities.set(id, {
      lineage: Number(event.lineageId),
      traits: event.traits,
      cells: Number(event.cells),
      dead: event.kind !== 'mature',
    });
    seen.add(key);
    previous = Number(event.tick);
  }
  return structuredClone(value) as unknown as LifeHistoryLog;
}
