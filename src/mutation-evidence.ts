import { lifeRules, sameLifeHistory, LIFE_TRAITS } from './life-history';
import {
  integer,
  exactDataRecord,
  finite,
  observedGenome,
  validGenome,
  type Genome,
  type LineageArchiveState,
} from './model';
import { MUTATION_CHANNELS, type MutationChannel } from './mutation';
import { NEURAL_CHANNELS, sameController } from './neural';

export type AttemptChannel =
  MutationChannel | 'propensity' | 'lifeHistory' | (typeof NEURAL_CHANNELS)[number];
export interface BirthEvent {
  kind: 'reproduction';
  /** Absent in pre-life-history observations; never reconstruct historic payments. */
  payment?: { parentAge: number; parentPaid: number; offspringGranted: number; overhead: number };
  /** Reproductive parent's lineage, not a newly allocated lineage. */
  id: number;
  tick: number;
  parentOrganismId: number;
  parentGenome: Genome;
  gate: boolean;
  channels: AttemptChannel[];
  placementAttempts: number;
  childOrganismId: number | null;
  childLineageId: number | null;
  childGenome: Genome | null;
  outcome: 'born-clone' | 'born-no-op' | 'born-changed' | 'failed-placement';
}
export const birthKeys = [
  'kind',
  'id',
  'tick',
  'parentOrganismId',
  'parentGenome',
  'gate',
  'channels',
  'placementAttempts',
  'childOrganismId',
  'childLineageId',
  'childGenome',
  'outcome',
];
function projection(value: unknown, neural: boolean, lifeHistory: boolean): value is Genome {
  if (!validGenome(value, true, true, neural, lifeHistory)) return false;
  const genome = value as Genome;
  return (
    Object.keys(genome).length ===
      5 +
        (genome.mutationPropensity === undefined ? 0 : 1) +
        (genome.lifeHistory ? 1 : 0) +
        (genome.controller ? 1 : 0) && genome.cells.every((cell) => Object.keys(cell).length === 3)
  );
}
/** Numeric observations treat signed zeros equally, as ordinary Save JSON does. */
export function inheritedDifference(parent: Genome, child: Genome): boolean {
  return (
    !sameLifeHistory(parent.lifeHistory, child.lifeHistory) ||
    parent.preference !== child.preference ||
    !sameController(parent.controller, child.controller) ||
    !Object.is(parent.tolerance, child.tolerance) ||
    !Object.is(parent.tempo, child.tempo) ||
    parent.mutationPropensity !== child.mutationPropensity ||
    parent.behavior.version !== child.behavior.version ||
    parent.behavior.mode !== child.behavior.mode ||
    (parent.behavior.mode === 'evolved' &&
      child.behavior.mode === 'evolved' &&
      (['food', 'wall', 'harmless', 'dangerous'] as const).some(
        (key) =>
          parent.behavior.mode === 'evolved' &&
          child.behavior.mode === 'evolved' &&
          parent.behavior.reactions[key] !== child.behavior.reactions[key],
      )) ||
    parent.cells.length !== child.cells.length ||
    parent.cells.some((cell, i) => {
      const other = child.cells[i];
      return cell.x !== other.x || cell.y !== other.y || cell.type !== other.type;
    })
  );
}
export function birthOutcome(
  parent: Genome,
  child: Genome | null,
  attempted: boolean,
): BirthEvent['outcome'] {
  return child === null
    ? 'failed-placement'
    : inheritedDifference(parent, child)
      ? 'born-changed'
      : attempted
        ? 'born-no-op'
        : 'born-clone';
}
function possibleChanges(event: BirthEvent, child: Genome): boolean {
  const parent = event.parentGenome,
    channels = event.channels;
  return (
    (parent.lifeHistory === undefined) === (child.lifeHistory === undefined) &&
    (sameLifeHistory(parent.lifeHistory, child.lifeHistory) ||
      (channels.includes('lifeHistory') &&
        LIFE_TRAITS.filter((key) => parent.lifeHistory![key] !== child.lifeHistory![key]).length ===
          1 &&
        LIFE_TRAITS.every(
          (key) => Math.abs(parent.lifeHistory![key] - child.lifeHistory![key]) <= 1,
        ))) &&
    parent.behavior.version === child.behavior.version &&
    parent.behavior.mode === child.behavior.mode &&
    !!parent.controller === !!child.controller &&
    (!parent.controller ||
      !child.controller ||
      ((channels.includes('neural-weight') ||
        parent.controller.weights.every(
          (weight, offset) => weight === child.controller!.weights[offset],
        )) &&
        (channels.includes('neural-bias') ||
          parent.controller.biases.every(
            (bias, offset) => bias === child.controller!.biases[offset],
          )))) &&
    (parent.mutationPropensity === undefined) === (child.mutationPropensity === undefined) &&
    (['preference', 'tolerance', 'tempo', 'mutationPropensity'] as const).every(
      (key) =>
        Object.is(parent[key], child[key]) ||
        channels.includes(key === 'mutationPropensity' ? 'propensity' : key),
    ) &&
    (parent.behavior.mode !== 'evolved' ||
      child.behavior.mode !== 'evolved' ||
      channels.includes('reactions') ||
      (['food', 'wall', 'harmless', 'dangerous'] as const).every(
        (key) =>
          parent.behavior.mode === 'evolved' &&
          child.behavior.mode === 'evolved' &&
          parent.behavior.reactions[key] === child.behavior.reactions[key],
      )) &&
    (channels.some((key) => ['add', 'remove', 'change'].includes(key)) ||
      (parent.cells.length === child.cells.length &&
        parent.cells.every(
          (cell, i) =>
            cell.x === child.cells[i].x &&
            cell.y === child.cells[i].y &&
            cell.type === child.cells[i].type,
        )))
  );
}
/** Strict bounded observation validation, independently of complete opaque genomes. */
export function validBirthEvent(
  event: BirthEvent,
  nextSpecies: number,
  nextId: number,
  neural = true,
  lifeHistory = true,
): boolean {
  if (!Array.isArray(event.channels)) return false;
  const attempted = event.gate || event.channels.includes('propensity');
  return (
    Object.keys(event).length === birthKeys.length + (Object.hasOwn(event, 'payment') ? 1 : 0) &&
    (!Object.hasOwn(event, 'payment') || (lifeHistory && validBirthPayment(event))) &&
    birthKeys.every((key) => Object.hasOwn(event, key)) &&
    event.kind === 'reproduction' &&
    integer(event.id, 1, nextSpecies - 1) &&
    integer(event.parentOrganismId, 1, nextId - 1) &&
    projection(event.parentGenome, neural, lifeHistory) &&
    (!event.parentGenome.lifeHistory ||
      (event.payment !== undefined && (!event.gate || event.channels.includes('lifeHistory')))) &&
    typeof event.gate === 'boolean' &&
    Array.isArray(event.channels) &&
    event.channels.length <=
      6 + (event.parentGenome.controller ? 1 : 0) + (event.parentGenome.lifeHistory ? 1 : 0) &&
    new Set(event.channels).size === event.channels.length &&
    event.channels.every((channel) =>
      [
        ...MUTATION_CHANNELS,
        'propensity',
        ...(neural && event.parentGenome.controller ? NEURAL_CHANNELS : []),
        ...(lifeHistory ? ['lifeHistory'] : []),
      ].includes(channel),
    ) &&
    !(event.channels.includes('neural-weight') && event.channels.includes('neural-bias')) &&
    (event.gate || event.channels.every((channel) => channel === 'propensity')) &&
    (!event.channels.includes('propensity') ||
      event.parentGenome.mutationPropensity !== undefined) &&
    (!event.channels.includes('lifeHistory') ||
      (event.gate && event.parentGenome.lifeHistory !== undefined)) &&
    (!event.channels.includes('reactions') || event.parentGenome.behavior.version === 2) &&
    integer(event.placementAttempts, 1, 3) &&
    (event.childGenome === null
      ? event.childOrganismId === null &&
        event.childLineageId === null &&
        event.placementAttempts === 3
      : projection(event.childGenome, neural, lifeHistory) &&
        possibleChanges(event, event.childGenome) &&
        integer(event.childOrganismId, event.parentOrganismId + 1, nextId - 1) &&
        integer(event.childLineageId, event.id, nextSpecies - 1) &&
        (attempted ||
          (!inheritedDifference(event.parentGenome, event.childGenome) &&
            event.childLineageId === event.id)) &&
        (event.outcome !== 'born-changed' || event.childLineageId > event.id)) &&
    event.outcome === birthOutcome(event.parentGenome, event.childGenome, attempted)
  );
}
export function birthObservation(event: Omit<BirthEvent, 'kind' | 'outcome'>): BirthEvent {
  const parentGenome = observedGenome(event.parentGenome),
    childGenome = event.childGenome ? observedGenome(event.childGenome) : null;
  return {
    ...event,
    kind: 'reproduction',
    parentGenome,
    childGenome,
    channels: [...event.channels],
    ...(event.payment ? { payment: { ...event.payment } } : {}),
    outcome: birthOutcome(
      parentGenome,
      childGenome,
      event.gate || event.channels.includes('propensity'),
    ),
  };
}
export function retainedBirthExport(archive: LineageArchiveState, tick: number) {
  const events = archive.events.filter((event) => event.kind === 'reproduction');
  return {
    format: 'evolab-retained-births',
    version: 2,
    completedTick: tick,
    window: {
      recordingOriginTick: archive.mutationOriginTick ?? tick,
      capacity: 512,
      retainedCount: events.length,
      sharedRetainedCount: archive.events.length,
      firstRetainedTick: events[0]?.tick ?? null,
      lastRetainedTick: events.at(-1)?.tick ?? null,
      sharedWith: 'lineage creation and extinction',
      eventsPruned: archive.eventsPruned,
      evictedThroughTick: archive.eventsEvictedThroughTick,
      beforeOrigin: 'unknown / not recorded',
      omittedPrefix: archive.eventsPruned ? 'pruned' : 'none since recording origin',
    },
    events: structuredClone(events),
  };
}

/** Successful placement is the only point at which energy changes hands. */
function validBirthPayment(event: BirthEvent): boolean {
  const p = event.payment;
  if (
    !exactDataRecord(p, ['parentAge', 'parentPaid', 'offspringGranted', 'overhead']) ||
    !validGenome(event.parentGenome)
  )
    return false;
  const rules = lifeRules(event.parentGenome);
  return (
    integer(p.parentAge, rules.maturity + 1, rules.ageLimit) &&
    Number(p.parentAge) % rules.cadence === 0 &&
    finite(p.parentPaid, 0, 100) &&
    finite(p.offspringGranted, 0, 100) &&
    finite(p.overhead, 0, 4) &&
    (event.childGenome === null
      ? p.parentPaid === 0 && p.offspringGranted === 0 && p.overhead === 0
      : validGenome(event.childGenome) &&
        p.offspringGranted === rules.grant(event.childGenome.cells.length) &&
        p.overhead === rules.overhead &&
        Math.abs(Number(p.parentPaid) - Number(p.offspringGranted) - Number(p.overhead)) <= 1e-6)
  );
}
