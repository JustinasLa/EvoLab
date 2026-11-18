import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyLease,
  classifyRecovery,
  createRecovery,
  leaseRecord,
  recoveryRecord,
  recoveryTarget,
  RecoveryError,
  RECOVERY_DATABASE,
  RECOVERY_LEASE_MS,
  type RecoveryClaim,
} from '../src/recovery';
import { checkpointRecord, createCheckpoints, CHECKPOINT_DATABASE } from '../src/checkpoints';
import { EXPERIMENT_RULES_VERSION } from '../src/experiment-model';
import { Ecosystem } from '../src/ecosystem';
import { startWorker, type Scope } from '../src/worker';
import { DEFAULTS, WORLD_MAX_BYTES, WORLD_VERSION } from '../src/model';
import { libraryHarness as harness } from './fixtures/library';

const world = (ticks = 0, seed = DEFAULTS.seed) => {
  const source = new Ecosystem({ ...DEFAULTS, seed });
  for (let tick = 0; tick < ticks; tick++) source.step();
  return JSON.stringify(source.save());
};
const base = world(3);
const claim = (sequence: number, overrides: Partial<RecoveryClaim> = {}): RecoveryClaim => ({
  owner: 'tab-a',
  generation: 'tab-a-1',
  sequence,
  savedAt: 1_000_000 + sequence * 60_000,
  ...overrides,
});
const pending = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded recovery records', () => {
  it('wraps one complete native Save with identity, tick, seed, save time and provenance', () => {
    const record = JSON.parse(recoveryRecord(claim(1), base));
    expect(record).toEqual({
      format: 'evolab-recovery',
      version: 1,
      owner: 'tab-a',
      generation: 'tab-a-1',
      sequence: 1,
      savedAt: 1_060_000,
      tick: 3,
      seed: DEFAULTS.seed,
      worldVersion: WORLD_VERSION,
      rulesVersion: EXPERIMENT_RULES_VERSION,
      world: base,
    });
    expect(classifyRecovery(1, recoveryRecord(claim(1), base))).toMatchObject({
      slot: 1,
      tick: 3,
      world: base,
      rulesVersion: EXPERIMENT_RULES_VERSION,
    });
    // An older rules version captured earlier remains a valid, exact record.
    expect(classifyRecovery(2, recoveryRecord(claim(1), base, 7)).rulesVersion).toBe(7);
  });
  it('rejects unbounded identities, oversized worlds and incomplete metadata', () => {
    for (const bad of [
      { owner: '' },
      { owner: 'x'.repeat(65) },
      { owner: 'Tab A' },
      { generation: '../' },
      { sequence: 0 },
      { sequence: 1.5 },
      { savedAt: -1 },
      { savedAt: 9e15 },
    ])
      expect(() => recoveryRecord(claim(1, bad), base)).toThrow(RecoveryError);
    for (const text of [
      '{',
      'null',
      '{}',
      JSON.stringify({ version: 1, tick: -1, settings: { seed: 1 } }),
      JSON.stringify({ version: 1, tick: 1, settings: {} }),
      'x'.repeat(WORLD_MAX_BYTES + 1),
      '🌿'.repeat(700_000),
    ])
      expect(() => recoveryRecord(claim(1), text)).toThrow(RecoveryError);
    expect(() => recoveryRecord(claim(1), 4 as any)).toThrow(RecoveryError);
    expect(() => recoveryRecord(claim(1), base, 0)).toThrow(RecoveryError);
  });
  it('preserves future and oversized values read-only and marks broken supported records replaceable', () => {
    for (const value of [
      7,
      null,
      'x'.repeat(WORLD_MAX_BYTES * 6 + 1025),
      '🌿'.repeat(4_000_000),
      '{}',
      'null',
      JSON.stringify({ format: 'evolab-recovery', version: 2, world: base }),
      JSON.stringify({ format: 'other', version: 1 }),
    ])
      expect(classifyRecovery(1, value)).toMatchObject({ readonly: true });
    const valid = JSON.parse(recoveryRecord(claim(1), base));
    for (const value of [
      '{',
      JSON.stringify({ ...valid, tick: 99 }),
      JSON.stringify({ ...valid, extra: true }),
      JSON.stringify({ ...valid, world: '{}' }),
    ])
      expect(classifyRecovery(1, value)).toMatchObject({
        token: value,
        problem: expect.stringContaining('Corrupt'),
      });
    expect(classifyRecovery(1, undefined)).toEqual({ slot: 1 });
  });
  it('classifies exact leases and preserves anything else as unsupported', () => {
    const lease = leaseRecord(claim(1));
    expect(classifyLease(lease)).toEqual({
      owner: 'tab-a',
      generation: 'tab-a-1',
      renewedAt: 1_060_000,
    });
    expect(classifyLease(undefined)).toBeNull();
    for (const value of [
      'null',
      '{',
      5,
      JSON.stringify({ ...JSON.parse(lease), version: 2 }),
      JSON.stringify({ ...JSON.parse(lease), owner: 'A B' }),
      `${lease} `,
      'x'.repeat(513),
    ])
      expect(classifyLease(value)).toBe('unsupported');
  });
  it('replaces an empty slot first, then the oldest replaceable record, never unsupported ones', () => {
    const row = (slot: number, sequence: number, owner = 'tab-b') =>
      classifyRecovery(
        slot,
        recoveryRecord(claim(sequence, { owner, generation: owner + '-1' }), base),
      );
    expect(recoveryTarget([{ slot: 1 }, { slot: 2 }], claim(1))).toBe(1);
    expect(recoveryTarget([row(1, 1), { slot: 2 }], claim(1))).toBe(2);
    expect(recoveryTarget([row(1, 5), row(2, 3)], claim(1))).toBe(2);
    expect(recoveryTarget([row(1, 5), classifyRecovery(2, '{')], claim(1))).toBe(2);
    const future = classifyRecovery(2, '{"format":"evolab-recovery","version":2}');
    expect(recoveryTarget([row(1, 9), future], claim(1))).toBe(1);
    expect(() => recoveryTarget([future, { ...future, slot: 1 }], claim(1))).toThrow(
      expect.objectContaining({ code: 'full' }),
    );
    expect(() => recoveryTarget([row(1, 4, 'tab-a'), { slot: 2 }], claim(4))).toThrow(
      expect.objectContaining({ code: 'stale' }),
    );
  });
});

