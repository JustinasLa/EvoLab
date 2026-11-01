import { describe, it, expect } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  Random,
  STROKE_COMMAND_CAPACITY,
  type Genome,
  type WorldFile,
} from '../src/model';
import { localTemperature } from '../src/refuges';
import { world9Cases, world9Text, projectWorld9 } from './fixtures/shade';
import { identicalRecords } from './fixtures/refuges';
import {
  legacyV3,
  legacyV4,
  legacyV5,
  legacyV6,
  legacyV7,
  legacyV8,
  legacyV9,
  advance,
} from './fixtures/telemetry';
import { Buffer } from 'node:buffer';
import { WIDTH, HEIGHT, index, positions, type Cell, type Organism } from '../src/model';
import {
  SHADE_CAPACITY,
  SHADE_MAX_BYTES,
  SHADE_UNITS_PER_FULL_LIGHT,
  emptyShade,
  parseShade,
  shadeFile,
  shadeSummary,
  shadeTool,
  validShadeBrush,
  activeShadeUnits,
  selectedLeafLight,
  shadeDab,
  type ShadeBrush,
  type ShadeField,
  type ShadeDab,
  type ShadeFile,
} from '../src/shade';

const brush = (units = 4, radius = 0): ShadeBrush => ({
  rulesVersion: 1,
  tool: units > 0 ? 'shade' : units < 0 ? 'lighten' : 'erase-shade',
  units,
  radius,
});

const leafGenome = (type: 3 | 4 | 7 = 4): Genome => ({
  cells: [{ x: 0, y: 0, type }],
  preference: 0.5,
  tolerance: 0.2,
  tempo: 2,
  behavior: { version: 1, mode: 'legacy' },
});
function leafWorld(units: number, nutrients = 20, age = 0, energy = 10, preference = 0.5) {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients, mutation: 0 }, false);
  const parent = world.spawn({ ...leafGenome(), preference }, 120, 78)!;
  parent.age = age;
  parent.energy = energy;
  const initial = world.save();
  initial.random = 23;
  initial.shadeHabitats = {
    version: 1,
    enabled: true,
    cells: units ? [[index(120, 78), units]] : [],
  };
  return Ecosystem.load(JSON.stringify(initial));
}
const energy = (world: Ecosystem) => world.save().telemetry.pending.energy;
const daylight1 = 0.65 + 0.35 * Math.sin(1 / 180);
const nominalGain1 = 0.04 * daylight1 * (1 - 0);

describe('S24-01 genuine immutable native9 full-state oracle', () => {
  for (const captured of world9Cases)
    for (const mode of ['disabled-empty', 'enabled-empty', 'disabled-stored'] as const)
      it(`retains every endpoint seed${captured.seed} mutation${captured.mutation} rotation${captured.rotation} ${mode}`, () => {
        const initial = JSON.parse(world9Text(captured.endpoints[0]));
        initial.version = 10;
        initial.interventions.version = 4;
        initial.shadeHabitats = {
          version: 1,
          enabled: mode === 'enabled-empty',
          cells:
            mode === 'disabled-stored'
              ? [
                  [index(120, 78), 16],
                  [37439, 7],
                ]
              : [],
        };
        let world = Ecosystem.load(JSON.stringify(initial));
        for (const tick of [0, 1, 30, 90, 330, 1600]) {
          while (world.tick < tick) world.step();
          expect(projectWorld9(world.save())).toEqual(
            JSON.parse(world9Text(captured.endpoints[tick])),
          );
          if (tick === captured.resumeTick) world = Ecosystem.load(JSON.stringify(world.save()));
        }
      });

  it('ignores active shade remote from a locally full-light leaf, preserving the complete native tick', () => {
    const full = leafWorld(0),
      remote = leafWorld(0);
    remote.shadeHabitats = parseShade({ version: 1, enabled: true, cells: [[0, 16]] });
    full.step();
    remote.step();
    const { shadeHabitats: _full, ...expected } = full.save();
    const { shadeHabitats: _remote, ...actual } = remote.save();
    expect(actual).toEqual(expected);
  });
});

describe('S24-02 real binary64 energy, probability thresholds and RNG', () => {
  for (let units = 0; units <= 16; units++)
    for (const preference of [0.5, 0.1])
      it(`applies the same exact factor to actual energy and trial outcome u${units} preference${preference}`, () => {
        const world = leafWorld(units, 20, 0, 10, preference),
          organism = world.organisms.values().next().value!;
        const stress = Math.max(0, Math.abs(0.5 - preference) - 0.2);
        const afterUpkeep = 10 - (0.012 + stress * 0.2);
        const fullGain = 0.04 * daylight1 * (1 - stress);
        const fullChance = (20 / 100) * daylight1 * (1 - stress);
        const gain = units === 0 ? fullGain : fullGain * ((16 - units) / 16);
        const chance = units === 0 ? fullChance : fullChance * ((16 - units) / 16);
        const random = new Random(23),
          success = random.next() < chance;
        let destination = -1;
        if (success) {
          const [dx, dy] = [
            [1, 0],
            [0, 1],
            [-1, 0],
            [0, -1],
          ][random.int(4)];
          destination = index(120 + dx, 78 + dy);
        }
        world.step();
        expect(organism.energy).toBe(afterUpkeep + gain);
        expect(energy(world).leavesGained).toBe(afterUpkeep + gain - afterUpkeep);
        expect(world.save().food).toEqual(success ? [destination] : []);
        expect(world.random.state).toBe(random.state);
      });
  for (const units of [0, 8, 16])
    for (const nutrients of [0, 20])
      for (const blocked of [false, true])
        it(`uses actual leaf-source light u${units} nutrients${nutrients} blocked${blocked}`, () => {
          const world = leafWorld(units, nutrients),
            organism = world.organisms.values().next().value!;
          if (blocked)
            for (const [dx, dy] of [
              [1, 0],
              [0, 1],
              [-1, 0],
              [0, -1],
            ])
              world.walls[index(120 + dx, 78 + dy)] = 1;
          const random = new Random(23),
            trial = random.next(),
            probability = (nutrients / 100) * daylight1 * (1 - 0);
          const threshold = units === 0 ? probability : probability * ((16 - units) / 16);
          expect(trial).toBe(0.09272266505286098);
          expect(random.state).toBe(1831565836);
          expect(probability).toBe(nutrients === 0 ? 0 : 0.13038888688843472);
          const succeeds = trial < threshold;
          let destination = -1;
          if (succeeds) {
            const [dx, dy] = [
              [1, 0],
              [0, 1],
              [-1, 0],
              [0, -1],
            ][random.int(4)];
            destination = index(120 + dx, 78 + dy);
            expect(random.state).toBe(-631835647);
          }
          world.step();
          const afterUpkeep = 10 - 0.012;
          const expectedEnergy =
            afterUpkeep + (units === 0 ? nominalGain1 : nominalGain1 * ((16 - units) / 16));
          expect(organism.energy).toBe(expectedEnergy);
          expect(energy(world).leavesGained).toBe(expectedEnergy - afterUpkeep);
          expect(energy(world).upkeepSpent).toBe(10 - afterUpkeep);
          expect(world.random.state).toBe(random.state);
          expect(world.save().food).toEqual(succeeds && !blocked ? [destination] : []);
          expect(world.births).toBe(0);
        });

  it('does not duplicate or remove an existing leaf-food destination', () => {
    const world = leafWorld(0),
      random = new Random(23);
    random.next();
    const [dx, dy] = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ][random.int(4)];
    world.food[index(120 + dx, 78 + dy)] = 1;
    world.step();
    expect(world.save().food).toEqual([index(120 + dx, 78 + dy)]);
    expect(world.random.state).toBe(random.state);
  });
  it('samples the source leaf rather than the actually chosen adjacent food destination', () => {
    const world = leafWorld(0),
      random = new Random(23);
    random.next();
    const [dx, dy] = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ][random.int(4)];
    const destination = index(120 + dx, 78 + dy);
    world.shadeHabitats = field(true, [[destination, 16]]);
    world.step();
    expect(world.save().food).toEqual([destination]);
    expect(energy(world).leavesGained).toBe(10 - 0.012 + nominalGain1 - (10 - 0.012));
    expect(world.random.state).toBe(random.state);
  });
});

