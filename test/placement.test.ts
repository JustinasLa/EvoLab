import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  HEIGHT,
  LIMIT,
  WIDTH,
  Random,
  founder,
  index,
  positions,
  validGenome,
} from '../src/model';
import { placementGhost, point, transformDesign, viewport } from '../src/view';
import { storedSensoryGenome } from './fixtures/sensory-legacy';

describe('placement geometry and detached designer transforms', () => {
  it('preserves complete ordered sensory/opaque payloads and bounds across the dihedral transforms', () => {
    const genome = storedSensoryGenome();
    const before = structuredClone(genome);
    let rotated = genome;
    for (let turn = 0; turn < 4; turn++) {
      rotated = transformDesign(rotated, 'rotate');
      expect(validGenome(rotated)).toBe(true);
      expect(rotated.behavior).toEqual(before.behavior);
      expect(rotated.legacyExtensions).toEqual(before.legacyExtensions);
      rotated.cells.forEach((cell, i) => {
        expect(cell.type).toBe(before.cells[i].type);
        expect(cell.legacyExtensions).toEqual(before.cells[i].legacyExtensions);
      });
    }
    expect(rotated).toEqual(before);
    expect(transformDesign(transformDesign(genome, 'mirror'), 'mirror')).toEqual(before);
    const mirrored = transformDesign(genome, 'mirror');
    mirrored.cells[0].type = 8;
    mirrored.behavior.mode = 'legacy';
    mirrored.legacyExtensions!.push(['detached', [['null']]]);
    expect(genome).toEqual(before);
    expect(() => transformDesign({ ...genome, cells: [] }, 'rotate')).toThrow();
  });

  it('matches engine rotation/wrapping at all four seams, blocks on walls and IDs, and permits food', () => {
    const world = new Ecosystem(DEFAULTS, false);
    const genome = founder(0);
    for (const [x, y] of [
      [0, 0],
      [WIDTH - 1, 0],
      [0, HEIGHT - 1],
      [WIDTH - 1, HEIGHT - 1],
    ]) {
      let rotated = genome;
      for (let rotation = 0; rotation < 4; rotation++) {
        const frame = world.frame();
        const ghost = placementGhost(frame, rotated, x, y);
        expect(ghost.positions).toEqual(positions({ genome, x, y, rotation }));
        expect(ghost.blocked).toBe(false);
        frame.cells[ghost.positions[0]] = 1;
        expect(placementGhost(frame, rotated, x, y).blocked).toBe(false);
        frame.cells[ghost.positions[0]] = 2;
        expect(placementGhost(frame, rotated, x, y).blocked).toBe(true);
        frame.cells[ghost.positions[0]] = 0;
        frame.ids[ghost.positions.at(-1)!] = 99;
        expect(placementGhost(frame, rotated, x, y).blocked).toBe(true);
        rotated = transformDesign(rotated, 'rotate');
      }
    }
    const frame = world.frame();
    frame.stats.population = LIMIT;
    expect(placementGhost(frame, genome, 20, 20).blocked).toBe(true);
  });

  it('shares the full-world drawing/pointer camera transform under zoom, pan, resize and letterboxing', () => {
    const canvas = document.createElement('canvas');
    for (const [width, height] of [
      [960, 624],
      [310, 700],
      [700, 200],
    ]) {
      Object.defineProperties(canvas, {
        clientWidth: { configurable: true, value: width },
        clientHeight: { configurable: true, value: height },
      });
      for (const camera of [
        { zoom: 0.5, x: 0, y: 0 },
        { zoom: 3.5, x: -127, y: 81 },
      ]) {
        const v = viewport(canvas, camera);
        for (const [x, y] of [
          [0, 0],
          [WIDTH - 1, HEIGHT - 1],
          [120, 78],
        ])
          expect(
            point(canvas, camera, v.left + (x + 0.5) * v.scale, v.top + (y + 0.5) * v.scale),
          ).toEqual({ x, y });
        expect(point(canvas, camera, v.left - 0.01, v.top)).toBeNull();
        expect(point(canvas, camera, v.left + WIDTH * v.scale, v.top)).toBeNull();
      }
    }
  });

  it('keeps the single legacy failed attempt, without retries or destructive world edits', () => {
    const world = new Ecosystem(DEFAULTS, false);
    const genome = founder(0);
    world.walls[index(0, 0)] = 1;
    world.food[index(WIDTH - 1, 0)] = 1;
    const before = world.save();
    const wallRandom = new Random(before.random);
    wallRandom.int(4);
    expect(world.paint('plant', 0, 0, 0, genome).placement).toBeNull();
    expect(world.save()).toEqual({
      ...before,
      nextSpecies: before.nextSpecies + 1,
      random: wallRandom.state,
    });
    world.walls.fill(0);
    world.spawn(genome, 0, 0);
    const occupied = world.save();
    const occupiedRandom = new Random(occupied.random);
    occupiedRandom.int(4);
    expect(world.paint('plant', 0, 0, 0, genome).placement).toBeNull();
    expect(world.save()).toEqual({
      ...occupied,
      nextSpecies: occupied.nextSpecies + 1,
      random: occupiedRandom.state,
    });
    for (let i = 2; i <= LIMIT; i++) world.organisms.set(i, { ...world.organisms.get(1)!, id: i });
    const full = world.save();
    expect(world.paint('plant', 60, 60, 0, genome).placement).toBeNull();
    expect(world.save()).toEqual({ ...full, nextSpecies: full.nextSpecies + 1 });
  });
});
