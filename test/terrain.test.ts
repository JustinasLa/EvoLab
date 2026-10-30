import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WIDTH, HEIGHT, index, type TerrainRecipe } from '../src/model';
import {
  DEFAULT_TERRAIN,
  TERRAIN_LABELS,
  generateTerrain,
  resolvedTerrainSeed,
  sameTerrain,
  validTerrain,
} from '../src/terrain';

describe('versioned pure terrain recipes', () => {
  it('accepts only exact bounded recipes and distinguishes following the world seed', () => {
    for (const preset of Object.keys(TERRAIN_LABELS))
      for (const seed of [null, 0, 4294967295])
        expect(validTerrain({ version: 1, preset, seed })).toBe(true);
    for (const value of [
      null,
      [],
      1,
      {},
      { ...DEFAULT_TERRAIN, version: 2 },
      { ...DEFAULT_TERRAIN, preset: 'toString' },
      { ...DEFAULT_TERRAIN, extra: true },
      ...['42', -1, 4294967296, 0.5, Infinity, NaN, undefined].map((seed) => ({
        ...DEFAULT_TERRAIN,
        seed,
      })),
    ])
      expect(validTerrain(value)).toBe(false);
    expect(resolvedTerrainSeed(DEFAULT_TERRAIN, 42)).toBe(42);
    expect(resolvedTerrainSeed({ ...DEFAULT_TERRAIN, seed: 0 }, 42)).toBe(0);
    expect(() => resolvedTerrainSeed({ ...DEFAULT_TERRAIN, seed: -1 }, 42)).toThrow();
    expect(() => resolvedTerrainSeed(DEFAULT_TERRAIN, -1)).toThrow();
    expect(sameTerrain(DEFAULT_TERRAIN, { ...DEFAULT_TERRAIN })).toBe(true);
    expect(sameTerrain(DEFAULT_TERRAIN, { ...DEFAULT_TERRAIN, seed: 42 })).toBe(false);
    expect(sameTerrain(DEFAULT_TERRAIN, { ...DEFAULT_TERRAIN, preset: 'open-field' })).toBe(false);
  });

  it('matches genuine pre-change ridge geometry for all six declared seeds', () => {
    for (const seed of [0, 1, 42, 100, 123, 4294967295]) {
      const baseline = JSON.parse(readFileSync(`test/fixtures/terrain/seed-${seed}.json`, 'utf8'));
      const mask = generateTerrain(DEFAULT_TERRAIN, seed);
      expect(Array.from(mask).flatMap((value, cell) => (value ? [cell] : []))).toEqual(
        baseline.walls,
      );
      expect(mask).toHaveLength(WIDTH * HEIGHT);
      expect(mask).toEqual(generateTerrain({ ...DEFAULT_TERRAIN, seed }, 9));
      mask.fill(0);
      expect(generateTerrain(DEFAULT_TERRAIN, seed).some(Boolean)).toBe(true);
    }
  });

  it('keeps all chamber floors connected across translated seams, with only binary bounded walls', () => {
    for (const preset of Object.keys(TERRAIN_LABELS) as TerrainRecipe['preset'][])
      for (const seed of [0, 1, 42, 100, 123, 4294967295]) {
        const walls = generateTerrain({ version: 1, preset, seed }, 0);
        expect(walls.length).toBe(37440);
        expect([...walls].every((value) => value === 0 || value === 1)).toBe(true);
        for (const cell of [18840, 18839, 18600, 18841, 19080]) expect(walls[cell]).toBe(0);
        const count = walls.reduce((total, value) => total + value, 0);
        if (preset === 'open-field') expect(count).toBe(0);
        else if (preset === 'porous-ridges') expect(count).toBeLessThanOrEqual(98);
        else {
          expect(count).toBeGreaterThanOrEqual(1207);
          expect(count).toBeLessThanOrEqual(1212);
          const seen = new Set<number>();
          const first = walls.findIndex((value) => !value);
          const pending = [first];
          seen.add(first);
          for (let cursor = 0; cursor < pending.length; cursor++) {
            const current = pending[cursor],
              horizontal = current % WIDTH,
              vertical = Math.floor(current / WIDTH);
            for (const next of [
              index(horizontal - 1, vertical),
              index(horizontal + 1, vertical),
              index(horizontal, vertical - 1),
              index(horizontal, vertical + 1),
            ])
              if (!walls[next] && !seen.has(next)) {
                seen.add(next);
                pending.push(next);
              }
          }
          expect(seen.size).toBe(WIDTH * HEIGHT - count);
        }
      }
    expect(index(-1, -1)).toBe(37439);
    expect(index(240, 156)).toBe(0);
  });
});
