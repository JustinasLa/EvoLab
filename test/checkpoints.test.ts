import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkpointRecord,
  classifyCheckpoint,
  createCheckpoints,
  CheckpointError,
} from '../src/checkpoints';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, WORLD_MAX_BYTES, encodeLegacyValue } from '../src/model';
import { libraryHarness as harness } from './fixtures/library';
const text = () => JSON.stringify(new Ecosystem(DEFAULTS).save());
const token = () => checkpointRecord('  Literal <name> 🌿 ', text());
const entry = () => classifyCheckpoint(1, token());
const pending = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('complete checkpoint storage', () => {
  it('retains exact native bytes and deterministic complete continuation without a projection', async () => {
    const native = harness();
    const world = new Ecosystem(DEFAULTS);
    for (let i = 0; i < 95; i++) world.step();
    const source = world.save();
    Object.defineProperty(source.settings, '__proto__', {
      value: { retained: true },
      enumerable: true,
    });
    (source.settings as any).opaque = { nested: [{ infinity: 1e300, zero: -0 }] };
    for (const organism of source.organisms) {
      (organism as any).opaque = 'identity';
      organism.genome.legacyExtensions = [
        ['opaque', encodeLegacyValue({ a: [1, 2], zero: -0, infinity: Infinity })],
      ];
      organism.genome.cells[0].legacyExtensions = [['opaque', encodeLegacyValue('cell')]];
    }
    const original = JSON.stringify(source);
    const store = createCheckpoints({ factory: () => native.factory });
    await store.access({ slot: 1 }, checkpointRecord('full', original));
    const row = (await store.list()).rows[0];
    expect((await store.access(row)).world).toBe(original);
    const download = Ecosystem.load(original),
      local = Ecosystem.load(row.world!);
    for (let i = 0; i < 150; i++) {
      download.step();
      local.step();
    }
    expect(local.save()).toEqual(download.save());
    expect(JSON.stringify(local.save())).toContain('"__proto__":{"retained":true}');
    expect(local.tick).toBe(245);
    store.dispose();
  });
  it('lists five fixed slots, reports physical count and bytes, applies exact CAS and explicit deletion', async () => {
    const native = harness();
    native.faults.upgrade = true;
    const store = createCheckpoints({ factory: () => native.factory });
    expect((await store.list()).rows).toEqual([1, 2, 3, 4, 5].map((slot) => ({ slot })));
    for (let slot = 1; slot <= 5; slot++) await store.access({ slot }, token());
    const snapshot = await store.list();
    expect(snapshot.count).toBe(5);
    expect(snapshot.bytes).toBe(new TextEncoder().encode(token()).byteLength * 5);
    const previous = snapshot.rows[0];
    await store.access(previous, checkpointRecord('replacement', text()));
    await expect(store.access(previous)).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.access(previous, null)).rejects.toMatchObject({ code: 'conflict' });
    const current = (await store.list()).rows[0];
    await store.access(current, null);
    expect(native.values.has(1)).toBe(false);
    native.values.set(1, '{');
    await store.access(classifyCheckpoint(1, '{'), null);
    native.values.set(1, token());
    native.values.set('foreign', token());
    await expect(store.access({ slot: 2 }, token())).rejects.toMatchObject({ code: 'full' });
    await store.access(classifyCheckpoint(1, native.values.get(1)), null);
    store.dispose();
    await expect(store.list()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.access({ slot: 0 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.access({ slot: 1, readonly: true })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(store.access({ slot: 1 }, '{}')).rejects.toMatchObject({ code: 'invalid' });
  });
  it('preserves unsupported values and classifies corrupt supported envelopes without trusting metadata', () => {
    for (const value of [
      null,
      {},
      'x'.repeat(WORLD_MAX_BYTES * 6 + 1025),
      '🌿'.repeat(4_000_000),
      '{}',
      'null',
      '{"version":2}',
    ])
      expect(classifyCheckpoint(1, value).readonly).toBe(true);
    for (const value of [
      '{',
      '{"version":1}',
      JSON.stringify({ ...JSON.parse(token()), tick: 10 }),
      JSON.stringify({ ...JSON.parse(token()), extra: true }),
    ])
      expect(classifyCheckpoint(1, value)).toMatchObject({
        token: value,
        problem: expect.stringContaining('Corrupt'),
      });
    for (const name of ['', ' ', 'x'.repeat(81)])
      expect(() => checkpointRecord(name, text())).toThrow(CheckpointError);
    for (const value of [
      'null',
      '{}',
      '{"tick":-1}',
      'x'.repeat(WORLD_MAX_BYTES + 1),
      '🌿'.repeat(700000),
    ])
      expect(() => checkpointRecord('name', value)).toThrow();
    expect(() => checkpointRecord('name', 2 as any)).toThrow();
  });
});