describe('transactional recovery storage', () => {
  it('opens only its own database and keeps at most two records, evicting the oldest in one transaction', async () => {
    const native = harness();
    native.faults.upgrade = true;
    const store = createRecovery({ factory: () => native.factory });
    expect(await store.inspect()).toEqual({
      rows: [{ slot: 1 }, { slot: 2 }],
      lease: null,
      count: 0,
    });
    expect(native.factory.open).toHaveBeenCalledWith(RECOVERY_DATABASE, 1);
    expect(native.connection.createObjectStore).toHaveBeenCalledWith('entries');
    const records = [1, 2, 3].map((sequence) => recoveryRecord(claim(sequence), world(sequence)));
    expect((await store.commit(claim(1), records[0])).slot).toBe(1);
    expect((await store.commit(claim(2), records[1])).slot).toBe(2);
    const third = await store.commit(claim(3), records[2]);
    expect(third.slot).toBe(1);
    expect(third.rows.map((row) => row.tick)).toEqual([3, 2]);
    expect(native.values.get(1)).toBe(records[2]);
    expect(native.values.get(2)).toBe(records[1]);
    expect(classifyLease(native.values.get('lease'))).toMatchObject({
      renewedAt: claim(3).savedAt,
    });
    expect(native.values.size).toBe(3);
    expect((await store.inspect()).count).toBe(3);
    store.dispose();
    await expect(store.inspect()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it.each([
    ['QuotaExceededError', 'quota'],
    ['UnknownError', 'storage'],
    ['SecurityError', 'unavailable'],
  ])('keeps the last valid snapshot when a %s aborts the write', async (name, code) => {
    const native = harness(),
      store = createRecovery({ factory: () => native.factory });
    await store.commit(claim(1), recoveryRecord(claim(1), base));
    const before = new Map(native.values);
    for (const fault of ['requestError', 'commitError'] as const) {
      native.faults[fault] = name;
      await expect(
        store.commit(claim(2), recoveryRecord(claim(2), world(4))),
      ).rejects.toMatchObject({
        code,
      });
      expect(native.values).toEqual(before);
      delete native.faults[fault];
    }
    expect(store.busy).toBe(false);
    expect((await store.commit(claim(2), recoveryRecord(claim(2), world(4)))).slot).toBe(2);
  });
  it('reports unavailable, blocked and unsupported storage without changing anything', async () => {
    await expect(createRecovery({ factory: () => undefined }).inspect()).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      createRecovery({
        factory: () => {
          throw new DOMException('', 'SecurityError');
        },
      }).inspect(),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const versioned = harness();
    versioned.faults.openError = 'VersionError';
    await expect(
      createRecovery({ factory: () => versioned.factory }).inspect(),
    ).rejects.toMatchObject({ code: 'unsupported' });
    for (const fault of ['wrongNames', 'version'] as const) {
      const test = harness();
      Object.assign(test.faults, { [fault]: fault === 'version' ? 2 : true });
      await expect(createRecovery({ factory: () => test.factory }).inspect()).rejects.toMatchObject(
        { code: 'unsupported' },
      );
    }
    for (const fault of ['keyPath', 'autoIncrement', 'indexes', 'storeThrow'] as const) {
      const test = harness();
      Object.assign(test.faults, { [fault]: fault === 'keyPath' ? 'id' : true });
      await expect(
        createRecovery({ factory: () => test.factory }).inspect(),
      ).rejects.toBeInstanceOf(RecoveryError);
    }
    const throwing = harness();
    throwing.faults.transactionThrow = 'InvalidStateError';
    await expect(
      createRecovery({ factory: () => throwing.factory }).inspect(),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(throwing.connection.close).toHaveBeenCalled();
    // A later open of an existing future database version is aborted, not migrated.
    const upgrade = harness();
    upgrade.faults.openStall = true;
    const opening = createRecovery({ factory: () => upgrade.factory }).inspect();
    upgrade.request.onupgradeneeded({ oldVersion: 1 });
    expect(upgrade.request.transaction.abort).toHaveBeenCalled();
    upgrade.deliverOpen();
    await expect(opening).rejects.toMatchObject({ code: 'storage' });
    const create = harness();
    Object.assign(create.faults, { upgrade: true, createThrow: true });
    await expect(createRecovery({ factory: () => create.factory }).inspect()).rejects.toMatchObject(
      {
        code: 'storage',
      },
    );
  });
  it('preserves future records, foreign keys and unsupported leases read-only', async () => {
    const native = harness(),
      store = createRecovery({ factory: () => native.factory });
    const future = JSON.stringify({ format: 'evolab-recovery', version: 2, world: 'opaque' });
    native.values.set(1, future);
    expect((await store.commit(claim(1), recoveryRecord(claim(1), base))).slot).toBe(2);
    expect((await store.commit(claim(2), recoveryRecord(claim(2), base))).slot).toBe(2);
    expect(native.values.get(1)).toBe(future);
    native.values.set(2, future);
    await expect(store.commit(claim(3), recoveryRecord(claim(3), base))).rejects.toMatchObject({
      code: 'full',
    });
    native.values.delete(2);
    native.values.set('lease', '{"version":9}');
    await expect(store.commit(claim(4), recoveryRecord(claim(4), base))).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect((await store.inspect()).lease).toBe('unsupported');
    native.values.delete('lease');
    native.values.set('foreign', 'kept');
    await expect(store.inspect()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(store.commit(claim(5), recoveryRecord(claim(5), base))).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(native.values.get('foreign')).toBe('kept');
    expect(native.values.get(1)).toBe(future);
    await expect(store.commit(claim(6), recoveryRecord(claim(7), base))).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      store.commit(claim(6, { generation: 'tab-a-2' }), recoveryRecord(claim(6), base)),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('skips overlapping operations instead of queueing them', async () => {
    const native = harness(),
      store = createRecovery({ factory: () => native.factory });
    const first = store.commit(claim(1), recoveryRecord(claim(1), base));
    expect(store.busy).toBe(true);
    const overlapping = [store.commit(claim(2), recoveryRecord(claim(2), base)), store.inspect()];
    for (const attempt of overlapping)
      await expect(attempt).rejects.toMatchObject({ code: 'busy' });
    await first;
    expect(store.busy).toBe(false);
    expect(native.values.get(1)).toContain('"sequence":1');
    expect(native.values.has(2)).toBe(false);
  });
  it('rejects stale completions and other tabs while their lease is fresh, then hands over abandoned leases', async () => {
    const native = harness();
    const tabA = createRecovery({ factory: () => native.factory }),
      tabB = createRecovery({ factory: () => native.factory });
    await tabA.commit(claim(2), recoveryRecord(claim(2), world(2)));
    // A late completion from the same tab with an older sequence never overwrites newer evidence.
    await expect(tabA.commit(claim(1), recoveryRecord(claim(1), world(1)))).rejects.toMatchObject({
      code: 'stale',
    });
    await expect(
      tabA.commit(
        claim(2, { generation: 'tab-a-2' }),
        recoveryRecord(claim(2, { generation: 'tab-a-2' }), base),
      ),
    ).rejects.toMatchObject({ code: 'stale' });
    const other = (savedAt: number): RecoveryClaim => ({
      owner: 'tab-b',
      generation: 'tab-b-1',
      sequence: 1,
      savedAt,
    });
    const renewed = claim(2).savedAt;
    const before = new Map(native.values);
    for (const savedAt of [renewed + RECOVERY_LEASE_MS - 1, renewed - RECOVERY_LEASE_MS + 1])
      await expect(
        tabB.commit(other(savedAt), recoveryRecord(other(savedAt), base)),
      ).rejects.toMatchObject({
        code: 'owned',
      });
    expect(native.values).toEqual(before);
    const takeover = other(renewed + RECOVERY_LEASE_MS);
    expect((await tabB.commit(takeover, recoveryRecord(takeover, base))).slot).toBe(2);
    expect(classifyLease(native.values.get('lease'))).toMatchObject({ owner: 'tab-b' });
    // The previous owner's later completion is rejected once the lease moved.
    const late = claim(3, { savedAt: takeover.savedAt + 1 });
    await expect(tabA.commit(late, recoveryRecord(late, base))).rejects.toMatchObject({
      code: 'owned',
    });
    expect(native.values.get(1)).toBe(before.get(1));
  });
  it('keeps an expired native write busy until it settles, without queueing later captures', async () => {
    vi.useFakeTimers();
    const native = harness(),
      store = createRecovery({ factory: () => native.factory });
    await store.inspect();
    native.faults.txStall = true;
    native.faults.abortThrow = true;
    const stalled = store.commit(claim(1), recoveryRecord(claim(1), base));
    const rejected = expect(stalled).rejects.toMatchObject({ code: 'pending' });
    await pending();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(store.busy).toBe(true);
    await expect(store.inspect()).rejects.toMatchObject({ code: 'busy' });
    native.faults.txStall = false;
    native.current.complete();
    await pending();
    expect(store.busy).toBe(false);
    expect(native.values.get(1)).toContain('"sequence":1');
    expect((await store.inspect()).rows[0].sequence).toBe(1);
  });
  it('keeps an expired open busy until the native request settles and closes it', async () => {
    vi.useFakeTimers();
    const native = harness();
    native.faults.openStall = true;
    const store = createRecovery({ factory: () => native.factory });
    const opening = store.inspect(),
      rejected = expect(opening).rejects.toMatchObject({ code: 'pending' });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(store.busy).toBe(true);
    native.deliverOpen();
    expect(store.busy).toBe(false);
    expect(native.connection.close).toHaveBeenCalled();
    native.faults.openStall = false;
    const errored = harness();
    errored.faults.openStall = true;
    const failing = createRecovery({ factory: () => errored.factory });
    const failed = expect(failing.inspect()).rejects.toMatchObject({ code: 'pending' });
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    errored.faults.openError = 'UnknownError';
    errored.deliverOpen();
    expect(failing.busy).toBe(false);
  });
  it('drops its connection on version change or close and reconnects for the next capture', async () => {
    const native = harness(),
      store = createRecovery({ factory: () => native.factory });
    await store.inspect();
    native.connection.onversionchange();
    expect(native.connection.close).toHaveBeenCalledTimes(1);
    await store.inspect();
    expect(native.factory.open).toHaveBeenCalledTimes(2);
    native.faults.txStall = true;
    const held = store.inspect();
    await Promise.resolve();
    native.faults.abortThrow = true;
    native.connection.onclose();
    native.faults.abortThrow = false;
    native.faults.txStall = false;
    native.current.native.abort();
    await expect(held).rejects.toBeInstanceOf(RecoveryError);
    await store.inspect();
    expect(native.factory.open).toHaveBeenCalledTimes(3);
    native.faults.txStall = true;
    const disposed = store.commit(claim(1), recoveryRecord(claim(1), base));
    await pending();
    store.dispose();
    await expect(disposed).rejects.toBeInstanceOf(RecoveryError);
    expect(native.values.size).toBe(0);
    const late = harness();
    late.faults.openStall = true;
    const closing = createRecovery({ factory: () => late.factory }),
      open = closing.inspect();
    closing.dispose();
    late.deliverOpen();
    await expect(open).rejects.toMatchObject({ code: 'unavailable' });
    const committed = harness(),
      finishing = createRecovery({ factory: () => committed.factory });
    await finishing.inspect();
    committed.faults.abortThrow = true;
    committed.faults.completionStall = 'readwrite';
    const write = finishing.commit(claim(1), recoveryRecord(claim(1), base));
    await pending();
    finishing.dispose();
    committed.current.releaseCompletion();
    await expect(write).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('never opens, counts or changes the five manual checkpoint slots', async () => {
    const recoveryNative = harness(),
      checkpointNative = harness();
    const factory = {
      open: vi.fn((name: string, version: number) =>
        (name === RECOVERY_DATABASE ? recoveryNative : checkpointNative).factory.open(
          name,
          version,
        ),
      ),
    } as unknown as IDBFactory;
    const checkpoints = createCheckpoints({ factory: () => factory });
    for (let slot = 1; slot <= 5; slot++)
      await checkpoints.access({ slot }, checkpointRecord('manual ' + slot, world(slot)));
    const manual = new Map(checkpointNative.values);
    const recovery = createRecovery({ factory: () => factory });
    for (let sequence = 1; sequence <= 4; sequence++)
      await recovery.commit(claim(sequence), recoveryRecord(claim(sequence), world(sequence)));
    expect(checkpointNative.values).toEqual(manual);
    expect(recoveryNative.values.size).toBe(3);
    expect((factory.open as any).mock.calls.map(([name]: [string]) => name)).toEqual([
      CHECKPOINT_DATABASE,
      RECOVERY_DATABASE,
    ]);
    expect((await checkpoints.list()).count).toBe(5);
  });
});

describe('capture leaves real worker continuations unchanged', () => {
  function bridge() {
    const tasks: (() => void)[] = [];
    let commandId = 0,
      time = 0,
      terminal: any;
    const scope: Scope = {
      onmessage: null,
      postMessage(data: any) {
        if (data.type === 'frame' || data.type === 'progress')
          queueMicrotask(() =>
            scope.onmessage!({
              data: {
                type: 'flow-ack',
                runId: data.runId,
                sequence: data.sequence,
                channel: data.type === 'frame' ? 'display' : 'progress',
              },
            } as MessageEvent),
          );
        if ('commandId' in data) terminal = structuredClone(data);
      },
    };
    startWorker(
      scope,
      (callback) => tasks.push(callback),
      () => time,
    );
    const send = (data: any) => {
      terminal = undefined;
      scope.onmessage!({
        data: {
          ...(data.type === 'start' ? { display: { epoch: 0, enabled: true, visible: true } } : {}),
          ...data,
          runId: 1,
          commandId: ++commandId,
        },
      } as MessageEvent);
      return terminal;
    };
    return {
      send,
      advance() {
        time += 40;
        tasks.shift()!();
      },
    };
  }
  it('produces identical worlds with recovery Saves interleaved at worker command boundaries', async () => {
    const enabled = bridge(),
      disabled = bridge();
    for (const side of [enabled, disabled]) {
      side.send({ type: 'start', settings: { ...DEFAULTS, seed: 9601 } });
      side.send({ type: 'speed', value: 4 });
    }
    const captured: string[] = [];
    for (let round = 0; round < 60; round++) {
      enabled.advance();
      disabled.advance();
      await Promise.resolve();
      if (round % 10 === 4) {
        const saved = enabled.send({ type: 'save' });
        expect(saved.type).toBe('saved');
        captured.push(recoveryRecord(claim(captured.length + 1), saved.text));
      }
    }
    for (const side of [enabled, disabled]) side.send({ type: 'pause' });
    const final = [enabled.send({ type: 'save' }).text, disabled.send({ type: 'save' }).text];
    expect(final[0]).toBe(final[1]);
    expect(captured).toHaveLength(6);
    const ticks = captured.map((record) => JSON.parse(record).tick);
    expect(ticks).toEqual([...ticks].sort((left, right) => left - right));
    expect(JSON.parse(final[0]).tick).toBeGreaterThan(ticks.at(-1)!);
    // The newest recovery world continues exactly like the uncaptured world.
    const recovered = Ecosystem.load(JSON.parse(captured.at(-1)!).world);
    while (recovered.tick < JSON.parse(final[1]).tick) recovered.step();
    expect(JSON.stringify(recovered.save())).toBe(final[1]);
  });
});
