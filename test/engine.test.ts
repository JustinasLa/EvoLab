import { describe, it, expect } from 'vitest';
import { DEFAULTS, Random, creature, mutate, readChampion, validSettings } from '../src/model';
import { evaluate, terrain } from '../src/physics';
import { Evolution } from '../src/evolution';

describe('genomes and portable champions', () => {
  it('reproduces seeded populations and bounds thousands of mutations', () => {
    expect(creature(new Random(42))).toEqual(creature(new Random(42)));
    const random = new Random(123);
    let child = creature(random);
    const original = structuredClone(child);
    for (let i = 0; i < 1500; i++) {
      child = mutate(child, random, 0.6);
      expect(
        readChampion(JSON.stringify({ version: 1, settings: DEFAULTS, genome: child })).genome,
      ).toEqual(child);
    }
    expect(child).not.toEqual(original);
    expect(validSettings(null)).toBe(false);
    expect(validSettings('settings')).toBe(false);
    expect(validSettings({ ...DEFAULTS, seed: -1 })).toBe(false);
    expect(validSettings({ ...DEFAULTS, seed: 1.1 })).toBe(false);
    expect(validSettings({ ...DEFAULTS, gravity: Infinity })).toBe(false);
    expect(validSettings({ ...DEFAULTS, course: 'lava' })).toBe(false);
  });
  it('rejects malformed, excessive, and disconnected imports', () => {
    const saved = { version: 1, settings: DEFAULTS, genome: creature(new Random(42)) };
    const parse = (x: unknown) => readChampion(JSON.stringify(x));
    expect(() => readChampion('x'.repeat(32001))).toThrow('too large');
    expect(() => readChampion('{')).toThrow();
    for (const value of [
      null,
      {},
      { ...saved, version: 2 },
      { ...saved, settings: {} },
      { ...saved, genome: null },
      { ...saved, genome: { ...saved.genome, id: '<script>' } },
      { ...saved, genome: { ...saved.genome, hue: 800 } },
      { ...saved, genome: { ...saved.genome, genes: [] } },
    ])
      expect(() => parse(value)).toThrow();
    const invalid = structuredClone(saved);
    invalid.genome.genes[1].parent = 1;
    expect(() => parse(invalid)).toThrow('invalid body');
    invalid.genome.genes[1].parent = 0;
    invalid.genome.genes[0].angle = 1;
    expect(() => parse(invalid)).toThrow('invalid body');
    invalid.genome.genes[0].angle = 0;
    invalid.genome.genes[1].torque = 10000;
    expect(() => parse(invalid)).toThrow('invalid body');
  });
});

describe('real rigid-body trials', () => {
  it('is repeatable and motor work produces movement', () => {
    const genome = creature(new Random(42));
    const a = evaluate(genome, DEFAULTS);
    expect(a).toEqual(evaluate(genome, DEFAULTS));
    expect(a.frames).toHaveLength(160);
    expect(a.frames[0]).toHaveLength(genome.genes.length * 3);
    expect(a.energy).toBeGreaterThan(0);
    expect(a.frames[0]).not.toEqual(a.frames.at(-1));
    expect(Number.isFinite(a.fitness)).toBe(true);
    expect(evaluate(genome, DEFAULTS, false).frames).toEqual([]);
  });
  it('changes the physical world for obstacles and gravity', () => {
    const genome = creature(new Random(8));
    expect(terrain('meadow')).toHaveLength(1);
    expect(terrain('steps')).toHaveLength(19);
    expect(terrain('gaps')).toHaveLength(13);
    expect(evaluate(genome, { ...DEFAULTS, gravity: 1.6 }).distance).not.toBe(
      evaluate(genome, DEFAULTS).distance,
    );
    for (const course of ['steps', 'gaps'] as const)
      expect(Number.isFinite(evaluate(genome, { ...DEFAULTS, course }).fitness)).toBe(true);
  });
});

describe('selection', () => {
  it('preserves elites, introduces offspring, and improves a seeded run', () => {
    const run = new Evolution({ ...DEFAULTS, population: 12 });
    const initial = structuredClone(run.population);
    let first = 0;
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const trials = run.population.map((_, j) => run.assess(j));
      const best = [...trials].sort((a, b) => b.fitness - a.fitness)[0];
      const result = run.advance(trials);
      if (i === 0) first = result.best;
      last = result.best;
      expect(run.population[0]).toEqual(best.genome);
      expect(result.index).toBe(i + 1);
      expect(result.best).toBeGreaterThanOrEqual(result.median);
      expect(result.champion.frames.length).toBeGreaterThan(0);
    }
    expect(last).toBeGreaterThan(first);
    expect(run.population).not.toEqual(initial);
    expect(() => run.advance([])).toThrow('every creature');
    const founder = creature(new Random(3));
    const seeded = new Evolution(DEFAULTS, founder);
    expect(seeded.population[0]).toEqual(founder);
    expect(seeded.population[1]).not.toEqual(founder);
  });
});
