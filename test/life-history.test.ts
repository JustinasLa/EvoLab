import { describe, expect, it } from 'vitest';
import { founder } from '../src/model';
import {
  defaultLifeHistory,
  lifeRules,
  sameLifeHistory,
  validLifeHistory,
} from '../src/life-history';

describe('bounded life-history contract', () => {
  it('preserves literal legacy costs and exposes paid tradeoffs', () => {
    const genome = founder(0),
      legacy = lifeRules(genome);
    expect([
      legacy.maturity,
      legacy.cadence,
      legacy.ageLimit,
      legacy.threshold,
      legacy.overhead,
      legacy.maintenance,
      legacy.grant(5),
    ]).toEqual([30, 11, 1275, 24, 2, 0, 10.5]);
    const early = lifeRules({
      ...genome,
      lifeHistory: { version: 1, maturity: 0, investment: 0, maintenance: 0 },
    });
    const late = lifeRules({
      ...genome,
      lifeHistory: { version: 1, maturity: 2, investment: 2, maintenance: 2 },
    });
    expect([early.maturity, early.overhead, early.grant(5), early.threshold]).toEqual([
      15, 4, 7, 13,
    ]);
    expect([late.maturity, late.overhead, late.grant(5), late.threshold]).toEqual([45, 2, 14, 19]);
    expect([late.cadence, late.ageLimit, late.maintenance]).toEqual([17, 1875, 0.04]);
  });
  it('requires a complete bounded opt-in and compares it by value', () => {
    const traits = defaultLifeHistory();
    expect(validLifeHistory(traits)).toBe(true);
    for (const value of [
      null,
      {},
      { ...traits, version: 2 },
      { ...traits, maturity: -1 },
      { ...traits, investment: 3 },
      { ...traits, maintenance: 0.5 },
      { ...traits, extra: 0 },
    ])
      expect(validLifeHistory(value)).toBe(false);
    expect(sameLifeHistory()).toBe(true);
    expect(sameLifeHistory(traits)).toBe(false);
    expect(sameLifeHistory(traits, { ...traits })).toBe(true);
    expect(sameLifeHistory(traits, { ...traits, maturity: 2 })).toBe(false);
  });
});
