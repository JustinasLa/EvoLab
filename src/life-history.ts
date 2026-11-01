import { exactDataRecord, integer, type Genome } from './model';

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