describe('S24-03 real plant-fed mouth consequence', () => {
  it('consumes only the food actually generated in the full-light arm', () => {
    const arms = [0, 8, 16].map((units) => leafWorld(units));
    for (const world of arms) world.step();
    const [destination] = arms[0].save().food;
    expect(destination).toBeDefined();
    const dx = (destination % WIDTH) - 120,
      dy = Math.floor(destination / WIDTH) - 78;
    for (const [offset, world] of arms.entries()) {
      world.changeSettings({ nutrients: 0 });
      const mouth = world.spawn(leafGenome(3), 120 + 2 * dx, 78 + 2 * dy)!;
      mouth.energy = 10;
      const births = world.births;
      world.step();
      const expected = offset === 0 ? 10 - 0.012 + 2.2 : 10 - 0.012;
      expect(mouth.energy).toBe(expected);
      expect(energy(world).mouthsGained).toBe(offset === 0 ? expected - (10 - 0.012) : 0);
      expect(world.save().food).toEqual([]);
      expect(world.births).toBe(births);
    }
  });
});

describe('S24-04 actual parent-funded reproduction, not asserted fitness', () => {
  for (const units of [0, 8, 16])
    for (const blocked of [false, true])
      it(`u${units} blocked${blocked} uses normal strict threshold and placement attempts`, () => {
        const world = leafWorld(units, 0, 32, 11.99),
          parent = world.organisms.values().next().value!;
        if (blocked)
          for (const [dx, dy] of [
            [1, 0],
            [0, 1],
            [-1, 0],
            [0, -1],
          ])
            for (let distance = 3; distance <= 7; distance++)
              world.walls[index(120 + dx * distance, 78 + dy * distance)] = 1;
        const before = world.save(),
          afterUpkeep = 11.99 - 0.012;
        const beforeBirth = afterUpkeep + nominalGain1 * ((16 - units) / 16);
        const born = units === 0 && !blocked;
        world.step();
        expect(world.births).toBe(Number(born));
        expect(world.organisms.size).toBe(born ? 2 : 1);
        expect(parent.energy).toBe(beforeBirth - (born ? 6.5 : 0));
        expect(parent.children).toBe(Number(born));
        expect(energy(world).leavesGained).toBe(beforeBirth - afterUpkeep);
        expect(energy(world).reproductionSpent).toBe(born ? 6.5 : 0);
        expect(energy(world).offspringGranted).toBe(born ? 4.5 : 0);
        expect(world.save().telemetry.pending.births).toBe(Number(born));
        expect(world.nextId).toBe(before.nextId + Number(born));
        if (born) {
          const child = [...world.organisms.values()][1];
          expect(child.id).toBe(before.nextId);
          expect(child.generation).toBe(parent.generation + 1);
          expect(child.energy).toBe(4.5);
          expect(child.genome).toEqual(parent.genome);
          expect(child.genome).not.toBe(parent.genome);
          expect(child.species).toBe(parent.species);
          expect(world.lineageSnapshot().living[0].liveCount).toBe(2);
          expect(parent.energy).toBe(5.504077777377686);
        }
      });

  for (const age of [0, 29, 30, 31, 33])
    it(`does not weaken age/modulo admission at initial age${age}`, () => {
      const world = leafWorld(0, 0, age, 100);
      world.step();
      expect(world.births).toBe(0);
    });
  it('retains strict equality and population cap controls', () => {
    const equal = leafWorld(16, 0, 32, 12 + 0.012);
    equal.step();
    expect(equal.organisms.values().next().value!.energy).toBe(12);
    expect(equal.births).toBe(0);
    const capped = leafWorld(0, 0, 32, 100);
    for (let offset = 0; capped.organisms.size < 1600; offset++)
      capped.spawn(leafGenome(7), offset % WIDTH, Math.floor(offset / WIDTH));
    capped.step();
    expect(capped.organisms.size).toBe(1600);
    expect(capped.births).toBe(0);
    expect(energy(capped).reproductionSpent).toBe(0);
  });
});

