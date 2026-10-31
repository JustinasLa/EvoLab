import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_MAX_BYTES,
  BLUEPRINT_DEFAULT_NAME,
  parseBlueprint,
  serializeBlueprint,
} from '../src/blueprint';
import { founder, type CellType, type Genome } from '../src/model';
import { storedSensoryGenome } from './fixtures/sensory-legacy';

const allTypes = (): Genome => ({
  behavior: { version: 1 as const, mode: 'legacy' as const },
  cells: [3, 4, 5, 6, 7, 8].map((type, offset) => ({
    x: (offset % 3) - 1,
    y: Math.floor(offset / 3),
    type: type as CellType,
  })),
  preference: 0.1234567890123456,
  tolerance: 0.4567890123456789,
  tempo: 11,
});
const envelope = (genome = allTypes()) => ({
  format: 'evolab-organism-blueprint',
  version: 2,
  name: BLUEPRINT_DEFAULT_NAME,
  description: '',
  genome,
});

describe('standalone blueprint schema', () => {
  it.each(['serialized', 'parsed'])(
    'detaches complete evolved and opaque payloads at the %s boundary',
    (boundary) => {
      const source = storedSensoryGenome(),
        original = structuredClone(source);
      const text = serializeBlueprint({
        name: '  λ🌱 literal  ',
        description: '<script>inert</script>',
        genome: source,
      });
      const copied =
        boundary === 'serialized'
          ? (JSON.parse(text).genome as Genome)
          : parseBlueprint(text).genome;
      expect(copied).toEqual(original);
      expect(copied.legacyExtensions).not.toBe(source.legacyExtensions);
      if (copied.behavior.mode === 'evolved') copied.behavior.reactions.food = 'ignore';
      (copied.legacyExtensions![0][1].at(-1)! as any)[1] = 'copy-only';
      expect(source).toEqual(original);
      const snapshot = structuredClone(copied);
      (source.legacyExtensions![0][1].at(-1)! as any)[1] = 'source-only';
      expect(copied).toEqual(snapshot);
      expect(JSON.parse(text).genome).toEqual(original);
      expect(parseBlueprint(text).name).toBe('  λ🌱 literal  ');
    },
  );
  it('round-trips every founder, functional type, precision, order and anatomy boundary', () => {
    const genomes = [
      ...[0, 1, 2, 3].map((kind) => founder(kind)),
      allTypes(),
      {
        behavior: { version: 1 as const, mode: 'legacy' as const },
        cells: [{ x: -4, y: 4, type: 8 as const }],
        preference: 0,
        tolerance: 0.12,
        tempo: 2,
      },
      {
        behavior: { version: 1 as const, mode: 'legacy' as const },
        cells: Array.from({ length: 16 }, (_, offset) => ({
          x: (offset % 4) + 1,
          y: Math.floor(offset / 4) - 4,
          type: 3 as const,
        })),
        preference: 1,
        tolerance: 0.6,
        tempo: 12,
      },
    ];
    for (const genome of genomes) {
      const input = envelope(genome);
      const text = serializeBlueprint(input);
      expect(parseBlueprint(text)).toEqual(input);
      expect(Object.keys(JSON.parse(text))).toEqual([
        'format',
        'version',
        'name',
        'description',
        'genome',
      ]);
      expect(Object.keys(JSON.parse(text).genome)).toEqual([
        'cells',
        'preference',
        'tolerance',
        'tempo',
        'behavior',
      ]);
      expect(Object.keys(JSON.parse(text).genome.cells[0])).toEqual(['x', 'y', 'type']);
    }
  });

  it('preserves Unicode, hostile literal text, exact whitespace and metadata limits', () => {
    for (const name of [
      '  生物 🌿  ',
      '<img src=x onerror=alert(1)>',
      'n'.repeat(80),
      '🌿'.repeat(40),
    ]) {
      const input = {
        ...envelope(),
        name,
        description: '<script>literal</script>\n' + 'd'.repeat(975),
      };
      expect(input.description.length).toBe(1000);
      expect(parseBlueprint(serializeBlueprint(input))).toEqual(input);
    }
    expect(parseBlueprint(serializeBlueprint(envelope())).description).toBe('');
  });

  it('detaches genomes and cells in both directions without living identity', () => {
    const source = envelope();
    const text = serializeBlueprint({ ...source, id: 72, age: 40 } as typeof source);
    const parsed = parseBlueprint(text);
    source.genome.cells[0].type = 8;
    source.genome.preference = 0.9;
    expect(parsed.genome).toEqual(allTypes());
    parsed.genome.cells[0].x = 4;
    expect(JSON.parse(text).genome).toEqual(allTypes());
    expect(JSON.parse(text)).not.toHaveProperty('id');
    expect(JSON.parse(text)).not.toHaveProperty('age');
  });

  it.each([
    null,
    [],
    42,
    'file',
    true,
    {},
    { version: 2, organisms: [] },
    { version: 1, champion: {} },
  ])('rejects non-blueprint envelopes: %j', (value) =>
    expect(() => parseBlueprint(JSON.stringify(value))).toThrow('standalone'),
  );

  it.each([undefined, '1', 0, -1, 1.5, 3, null, true])(
    'rejects unsupported version %j',
    (version) => {
      const value = { ...envelope(), version };
      expect(() => parseBlueprint(JSON.stringify(value))).toThrow();
    },
  );

  it.each(['', ' \t\n', 'n'.repeat(81), '🌿'.repeat(41), null, 42, {}, []])(
    'rejects invalid name %j',
    (name) => expect(() => parseBlueprint(JSON.stringify({ ...envelope(), name }))).toThrow('name'),
  );

  it.each(['d'.repeat(1001), null, 42, {}, []])('rejects invalid description %j', (description) => {
    expect(() => parseBlueprint(JSON.stringify({ ...envelope(), description }))).toThrow(
      'description',
    );
  });

  it('rejects every missing and unknown key, including living and future behavior fields', () => {
    const livingKeys = [
      'id',
      'species',
      'age',
      'energy',
      'generation',
      'children',
      'ancestry',
      'rotation',
      'direction',
      'x',
      'y',
      'settings',
      'behavior',
    ];
    for (const location of ['root', 'genome', 'cell']) {
      const value = envelope();
      const record = (location === 'root'
        ? value
        : location === 'genome'
          ? value.genome
          : value.genome.cells[0]) as unknown as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const copy = structuredClone(value);
        const target = (location === 'root'
          ? copy
          : location === 'genome'
            ? copy.genome
            : copy.genome.cells[0]) as unknown as Record<string, unknown>;
        delete target[key];
        expect(() => parseBlueprint(JSON.stringify(copy))).toThrow();
      }
      for (const key of livingKeys.filter((key) => !Object.hasOwn(record, key))) {
        record[key] = { arbitrary: true };
        expect(() => parseBlueprint(JSON.stringify(value))).toThrow();
        delete record[key];
      }
    }
    expect(() => parseBlueprint(JSON.stringify({ ...envelope(), format: 'world' }))).toThrow(
      'standalone',
    );
    for (const genome of [
      null,
      [],
      5,
      { ...allTypes(), cells: [null] },
      { ...allTypes(), cells: [[]] },
    ])
      expect(() => parseBlueprint(JSON.stringify({ ...envelope(), genome }))).toThrow();
    expect(() => parseBlueprint('{"__proto__":{},"format":"evolab-organism-blueprint"}')).toThrow();
  });

  it('rejects invalid anatomy without repair', () => {
    const cell = { x: 0, y: 0, type: 3 };
    const bodies = [
      [],
      Array(17).fill(cell),
      [cell, cell],
      [cell, { ...cell, type: 4 }],
      [cell, { ...cell, x: 1, y: 1 }],
      [cell, { ...cell, x: 2 }],
      ...[0.5, -5, 5, '0', null].map((x) => [{ ...cell, x }]),
      ...[0.5, -5, 5, '0', null].map((y) => [{ ...cell, y }]),
      ...[2, 9, 3.5, '3', null].map((type) => [{ ...cell, type }]),
      null,
      {},
      'cells',
    ];
    for (const cells of bodies)
      expect(() =>
        parseBlueprint(JSON.stringify({ ...envelope(), genome: { ...allTypes(), cells } })),
      ).toThrow();
  });

  it('rejects all invalid traits including non-finite programmatic exports', () => {
    const invalid = {
      preference: [-0.001, 1.001, NaN, Infinity, -Infinity, null, '0.5'],
      tolerance: [0.1199, 0.6001, NaN, Infinity, null, '0.3'],
      tempo: [1, 13, 2.5, NaN, Infinity, null, '3'],
    };
    for (const [key, values] of Object.entries(invalid))
      for (const value of values) {
        const input = { ...envelope(), genome: { ...allTypes(), [key]: value } };
        expect(() => serializeBlueprint(input as ReturnType<typeof envelope>)).toThrow();
        expect(() => parseBlueprint(JSON.stringify(input))).toThrow();
      }
  });

  it('enforces inclusive UTF-8 bytes before parsing, not character count', () => {
    const text = serializeBlueprint(envelope());
    const padded =
      text + ' '.repeat(BLUEPRINT_MAX_BYTES - new TextEncoder().encode(text).byteLength);
    expect(new TextEncoder().encode(padded)).toHaveLength(BLUEPRINT_MAX_BYTES);
    expect(parseBlueprint(padded)).toEqual(envelope());
    expect(() => parseBlueprint(padded + ' ')).toThrow('16 KiB');
    const multibyte = '🌿'.repeat(4500);
    expect(multibyte.length).toBeLessThan(BLUEPRINT_MAX_BYTES);
    expect(() => parseBlueprint(multibyte)).toThrow('16 KiB');
    expect(() => parseBlueprint('{bad JSON secret payload')).toThrow(
      'Could not parse this blueprint. Choose a valid JSON file.',
    );
  });
});
