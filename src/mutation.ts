import { LIFE_TRAITS } from './life-history';
import {
  clamp,
  cloneGenome,
  connected,
  integer,
  mutate,
  type CellType,
  type Genome,
  type Random,
} from './model';

export const MUTATION_CHANNELS = [
  'add',
  'remove',
  'change',
  'preference',
  'tolerance',
  'tempo',
  'reactions',
] as const;
export type MutationChannel = (typeof MUTATION_CHANNELS)[number];
export type MutationPolicy =
  | { version: 1; mode: 'legacy' }
  | { version: 1; mode: 'weighted'; weights: Record<MutationChannel, number> };
export const legacyMutation = (): MutationPolicy => ({ version: 1, mode: 'legacy' });
export const weightedMutation = (): Extract<MutationPolicy, { mode: 'weighted' }> => ({
  version: 1,
  mode: 'weighted',
  weights: { add: 1, remove: 1, change: 1, preference: 1, tolerance: 1, tempo: 1, reactions: 1 },
});
function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
export function validMutationPolicy(value: unknown): value is MutationPolicy {
  if (!value || typeof value !== 'object') return false;
  const policy = value as MutationPolicy;
  return (
    policy.version === 1 &&
    (policy.mode === 'legacy'
      ? keys(policy, ['version', 'mode'])
      : policy.mode === 'weighted' &&
        keys(policy, ['version', 'mode', 'weights']) &&
        keys(policy.weights, MUTATION_CHANNELS) &&
        MUTATION_CHANNELS.every((key) => integer(policy.weights[key], 0, 100)))
  );
}
export const sameMutationPolicy = (left: MutationPolicy, right: MutationPolicy): boolean =>
  left.mode === right.mode &&
  (left.mode === 'legacy' ||
    (right.mode === 'weighted' &&
      MUTATION_CHANNELS.every((key) => left.weights[key] === right.weights[key])));

/** Called only after the existing birth mutation gate. No retries or cross-channel fallback. */
export function mutateWithPolicy(
  source: Genome,
  random: Random,
  policy: MutationPolicy,
  observe?: (channel: string) => void,
): Genome {
  if (policy.mode === 'legacy') return mutate(source, random, observe);
  const eligible = MUTATION_CHANNELS.filter(
    (key) => key !== 'reactions' || source.behavior.version === 2,
  );
  const total = eligible.reduce((sum, key) => sum + policy.weights[key], 0);
  const g = cloneGenome(source);
  if (total === 0) return g;
  let target = random.next() * total;
  const channel = eligible.find((key) => (target -= policy.weights[key]) < 0)!;
  observe?.(channel);
  if (channel === 'add') {
    if (g.cells.length < 16) {
      const cell = g.cells[random.int(g.cells.length)],
        [dx, dy] = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ][random.int(4)],
        next = { x: cell.x + dx, y: cell.y + dy, type: (3 + random.int(6)) as CellType };
      if (
        Math.abs(next.x) <= 4 &&
        Math.abs(next.y) <= 4 &&
        !g.cells.some((c) => c.x === next.x && c.y === next.y)
      )
        g.cells.push(next);
    }
  } else if (channel === 'remove') {
    if (g.cells.length > 1) {
      const remove = random.int(g.cells.length),
        rest = g.cells.filter((_, i) => i !== remove);
      if (connected(rest)) g.cells = rest;
    }
  } else if (channel === 'change') {
    const cell = g.cells[random.int(g.cells.length)],
      alternatives = ([3, 4, 5, 6, 7, 8] as CellType[]).filter((type) => type !== cell.type);
    cell.type = alternatives[random.int(5)];
  } else if (channel === 'preference')
    g.preference = clamp(g.preference + (random.next() - 0.5) * 0.18, 0, 1);
  else if (channel === 'tolerance')
    g.tolerance = clamp(g.tolerance + (random.next() - 0.5) * 0.06, 0.12, 0.6);
  else if (channel === 'tempo') g.tempo = clamp(g.tempo + random.int(3) - 1, 2, 12);
  else if (g.behavior.mode === 'evolved') {
    const reactions = g.behavior.reactions,
      category = (['food', 'wall', 'harmless', 'dangerous'] as const)[random.int(4)],
      alternatives = (['ignore', 'chase', 'flee'] as const).filter(
        (action) => action !== reactions[category],
      );
    reactions[category] = alternatives[random.int(2)];
  }
  return g;
}

/** Independent self trial after the ordinary gate/policy, before any placement attempts. */
export function mutatePropensity(
  source: Genome,
  random: Random,
  observe?: (channel: string) => void,
): Genome {
  if (source.mutationPropensity === undefined) return source;
  if (random.next() >= 0.05) return source;
  observe?.('propensity');
  const genome = cloneGenome(source);
  genome.mutationPropensity = clamp(source.mutationPropensity + (random.next() - 0.5) * 0.2, 0, 1);
  return genome;
}

/** One bounded trait step after the ordinary gate, only for explicit opt-in. */
export function mutateLifeHistory(
  source: Genome,
  random: Random,
  observe?: (channel: string) => void,
): Genome {
  if (!source.lifeHistory) return source;
  const genome = cloneGenome(source);
  const key = LIFE_TRAITS[random.int(LIFE_TRAITS.length)];
  observe?.('lifeHistory');
  genome.lifeHistory![key] = clamp(genome.lifeHistory![key] + (random.int(2) === 0 ? -1 : 1), 0, 2);
  return genome;
}
