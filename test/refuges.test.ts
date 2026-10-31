import { describe, it, expect } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  index,
  positions,
  temperature,
  type RefugeBrush,
} from '../src/model';
import {
  emptyRefuges,
  parseRefuges,
  refugeFile,
  refugeSummary,
  refugeDab,
  localTemperature,
  activeRefugeUnits,
  validRefugeBrush,
} from '../src/refuges';
import { acceptedReference, fixtureText, predecessor, identicalRecords } from './fixtures/refuges';
import { advance } from './fixtures/telemetry';
import { restoreHistoricalWorld } from './fixtures/sensory-legacy';

const brush = (units = 4, radius = 0): RefugeBrush => ({
  rulesVersion: 1,
  tool: units > 0 ? 'warm' : units < 0 ? 'cool' : 'erase-temperature',
  units,
  radius,
});
const field = (enabled = true, cells: [number, number][] = []) =>
  parseRefuges({ version: 1, enabled, cells });
const input = (name: string) => fixtureText(`capture-attempt3/inputs/${name}.json`);

describe('painted temperature mechanics and genuine accepted-base equivalence', () => {
  for (const seed of [0, 1, 42, 100, 123, 4294967295])
    for (const preset of ['open-field', 'porous-ridges', 'chambered-refuges'])
      it(`preserves the complete original trajectory for seed ${seed}, ${preset}, in every local-zero mode`, () => {
        const text = input(`seed-${seed}-${preset}`),
          reference = acceptedReference(text);
        const candidates = [Ecosystem.load(text), Ecosystem.load(text), Ecosystem.load(text)];
        candidates[1].thermalRefuges = field();
        candidates[2].thermalRefuges = field(false, [
          [0, 32],
          [37439, -32],
        ]);
        for (const tick of [0, 30, 90, 330, 1600]) {
          while (reference.tick < tick) reference.step();
          const frozen = JSON.parse(
            fixtureText(`capture-attempt3/outputs/seed-${seed}-${preset}-tick-${tick}.json`),
          );
          expect(reference.save()).toEqual(frozen);
          for (const candidate of candidates) {
            while (candidate.tick < tick) candidate.step();
            expect(predecessor(candidate.save())).toEqual(reference.save());
          }
        }
      });
  for (const version of [2, 3, 4, 5, 6])
    for (const population of ['empty', 'populated'])
      it(`migrates literal v${version} ${population} at every sample boundary with exact shock continuation`, () => {
        for (const tick of [0, 25, 29, 30, 31]) {
          const text = input(`v${version}-${population}-tick-${tick}`),
            reference = acceptedReference(text),
            world = Ecosystem.load(text);
          expect(world.save().thermalRefuges).toEqual({ version: 1, enabled: false, cells: [] });
          for (const endpoint of [tick, tick + 1, tick + 30, 901]) {
            while (reference.tick < endpoint) reference.step();
            while (world.tick < endpoint) world.step();
            expect(predecessor(world.save())).toEqual(reference.save());
          }
        }
      });
  for (const preference of [0.75, 0.25])
    for (const blocked of [false, true])
      it(`funds actual reproduction only for the matching ${preference} arm, placement blocked=${blocked}`, () => {
        const text = input(`threshold-${preference}-${blocked ? 'blocked' : 'open'}`),
          states = [-25, 0, 25].map((units) => {
            const world = Ecosystem.load(text);
            world.thermalRefuges = field(true, units ? [[index(120, 78), units]] : []);
            const before = world.save();
            expect(before.organisms[0].age).toBe(32);
            expect(before.organisms[0].energy).toBe(24);
            world.step();
            return world.save();
          });
        const match = preference === 0.75 ? 2 : 0;
        states.forEach((saved, arm) => {
          const born = !blocked && arm === match;
          expect(saved.births).toBe(Number(born));
          expect(saved.organisms).toHaveLength(born ? 2 : 1);
          expect(saved.organisms[0].children).toBe(Number(born));
          expect(saved.telemetry.pending.energy.reproductionSpent > 0).toBe(born);
          expect(saved.telemetry.pending.energy.offspringGranted).toBe(born ? 10.5 : 0);
          if (born) expect(saved.organisms[1].generation).toBe(1);
        });
        const matching = states[match],
          opposite = states[2 - match];
        expect(matching.telemetry.pending.energy.leavesGained).toBeGreaterThan(
          opposite.telemetry.pending.energy.leavesGained,
        );
        expect(matching.telemetry.pending.energy.climateUpkeepSpent).toBeLessThan(
          opposite.telemetry.pending.energy.climateUpkeepSpent,
        );
        const reference = acceptedReference(text);
        reference.step();
        expect(predecessor(states[1])).toEqual(reference.save());
      });
  it('changes actual Armor survival without food, grants, resets or synthetic observations', () => {
    const outcomes = [0, 25, -25].map((units) => {
      const world = Ecosystem.load(input('armor-survival'));
      world.thermalRefuges = field(true, units ? [[index(120, 78), units]] : []);
      world.step();
      return world.save();
    });
    expect(outcomes.map((saved) => saved.organisms.length)).toEqual([1, 1, 0]);
    expect(outcomes.map((saved) => saved.deaths)).toEqual([0, 0, 1]);
    expect(outcomes[2].telemetry.pending.deaths.energy).toBe(1);
    expect(outcomes[1].organisms[0].energy).toBeGreaterThan(outcomes[0].organisms[0].energy);
    for (const saved of outcomes) {
      expect(saved.births).toBe(0);
      expect(saved.telemetry.samples).toEqual([]);
      expect(saved.telemetry.pending.energy.offspringGranted).toBe(0);
    }
  });
  it('adds after the full raw climate expression and before its sole clamp', () => {
    for (const offset of [-0.32, 0, 0.32])
      for (const units of [-32, -25, 0, 25, 32]) {
        const x = 0,
          y = 0,
          tick = 900,
          strength = 1;
        const raw =
          0.5 +
          strength *
            (0.27 * Math.sin((x / WIDTH) * Math.PI * 2 - tick / 1100) +
              0.13 * Math.cos((y / HEIGHT) * Math.PI * 2) +
              0.12 * Math.sin(tick / 650)) +
          offset;
        expect(temperature(x, y, tick, strength, offset, units)).toBe(
          Math.max(0, Math.min(1, raw + units / 100)),
        );
        expect(
          localTemperature(x, y, tick, strength, offset, field(true, units ? [[0, units]] : [])),
        ).toBe(temperature(x, y, tick, strength, offset, units));
      }
    expect(localTemperature(0, 0, 0, 0, 0, field(true, [[0, 25]]))).toBe(0.75);
    expect(activeRefugeUnits(field(false, [[0, 25]]), 0, 0)).toBe(0);
  });
  it.each([
    [WIDTH / 4, 0, 0.32, -32, 1.22],
    [(WIDTH * 3) / 4, HEIGHT / 2, -0.32, 32, -0.22],
  ])(
    'brings raw out-of-range climate back inside before clamping at %s,%s',
    (x, y, offset, units, raw) => {
      const result = temperature(x, y, 0, 1, offset, units);
      expect(result).toBeCloseTo(raw + units / 100, 15);
      expect(result).not.toBe(
        Math.max(0, Math.min(1, temperature(x, y, 0, 1, offset) + units / 100)),
      );
    },
  );
  it('uses only the anchor for all leaves of a rotated body, not the painted footprint', () => {
    const original = JSON.parse(input('threshold-0.75-open'));
    original.organisms[0].rotation = 1;
    const text = JSON.stringify(original),
      anchor = Ecosystem.load(text),
      footprint = Ecosystem.load(text),
      reference = acceptedReference(text),
      metabolic = acceptedReference(
        JSON.stringify({ ...original, eventOffset: 0.25, eventUntil: 900 }),
      ),
      body = original.organisms[0];
    anchor.thermalRefuges = field(true, [[index(body.x, body.y), 25]]);
    footprint.thermalRefuges = field(
      true,
      positions(body)
        .filter((position) => position !== index(body.x, body.y))
        .sort((left, right) => left - right)
        .map((position) => [position, -25]),
    );
    for (const world of [anchor, footprint, reference, metabolic]) world.step();
    expect(predecessor(footprint.save())).toEqual(reference.save());
    expect(predecessor(anchor.save())).toEqual({
      ...metabolic.save(),
      eventOffset: 0,
      eventUntil: 0,
    });
    expect(anchor.save().births).toBe(1);
    expect(footprint.save().births).toBe(0);
  });
  it.each([1, 2])(
    'expires the global event exactly at tick eventUntil=%s while retaining local units',
    (until) => {
      const original = JSON.parse(input('armor-survival'));
      original.eventOffset = 0.32;
      original.eventUntil = until;
      original.organisms[0].energy = 1;
      const world = Ecosystem.load(JSON.stringify(original));
      world.thermalRefuges = field(true, [[index(120, 78), -25]]);
      world.step();
      const raw = 0.5 + (1 < until ? 0.32 : 0),
        local = Math.max(0, Math.min(1, raw - 0.25)),
        stress = Math.max(0, Math.abs(local - 0.75) - 0.125),
        spent = 0.012 + stress * 0.2;
      expect(world.save().organisms[0].energy).toBe(1 - spent);
      expect(world.frame().offset).toBe(1 < until ? 0.32 : 0);
      expect(localTemperature(120, 78, 1, 0, world.frame().offset, world.thermalRefuges)).toBe(
        local,
      );
    },
  );
  for (const seed of [0, 42, 123])
    for (const units of [-25, 25])
      it(`retains genuine founder ecology and active-field shock/reload continuation for seed ${seed}, units ${units}`, () => {
        const text = input(`seed-${seed}-open-field`),
          control = Ecosystem.load(text),
          reference = acceptedReference(text),
          active = Ecosystem.load(text);
        expect(active.save().organisms).toHaveLength(1);
        expect(active.save().food).toEqual([]);
        active.changeRefugeMode(true);
        active.paintRefuge(brush(units, 8), 120, 78);
        advance(active, 330);
        advance(control, 330);
        for (let tick = 0; tick < 330; tick++) reference.step();
        expect(predecessor(control.save())).toEqual(reference.save());
        const beforeShock = { offset: active.eventOffset, until: active.eventUntil };
        active.shock('heat');
        active.appendIntervention({
          kind: 'shock',
          detail: {
            kind: 'heat',
            before: beforeShock,
            after: { offset: active.eventOffset, until: active.eventUntil },
          },
        });
        const reloaded = Ecosystem.load(JSON.stringify(active.save()));
        for (const world of [active, reloaded]) advance(world, 1270);
        advance(control, 1270);
        for (let tick = 330; tick < 1600; tick++) reference.step();
        expect(active.save()).toEqual(reloaded.save());
        expect(predecessor(control.save())).toEqual(reference.save());
        expect(active.save().tick).toBe(1600);
        expect(active.save().thermalRefuges.cells.length).toBe(197);
        expect(active.save().eventUntil).toBe(1230);
        for (const organism of active.organisms.values())
          for (const position of positions(organism)) {
            expect(active.walls[position]).toBe(0);
            expect(active.occupied[position]).toBe(organism.id);
          }
        expect(active.telemetry.pending.energy.offspringGranted).toBeGreaterThanOrEqual(0);
        expect(active.telemetry.samples).toHaveLength(53);
      });
  it('performs wrapped additive saturating and cancellation dabs without mutating candidates', () => {
    const world = new Ecosystem(DEFAULTS, false);
    world.changeRefugeMode(true);
    const before = world.save(),
      candidate = refugeDab(world.thermalRefuges, brush(25, 1), 0, 0);
    expect(candidate.changes).toHaveLength(5);
    expect(world.save()).toEqual(before);
    const first = world.paintRefuge(brush(25, 1), 0, 0);
    world.paintRefuge(brush(25, 1), 0, 0, first.rowSequence);
    expect(world.thermalRefuges.units[index(-1, 0)]).toBe(32);
    expect(world.thermalRefuges.units[index(0, -1)]).toBe(32);
    expect(world.paintRefuge(brush(25, 1), 0, 0, first.rowSequence).rowSequence).toBeNull();
    world.paintRefuge(brush(-32, 1), 0, 0);
    expect(world.thermalRefuges.nonzeroCells).toBe(0);
    world.paintRefuge(brush(-4), 10, 10);
    expect(world.paintRefuge(brush(0), 10, 10).changedBrushCells).toBe(1);
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
  });
  it('rejects a complete capacity-overflowing disk atomically, allowing edits and no-ops at capacity', () => {
    const world = new Ecosystem(DEFAULTS, false);
    world.thermalRefuges = field(
      true,
      Array.from({ length: 4096 }, (_, position) => [position, 32]),
    );
    const before = world.save();
    expect(() => world.paintRefuge(brush(4, 8), 20, 50)).toThrow(/capacity/);
    expect(world.save()).toEqual(before);
    expect(world.paintRefuge(brush(4), 0, 0).rowSequence).toBeNull();
    world.paintRefuge(brush(-32), 0, 0);
    expect(world.thermalRefuges.nonzeroCells).toBe(4095);
    world.paintRefuge(brush(4), 20, 50);
    expect(world.thermalRefuges.nonzeroCells).toBe(4096);
    expect(refugeSummary(world.thermalRefuges)).toMatchObject({
      capacity: 4096,
      minimumUnits: 0,
      maximumUnits: 32,
    });
  });
  it('retains inactive paint, changes no ecology at command time and clears only the field', () => {
    const world = new Ecosystem(),
      before = predecessor(world.save()),
      archive = world.lineageSnapshot();
    expect(world.changeRefugeMode(false)).toBeNull();
    expect(world.clearRefuges().rowSequence).toBeNull();
    expect(() => world.paintRefuge(brush(), 0, 0)).toThrow(/disabled/);
    world.changeRefugeMode(true);
    world.paintRefuge(brush(), 120, 78);
    world.changeRefugeMode(false);
    expect(refugeFile(world.thermalRefuges).cells).toEqual([[index(120, 78), 4]]);
    const { interventions: _beforeLog, ...beforeEcology } = before;
    const {
      interventions: _afterLog,
      thermalRefuges: _field,
      lineageArchive: _archive,
      version: _version,
      ...afterEcology
    } = world.save();
    afterEcology.organisms = restoreHistoricalWorld(world.save()).organisms as any;
    expect({ version: 6, ...afterEcology }).toEqual(beforeEcology);
    expect(world.lineageSnapshot()).toEqual(archive);
    expect(world.clearRefuges()).toMatchObject({ removedCells: 1, nonzeroCells: 0 });
    expect(world.thermalRefuges.enabled).toBe(false);
    const frame = world.frame();
    frame.thermalRefuges.units.fill(32);
    expect(world.thermalRefuges.units[0]).toBe(0);
    expect(frame.thermalRefuges.units.byteLength).toBe(WIDTH * HEIGHT);
  });
});

