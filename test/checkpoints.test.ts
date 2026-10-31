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

describe('native checkpoint ownership and failure delivery', () => {
  it('handles absent factories, thrown opens, native errors, unsupported schemas and disposal', async () => {
    await expect(createCheckpoints({ factory: () => undefined }).open()).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      createCheckpoints({
        factory: () => {
          throw new DOMException('', 'SecurityError');
        },
      }).open(),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const native = harness();
    native.faults.openError = 'VersionError';
    await expect(createCheckpoints({ factory: () => native.factory }).open()).rejects.toMatchObject(
      { code: 'unsupported' },
    );
    delete native.faults.openError;
    for (const fault of ['wrongNames', 'version'] as const) {
      const test = harness();
      Object.assign(test.faults, { [fault]: fault === 'version' ? 2 : true });
      await expect(createCheckpoints({ factory: () => test.factory }).open()).rejects.toMatchObject(
        { code: 'unsupported' },
      );
    }
    for (const fault of ['keyPath', 'autoIncrement', 'indexes', 'storeThrow'] as const) {
      const test = harness();
      Object.assign(test.faults, { [fault]: fault === 'keyPath' ? 'id' : true });
      const store = createCheckpoints({ factory: () => test.factory });
      await expect(store.list()).rejects.toBeInstanceOf(CheckpointError);
      store.dispose();
    }
    const store = createCheckpoints({ factory: () => native.factory });
    await store.open();
    native.connection.onversionchange();
    await store.open();
    native.connection.onclose();
    await store.open();
    native.faults.transactionThrow = 'InvalidStateError';
    await expect(store.list()).rejects.toMatchObject({ code: 'unavailable' });
    store.dispose();
    const late = harness();
    late.faults.openStall = true;
    const closing = createCheckpoints({ factory: () => late.factory }),
      opening = closing.open();
    closing.dispose();
    late.deliverOpen();
    await expect(opening).rejects.toMatchObject({ code: 'unavailable' });
    expect(late.connection.close).toHaveBeenCalled();
  });
  it.each([
    ['QuotaExceededError', 'quota'],
    ['UnknownError', 'storage'],
    ['SecurityError', 'unavailable'],
    ['VersionError', 'unsupported'],
  ])('preserves exact bytes on %s request and commit failures', async (name, code) => {
    const native = harness(),
      store = createCheckpoints({ factory: () => native.factory });
    native.values.set(1, token());
    await store.open();
    for (const fault of ['requestError', 'commitError'] as const) {
      native.faults[fault] = name;
      await expect(store.access(entry(), checkpointRecord('new', text()))).rejects.toMatchObject({
        code,
      });
      expect(native.values.get(1)).toBe(token());
      delete native.faults[fault];
    }
    store.dispose();
  });
  it('keeps one expired open until native settlement and aborts expired upgrades', async () => {
    vi.useFakeTimers();
    const native = harness(),
      status = vi.fn();
    Object.assign(native.faults, { openStall: true, blocked: true });
    const store = createCheckpoints({ factory: () => native.factory, status });
    const opening = store.open(),
      rejected = expect(opening).rejects.toMatchObject({ code: 'pending' });
    await pending();
    await expect(store.open()).rejects.toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await expect(store.open()).rejects.toMatchObject({ code: 'busy' });
    native.faults.upgrade = true;
    native.deliverOpen();
    expect(native.request.transaction.abort).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.stringContaining('Late'));
    expect(store.busy).toBe(false);
    store.dispose();
    const upgrade = harness();
    Object.assign(upgrade.faults, { upgrade: true, createThrow: true });
    const broken = createCheckpoints({ factory: () => upgrade.factory });
    await broken.open();
    expect(upgrade.request.transaction.abort).toHaveBeenCalled();
    broken.dispose();
  });
  it.each([false, true])(
    'retains uncertain writes until native settlement, commit=%s',
    async (commit) => {
      vi.useFakeTimers();
      const native = harness(),
        status = vi.fn(),
        store = createCheckpoints({ factory: () => native.factory, status });
      await store.open();
      Object.assign(native.faults, { txStall: true, abortThrow: true });
      const writing = store.access({ slot: 1 }, token()),
        rejected = expect(writing).rejects.toMatchObject({ code: 'pending' });
      await pending();
      const owner = native.current;
      await vi.advanceTimersByTimeAsync(10000);
      await rejected;
      expect(store.busy).toBe(true);
      await expect(store.access({ slot: 2 }, token())).rejects.toMatchObject({ code: 'busy' });
      native.connection.onversionchange();
      if (commit) {
        delete native.faults.txStall;
        owner.complete();
      } else owner.native.onabort();
      await pending();
      expect(store.busy).toBe(false);
      expect(status).toHaveBeenCalledWith(
        expect.stringContaining(commit ? 'committed after' : 'aborted'),
      );
      expect(native.values.size).toBe(commit ? 1 : 0);
      store.dispose();
    },
  );
  it.each(['onversionchange', 'onclose'] as const)(
    'revokes read presentation on %s until native terminal delivery',
    async (invalidation) => {
      vi.useFakeTimers();
      const native = harness(),
        status = vi.fn(),
        invalidated = vi.fn();
      const store = createCheckpoints({ factory: () => native.factory, status, invalidated });
      await store.open();
      Object.assign(native.faults, { completionStall: 'readonly', abortThrow: true });
      const reading = store.list();
      await pending();
      const owner = native.current;
      native.connection[invalidation]();
      const count = status.mock.calls.length;
      expect(invalidated).toHaveBeenCalledOnce();
      expect(store.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(10001);
      expect(status).toHaveBeenCalledTimes(count);
      owner.releaseCompletion();
      await reading;
      expect(status).toHaveBeenCalledTimes(count);
      expect(store.busy).toBe(false);
      store.dispose();
    },
  );
  it('settles a timed-out read, rejects disposed native completion and ignores duplicate terminals', async () => {
    vi.useFakeTimers();
    const native = harness(),
      status = vi.fn(),
      store = createCheckpoints({ factory: () => native.factory, status });
    await store.open();
    native.faults.txStall = true;
    const read = store.list(),
      rejected = expect(read).rejects.toMatchObject({ code: 'pending' });
    await pending();
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(store.busy).toBe(false);
    delete native.faults.txStall;
    Object.assign(native.faults, { completionStall: 'readonly', abortThrow: true });
    const another = store.list();
    await pending();
    const owner = native.current;
    const completed = owner.native.oncomplete,
      aborted = owner.native.onabort;
    store.dispose();
    owner.releaseCompletion();
    await expect(another).rejects.toMatchObject({ code: 'unavailable' });
    completed();
    aborted();
    expect(store.busy).toBe(false);
  });
  it('rejects inaccessible changed records and counts foreign records before filling an empty slot', async () => {
    const native = harness(),
      store = createCheckpoints({ factory: () => native.factory });
    await store.open();
    for (const value of [null, '{"version":2}', undefined]) {
      if (value === undefined) native.values.delete(1);
      else native.values.set(1, value);
      await expect(store.access(entry(), null)).rejects.toMatchObject({ code: 'conflict' });
    }
    for (let i = 2; i <= 6; i++) native.values.set(i, token());
    await expect(store.access({ slot: 1 }, token())).rejects.toMatchObject({ code: 'full' });
    expect(native.values.has(1)).toBe(false);
    store.dispose();
  });
});

it('checks native transaction ownership again after asynchronous open settles', async () => {
  const native = harness(),
    store = createCheckpoints({ factory: () => native.factory });
  await store.open();
  const first = store.list(),
    second = store.list();
  await expect(second).rejects.toMatchObject({ code: 'busy' });
  await first;
  const stale = store.list();
  store.dispose();
  await expect(stale).rejects.toMatchObject({ code: 'unavailable' });
});

it('classifies synchronous quota failure inside native success delivery and preserves stored bytes', async () => {
  const native = harness();
  native.values.set(1, token());
  const store = createCheckpoints({ factory: () => native.factory });
  await store.open();
  const original = native.connection.transaction.getMockImplementation()!;
  native.connection.transaction.mockImplementation((stores, mode) => {
    const tx = original(stores, mode),
      objectStore = tx.objectStore;
    tx.objectStore = () => {
      const entries = objectStore();
      entries.put = () => {
        throw new DOMException('quota exhausted', 'QuotaExceededError');
      };
      return entries;
    };
    return tx;
  });
  await expect(store.access(entry(), checkpointRecord('new', text()))).rejects.toMatchObject({
    code: 'quota',
  });
  expect(native.values.get(1)).toBe(token());
  store.dispose();
});
