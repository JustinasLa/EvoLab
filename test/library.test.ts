import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyRecord,
  createLibrary,
  encodeRecord,
  libraryCandidate,
  LIBRARY_RECORD_BYTES,
  LibraryError,
  type LibraryEntry,
  type LibraryProblem,
} from '../src/library';
import { founder } from '../src/model';
import { serializeBlueprint } from '../src/blueprint';
import { libraryHarness as harness } from './fixtures/library';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const candidate = () => libraryCandidate(founder(2), '  <img> 🌿  ', 'literal\nmetadata');
const token = () => encodeRecord(candidate(), 1);
const entry = (id = first, value = token()) => classifyRecord(id, value) as LibraryEntry;
const pending = async () => {
  for (let phase = 0; phase < 12; phase++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bounded local record classification', () => {
  it('projects exact ordered known genome fields and genuine provenance', () => {
    const genome = {
      ...founder(2),
      extra: 'x'.repeat(100000),
      cells: founder(2).cells.map((cell) => ({ ...cell, extra: true })),
    };
    const saved = libraryCandidate(genome, '  name  ', 'description', {
      captureTick: 0,
      seed: 4294967295,
    });
    expect(saved.blueprint.genome).toEqual(founder(2));
    expect(classifyRecord(first, encodeRecord(saved, 2))).toMatchObject({
      kind: 'valid',
      revision: 2,
      provenance: { captureTick: 0, seed: 4294967295 },
    });
    genome.cells[0].x = 4;
    expect(saved.blueprint.genome.cells[0].x).toBe(0);
    expect(() => libraryCandidate({ ...founder(0), cells: [] }, 'name', '')).toThrow();
  });
  it('establishes all declarations before codec errors and never repairs unknown or future data', () => {
    const blueprint = JSON.parse(serializeBlueprint(candidate().blueprint));
    const supported = JSON.parse(token());
    const unknown = [
      null,
      {},
      [],
      1,
      '{',
      'null',
      '{}',
      JSON.stringify({ recordVersion: 0 }),
      JSON.stringify({ ...supported, blueprint: 5 }),
      JSON.stringify({ ...supported, blueprint: '{' }),
      JSON.stringify({ ...supported, blueprint: 'null' }),
      JSON.stringify({ ...supported, blueprint: '{}' }),
      JSON.stringify({ ...supported, blueprint: JSON.stringify({ format: '', version: 1 }) }),
      JSON.stringify({
        ...supported,
        blueprint: JSON.stringify({ format: blueprint.format, version: 0 }),
      }),
      'x'.repeat(LIBRARY_RECORD_BYTES + 1),
      '🌿'.repeat(6000),
      JSON.stringify({ ...supported, blueprint: 'x'.repeat(16385) }),
    ];
    const cyclic: any = {};
    cyclic.self = cyclic;
    unknown.push(cyclic);
    for (const value of unknown)
      expect(classifyRecord(first, value)).toMatchObject({ kind: 'unknown' });
    expect(classifyRecord('invalid', token())).toMatchObject({ kind: 'unknown' });
    for (const value of [
      JSON.stringify({ recordVersion: 2, extra: true }),
      JSON.stringify({
        ...supported,
        blueprint: JSON.stringify({ ...blueprint, version: 2, extra: true }),
      }),
      JSON.stringify({
        ...supported,
        blueprint: JSON.stringify({ format: 'foreign', version: 1 }),
      }),
    ])
      expect(classifyRecord(first, value)).toMatchObject({ kind: 'unsupported' });
    for (const change of [
      { revision: 0 },
      { extra: true },
      { provenance: {} },
      { provenance: { seed: -1 } },
      { provenance: { captureTick: -1 } },
      { provenance: { unknown: 1 } },
      { blueprint: JSON.stringify({ ...blueprint, name: '' }) },
    ]) {
      const value = JSON.stringify({ ...supported, ...change });
      expect(classifyRecord(first, value)).toMatchObject({ kind: 'damaged', token: value });
    }
  });
  it('rejects revision, provenance and escaped envelope size overflow without truncation', () => {
    for (const revision of [0, Number.MAX_SAFE_INTEGER + 1])
      expect(() => encodeRecord(candidate(), revision)).toThrow();
    expect(() => libraryCandidate(founder(0), 'a', '', {})).toThrow();
    expect(() => libraryCandidate(founder(0), 'a', '', { seed: -1 })).toThrow();
    expect(() => libraryCandidate(founder(0), 'a', '', { captureTick: -1 })).toThrow();
    expect(() => libraryCandidate(founder(0), 'a'.repeat(81), '')).toThrow();
    expect(() => libraryCandidate(founder(0), 'a', '\u0000'.repeat(1000))).not.toThrow();
  });
});