describe('strict owned field and history, without narrowing historically open records', () => {
  for (const location of ['settings', 'organism', 'genome', 'cell'])
    for (const family of ['overflow', 'signed', 'prototype'])
      it(`retains original raw ${family} values as own ${location} properties through every historical and current boundary`, () => {
        for (const version of [2, 3, 4, 5, 6]) {
          const text = fixtureText(
              `capture-direct/inputs/direct-${location}-${family}-v${version}.json`,
            ),
            reference = acceptedReference(text),
            world = Ecosystem.load(text);
          const parsed = JSON.parse(text);
          identicalRecords(structuredClone(parsed), parsed);
          identicalRecords(predecessor(world.save()), reference.save());
          const detached = world.save();
          identicalRecords(detached, world.save());
          const records = [
            detached.settings,
            detached.organisms[0],
            detached.organisms[0].genome,
            detached.organisms[0].genome.cells[0],
          ];
          for (const record of records) {
            Object.defineProperty(record, '__proto__', {
              value: { changed: true },
              configurable: true,
            });
            Object.defineProperty(record, 'constructor', {
              value: { changed: true },
              configurable: true,
            });
            Object.defineProperty(record, 'prototype', {
              value: { changed: true },
              configurable: true,
            });
          }
          identicalRecords(predecessor(world.save()), reference.save());
          const current = JSON.stringify(world.save()),
            original = JSON.stringify(reference.save()),
            reloaded = Ecosystem.load(current),
            oldReloaded = acceptedReference(original);
          identicalRecords(
            predecessor(reloaded.save()),
            location === 'genome' || location === 'cell' ? reference.save() : oldReloaded.save(),
          );
          world.step();
          reference.step();
          identicalRecords(predecessor(world.save()), reference.save());
          reloaded.step();
          oldReloaded.step();
          identicalRecords(
            predecessor(reloaded.save()),
            location === 'genome' || location === 'cell' ? reference.save() : oldReloaded.save(),
          );
        }
      });
  for (const [location, deepest] of [
    ['settings', 1646],
    ['organism', 1645],
    ['genome', 1644],
    ['cell', 1642],
  ] as const)
    it(`preserves the genuine ${location} depth frontier and the adjacent original limitation`, () => {
      for (const depth of [128, 512, deepest, deepest + 1]) {
        const text = fixtureText(
          `capture-boundaries-attempt2/inputs/depth-${location}-${depth}.json`,
        );
        let original: ReturnType<ReturnType<typeof acceptedReference>['save']> | undefined,
          failure: unknown;
        try {
          original = acceptedReference(text).save();
        } catch (error) {
          failure = error;
        }
        if (failure && (location === 'settings' || location === 'organism'))
          expect(() => Ecosystem.load(text).save()).toThrow();
        else if (failure)
          identicalRecords(
            predecessor(Ecosystem.load(text).save()).organisms,
            JSON.parse(text).organisms,
          );
        else identicalRecords(predecessor(Ecosystem.load(text).save()), original);
      }
    });
  it.each([
    'capture-attempt3/inputs/saturated-1600x16-ancestry8-history180-128.json',
    'capture-attempt3/inputs/natural-full-180-128.json',
    'native-depth-direct/inputs/desktop-combined-1087.json',
    'capture-direct/inputs/native-cap-v5.json',
  ])('retains complete saturated/raw/cap state %s without stripping', (name) => {
    const text = fixtureText(name),
      reference = acceptedReference(text),
      world = Ecosystem.load(text);
    identicalRecords(predecessor(world.save()), reference.save());
    world.step();
    reference.step();
    identicalRecords(predecessor(world.save()), reference.save());
  });
  const invalidFields: unknown[] = [
    null,
    [],
    {},
    { version: 2, enabled: false, cells: [] },
    { version: 1, enabled: 0, cells: [] },
    { version: 1, enabled: true, cells: [], extra: 1 },
    ...[
      [
        [1, 4],
        [0, 4],
      ],
      [
        [0, 0],
        [0, 1],
      ],
      [[37440, 4]],
      [[-1, 4]],
      [[0.5, 4]],
      [[0, 33]],
      [[0, -33]],
      [[0, 0.5]],
      [[0, null]],
      [[0, '4']],
      [[0, 4, 8]],
      [{ index: 0, units: 4 }],
      [[0, { nested: 4 }]],
      Array.from({ length: 4097 }, (_, position) => [position, 1]),
    ].map((cells) => ({ version: 1, enabled: true, cells })),
  ];
  it.each(invalidFields.map((value, position) => [position, value] as const))(
    'rejects isolated malformed owned field %i before replacing any complete state',
    (_position, value) => {
      const world = new Ecosystem(),
        before = world.save();
      expect(() => Ecosystem.load(JSON.stringify({ ...before, thermalRefuges: value }))).toThrow(
        /painted temperature/i,
      );
      expect(world.save()).toEqual(before);
    },
  );
  it('checks owned bytes separately while accepting canonical explicit signed zero', () => {
    expect(() =>
      parseRefuges({ version: 1, enabled: false, cells: [[0, 'x'.repeat(65536)]] }),
    ).toThrow(/64 KiB/);
    expect(
      refugeFile(
        parseRefuges({
          version: 1,
          enabled: false,
          cells: [
            [-0, -0],
            [1, 0],
            [37439, -32],
          ],
        }),
      ),
    ).toEqual({ version: 1, enabled: false, cells: [[37439, -32]] });
    expect(
      refugeSummary(
        field(false, [
          [0, -32],
          [37439, 32],
        ]),
      ),
    ).toMatchObject({ minimumUnits: -32, maximumUnits: 32, sumUnits: 0, nonzeroCells: 2 });
  });
  it('rejects malformed brushes and anchors without writes, and covers the full radius-eight disk', () => {
    for (const value of [
      { ...brush(), units: 0 },
      { ...brush(-4), units: 4 },
      { ...brush(0), units: 4 },
      { ...brush(), rulesVersion: 2 },
      { ...brush(), tool: 'food' },
      { ...brush(), radius: 9 },
    ]) {
      expect(validRefugeBrush(value)).toBe(false);
      expect(() => refugeDab(field(), value as RefugeBrush, 0, 0)).toThrow(/Invalid/);
    }
    for (const [x, y] of [
      [-1, 0],
      [0, 156],
      [240, 0],
      [0, 0.5],
    ])
      expect(() => refugeDab(field(), brush(), x, y)).toThrow(/Invalid/);
    expect(refugeDab(field(), brush(32, 8), 239, 155).changes).toHaveLength(197);
  });
  it('validates reverse retained mode chains and enabled paint independently of field contents', () => {
    const world = new Ecosystem(DEFAULTS, false);
    world.changeRefugeMode(true);
    world.paintRefuge(brush(), 0, 0);
    world.changeRefugeMode(false);
    world.clearRefuges();
    const saved = world.save();
    expect(Ecosystem.load(JSON.stringify(saved)).save()).toEqual(saved);
    const reject = (mutate: (value: any) => void) => {
      const value = structuredClone(saved);
      mutate(value);
      expect(() => Ecosystem.load(JSON.stringify(value))).toThrow(/manual intervention/);
    };
    reject((value) => {
      value.thermalRefuges.enabled = true;
    });
    reject((value) => {
      value.interventions.entries[0].detail.before = true;
    });
    reject((value) => {
      value.interventions.entries[1].detail.units = 0;
    });
    reject((value) => {
      value.interventions.entries[1].detail.changedBrushCells = 0;
    });
    reject((value) => {
      value.interventions.entries[1].detail.first.x = 240;
    });
    reject((value) => {
      value.interventions.entries[1].detail.successfulCommands = 4097;
    });
    reject((value) => {
      value.interventions.entries[1].detail.removedOrganisms = 0;
    });
    reject((value) => {
      value.interventions.entries[3].detail.removedCells = 0;
    });
    reject((value) => {
      value.interventions.entries[3].detail.rulesVersion = 2;
    });
    reject((value) => {
      value.interventions.entries[0].detail.rulesVersion = 2;
    });
    const inactivePaint = {
      ...saved,
      thermalRefuges: { version: 1, enabled: false, cells: [] },
      interventions: {
        ...saved.interventions,
        totalEntries: 1,
        entries: [{ ...saved.interventions.entries[1], sequence: 1 }],
      },
    };
    expect(() => Ecosystem.load(JSON.stringify(inactivePaint))).toThrow(/manual intervention/);
    expect(() => world.changeRefugeMode('true' as any)).toThrow(/Invalid/);
  });
  it('preserves all rings at 128/129 and performs no-op or continued-row effects at the sequence limit', () => {
    const world = new Ecosystem(DEFAULTS, false);
    for (let entry = 0; entry < 129; entry++) world.changeRefugeMode(entry % 2 === 0);
    world.paintRefuge(brush(4), 0, 0);
    const saved = world.save(),
      history = saved.interventions;
    expect(history.entries).toHaveLength(128);
    expect(history.totalEntries).toBe(130);
    expect(history.prefixSettings).toEqual(DEFAULTS);
    history.totalEntries = Number.MAX_SAFE_INTEGER;
    history.entries.forEach((entry, position) => {
      entry.sequence = Number.MAX_SAFE_INTEGER - 127 + position;
    });
    const limited = Ecosystem.load(JSON.stringify(saved)),
      before = limited.save();
    expect(limited.changeRefugeMode(true)).toBeNull();
    expect(() => limited.changeRefugeMode(false)).toThrow(/sequence/);
    expect(() => limited.clearRefuges()).toThrow(/sequence/);
    expect(() => limited.paintRefuge(brush(), 1, 0)).toThrow(/sequence/);
    expect(limited.save()).toEqual(before);
    expect(limited.paintRefuge(brush(), 0, 0, Number.MAX_SAFE_INTEGER).rowSequence).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    const continuing = limited.save();
    const latest = continuing.interventions.entries.at(-1)!;
    if (latest.kind !== 'refuge-paint') throw new Error('Expected painted row');
    latest.detail.successfulCommands = 4096;
    latest.detail.changedBrushCells = 4096;
    const exhausted = Ecosystem.load(JSON.stringify(continuing));
    expect(() => exhausted.paintRefuge(brush(), 0, 0, Number.MAX_SAFE_INTEGER)).toThrow(
      /exhausted/,
    );
    exhausted.thermalRefuges.units.fill(0);
    exhausted.thermalRefuges.nonzeroCells = 0;
    expect(exhausted.clearRefuges().rowSequence).toBeNull();
    expect(exhausted.paintRefuge(brush(0), 0, 0).rowSequence).toBeNull();
  });
});
