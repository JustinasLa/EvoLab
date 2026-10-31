import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { WIDTH, HEIGHT, index, type Cell, type Organism } from '../src/model';
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
