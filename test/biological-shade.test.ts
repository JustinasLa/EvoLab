import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  WORLD_VERSION,
  index,
  positions,
  Random,
  type Genome,
} from '../src/model';
import {
  biologicalShadeField,
  biologicalShadeSummary,
  biologicalShadeExposure,
  parseBiologicalShade,
  combinedShadeUnits,
} from '../src/biological-shade';
import {
  biologicalShadeDescription,
  biologicalShadeInspection,
  biologicalShadeMarkup,
  biologicalShadeTile,
} from '../src/biological-shade-view';
import { localTemperature } from '../src/refuges';
import { selectedLeafLight } from '../src/shade';
import { nutrientSummary, NUTRIENT_TOTAL } from '../src/nutrients';
import { measurementEnvelope } from '../src/measurement-export';
import { organismHtml } from '../src/view';
import { newController } from '../src/neural';

const body = (cells: Genome['cells'] = [{ x: 0, y: 0, type: 7 }]): Genome => ({
  cells,
  preference: 0.5,
  tolerance: 0.12,
  tempo: 12,
  behavior: { version: 1, mode: 'legacy' },
});
const world = (enabled = true, finite = false) =>
  new Ecosystem({ ...DEFAULTS, climate: 0, mutation: 0, nutrients: 0 }, false, {
    biologicalShade: enabled,
    nutrientCycle: finite,
  });
const restore = (value: unknown) => Ecosystem.load(JSON.stringify(value));