describe('native event ownership and transactions', () => {
  it('aborts failed store creation and reports a native abort after the deadline', async () => {
    const native = harness();
    native.faults.upgrade = true;
    native.faults.createThrow = true;
    const library = createLibrary({ factory: () => native.factory });
    await library.open();
    expect(native.request.transaction.abort).toHaveBeenCalled();
    vi.useFakeTimers();
    native.faults.txStall = true;
    const reading = library.list();
    const rejected = expect(reading).rejects.toMatchObject({ code: 'pending' });
    await pending();
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(library.busy).toBe(false);
    library.dispose();
  });
  it('creates, lists, reads, renames, duplicates, replaces and deletes without changing IDs', async () => {
    const native = harness();
    native.faults.upgrade = true;
    const ids = [first, second];
    const library = createLibrary({ factory: () => native.factory, randomId: () => ids.shift()! });
    expect(await library.list()).toEqual({ count: 0, rows: [] });
    expect(await library.mutate({ type: 'create', candidate: candidate() })).toBe(first);
    let source = (await library.list()).rows[0] as LibraryEntry;
    expect(await library.read(source)).toEqual(source);
    await library.mutate({ type: 'rename', entry: source, name: source.blueprint.name });
    expect(native.values.get(first)).toBe(source.token);
    await library.mutate({ type: 'rename', entry: source, name: 'new' });
    await expect(library.read(source)).rejects.toMatchObject({ code: 'conflict' });
    source = (await library.list()).rows[0] as LibraryEntry;
    await library.mutate({ type: 'duplicate', entry: source });
    expect((await library.list()).rows).toHaveLength(2);
    await library.mutate({
      type: 'replace',
      entry: source,
      candidate: libraryCandidate(founder(1), 'replacement', '', { captureTick: 12 }),
    });
    source = (await library.list()).rows[0] as LibraryEntry;
    expect(source).toMatchObject({ id: first, revision: 3, provenance: { captureTick: 12 } });
    await library.mutate({ type: 'delete', entry: source });
    expect((await library.list()).rows[0]).toMatchObject({ id: second });
    library.dispose();
    await expect(library.open()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('counts every physical row and bounds cursor scans at 100', async () => {
    const native = harness();
    for (let index = 0; index < 101; index++)
      native.values.set(
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        index % 2 ? token() : '{}',
      );
    const library = createLibrary({
      factory: () => native.factory,
      randomId: () => crypto.randomUUID(),
    });
    const snapshot = await library.list();
    expect(snapshot.count).toBe(101);
    expect(snapshot.rows).toHaveLength(100);
    await expect(library.mutate({ type: 'create', candidate: candidate() })).rejects.toMatchObject({
      code: 'full',
    });
    const source = snapshot.rows.find((row) => row.kind === 'valid') as LibraryEntry;
    await expect(
      library.mutate({ type: 'rename', entry: source, name: 'new' }),
    ).rejects.toMatchObject({ code: 'full' });
    native.values.delete([...native.values.keys()][0]);
    await library.mutate({ type: 'rename', entry: source, name: 'new' });
    await expect(
      library.mutate({
        type: 'duplicate',
        entry: entry(source.id, native.values.get(source.id) as string),
      }),
    ).rejects.toMatchObject({ code: 'full' });
    library.dispose();
  });
  it('repeats repair classification and exact full-string CAS in the write transaction', async () => {
    const native = harness(),
      raw = { ...JSON.parse(token()), revision: 0 };
    const original = JSON.stringify(raw);
    native.values.set(first, original);
    const library = createLibrary({ factory: () => native.factory });
    const damaged = (await library.list()).rows[0] as LibraryProblem;
    const blueprint = JSON.parse(raw.blueprint);
    for (const replacement of [
      token(),
      JSON.stringify({ recordVersion: 2, extra: true }),
      JSON.stringify({
        ...raw,
        blueprint: JSON.stringify({ ...blueprint, version: 2, extra: true }),
      }),
      JSON.stringify({ ...raw, revision: -1 }),
      '{}',
      'x'.repeat(25000),
      null,
      undefined,
    ]) {
      if (replacement === undefined) native.values.delete(first);
      else native.values.set(first, replacement);
      await expect(library.mutate({ type: 'repair', entry: damaged })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(native.values.get(first)).toEqual(replacement);
    }
    native.values.set(first, original);
    await library.mutate({ type: 'repair', entry: damaged });
    expect(native.values.size).toBe(0);
    await expect(
      library.mutate({ type: 'repair', entry: { kind: 'unknown', id: first, reason: 'unknown' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    library.dispose();
  });
  it('bounds UUID collisions and refuses insecure IDs and revision overflow', async () => {
    const native = harness();
    native.values.set(first, token());
    const id = vi.fn(() => first),
      library = createLibrary({ factory: () => native.factory, randomId: id });
    await library.open();
    await expect(library.mutate({ type: 'create', candidate: candidate() })).rejects.toMatchObject({
      code: 'collision',
    });
    expect(id).toHaveBeenCalledTimes(3);
    id.mockReturnValueOnce('bad');
    await expect(library.mutate({ type: 'create', candidate: candidate() })).rejects.toMatchObject({
      code: 'unavailable',
    });
    id.mockImplementationOnce(() => {
      throw new Error('crypto');
    });
    await expect(library.mutate({ type: 'create', candidate: candidate() })).rejects.toMatchObject({
      code: 'unavailable',
    });
    native.values.set(first, encodeRecord(candidate(), Number.MAX_SAFE_INTEGER));
    await expect(
      library.mutate({
        type: 'rename',
        entry: entry(first, native.values.get(first) as string),
        name: 'new',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    library.dispose();
  });
  it('retries a request collision with a new transaction after native abort, preserving original bytes', async () => {
    const native = harness();
    const original = token();
    native.values.set(first, original);
    const id = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const library = createLibrary({ factory: () => native.factory, randomId: id });
    await library.open();
    const writing = library.mutate({ type: 'create', candidate: candidate() });
    const transaction = native.current.native;
    const onerror = transaction.onerror;
    const observed = vi.fn((event: Event) => {
      expect(transaction.error).toBeNull();
      expect((event.target as IDBRequest).error?.name).toBe('ConstraintError');
      onerror(event);
    });
    transaction.onerror = observed;
    await expect(writing).resolves.toBe(second);
    expect(observed).toHaveBeenCalledOnce();
    expect(transaction.error.name).toBe('ConstraintError');
    expect(id).toHaveBeenCalledTimes(2);
    expect(native.connection.transaction).toHaveBeenCalledTimes(2);
    expect(native.values.get(first)).toBe(original);
    expect(classifyRecord(second, native.values.get(second))).toMatchObject({ kind: 'valid' });
    library.dispose();
  });
  it.each([
    ['QuotaExceededError', 'quota'],
    ['UnknownError', 'storage'],
    ['SecurityError', 'unavailable'],
    ['InvalidStateError', 'unavailable'],
    ['VersionError', 'unsupported'],
  ])('maps request and commit %s to %s without publishing', async (name, code) => {
    const native = harness(),
      status = vi.fn(),
      library = createLibrary({ factory: () => native.factory, status });
    await library.open();
    native.faults.requestError = name;
    await expect(library.mutate({ type: 'create', candidate: candidate() })).rejects.toMatchObject({
      code,
    });
    expect(native.values.size).toBe(0);
    delete native.faults.requestError;
    native.faults.commitError = name;
    await expect(library.mutate({ type: 'create', candidate: candidate() })).rejects.toMatchObject({
      code,
    });
    expect(native.values.size).toBe(0);
    library.dispose();
  });
  it('retains one timed-out native open and closes its late success', async () => {
    vi.useFakeTimers();
    const native = harness();
    native.faults.openStall = true;
    native.faults.blocked = true;
    const status = vi.fn(),
      library = createLibrary({ factory: () => native.factory, status });
    const opened = library.open();
    const rejected = expect(opened).rejects.toMatchObject({ code: 'pending' });
    await pending();
    expect(status).toHaveBeenCalledWith(expect.stringContaining('blocked'));
    await expect(library.open()).rejects.toMatchObject({ code: 'busy' });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await expect(library.open()).rejects.toMatchObject({ code: 'busy' });
    native.faults.upgrade = true;
    native.deliverOpen();
    expect(native.request.transaction.abort).toHaveBeenCalled();
    expect(native.connection.close).toHaveBeenCalled();
    expect(library.busy).toBe(false);
    library.dispose();
  });
  it('keeps transaction ownership after an uncertain deadline until native settlement', async () => {
    vi.useFakeTimers();
    const native = harness(),
      status = vi.fn(),
      library = createLibrary({ factory: () => native.factory, status });
    await library.open();
    native.faults.txStall = true;
    native.faults.abortThrow = true;
    const writing = library.mutate({ type: 'create', candidate: candidate() });
    const rejected = expect(writing).rejects.toMatchObject({ code: 'pending' });
    await pending();
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(library.busy).toBe(true);
    await expect(library.mutate({ type: 'create', candidate: candidate() })).rejects.toMatchObject({
      code: 'busy',
    });
    native.connection.onversionchange();
    delete native.faults.txStall;
    native.current.complete();
    await pending();
    expect(native.values.size).toBe(1);
    expect(library.busy).toBe(false);
    expect(status).toHaveBeenCalledWith(expect.stringContaining('committed after'));
    library.dispose();
  });
  it.each(
    [false, true].flatMap((expired) =>
      ['onversionchange', 'onclose'].flatMap((invalidation) =>
        ['complete', 'abort'].map((terminal) => ({ expired, invalidation, terminal })),
      ),
    ),
  )(
    'revokes read presentation after expired=$expired $invalidation until $terminal',
    async ({ expired, invalidation, terminal }) => {
      vi.useFakeTimers();
      const native = harness();
      native.values.set(first, encodeRecord(candidate(), 1));
      const status = vi.fn();
      const library = createLibrary({ factory: () => native.factory, status });
      await library.open();
      native.faults.completionStall = 'readonly';
      native.faults.abortThrow = true;
      const reading = library.list().then(
        () => 'read',
        () => 'rejected',
      );
      await pending();
      const owner = native.current;
      if (expired) await vi.advanceTimersByTimeAsync(10000);
      native.connection[invalidation]();
      const calls = status.mock.calls.length;
      expect(library.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(10001);
      expect(status).toHaveBeenCalledTimes(calls);
      await expect(library.open()).rejects.toMatchObject({ code: 'busy' });
      if (terminal === 'complete') owner.releaseCompletion();
      else owner.native.onabort();
      await reading;
      expect(library.busy).toBe(false);
      expect(status).toHaveBeenCalledTimes(calls);
      expect([...native.values]).toEqual([[first, encodeRecord(candidate(), 1)]]);
      library.dispose();
    },
  );

  it.each(
    [false, true].flatMap((expired) =>
      ['onversionchange', 'onclose'].flatMap((invalidation) =>
        ['complete', 'abort'].map((terminal) => ({ expired, invalidation, terminal })),
      ),
    ),
  )(
    'retains write certainty after expired=$expired $invalidation until $terminal',
    async ({ expired, invalidation, terminal }) => {
      vi.useFakeTimers();
      const native = harness();
      const status = vi.fn();
      const settled = vi.fn();
      const library = createLibrary({ factory: () => native.factory, status });
      await library.open();
      native.faults.abortThrow = true;
      if (terminal === 'complete') native.faults.completionStall = 'readwrite';
      else native.faults.txStall = true;
      const writing = library.mutate({ type: 'create', candidate: candidate() }, settled).then(
        () => 'committed',
        () => 'rejected',
      );
      await pending();
      const owner = native.current;
      const completion = owner.native.oncomplete;
      const abortion = owner.native.onabort;
      native.connection[invalidation]();
      expect(settled).not.toHaveBeenCalled();
      expect(library.busy).toBe(true);
      await expect(library.open()).rejects.toMatchObject({ code: 'busy' });
      if (expired) await vi.advanceTimersByTimeAsync(10001);
      if (terminal === 'complete') owner.releaseCompletion();
      else abortion();
      await writing;
      expect(settled).toHaveBeenCalledExactlyOnceWith(terminal === 'complete', expired);
      expect(library.busy).toBe(false);
      expect(native.values.size).toBe(terminal === 'complete' ? 1 : 0);
      completion();
      abortion();
      expect(settled).toHaveBeenCalledTimes(1);
      expect(native.factory.open).toHaveBeenCalledTimes(1);
      library.dispose();
    },
  );

  it('does not retry an invalidated write even when its abort reports a collision', async () => {
    const native = harness();
    const randomId = vi.fn(() => first);
    const settled = vi.fn();
    const library = createLibrary({ factory: () => native.factory, randomId });
    await library.open();
    native.faults.requestError = 'ConstraintError';
    native.faults.abortThrow = true;
    const writing = library.mutate({ type: 'create', candidate: candidate() }, settled);
    const rejected = expect(writing).rejects.toMatchObject({ code: 'collision' });
    await pending();
    native.connection.onversionchange();
    native.current.native.onabort();
    await rejected;
    expect(settled).toHaveBeenCalledExactlyOnceWith(false, false);
    expect(randomId).toHaveBeenCalledTimes(1);
    expect(native.factory.open).toHaveBeenCalledTimes(1);
    expect(native.connection.transaction).toHaveBeenCalledTimes(1);
    expect(native.values.size).toBe(0);
    library.dispose();
  });

  it('preserves unsupported stores, handles native close/version changes and disposal', async () => {
    for (const fault of ['keyPath', 'autoIncrement', 'indexes', 'storeThrow'] as const) {
      const native = harness();
      Object.assign(native.faults, { [fault]: fault === 'keyPath' ? 'id' : true });
      const library = createLibrary({ factory: () => native.factory });
      await expect(library.list()).rejects.toBeInstanceOf(LibraryError);
      library.dispose();
    }
    for (const fault of ['wrongNames', 'version'] as const) {
      const native = harness();
      Object.assign(native.faults, { [fault]: fault === 'version' ? 2 : true });
      await expect(createLibrary({ factory: () => native.factory }).open()).rejects.toMatchObject({
        code: 'unsupported',
      });
    }
    const native = harness(),
      status = vi.fn(),
      library = createLibrary({ factory: () => native.factory, status });
    await library.open();
    native.connection.onversionchange();
    expect(native.connection.close).toHaveBeenCalled();
    await library.open();
    native.connection.onclose();
    await library.open();
    native.faults.transactionThrow = 'InvalidStateError';
    await expect(library.list()).rejects.toMatchObject({ code: 'unavailable' });
    library.dispose();
    await expect(library.mutate({ type: 'create', candidate: candidate() })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(library.read(entry())).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('handles absent factories, synchronous open failures, errors and late disposal', async () => {
    await expect(createLibrary({ factory: () => undefined }).open()).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      createLibrary({
        factory: () => {
          throw new DOMException('', 'SecurityError');
        },
      }).open(),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const native = harness();
    native.faults.openError = 'VersionError';
    await expect(createLibrary({ factory: () => native.factory }).open()).rejects.toMatchObject({
      code: 'unsupported',
    });
    delete native.faults.openError;
    native.faults.openStall = true;
    const library = createLibrary({ factory: () => native.factory }),
      opened = library.open();
    library.dispose();
    native.deliverOpen();
    await expect(opened).rejects.toMatchObject({ code: 'unavailable' });
    expect(native.connection.close).toHaveBeenCalled();
  });
});