describe('S24-05 mortality and no free advantage', () => {
  for (const units of [0, 8, 16])
    it(`u${units} pays unchanged upkeep and has no rescue`, () => {
      const world = leafWorld(units, 0, 0, 0.005);
      const id = world.organisms.values().next().value!.id;
      world.step();
      expect(world.organisms.has(id)).toBe(units !== 16);
      expect(world.deaths).toBe(Number(units === 16));
      expect(world.births).toBe(0);
      expect(world.nextId).toBe(id + 1);
      expect(world.save().food).toEqual(units === 16 ? [index(120, 78)] : []);
      if (units === 16) {
        expect(energy(world).leavesGained).toBe(0);
        expect(world.lastDeath?.cause).toBe('energy');
      }
    });
  it('leaf-free armor has identical upkeep, temperature, energy and death in every light field', () => {
    const outcomes = [0, 8, 16].map((units) => {
      const world = leafWorld(units, 0, 0, 0.005);
      world.organisms.values().next().value!.genome.cells[0].type = 7;
      world.step();
      const { shadeHabitats: _shade, ...saved } = world.save();
      return saved;
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
  });
});

describe('S24-06 spatial and compositional metabolism', () => {
  for (let units = 0; units <= 16; units++)
    for (const offset of [-25, 0, 25])
      for (const event of ['none', 'active', 'expired'] as const)
        it(`u${units} refuge${offset} event${event} keeps exact existing stress arithmetic`, () => {
          const world = leafWorld(units, 0, 0, 10, 0.1),
            parent = world.organisms.values().next().value!;
          world.thermalRefuges.enabled = true;
          world.thermalRefuges.units[index(120, 78)] = offset;
          world.thermalRefuges.nonzeroCells = Number(offset !== 0);
          world.eventOffset = event === 'none' ? 0 : 0.32;
          world.eventUntil = event === 'active' ? 900 : event === 'expired' ? 1 : 0;
          const temp = localTemperature(
            120,
            78,
            1,
            0,
            event === 'active' ? 0.32 : 0,
            world.thermalRefuges,
          );
          const stress = Math.max(
            0,
            Math.abs(temp - parent.genome.preference) - parent.genome.tolerance,
          );
          const afterUpkeep = 10 - (0.012 + stress * 0.2);
          const full = 0.04 * daylight1 * (1 - stress);
          const expected = afterUpkeep + (units === 0 ? full : full * ((16 - units) / 16));
          world.step();
          expect(parent.energy).toBe(expected);
          expect(energy(world).leavesGained).toBe(expected - afterUpkeep);
          expect(energy(world).upkeepSpent).toBe(10 - afterUpkeep);
          expect(world.random.state).toBe(1831565836);
        });

  for (const rotation of [0, 1, 2, 3])
    for (const anchor of [
      [0, 0],
      [239, 155],
      [120, 78],
    ])
      for (const target of ['leaf', 'anchor', 'mouth', 'destination'] as const)
        it(`samples ordered rotated wrapped leaves r${rotation} anchor${anchor} target${target}`, () => {
          const world = new Ecosystem(
            { ...DEFAULTS, climate: 0, mutation: 0, nutrients: 0 },
            false,
          );
          const organism = world.spawn(
            {
              ...leafGenome(),
              cells: [
                { x: 0, y: 0, type: 7 },
                { x: 1, y: 0, type: 4 },
                { x: 2, y: 0, type: 4 },
                { x: 0, y: 1, type: 3 },
              ],
            },
            anchor[0],
            anchor[1],
          )!;
          organism.rotation = rotation;
          organism.energy = 10;
          world.occupied.fill(0);
          const places = positions(organism);
          for (const position of places) world.occupied[position] = organism.id;
          let destinationX = 1,
            destinationY = -1;
          for (let turn = 0; turn < rotation; turn++)
            [destinationX, destinationY] = [-destinationY, destinationX];
          const chosen =
            target === 'leaf'
              ? places[1]
              : target === 'mouth'
                ? places[3]
                : target === 'anchor'
                  ? places[0]
                  : index(anchor[0] + destinationX, anchor[1] + destinationY);
          world.shadeHabitats = parseShade({ version: 1, enabled: true, cells: [[chosen, 16]] });
          world.random.state = 23;
          const afterUpkeep = 10 - 0.012 * 4;
          const afterFirst = afterUpkeep + (target === 'leaf' ? 0 : nominalGain1);
          const expected = afterFirst + nominalGain1;
          world.step();
          expect(organism.energy).toBe(expected);
          expect(energy(world).leavesGained).toBe(
            afterFirst - afterUpkeep + (expected - afterFirst),
          );
          expect(energy(world).upkeepSpent).toBe(10 - afterUpkeep);
          expect(world.random.state).toBe(-631835647);
        });

  it('samples before movement and uses new positions on the following tick', () => {
    const world = new Ecosystem({ ...DEFAULTS, climate: 0, mutation: 0, nutrients: 0 }, false);
    const organism = world.spawn(
      {
        ...leafGenome(),
        cells: [
          { x: 0, y: 0, type: 4 },
          { x: 1, y: 0, type: 5 },
        ],
      },
      120,
      78,
    )!;
    organism.age = 1;
    organism.energy = 10;
    organism.direction = 0;
    world.random.state = 23;
    world.shadeHabitats = parseShade({ version: 1, enabled: true, cells: [[index(120, 78), 16]] });
    world.step();
    expect(organism.x).toBe(119);
    expect(energy(world).leavesGained).toBe(0);
    expect(organism.energy).toBe(10 - 0.012 * 2 - 0.03);
    expect(selectedLeafLight(world.shadeHabitats, organism)?.sumLightUnits).toBe(16);
    const before = organism.energy;
    world.step();
    const afterUpkeep = before - 0.012 * 2;
    const expected = afterUpkeep + 0.04 * (0.65 + 0.35 * Math.sin(2 / 180)) * (1 - 0);
    expect(organism.energy).toBe(expected);
    expect(energy(world).leavesGained).toBe(expected - afterUpkeep);
  });
});

describe('S24-07 transactional map and intervention installation', () => {
  it('edits no ecology, RNG, temperature, samples or energy; ordinary tools and terrain preserve shade', () => {
    const world = leafWorld(0),
      before = world.save();
    expect(world.changeShadeMode(true)).toBeNull();
    expect(world.paintShade(brush(), 239, 155).changedBrushCells).toBe(1);
    expect(world.paintShade(brush(-2), 239, 155).changedBrushCells).toBe(1);
    expect(world.shadeHabitats.units[37439]).toBe(2);
    world.changeShadeMode(false);
    const { interventions: _oldLog, shadeHabitats: _oldShade, ...oldEcology } = before;
    const { interventions: _newLog, shadeHabitats: _newShade, ...newEcology } = world.save();
    expect(newEcology).toEqual(oldEcology);
    for (const tool of ['food', 'wall', 'erase'] as const) world.paint(tool, 5, 5, 1);
    world.spawn(leafGenome(7), 20, 20);
    world.changeRefugeMode(true);
    world.paintRefuge({ rulesVersion: 1, tool: 'warm', units: 4, radius: 0 }, 0, 0);
    world.clearRefuges();
    world.changeTerrain('clear');
    world.changeTerrain('regenerate');
    expect(world.save().shadeHabitats).toEqual({ version: 1, enabled: false, cells: [[37439, 2]] });
    expect(world.tick).toBe(0);
    const nextSequence = world.save().interventions.totalEntries + 1;
    expect(world.clearShade()).toEqual({
      rowSequence: nextSequence,
      removedCells: 1,
      nonzeroCells: 0,
    });
    expect(world.shadeHabitats.enabled).toBe(false);
    expect(world.clearShade().rowSequence).toBeNull();
  });

  it('admits complete dabs and rejects whole capacity overflow, retaining prior gesture dabs', () => {
    const world = leafWorld(0, 0);
    world.shadeHabitats = field(
      true,
      Array.from({ length: 4095 }, (_, position) => [position, 1]),
    );
    const before = world.save();
    expect(() => world.paintShade(brush(4, 1), 120, 78)).toThrow(/capacity/);
    expect(world.save()).toEqual(before);
    const first = world.paintShade(brush(), 120, 78);
    expect(first.nonzeroCells).toBe(4096);
    const admitted = world.save();
    expect(() => world.paintShade(brush(), 122, 78, first.rowSequence)).toThrow(/capacity/);
    expect(world.save()).toEqual(admitted);
    expect(world.paintShade(brush(), 120, 78, first.rowSequence).nonzeroCells).toBe(4096);
    expect(world.save().interventions.entries.at(-1)?.kind).toBe('shade-paint');
    world.paintShade(brush(0), 0, 0);
    expect(world.paintShade(brush(), 122, 78).nonzeroCells).toBe(4096);
  });

  it('counts actual effective cells, freezes brush parameters and never consumes a refuge continuation', () => {
    const world = leafWorld(0, 0);
    const first = world.paintShade(brush(4, 8), 0, 0);
    expect(first.changedBrushCells).toBe(197);
    expect(world.paintShade(brush(4, 8), 0, 0, first.rowSequence).changedBrushCells).toBe(197);
    const row = world.save().interventions.entries.at(-1)!;
    expect(row).toMatchObject({
      kind: 'shade-paint',
      detail: { successfulCommands: 2, changedBrushCells: 394 },
    });
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    for (const changed of [
      brush(3, 8),
      brush(4, 7),
      brush(-4, 8),
      { ...brush(4, 8), rulesVersion: 2 },
    ]) {
      const before = world.save();
      expect(() => world.paintShade(changed as ShadeBrush, 0, 0, first.rowSequence)).toThrow(
        /continuation/,
      );
      expect(world.save()).toEqual(before);
    }
    world.changeRefugeMode(true);
    const thermal = world.paintRefuge(
      { rulesVersion: 1, tool: 'warm', units: 4, radius: 0 },
      10,
      10,
    );
    const before = world.save();
    expect(() => world.paintShade(brush(), 0, 0, thermal.rowSequence)).toThrow(/continuation/);
    expect(() => world.paintShade(brush(), 0, 0, first.rowSequence)).toThrow(/continuation/);
    expect(world.save()).toEqual(before);
  });

  it('leaves no rows or sequences for saturated paint, zero erase, empty clear or same mode', () => {
    const world = leafWorld(16, 0),
      before = world.save();
    expect(world.paintShade(brush(16), 120, 78)).toMatchObject({
      rowSequence: null,
      changedBrushCells: 0,
    });
    expect(world.paintShade(brush(0), 0, 0)).toMatchObject({
      rowSequence: null,
      changedBrushCells: 0,
    });
    expect(world.changeShadeMode(true)).toBeNull();
    expect(world.save()).toEqual(before);
    world.clearShade();
    const cleared = world.save();
    expect(world.clearShade().rowSequence).toBeNull();
    expect(world.save()).toEqual(cleared);
    world.changeShadeMode(false);
    const disabled = world.save();
    expect(() => world.paintShade(brush(), 0, 0)).toThrow(/disabled/);
    expect(() => world.changeShadeMode('true' as any)).toThrow(/Invalid/);
    expect(world.save()).toEqual(disabled);
  });

  it('enforces stroke4096 and sequence MAX_SAFE_INTEGER before any effective mutation', () => {
    const world = leafWorld(0, 0);
    for (let offset = 0; offset < 129; offset++) world.changeShadeMode(offset % 2 === 1);
    world.changeShadeMode(true);
    world.paintShade(brush(), 0, 0);
    const saved = world.save(),
      log = saved.interventions;
    expect(log.entries.length).toBe(128);
    expect(log.totalEntries).toBe(131);
    log.totalEntries = Number.MAX_SAFE_INTEGER;
    log.entries.forEach((row, position) => {
      row.sequence = Number.MAX_SAFE_INTEGER - 127 + position;
    });
    const exhausted = Ecosystem.load(JSON.stringify(saved)),
      before = exhausted.save();
    expect(exhausted.changeShadeMode(true)).toBeNull();
    expect(() => exhausted.changeShadeMode(false)).toThrow(/sequence limit/);
    expect(() => exhausted.paintShade(brush(), 1, 0)).toThrow(/sequence limit/);
    expect(() => exhausted.clearShade()).toThrow(/sequence limit/);
    expect(exhausted.save()).toEqual(before);
    const sequence = Number.MAX_SAFE_INTEGER;
    expect(exhausted.paintShade(brush(), 1, 0, sequence).rowSequence).toBe(sequence);
    expect(exhausted.save().interventions.totalEntries).toBe(sequence);
    const saturated = exhausted.save(),
      latest = saturated.interventions.entries.at(-1)!;
    if (latest.kind !== 'shade-paint') throw new Error('Expected retained shade stroke.');
    latest.detail.successfulCommands = STROKE_COMMAND_CAPACITY;
    latest.detail.changedBrushCells = STROKE_COMMAND_CAPACITY;
    const stroke = Ecosystem.load(JSON.stringify(saturated)),
      strokeBefore = stroke.save();
    expect(() => stroke.paintShade(brush(), 2, 0, sequence)).toThrow(/stroke exhausted/);
    expect(stroke.save()).toEqual(strokeBefore);
    stroke.shadeHabitats.units.fill(0);
    stroke.shadeHabitats.nonzeroCells = 0;
    expect(stroke.clearShade().rowSequence).toBeNull();
    expect(stroke.save().interventions).toEqual(strokeBefore.interventions);
  });

  const corruptions: ((candidate: any) => void)[] = [
    (candidate) => {
      delete candidate.shadeHabitats;
    },
    (candidate) => {
      candidate.shadeHabitats.enabled = false;
      candidate.shadeHabitats.cells.push([37440, 4]);
    },
    (candidate) => {
      candidate.shadeHabitats.cells.push([37439, 17]);
    },
    (candidate) => {
      candidate.shadeHabitats.extra = false;
    },
    (candidate) => {
      candidate.interventions.version = 3;
    },
    (candidate) => {
      candidate.interventions.entries[0].detail.after = false;
    },
    (candidate) => {
      candidate.interventions.entries[0].detail.before = true;
    },
    (candidate) => {
      candidate.interventions.entries[0].lastTick = 1;
    },
    (candidate) => {
      candidate.interventions.entries[0].detail.rulesVersion = 2;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.tool = 'warm';
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.rulesVersion = 2;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.units = 0;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.radius = 9;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.first.x = 240;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.last.y = -1;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.successfulCommands = 0;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.successfulCommands = 4097;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.changedBrushCells = 0;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.changedBrushCells = 198;
    },
    (candidate) => {
      candidate.interventions.entries[1].detail.removedOrganisms = 0;
    },
    (candidate) => {
      candidate.interventions.entries[2].detail.removedCells = 0;
    },
    (candidate) => {
      candidate.interventions.entries[2].detail.removedCells = 4097;
    },
    (candidate) => {
      candidate.interventions.entries[2].detail.rulesVersion = 2;
    },
    (candidate) => {
      candidate.interventions.entries[2].detail.extra = 0;
    },
    (candidate) => {
      candidate.shadeHabitats.enabled = false;
    },
    (candidate) => {
      candidate.interventions.entries[1].origin = 'automatic';
    },
    (candidate) => {
      candidate.interventions.entries.at(-1).sequence++;
    },
  ];
  for (const [offset, corrupt] of corruptions.entries())
    it(`rejects whole candidates through the final owned tuple/history row ${offset}`, () => {
      const world = new Ecosystem(DEFAULTS, false);
      world.changeShadeMode(true);
      world.paintShade(brush(4, 8), 0, 0);
      world.clearShade();
      const before = world.save(),
        candidate = structuredClone(before);
      corrupt(candidate);
      expect(() => Ecosystem.load(JSON.stringify(candidate))).toThrow();
      expect(world.save()).toEqual(before);
    });

  it('requires paint while known-enabled without reconstructing matrices or unknown prefix history', () => {
    const world = leafWorld(0, 0);
    world.paintShade(brush(), 0, 0);
    const saved = world.save();
    expect(Ecosystem.load(JSON.stringify(saved)).save()).toEqual(saved);
    saved.shadeHabitats.enabled = false;
    expect(() => Ecosystem.load(JSON.stringify(saved))).toThrow(/history/);
    saved.interventions.entries = [];
    saved.interventions.totalEntries = 0;
    expect(Ecosystem.load(JSON.stringify(saved)).save()).toEqual(saved);
  });

  it('validates zero tuples, the final tuple and disabled field bytes before installation; save planes are independent', () => {
    const world = leafWorld(0, 0),
      saved = world.save();
    saved.shadeHabitats = {
      version: 1,
      enabled: false,
      cells: [
        [0, 0],
        [37439, 16],
      ],
    };
    const loaded = Ecosystem.load(JSON.stringify(saved));
    expect(loaded.save().shadeHabitats.cells).toEqual([[37439, 16]]);
    saved.shadeHabitats.cells[1][1] = 1;
    loaded.save().shadeHabitats.cells[0][1] = 2;
    expect(loaded.shadeHabitats.units[37439]).toBe(16);
    const before = loaded.save();
    const oversized = JSON.stringify({
      ...before,
      shadeHabitats: { version: 1, enabled: false, cells: [[0, '雪'.repeat(22000)]] },
    });
    expect(() => Ecosystem.load(oversized)).toThrow(/64 KiB/);
    expect(loaded.save()).toEqual(before);
  });
});

describe('S24-08 native/historical genomes, histories and complete opaque state', () => {
  it('loads genuine native9 living/extinct passive genomes and carriers without wrapping them again', () => {
    const text = world9Text('native9-opaque-extinct'),
      original = JSON.parse(text);
    const world = Ecosystem.load(text);
    expect(projectWorld9(world.save())).toEqual(original);
    expect(world.save().lineageArchive.summaries.some((row) => row.extinctTick !== null)).toBe(
      true,
    );
    expect(world.save().organisms[0].genome.behavior.mode).toBe('evolved');
    expect(world.save().organisms[0].genome.legacyExtensions?.length).toBeGreaterThan(0);
    for (const row of world.save().lineageArchive.summaries) {
      expect(row.foundingGenome?.behavior.mode).toBe('evolved');
      expect(row.foundingGenome?.legacyExtensions?.length).toBeGreaterThan(0);
    }
    const saved = world.save();
    expect(Ecosystem.load(JSON.stringify(saved)).save()).toEqual(saved);
    const detached = world.save();
    (detached.settings as any).__proto__.prototype.nested[1].text = 'changed';
    (detached.organisms[0] as any).opaque.constructor[0] = 'changed';
    expect(world.save()).toEqual(saved);
  });

  for (const version of [9, 10, 11, 12])
    for (const target of ['living', 'extinct'] as const)
      for (const defect of ['behavior-version', 'reaction', 'carrier'] as const)
        it(`keeps strict native validation v${version} ${target} ${defect}`, () => {
          const world = Ecosystem.load(world9Text('native9-opaque-extinct'));
          const saved: any =
            version === 9 ? projectWorld9(world.save()) : { ...world.save(), version };
          const genome =
            target === 'living'
              ? saved.organisms[0].genome
              : saved.lineageArchive.summaries.find((row: any) => row.extinctTick !== null)
                  .foundingGenome;
          if (defect === 'behavior-version') genome.behavior.version = version >= 11 ? 3 : 2;
          else if (defect === 'reaction') genome.behavior.reactions.food = 'win';
          else genome.legacyExtensions = [['__proto__', [['number', 'invalid']]]];
          const before = world.save();
          expect(() => Ecosystem.load(JSON.stringify(saved))).toThrow();
          expect(world.save()).toEqual(before);
        });

  for (const version of [2, 3, 4, 5, 6, 7, 8, 9])
    for (const tick of [0, 25, 29, 30, 31])
      for (const populated of [false, true])
        it(`preserves v${version} populated${populated} tick${tick} cadence, RNG, order and shock continuation`, () => {
          const source = leafWorld(0, 0),
            initial = source.save();
          const world = Ecosystem.load(
            JSON.stringify({
              ...initial,
              shadeHabitats: { version: 1, enabled: false, cells: [] },
            }),
          );
          if (!populated) world.kill(world.organisms.values().next().value!, 'manual');
          world.shock('cold');
          advance(world, tick);
          const current = world.save();
          const old =
            version === 9
              ? legacyV9(current)
              : version === 8
                ? legacyV8(current)
                : version === 7
                  ? legacyV7(current)
                  : version === 6
                    ? legacyV6(current)
                    : version === 5
                      ? legacyV5(current)
                      : version === 4
                        ? legacyV4(current)
                        : version === 3
                          ? legacyV3(current)
                          : (() => {
                              const {
                                telemetry: _telemetry,
                                interventions: _manual,
                                ...ecology
                              } = legacyV5(current);
                              return { ...ecology, version: 2 };
                            })();
          const migrated = Ecosystem.load(
            JSON.stringify({
              ...old,
              shadeHabitats: { invalid: 'historically opaque root extension' },
            }),
          );
          expect(migrated.save().shadeHabitats).toEqual({ version: 1, enabled: false, cells: [] });
          expect(migrated.save().organisms).toEqual(current.organisms);
          expect(migrated.random.state).toBe(current.random);
          expect(migrated.tick).toBe(tick);
          expect(migrated.eventUntil).toBe(current.eventUntil);
          expect(migrated.eventOffset).toBe(current.eventOffset);
          const history = migrated.save().telemetry;
          expect(history.samples.length).toBe(version === 2 ? 0 : Math.floor(tick / 30));
          const firstBoundary = (Math.floor(tick / 30) + 1) * 30;
          advance(migrated, firstBoundary - tick);
          expect(migrated.save().telemetry.samples.at(-1)?.tick).toBe(firstBoundary);
          const resumed = Ecosystem.load(JSON.stringify(migrated.save()));
          advance(migrated, 901 - firstBoundary);
          advance(resumed, 901 - firstBoundary);
          expect(migrated.save()).toEqual(resumed.save());
          expect(migrated.frame().offset).toBe(0);
        });

  it('preserves raw overflow, signed zero and prototype-looking own settings/organism properties natively', () => {
    const original = JSON.parse(world9Text('native9-opaque-extinct'));
    for (const target of [original.settings, original.organisms[0]]) {
      Object.defineProperty(target, 'constructor', {
        value: { overflow: 'positive', negative: 'negative', signed: 'signed' },
        enumerable: true,
      });
    }
    const raw = JSON.stringify(original)
      .replaceAll('"overflow":"positive"', '"overflow":1e400')
      .replaceAll('"negative":"negative"', '"negative":-1e400')
      .replaceAll('"signed":"signed"', '"signed":-0');
    const parsed = JSON.parse(raw),
      world = Ecosystem.load(raw),
      saved = world.save();
    identicalRecords(saved.settings, parsed.settings);
    identicalRecords(saved.organisms, parsed.organisms);
    expect(Object.is((saved.settings as any).constructor.signed, -0)).toBe(true);
    expect((saved.settings as any).constructor.overflow).toBe(Infinity);
    const reloaded = Ecosystem.load(JSON.stringify(saved)).save();
    expect((reloaded.settings as any).constructor).toEqual({
      overflow: null,
      negative: null,
      signed: 0,
    });
    identicalRecords(world.save(), saved);
  });
});
const file = (enabled = true, cells: [number, number][] = []): ShadeFile => ({
  version: 1,
  enabled,
  cells,
});
const field = (enabled = true, cells: [number, number][] = []) => parseShade(file(enabled, cells));
// Only a test consumer installs admitted candidates. The production module is pure.
const install = (target: ShadeField, candidate: ShadeDab) => {
  for (const [position, units] of candidate.changes) target.units[position] = units;
  target.nonzeroCells = candidate.nonzeroCells;
};
const snapshot = (stored: ShadeField) => ({
  ...stored,
  units: Buffer.from(stored.units).toString('base64'),
});
const body = (
  cells: Cell[],
  rotation = 0,
  x = 0,
  y = 0,
): Pick<Organism, 'x' | 'y' | 'rotation' | 'genome'> => ({
  x,
  y,
  rotation,
  genome: {
    cells,
    preference: 0.5,
    tolerance: 0.2,
    tempo: 8,
    behavior: { version: 1, mode: 'legacy' },
  },
});

describe('bounded shade owned-field codec', () => {
  it('starts disabled with a fresh zeroed fixed-size unsigned plane', () => {
    const first = emptyShade(),
      second = emptyShade();
    expect(SHADE_CAPACITY).toBe(4096);
    expect(SHADE_MAX_BYTES).toBe(65536);
    expect(SHADE_UNITS_PER_FULL_LIGHT).toBe(16);
    expect(first).toMatchObject({ version: 1, enabled: false, nonzeroCells: 0 });
    expect(first.units).toBeInstanceOf(Uint8Array);
    expect(first.units.byteLength).toBe(WIDTH * HEIGHT);
    expect(first.units.every((units) => units === 0)).toBe(true);
    first.units[0] = 16;
    expect(second.units[0]).toBe(0);
  });

  it.each([false, true])('roundtrips every attenuation value with mode %s', (enabled) => {
    const cells: [number, number][] = Array.from({ length: 17 }, (_, units) => [units, units]);
    cells.push([WIDTH * HEIGHT - 1, 16]);
    const source = file(enabled, cells),
      before = structuredClone(source),
      decoded = parseShade(source),
      encoded = shadeFile(decoded);
    expect(source).toEqual(before);
    expect(decoded.nonzeroCells).toBe(17);
    expect(encoded).toEqual(file(enabled, cells.slice(1)));
    expect(shadeFile(parseShade(JSON.parse(JSON.stringify(encoded))))).toEqual(encoded);
    for (let units = 0; units <= 16; units++) {
      expect(decoded.units[units]).toBe(units);
      expect(activeShadeUnits(decoded, units, 0)).toBe(enabled ? units : 0);
      expect((16 - activeShadeUnits(decoded, units, 0)) / 16).toBe(enabled ? 1 - units / 16 : 1);
    }
  });

  const invalidFields: unknown[] = [
    undefined,
    null,
    false,
    1,
    'shade',
    [],
    {},
    { enabled: false, cells: [] },
    { version: 1, cells: [] },
    { version: 1, enabled: false },
    { version: 0, enabled: false, cells: [] },
    { version: 2, enabled: false, cells: [] },
    { version: '1', enabled: false, cells: [] },
    { version: 1, enabled: 0, cells: [] },
    { version: 1, enabled: 'false', cells: [] },
    { version: 1, enabled: false, cells: {} },
    { version: 1, enabled: false, cells: null },
    { ...file(false), extra: 1 },
    { ...file(false), [Symbol('extra')]: 1 },
    Object.defineProperty(file(false), 'hidden', { value: 1 }),
    Object.assign(Object.create({ version: 1 }), { enabled: false, cells: [], extra: 1 }),
    Object.assign(Object.create({ cells: [] }), { version: 1, enabled: false, extra: 1 }),
    ...['__proto__', 'constructor', 'prototype'].map((key) =>
      Object.defineProperty(file(false), key, { value: 1, enumerable: true }),
    ),
  ];
  it.each(invalidFields.map((value, test) => [test, value] as const))(
    'rejects malformed own field %i even when disabled',
    (_test, value) => {
      expect(() => parseShade(value)).toThrow(/Invalid painted shade field/);
    },
  );

  const invalidCells: unknown[] = [
    [null],
    [{}],
    [[0]],
    [[0, 1, 2]],
    [new Array(2)],
    ...[-1, WIDTH * HEIGHT, 0.5, NaN, Infinity, -Infinity, '0', null, false, {}].map((position) => [
      [position, 1],
    ]),
    ...[-1, 17, 0.5, NaN, Infinity, -Infinity, '1', null, false, {}].map((units) => [[0, units]]),
    [
      [0, 1],
      [0, 1],
    ],
    [
      [1, 1],
      [0, 1],
    ],
    [
      [0, 0],
      [0, 1],
    ],
    [
      [1, 0],
      [0, 0],
    ],
  ];
  for (const enabled of [false, true])
    it.each(invalidCells.map((cells, test) => [test, cells] as const))(
      `rejects malformed tuple/order %i with mode ${enabled}`,
      (_test, cells) => {
        expect(() => parseShade({ version: 1, enabled, cells })).toThrow(
          /Invalid painted shade cell/,
        );
      },
    );

  it('checks the last tuple before returning without rewriting caller data', () => {
    const source = file(
        false,
        Array.from({ length: SHADE_CAPACITY }, (_, position) => [position, 16]),
      ),
      independent = parseShade(source),
      before = independent.units.slice();
    source.cells.at(-1)![1] = 17;
    const invalid = structuredClone(source);
    expect(() => parseShade(source)).toThrow(/cell/);
    expect(source).toEqual(invalid);
    expect(independent.units).toEqual(before);
    expect(independent.nonzeroCells).toBe(SHADE_CAPACITY);
  });

  it.each([false, true])('bounds tuple admission including zeros with mode %s', (enabled) => {
    for (const units of [0, 1, 16]) {
      const source = file(
          enabled,
          Array.from({ length: SHADE_CAPACITY }, (_, position) => [position, units]),
        ),
        decoded = parseShade(source);
      expect(decoded.nonzeroCells).toBe(units ? SHADE_CAPACITY : 0);
      expect(shadeFile(decoded).cells).toHaveLength(units ? SHADE_CAPACITY : 0);
      source.cells.push([SHADE_CAPACITY, units]);
      expect(() => parseShade(source)).toThrow(/field/);
    }
  });

  it('enforces the owned UTF-8 byte bound before malformed cell validation, also while off', () => {
    const overhead = new TextEncoder().encode(
      JSON.stringify({ version: 1, enabled: false, cells: [[0, '']] }),
    ).byteLength;
    for (const [text, extra] of [
      ['x'.repeat(SHADE_MAX_BYTES - overhead), 0],
      ['x'.repeat(SHADE_MAX_BYTES - overhead + 1), 1],
      ['é'.repeat(Math.floor((SHADE_MAX_BYTES - overhead) / 2) + 1), 1],
    ] as const) {
      const source = { version: 1, enabled: false, cells: [[0, text]] };
      expect(() => parseShade(source)).toThrow(extra ? /64 KiB/ : /Invalid painted shade cell/);
    }
  });

  it('canonicalizes only owned integer zero and detaches decode and encode', () => {
    const source = file(false, [
        [-0, -0],
        [1, 8],
        [WIDTH * HEIGHT - 1, 16],
      ]),
      decoded = parseShade(source),
      other = parseShade(source),
      encoded = shadeFile(decoded);
    expect(encoded.cells).toEqual([
      [1, 8],
      [WIDTH * HEIGHT - 1, 16],
    ]);
    expect(Object.is(source.cells[0][0], -0)).toBe(true);
    expect(Object.is(source.cells[0][1], -0)).toBe(true);
    source.cells[1][1] = 2;
    expect(decoded.units[1]).toBe(8);
    encoded.cells[0][1] = 3;
    encoded.cells.push([2, 4]);
    expect(decoded.units[1]).toBe(8);
    decoded.units[1] = 5;
    expect(other.units[1]).toBe(8);
    expect(encoded.cells[0][1]).toBe(3);
    expect(shadeFile(other).enabled).toBe(false);
  });
});

describe('stored summaries and effective wrapped light', () => {
  it.each([false, true])('summarizes stored values independently of mode %s', (enabled) => {
    const empty = field(enabled);
    expect(shadeSummary(empty)).toEqual({
      version: 1,
      enabled,
      nonzeroCells: 0,
      capacity: 4096,
      unitsPerFullLight: 16,
      minimumStoredLightUnits: 16,
      maximumStoredLightUnits: 16,
      sumShadeUnits: 0,
    });
    const mixed = field(enabled, [
        [0, 1],
        [100, 8],
        [WIDTH * HEIGHT - 1, 16],
      ]),
      plane = { version: 1 as const, enabled, units: mixed.units.slice() };
    expect(shadeSummary(plane)).toEqual({
      ...shadeSummary(empty),
      nonzeroCells: 3,
      minimumStoredLightUnits: 0,
      sumShadeUnits: 25,
    });
    const maximum = field(
      enabled,
      Array.from({ length: SHADE_CAPACITY }, (_, position) => [position, 16]),
    );
    expect(shadeSummary(maximum)).toMatchObject({
      nonzeroCells: 4096,
      minimumStoredLightUnits: 0,
      maximumStoredLightUnits: 16,
      sumShadeUnits: 65536,
    });
    expect(shadeSummary(field(enabled, [[0, 3]]))).toMatchObject({
      minimumStoredLightUnits: 13,
      maximumStoredLightUnits: 16,
    });
  });

  it('wraps both coordinates at every edge and corner while disabled paint stays stored', () => {
    const corners: [number, number][] = [
        [0, 0],
        [239, 0],
        [0, 155],
        [239, 155],
      ],
      stored = field(
        true,
        corners.map(([x, y], cell) => [index(x, y), cell + 1]),
      );
    for (const [cell, [x, y]] of corners.entries())
      for (const horizontal of [-2, -1, 0, 1, 2])
        for (const vertical of [-2, -1, 0, 1, 2])
          expect(activeShadeUnits(stored, x + horizontal * WIDTH, y + vertical * HEIGHT)).toBe(
            cell + 1,
          );
    const before = shadeFile(stored);
    stored.enabled = false;
    for (const [x, y] of corners) expect(activeShadeUnits(stored, x, y)).toBe(0);
    expect(shadeFile(stored)).toEqual({ ...before, enabled: false });
  });
});

describe('candidate shade dabs and whole-dab admission', () => {
  it('validates all signed intensities and radii with distinct tools', () => {
    for (let radius = 0; radius <= 8; radius++)
      for (let units = -16; units <= 16; units++) {
        expect(validShadeBrush(brush(units, radius))).toBe(true);
        expect(shadeTool(brush(units).tool)).toBe(true);
      }
    for (const tool of ['warm', 'cool', 'erase-temperature', 'erase', 'food', '', null, 0])
      expect(shadeTool(tool)).toBe(false);
  });

  const invalidBrushes: unknown[] = [
    undefined,
    null,
    false,
    1,
    '',
    [],
    {},
    ...[0, 2, '1', null].map((rulesVersion) => ({ ...brush(), rulesVersion })),
    ...[-1, 9, 0.5, NaN, Infinity, '0', null].map((radius) => ({ ...brush(), radius })),
    ...[0, -1, 17, 0.5, NaN, Infinity, '4', null].map((units) => ({ ...brush(), units })),
    ...[0, 1, -17, -0.5, -Infinity, '-4', null].map((units) => ({ ...brush(-4), units })),
    ...[1, -1, '0', null].map((units) => ({ ...brush(0), units })),
    { ...brush(), tool: 'warm' },
  ];
  it.each(invalidBrushes.map((value, test) => [test, value] as const))(
    'rejects malformed brush %i without writes',
    (_test, value) => {
      const stored = field(true, [[0, 8]]),
        before = snapshot(stored);
      expect(validShadeBrush(value)).toBe(false);
      expect(() => shadeDab(stored, value as ShadeBrush, 0, 0)).toThrow(/Invalid/);
      expect(snapshot(stored)).toEqual(before);
    },
  );

  it('rejects malformed anchors and disabled operations without modifying stored paint', () => {
    const stored = field(true, [[0, 8]]),
      before = snapshot(stored);
    for (const x of [-1, WIDTH, 0.5, NaN, Infinity, '0', null])
      expect(() => shadeDab(stored, brush(), x as number, 0)).toThrow(/Invalid/);
    for (const y of [-1, HEIGHT, 0.5, NaN, Infinity, '0', null])
      expect(() => shadeDab(stored, brush(), 0, y as number)).toThrow(/Invalid/);
    expect(snapshot(stored)).toEqual(before);
    stored.enabled = false;
    for (const units of [-16, 0, 16])
      expect(() => shadeDab(stored, brush(units), 0, 0)).toThrow(/disabled/);
    expect(snapshot(stored)).toEqual({ ...before, enabled: false });
  });

  it('generates every disk exactly once across all edges/corners without mutating its source', () => {
    const diskSizes = [1, 5, 13, 29, 49, 81, 113, 149, 197],
      anchors = [
        [0, 0],
        [239, 0],
        [0, 155],
        [239, 155],
        [120, 0],
        [120, 155],
        [0, 78],
        [239, 78],
        [120, 78],
      ];
    for (const [x, y] of anchors)
      for (let radius = 0; radius <= 8; radius++) {
        const stored = field(),
          before = snapshot(stored),
          candidate = shadeDab(stored, brush(4, radius), x, y),
          expected: number[] = [];
        // An independent toroidal-distance oracle scans the whole plane.
        for (let row = 0; row < HEIGHT; row++)
          for (let column = 0; column < WIDTH; column++) {
            const dx = Math.min(Math.abs(column - x), WIDTH - Math.abs(column - x)),
              dy = Math.min(Math.abs(row - y), HEIGHT - Math.abs(row - y));
            if (dx * dx + dy * dy <= radius * radius) expected.push(row * WIDTH + column);
          }
        expect(candidate.changes.map(([position]) => position).sort((a, b) => a - b)).toEqual(
          expected,
        );
        expect(candidate.changedBrushCells).toBe(diskSizes[radius]);
        expect(candidate.nonzeroCells).toBe(diskSizes[radius]);
        expect(candidate.changes.every(([, units]) => units === 4)).toBe(true);
        expect(snapshot(stored)).toEqual(before);
      }
  });

  it('saturates every valid old value and signed intensity, tracking only effective changes', () => {
    for (let previous = 0; previous <= 16; previous++)
      for (let units = -16; units <= 16; units++) {
        const stored = field(true, previous ? [[0, previous]] : []),
          candidate = shadeDab(stored, brush(units), 0, 0),
          next = units === 0 ? 0 : Math.max(0, Math.min(16, previous + units));
        expect(candidate).toEqual({
          changes: previous === next ? [] : [[0, next]],
          nonzeroCells: Number(next !== 0),
          changedBrushCells: Number(previous !== next),
        });
        expect(stored.units[0]).toBe(previous);
        expect(stored.nonzeroCells).toBe(Number(previous !== 0));
      }
  });

  it('returns detached candidates that can be rejected for later admission without writes', () => {
    const stored = field(true, [[0, 8]]),
      before = snapshot(stored),
      first = shadeDab(stored, brush(4, 1), 0, 0),
      second = shadeDab(stored, brush(4, 1), 0, 0);
    first.changes[0][1] = 16;
    first.changes.push([100, 16]);
    first.nonzeroCells = 500;
    expect(snapshot(stored)).toEqual(before);
    expect(second).toEqual(shadeDab(stored, brush(4, 1), 0, 0));
    stored.units[0] = 1;
    expect(second.changes.find(([position]) => position === 0)).toEqual([0, 12]);
  });

  it('rejects a mixed disk whole at 4095, then admits exactly the last free cell', () => {
    const stored = field(
        true,
        Array.from({ length: 4095 }, (_, position) => [position, 8]),
      ),
      before = snapshot(stored);
    // This disk would alter existing paint and introduce multiple new cells.
    expect(() => shadeDab(stored, brush(4, 1), 14, 17)).toThrow(/Whole dab rejected/);
    expect(snapshot(stored)).toEqual(before);
    const admitted = shadeDab(stored, brush(4), 15, 17);
    expect(admitted).toEqual({ changes: [[4095, 4]], nonzeroCells: 4096, changedBrushCells: 1 });
    expect(snapshot(stored)).toEqual(before);
    install(stored, admitted);
    const full = snapshot(stored);
    expect(() => shadeDab(stored, brush(4), 16, 17)).toThrow(/capacity/);
    expect(() => shadeDab(stored, brush(4, 1), 15, 17)).toThrow(/Whole dab rejected/);
    expect(snapshot(stored)).toEqual(full);
    expect(stored.units[4095]).toBe(4); // Earlier admitted dab remains.
  });

  it('permits saturation, existing edits, erasure and later admission at capacity', () => {
    const stored = field(
      true,
      Array.from({ length: SHADE_CAPACITY }, (_, position) => [position, 16]),
    );
    expect(shadeDab(stored, brush(16), 0, 0)).toEqual({
      changes: [],
      nonzeroCells: 4096,
      changedBrushCells: 0,
    });
    install(stored, shadeDab(stored, brush(-1), 0, 0));
    expect(stored.units[0]).toBe(15);
    expect(stored.nonzeroCells).toBe(4096);
    install(stored, shadeDab(stored, brush(-16), 0, 0));
    expect(stored.units[0]).toBe(0);
    expect(stored.nonzeroCells).toBe(4095);
    install(stored, shadeDab(stored, brush(16), 16, 17));
    expect(stored.nonzeroCells).toBe(4096);
    install(stored, shadeDab(stored, brush(0, 1), 16, 17));
    expect(stored.nonzeroCells).toBe(4093);
    expect(shadeFile(stored).cells).toHaveLength(stored.nonzeroCells);
    expect(shadeDab(stored, brush(0, 1), 16, 17).changes).toEqual([]);
    expect(shadeDab(stored, brush(-16, 1), 16, 17).changes).toEqual([]);
  });
});

describe('current per-leaf exposure, separate from temperature and metabolism', () => {
  it('returns null for no selection and every leaf-free functional type', () => {
    expect(selectedLeafLight(field(), null)).toBeNull();
    expect(selectedLeafLight(field(), body([]))).toBeNull();
    for (const type of [3, 5, 6, 7, 8] as const)
      expect(selectedLeafLight(field(true, [[0, 16]]), body([{ x: 0, y: 0, type }]))).toBeNull();
  });

  it('reports every exact light fraction with disabled paint ignored', () => {
    const organism = body([{ x: 0, y: 0, type: 4 }]);
    for (let units = 0; units <= 16; units++)
      for (const enabled of [false, true]) {
        const stored = field(enabled, units ? [[0, units]] : []),
          lightUnits = enabled ? 16 - units : 16;
        expect(selectedLeafLight(stored, organism)).toEqual({
          leafCells: 1,
          minimumLightUnits: lightUnits,
          maximumLightUnits: lightUnits,
          sumLightUnits: lightUnits,
        });
      }
  });

  it.each([0, 1, 2, 3])('samples only actual wrapped leaf positions at rotation %i', (rotation) => {
    const offsets = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ],
      [dx, dy] = offsets[rotation],
      [mx, my] = offsets[(rotation + 1) % 4],
      organism = body(
        [
          { x: 0, y: 0, type: 3 },
          { x: 1, y: 0, type: 4 },
          { x: 0, y: 1, type: 5 },
          { x: 2, y: 0, type: 4 },
          { x: 3, y: 0, type: 4 },
        ],
        rotation,
      ),
      stored = field(
        true,
        [
          [index(dx, dy), 8],
          [index(2 * dx, 2 * dy), 16],
        ].sort((a, b) => a[0] - b[0]) as [number, number][],
      ),
      before = structuredClone(organism);
    expect(selectedLeafLight(stored, organism)).toEqual({
      leafCells: 3,
      minimumLightUnits: 0,
      maximumLightUnits: 16,
      sumLightUnits: 24,
    });
    const exposure = selectedLeafLight(stored, organism)!;
    expect(exposure.sumLightUnits / (16 * exposure.leafCells)).toBe(0.5);
    exposure.sumLightUnits = 0;
    expect(selectedLeafLight(stored, organism)!.sumLightUnits).toBe(24);
    expect(organism).toEqual(before);
    for (const position of [0, index(mx, my), index(4 * dx, 4 * dy)]) {
      const unrelated = field(true, [[position, 16]]);
      expect(selectedLeafLight(unrelated, organism)).toEqual({
        leafCells: 3,
        minimumLightUnits: 16,
        maximumLightUnits: 16,
        sumLightUnits: 48,
      });
    }
    stored.enabled = false;
    expect(selectedLeafLight(stored, organism)).toEqual({
      leafCells: 3,
      minimumLightUnits: 16,
      maximumLightUnits: 16,
      sumLightUnits: 48,
    });
  });

  it('bounds sixteen-leaf sums and updates current exposure after an anchor move', () => {
    const cells: Cell[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cells.push({ x, y, type: 4 });
    const organism = body(cells, 0, WIDTH - 1, HEIGHT - 1),
      stored = field(true, [[index(WIDTH - 1, HEIGHT - 1), 16]]);
    expect(selectedLeafLight(field(), organism)).toEqual({
      leafCells: 16,
      minimumLightUnits: 16,
      maximumLightUnits: 16,
      sumLightUnits: 256,
    });
    expect(selectedLeafLight(stored, organism)).toEqual({
      leafCells: 16,
      minimumLightUnits: 0,
      maximumLightUnits: 16,
      sumLightUnits: 240,
    });
    const dark = field(
      true,
      cells.map(({ x, y }) => [index(x, y), 16] as [number, number]),
    );
    expect(selectedLeafLight(dark, body(cells))).toEqual({
      leafCells: 16,
      minimumLightUnits: 0,
      maximumLightUnits: 0,
      sumLightUnits: 0,
    });
    organism.x = 0;
    expect(selectedLeafLight(stored, organism)).toEqual({
      leafCells: 16,
      minimumLightUnits: 16,
      maximumLightUnits: 16,
      sumLightUnits: 256,
    });
  });
});
