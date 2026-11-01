import {
  integer,
  observedGenome,
  validGenome,
  type Genome,
  type LineageArchiveState,
} from './model';
import { MUTATION_CHANNELS, type MutationChannel } from './mutation';

export type AttemptChannel = MutationChannel | 'propensity';
export interface BirthEvent {
  kind: 'reproduction';
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
function projection(value: unknown): value is Genome {
  if (!validGenome(value)) return false;
  const genome = value as Genome;
  return (
    Object.keys(genome).length === (genome.mutationPropensity === undefined ? 5 : 6) &&
    genome.cells.every((cell) => Object.keys(cell).length === 3)
  );
}
export function inheritedDifference(parent: Genome, child: Genome): boolean {
  return (
    !Object.is(parent.preference, child.preference) ||
    !Object.is(parent.tolerance, child.tolerance) ||
    !Object.is(parent.tempo, child.tempo) ||
    !Object.is(parent.mutationPropensity, child.mutationPropensity) ||
    JSON.stringify(parent.behavior) !== JSON.stringify(child.behavior) ||
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
/** Strict bounded observation validation, independently of complete opaque genomes. */
export function validBirthEvent(event: BirthEvent, nextSpecies: number, nextId: number): boolean {
  const attempted = event.gate || event.channels.includes('propensity');
  return (
    Object.keys(event).length === birthKeys.length &&
    birthKeys.every((key) => Object.hasOwn(event, key)) &&
    event.kind === 'reproduction' &&
    integer(event.id, 1, nextSpecies - 1) &&
    integer(event.parentOrganismId, 1, nextId - 1) &&
    projection(event.parentGenome) &&
    typeof event.gate === 'boolean' &&
    Array.isArray(event.channels) &&
    event.channels.length <= 6 &&
    new Set(event.channels).size === event.channels.length &&
    event.channels.every((channel) => [...MUTATION_CHANNELS, 'propensity'].includes(channel)) &&
    (event.gate || event.channels.every((channel) => channel === 'propensity')) &&
    (!event.channels.includes('propensity') ||
      event.parentGenome.mutationPropensity !== undefined) &&
    integer(event.placementAttempts, 1, 3) &&
    (event.childGenome === null
      ? event.childOrganismId === null &&
        event.childLineageId === null &&
        event.placementAttempts === 3
      : projection(event.childGenome) &&
        integer(event.childOrganismId, event.parentOrganismId + 1, nextId - 1) &&
        integer(event.childLineageId, event.id, nextSpecies - 1) &&
        (attempted || event.childLineageId === event.id)) &&
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
    outcome: birthOutcome(
      parentGenome,
      childGenome,
      event.gate || event.channels.includes('propensity'),
    ),
  };
}
export function retainedBirthExport(archive: LineageArchiveState, tick: number) {
  return {
    format: 'evolab-retained-births',
    version: 1,
    completedTick: tick,
    window: {
      recordingOriginTick: archive.mutationOriginTick ?? tick,
      capacity: 512,
      sharedWith: 'lineage creation and extinction',
      eventsPruned: archive.eventsPruned,
      evictedThroughTick: archive.eventsEvictedThroughTick,
      beforeOrigin: 'unknown / not recorded',
      omittedPrefix: archive.eventsPruned ? 'pruned' : 'none since recording origin',
    },
    events: structuredClone(archive.events.filter((event) => event.kind === 'reproduction')),
  };
}