describe('bounded passive armor shade', () => {
  it('reduces actual leaf-food production while retaining mandatory dark trials and direction draws', () => {
    const daylight = 0.65 + 0.35 * Math.sin(1 / 180);
    let seed = 1;
    for (; seed < 10000; seed++) {
      const random = new Random(seed),
        trial = random.next(),
        direction = random.int(4);
      if (trial >= 0.2 * daylight * 0.75 && trial < 0.2 * daylight && direction !== 0) break;
    }
    expect(seed).toBeLessThan(10000);
    const enabled = world(),
      disabled = world(false);
    for (const habitat of [enabled, disabled]) {
      habitat.spawn(body(), 50, 50);
      habitat.spawn(body([{ x: 0, y: 0, type: 4 }]), 49, 50);
      habitat.changeSettings({ nutrients: 20 });
      habitat.random.state = seed;
      habitat.step();
    }
    expect(enabled.save().food).toHaveLength(0);
    expect(disabled.save().food).toHaveLength(1);
    const oneTrial = new Random(seed);
    oneTrial.next();
    expect(enabled.random.state).toBe(oneTrial.state);
    oneTrial.int(4);
    expect(disabled.random.state).toBe(oneTrial.state);
    const dark = world();
    dark.spawn(body([{ x: 0, y: 0, type: 4 }]), 20, 20);
    for (const [column, row] of [
      [19, 20],
      [21, 20],
      [20, 19],
      [20, 21],
    ])
      dark.spawn(body(), column, row);
    dark.changeSettings({ nutrients: 20 });
    dark.random.state = seed;
    dark.step();
    const expected = new Random(seed);
    expected.next();
    expect(dark.random.state).toBe(expected.state);
    expect(dark.telemetrySnapshot().pending.energy.leavesGained).toBe(0);
    expect(dark.save().food).toEqual([]);
  });
  it('derives a five-cell wrapped footprint with saturation and no painted edits', () => {
    const habitat = world();
    const source = habitat.spawn(body(), 0, 0)!;
    const field = biologicalShadeField(habitat.organisms.values());
    expect(biologicalShadeSummary(field)).toEqual({
      armorCells: 1,
      affectedCells: 5,
      maximumUnits: 4,
      sumUnits: 20,
    });
    for (const target of [index(0, 0), index(-1, 0), index(1, 0), index(0, -1), index(0, 1)])
      expect(field.units[target]).toBe(4);
    expect(field.units[index(1, 1)]).toBe(0);
    for (const [column, row] of [
      [1, 0],
      [WIDTH - 1, 0],
      [0, 1],
      [0, HEIGHT - 1],
    ])
      habitat.spawn(body(), column, row);
    expect(habitat.frame().biologicalShade!.units[0]).toBe(16);
    expect(combinedShadeUnits(14, 4)).toBe(16);
    expect(combinedShadeUnits(2, 4)).toBe(6);
    expect(biologicalShadeExposure(field, habitat.shadeHabitats, source)).toEqual({
      anchorUnits: 4,
      armorCells: 1,
      leafCells: 0,
      biologicalLeafUnits: 0,
      paintedLeafUnits: 0,
    });
    expect(habitat.save().shadeHabitats.cells).toEqual([]);
    expect(habitat.save().thermalRefuges.cells).toEqual([]);
  });

  it('rotates the source cell before casting, and updates on paused movement and removal', () => {
    const habitat = world();
    const source = habitat.spawn(
      body([
        { x: 0, y: 0, type: 4 },
        { x: 1, y: 0, type: 7 },
      ]),
      0,
      0,
    )!;
    expect(habitat.move(source, 0, 0, 1)).toBe(true);
    const armorPosition = positions(source)[1];
    expect(armorPosition).toBe(index(0, 1));
    expect(habitat.frame().biologicalShade!.units[index(0, 2)]).toBe(4);
    expect(habitat.frame().biologicalShade!.units[index(2, 0)]).toBe(0);
    habitat.move(source, 10, 0);
    expect(habitat.frame().biologicalShade!.units[armorPosition]).toBe(0);
    habitat.kill(source, 'manual');
    expect(habitat.presentation().biologicalShade!.armorCells).toBe(0);
    expect(habitat.frame().biologicalShade!.units.some(Boolean)).toBe(false);
    expect(habitat.tick).toBe(0);
  });

  it.each([false, true])(
    'applies real self/neighbor hot benefits and cold costs, finite=%s',
    (finite) => {
      for (const preference of [0.5, 1]) {
        const enabled = world(true, finite),
          disabled = world(false, finite);
        for (const habitat of [enabled, disabled]) {
          const anatomy = body([
            { x: 0, y: 0, type: 7 },
            { x: 1, y: 0, type: 8 },
          ]);
          anatomy.preference = preference;
          habitat.spawn(anatomy, 50, 50);
          habitat.spawn({ ...body([{ x: 0, y: 0, type: 8 }]), preference }, 49, 50);
          if (preference === 0.5) habitat.shock(0.32);
          habitat.step();
        }
        const shaded = [...enabled.organisms.values()],
          plain = [...disabled.organisms.values()];
        if (preference === 0.5) {
          expect(shaded[0].energy - plain[0].energy).toBeCloseTo(0.008, 12);
          expect(shaded[1].energy - plain[1].energy).toBeCloseTo(0.008, 12);
        } else {
          expect(shaded[0].energy - plain[0].energy).toBeCloseTo(-0.024, 12);
          expect(shaded[1].energy - plain[1].energy).toBeCloseTo(-0.008, 12);
        }
        if (finite) {
          expect(
            nutrientSummary(enabled.nutrientCycle!, enabled.organisms.values(), enabled.food).total,
          ).toBe(NUTRIENT_TOTAL);
          const budget = enabled.nutrientCycle!.budget!;
          expect(budget.before + budget.sunlight - budget.after).toBeCloseTo(budget.dissipated, 10);
        }
      }
    },
  );

  it('charges armor maintenance and applies the combined light penalty per actual leaf', () => {
    const habitat = world();
    const source = habitat.spawn(
      body([
        { x: 0, y: 0, type: 7 },
        { x: 1, y: 0, type: 4 },
      ]),
      30,
      30,
    )!;
    const neighbor = habitat.spawn(body([{ x: 0, y: 0, type: 4 }]), 29, 30)!;
    habitat.changeShadeMode(true);
    habitat.paintShade({ rulesVersion: 1, tool: 'shade', radius: 0, units: 14 }, 31, 30);
    const before = habitat.save(),
      neighborEnergy = neighbor.energy;
    habitat.step();
    expect(source.energy).toBeCloseTo(before.organisms[0].energy - 0.024 - 0.008, 12);
    expect(neighbor.energy - neighborEnergy).toBeCloseTo(
      -0.012 + 0.04 * (0.65 + 0.35 * Math.sin(1 / 180)) * 0.75,
      12,
    );
    expect(habitat.telemetrySnapshot().pending.energy.upkeepSpent).toBeCloseTo(0.044, 12);
    expect(habitat.telemetrySnapshot().pending.energy.climateUpkeepSpent).toBe(0);
    expect(habitat.save().shadeHabitats).toEqual(before.shadeHabitats);
    expect(habitat.save().interventions).toEqual(before.interventions);
    const shown = habitat.presentation(source.id);
    expect(shown.selectedLeafLight!.sumLightUnits).toBe(0);
    expect(shown.selectedBiologicalShade).toMatchObject({
      anchorUnits: 4,
      biologicalLeafUnits: 4,
      paintedLeafUnits: 14,
    });
    expect(
      selectedLeafLight(habitat.shadeHabitats, source, habitat.frame().biologicalShade!.units),
    ).toEqual(shown.selectedLeafLight);
  });

  it('combines biological and painted temperature before the sole clamp', () => {
    const habitat = world();
    habitat.changeSettings({ climate: 1 });
    const source = habitat.spawn(body(), 60, 0)!;
    habitat.shock(0.32);
    habitat.changeRefugeMode(true);
    habitat.paintRefuge({ rulesVersion: 1, tool: 'cool', radius: 0, units: -20 }, 60, 0);
    const painted = habitat.save().thermalRefuges;
    expect(habitat.presentation(source.id).anchorTemperature).toBe(0.98);
    expect(localTemperature(60, 0, 0, 1, 0.32, habitat.thermalRefuges)).toBe(1);
    expect(habitat.save().thermalRefuges).toEqual(painted);
    expect(habitat.populationObservation().adaptation.stressedOrganisms).toBe(1);
  });

  it('freezes the field for the whole tick even when an earlier source dies', () => {
    const habitat = world(true, true);
    const source = habitat.spawn(body(), 10, 10)!;
    const target = habitat.spawn(body([{ x: 0, y: 0, type: 8 }]), 11, 10)!;
    habitat.shock(0.32);
    source.energy = 0;
    const before = target.energy;
    habitat.step();
    expect(habitat.organisms.has(source.id)).toBe(false);
    expect(before - target.energy).toBeCloseTo(0.012 + 0.16 * 0.2, 12);
    expect(habitat.presentation(target.id).selectedBiologicalShade!.anchorUnits).toBe(0);
    const next = target.energy;
    habitat.step();
    expect(next - target.energy).toBeCloseTo(0.012 + 0.2 * 0.2, 12);
    expect(
      nutrientSummary(habitat.nutrientCycle!, habitat.organisms.values(), habitat.food).total,
    ).toBe(NUTRIENT_TOTAL);
  });

  it('freezes moving-source exposure and reconstructs without a trail on the next tick', () => {
    const habitat = world();
    const genome = body([
      { x: 0, y: 0, type: 7 },
      { x: 1, y: 0, type: 5 },
    ]);
    genome.tempo = 2;
    genome.controller = newController();
    genome.controller.biases[5] = 1;
    const source = habitat.spawn(genome, 30, 30)!;
    source.age = 1;
    const target = habitat.spawn(body([{ x: 0, y: 0, type: 8 }]), 30, 31)!;
    habitat.shock(0.32);
    const before = target.energy;
    habitat.step();
    expect(source.y).toBe(29);
    expect(before - target.energy).toBeCloseTo(0.044, 12);
    expect(habitat.presentation(target.id).selectedBiologicalShade!.anchorUnits).toBe(0);
    const next = target.energy;
    habitat.step();
    expect(next - target.energy).toBeCloseTo(0.052, 12);
  });

  it('accounts for newborn armor only at the following tick, preserving parent funding', () => {
    const habitat = world(true, true);
    const parent = habitat.spawn(body(), 40, 40)!;
    parent.energy = 40;
    parent.age = 32;
    habitat.step();
    expect(habitat.births).toBe(1);
    expect(habitat.presentation().biologicalShade!.armorCells).toBe(2);
    const ledger = habitat.telemetrySnapshot().pending.energy;
    expect(ledger.upkeepSpent).toBeCloseTo(0.02, 12);
    expect(ledger.reproductionSpent).toBeGreaterThanOrEqual(ledger.offspringGranted);
    habitat.step();
    expect(habitat.telemetrySnapshot().pending.energy.upkeepSpent - ledger.upkeepSpent).toBeCloseTo(
      0.04,
      12,
    );
    expect(
      nutrientSummary(habitat.nutrientCycle!, habitat.organisms.values(), habitat.food).total,
    ).toBe(NUTRIENT_TOTAL);
  });

  it('records extinction from actual maintenance without automatic rescue', () => {
    const habitat = world();
    const source = habitat.spawn(body(), 10, 10)!;
    source.energy = 0.015;
    habitat.step();
    expect(habitat.organisms.size).toBe(0);
    expect(habitat.deaths).toBe(1);
    expect(habitat.presentation().biologicalShade!.armorCells).toBe(0);
    const random = habitat.random.state;
    habitat.step();
    expect(habitat.random.state).toBe(random);
  });

  it('strictly validates the native mode and preserves predecessor17 nutrients and disabled ecology', () => {
    for (const invalid of [
      undefined,
      null,
      [],
      true,
      {},
      { version: 1 },
      { enabled: true },
      { version: 2, enabled: true },
      { version: 1, enabled: 1 },
      { version: 1, enabled: true, units: [] },
    ]) {
      expect(() => parseBiologicalShade(invalid)).toThrow('biological shade');
      expect(() => restore({ ...world().save(), biologicalShade: invalid })).toThrow(
        'biological shade',
      );
    }
    expect(parseBiologicalShade({ version: 1, enabled: false })).toEqual({
      version: 1,
      enabled: false,
    });
    const habitat = world(false, true);
    habitat.spawn(
      body([
        { x: 0, y: 0, type: 7 },
        { x: 1, y: 0, type: 4 },
      ]),
      12,
      12,
    );
    const native = habitat.save();
    const legacy = restore({ ...native, version: 17, biologicalShade: { unknown: true } });
    expect(legacy.save()).toEqual(native);
    for (let tick = 0; tick < 40; tick++) {
      habitat.step();
      legacy.step();
      expect(legacy.save()).toEqual(habitat.save());
    }
    expect(habitat.frame().biologicalShade).toBeUndefined();
    expect(habitat.presentation().biologicalShade).toBeUndefined();
    expect(habitat.save().version).toBe(WORLD_VERSION);
  });

  it('reconstructs deterministic fields on save/reload with detached planes and curated provenance', () => {
    const habitat = world(true, true);
    const source = habitat.spawn(
      body([
        { x: 0, y: 0, type: 7 },
        { x: 1, y: 0, type: 4 },
      ]),
      8,
      8,
    )!;
    habitat.changeSettings({ nutrients: 20 });
    const replay = restore(habitat.save());
    const frame = habitat.frame();
    frame.biologicalShade!.units.fill(16);
    const summary = habitat.presentation(source.id);
    expect(summary.biologicalShade!.maximumUnits).toBe(4);
    expect(measurementEnvelope(habitat.measurements()).snapshot.biologicalShade).toEqual(
      summary.biologicalShade,
    );
    expect(Object.keys(habitat.save().biologicalShade).sort()).toEqual(['enabled', 'version']);
    for (let tick = 0; tick < 40; tick++) {
      habitat.step();
      replay.step();
    }
    expect(replay.save()).toEqual(habitat.save());
    expect(replay.frame()).toEqual(habitat.frame());
    expect(organismHtml(source, habitat.presentation(source.id))).toContain(
      'Biological source: living armor',
    );
    expect(organismHtml(source, habitat.frame())).toContain('Biological source: living armor');
  });

  it('presents source-separated magnitudes, disabled state, missing frames and invalid coordinates', () => {
    const habitat = world();
    const source = habitat.spawn(body(), 8, 8)!;
    const shown = habitat.presentation(source.id);
    expect(biologicalShadeMarkup()).toContain('next reseed');
    expect(biologicalShadeDescription(shown.biologicalShade, 0)).toContain('1 living armor');
    expect(biologicalShadeDescription(undefined, 0)).toContain('Disabled');
    expect(biologicalShadeInspection(shown.selectedBiologicalShade)).toContain(
      'additional upkeep 0.008',
    );
    expect(biologicalShadeInspection(undefined)).toContain('disabled');
    expect(biologicalShadeTile(undefined, 0, 0)).toContain('Waiting');
    expect(biologicalShadeTile(undefined, -1, 0)).toContain('whole-number');
    expect(biologicalShadeTile(habitat.frame(), 8, 8)).toContain('living armor 4/16');
    expect(biologicalShadeTile(world(false).frame(), 8, 8)).toContain('living armor 0/16');
    habitat.shadeHabitats.enabled = true;
    habitat.shadeHabitats.units[index(8, 8)] = 8;
    expect(biologicalShadeTile(habitat.frame(), 8, 8)).toContain('combined transmission 0.25');
  });
});
