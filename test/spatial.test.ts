import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, HEIGHT, WIDTH, index } from '../src/model';
import {
  SPATIAL_CHANNELS,
  SPATIAL_COMPLETED_WINDOWS,
  SpatialObserver,
  spatialBin,
  spatialBudget,
  type SpatialChannel,
  type SpatialWindow,
} from '../src/spatial';
import { roleGenome } from './fixtures/roles';
import { populatedWorld, wrappedScene } from './fixtures/spatial';

const value = (window: SpatialWindow, channel: SpatialChannel, bin: number): number =>
  window.values[SPATIAL_CHANNELS.indexOf(channel) * spatialBudget().bins + bin];

function nonzero(window: SpatialWindow, bins = spatialBudget().bins): Record<string, number> {
  const result: Record<string, number> = {};
  window.values.forEach((amount, at) => {
    if (amount !== 0) result[`${SPATIAL_CHANNELS[Math.floor(at / bins)]}@${at % bins}`] = amount;
  });
  return result;
}

describe('bounded spatial event capture', () => {
  it('derives fixed bins, partial edges and byte/work budgets from world dimensions', () => {
    expect(spatialBudget()).toEqual({
      columns: 15,
      rows: 10,
      bins: 150,
      edgeColumnTiles: 16,
      edgeRowTiles: 12,
      valuesPerWindow: 1350,
      windows: 7,
      bytes: 7 * (1350 + 9) * 8,
      maxWritesPerEvent: 3,
      rotationClearsPerWindow: 1359,
    });
    expect(spatialBudget(33, 17)).toMatchObject({
      columns: 3,
      rows: 2,
      edgeColumnTiles: 1,
      edgeRowTiles: 1,
    });
    expect(spatialBin(0, 0)).toBe(0);
    expect(spatialBin(WIDTH - 1, 0)).toBe(14);
    expect(spatialBin(WIDTH - 1, HEIGHT - 1)).toBe(149);
    expect(spatialBin(15, 16)).toBe(15);
    const observer = new SpatialObserver(0, 'enabled', 33, 17);
    observer.birth(32 + 16 * 33);
    observer.death(0, 'manual');
    expect(nonzero(observer.snapshot().windows[0], 6)).toEqual({
      'births@5': 1,
      'manualRemovals@0': 1,
    });
  });

  it('records wrapped event locations that reconcile exactly with the engine ledgers', () => {
    const { world, parent, erased } = wrappedScene();
    const reference = Ecosystem.load(JSON.stringify(world.save()));
    expect(world.spatialSnapshot()).toBeUndefined();
    world.observeSpatial(true);
    const ids = new Set(world.organisms.keys());
    world.step();
    reference.step();
    expect(world.save()).toEqual(reference.save());
    const child = [...world.organisms.values()].find((organism) => !ids.has(organism.id))!;
    expect(child.ancestry).toEqual(parent.ancestry);
    expect(child.x >= 0 && child.x < WIDTH && child.y >= 0 && child.y < HEIGHT).toBe(true);
    world.paint('erase', erased.x, erased.y, 0, erased.genome);
    const snapshot = world.spatialSnapshot()!;
    expect(snapshot).toMatchObject({
      coverageStartTick: 0,
      startReason: 'enabled',
      tick: 1,
      evictedWindows: 0,
      evictedThroughTick: null,
    });
    const [window] = snapshot.windows;
    expect(window).toMatchObject({
      fromTick: 0,
      toTick: 300,
      throughTick: 1,
      complete: false,
      partial: true,
    });
    const birthBin = spatialBin(child.x, child.y);
    const ledger = world.telemetrySnapshot().pending,
      ledgerEnergy = ledger.energy;
    expect(ledgerEnergy.mouthsGained).toBeCloseTo(2.2, 12);
    expect(ledgerEnergy.stingsGained).toBeCloseTo(0.65, 12);
    expect(nonzero(window)).toEqual({
      'feedings@0': 1,
      'feedingEnergy@0': ledgerEnergy.mouthsGained,
      'attacks@75': 1,
      'attackDrained@75': 2.5,
      'attackGained@75': ledgerEnergy.stingsGained,
      [`births@${birthBin}`]: 1,
      'starvationDeaths@149': 1,
      'ageDeaths@141': 1,
      'manualRemovals@48': 1,
    });
    // Mouths record where they eat, not where the food was; the target tile, not the stinger.
    expect(value(window, 'feedings', 14)).toBe(0);
    expect(value(window, 'attacks', 89)).toBe(0);
    expect(window.totals).toEqual({
      births: ledger.births,
      starvationDeaths: ledger.deaths.energy,
      ageDeaths: ledger.deaths.age,
      manualRemovals: ledger.deaths.manual,
      feedings: 1,
      feedingEnergy: ledger.energy.mouthsGained,
      attacks: 1,
      attackDrained: ledger.energy.stingsDrained,
      attackGained: ledger.energy.stingsGained,
    });
    expect(world.spatialSummary()!.windows[0]).toMatchObject({ activeBins: 6 });
    window.values.fill(9);
    window.totals.births = 9;
    expect(world.spatialSnapshot()!.windows[0].totals.births).toBe(1);
    expect(nonzero(world.spatialSnapshot()!.windows[0])).not.toHaveProperty('births@0');
    expect(JSON.stringify(world.save())).not.toContain('spatial');
  });

  it('records only actual nutrient-cycle stinger transfers', () => {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false, {
      nutrientCycle: true,
    });
    const attacker = world.spawn(roleGenome(6), 10, 10)!;
    attacker.age = 3;
    attacker.energy = 10;
    const victim = world.spawn(roleGenome(4), 11, 10)!;
    victim.energy = -1;
    world.observeSpatial(true);
    world.step();
    const [window] = world.spatialSnapshot()!.windows;
    expect(window.totals.attacks).toBe(0);
    expect(window.totals.starvationDeaths).toBe(1);
  });

  it('starts partial windows at the actual tick, completes them at fixed boundaries and evicts oldest', () => {
    const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0 }, false);
    for (let tick = 0; tick < 298; tick++) world.step();
    world.observeSpatial(true);
    world.observeSpatial(true);
    world.step();
    expect(world.spatialSnapshot()!.windows).toHaveLength(1);
    world.step();
    let snapshot = world.spatialSnapshot()!;
    expect(
      snapshot.windows.map(({ fromTick, toTick, throughTick, complete, partial }) => ({
        fromTick,
        toTick,
        throughTick,
        complete,
        partial,
      })),
    ).toEqual([
      { fromTick: 298, toTick: 300, throughTick: 300, complete: true, partial: true },
      { fromTick: 300, toTick: 600, throughTick: 300, complete: false, partial: true },
    ]);
    const observer = new SpatialObserver(298, 'enabled');
    for (let tick = 299; tick <= 300 * (SPATIAL_COMPLETED_WINDOWS + 1); tick++) {
      observer.feeding(index(tick % WIDTH, 0), 2.2);
      observer.endTick(tick);
    }
    snapshot = observer.snapshot();
    expect(snapshot.windows).toHaveLength(SPATIAL_COMPLETED_WINDOWS + 1);
    expect(snapshot).toMatchObject({ evictedWindows: 1, evictedThroughTick: 300 });
    expect(snapshot.windows[0]).toMatchObject({ fromTick: 300, toTick: 600, partial: false });
    expect(snapshot.windows[0].totals.feedings).toBe(300);
    expect(snapshot.windows.at(-1)).toMatchObject({
      fromTick: 2100,
      throughTick: 2100,
      complete: false,
    });
    // The reused pending buffer was cleared before reuse.
    expect(snapshot.windows.at(-1)!.values.every((amount) => amount === 0)).toBe(true);
    const bytes = snapshot.windows.reduce(
      (total, window) => total + window.values.byteLength + SPATIAL_CHANNELS.length * 8,
      0,
    );
    expect(bytes).toBe(spatialBudget().bytes);
  });

  it('discards evidence on toggle off and on world replacement, and ignores pauses', () => {
    const { world } = wrappedScene();
    world.observeSpatial(true);
    world.step();
    const before = world.spatialSnapshot()!;
    world.presentation();
    world.telemetrySnapshot();
    world.save();
    expect(world.spatialSnapshot()).toEqual(before);
    world.observeSpatial(false);
    expect(world.spatialSnapshot()).toBeUndefined();
    world.step();
    world.observeSpatial(true);
    expect(world.spatialSnapshot()).toMatchObject({ coverageStartTick: 2, tick: 2 });
    expect(world.spatialSnapshot()!.windows[0].values.every((amount) => amount === 0)).toBe(true);
    const imported = Ecosystem.load(JSON.stringify(world.save()));
    expect(imported.spatialSnapshot()).toBeUndefined();
    imported.observeSpatial(true, 'world-replaced');
    expect(imported.spatialSummary()).toMatchObject({
      coverageStartTick: 2,
      startReason: 'world-replaced',
      windows: [{ fromTick: 2, activeBins: 0 }],
    });
  });

  it('continues through extinction with empty windows and identical complete outcomes', () => {
    const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0 }, false);
    world.spawn(roleGenome(3), 5, 5)!.energy = 0.01;
    const reference = Ecosystem.load(JSON.stringify(world.save()));
    world.observeSpatial(true);
    for (let tick = 0; tick < 650; tick++) {
      world.step();
      reference.step();
    }
    expect(world.organisms.size).toBe(0);
    expect(world.save()).toEqual(reference.save());
    const windows = world.spatialSnapshot()!.windows;
    expect(windows.map((window) => window.totals.starvationDeaths)).toEqual([1, 0, 0]);
    expect(windows.at(-1)).toMatchObject({ fromTick: 600, throughTick: 650 });
  });

  it('leaves a populated seeded ecosystem exactly unchanged while counts match sampled ledgers', () => {
    const observed = populatedWorld();
    const control = Ecosystem.load(JSON.stringify(observed.save()));
    observed.observeSpatial(true);
    for (let tick = 0; tick < 900; tick++) {
      observed.step();
      control.step();
      if (tick % 37 === 0) observed.spatialSummary();
    }
    expect(JSON.stringify(observed.save())).toBe(JSON.stringify(control.save()));
    const samples = observed.telemetrySnapshot().samples;
    const windows = observed.spatialSnapshot()!.windows;
    expect(windows).toHaveLength(4);
    for (const window of windows.slice(0, 3)) {
      const inside = samples.filter(
        (sample) => sample.tick > window.fromTick && sample.tick <= window.toTick,
      );
      const sum = (pick: (sample: (typeof samples)[number]) => number) =>
        inside.reduce((total, sample) => total + pick(sample), 0);
      expect(window.totals.births).toBe(sum((sample) => sample.births));
      expect(window.totals.starvationDeaths).toBe(sum((sample) => sample.deaths.energy));
      expect(window.totals.ageDeaths).toBe(sum((sample) => sample.deaths.age));
      expect(window.totals.manualRemovals).toBe(0);
      expect(window.totals.feedingEnergy).toBeCloseTo(
        sum((sample) => sample.energy.mouthsGained),
        6,
      );
      expect(window.totals.attackDrained).toBeCloseTo(
        sum((sample) => sample.energy.stingsDrained),
        6,
      );
      expect(window.totals.attackGained).toBeCloseTo(
        sum((sample) => sample.energy.stingsGained),
        6,
      );
      let binned = 0;
      for (let bin = 0; bin < spatialBudget().bins; bin++) binned += value(window, 'births', bin);
      expect(binned).toBe(window.totals.births);
    }
    for (const channel of ['births', 'starvationDeaths', 'feedings', 'attacks'] as const)
      expect(windows[0].totals[channel]).toBeGreaterThan(0);
  });
});
