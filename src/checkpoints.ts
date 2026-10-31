import { integer, WORLD_MAX_BYTES } from './model';

export const CHECKPOINT_DATABASE = 'evolab-world-checkpoints';
export const CHECKPOINT_CAPACITY = 5;
const RECORD_MAX_BYTES = WORLD_MAX_BYTES * 6 + 1024;
export interface Checkpoint {
  slot: number;
  token?: string;
  name?: string;
  tick?: number;
  seed?: number;
  world?: string;
  problem?: string;
  readonly?: boolean;
}
const messages = {
  busy: 'Checkpoint storage busy. Wait for its native operation; no action was queued.',
  unavailable: 'Checkpoint storage unavailable. Download your world instead.',
  unsupported: 'Unsupported checkpoint storage. No stored data was changed.',
  quota: 'Checkpoint storage is full. Download your world or delete a checkpoint you choose.',
  storage: 'Checkpoint storage failed. Refresh explicitly; the displayed list may be stale.',
  pending:
    'Native checkpoint storage has not settled. A write may have committed. Wait, then Refresh before retrying.',
  conflict: 'Checkpoint changed or disappeared. Refresh and review it again; nothing was replaced.',
  invalid: 'Invalid checkpoint name or complete world payload.',
  full: 'Checkpoint storage is overfull. No checkpoint was saved.',
};
export class CheckpointError extends Error {
  constructor(public code: keyof typeof messages) {
    super(messages[code]);
  }
}
function storageError(error: unknown): CheckpointError {
  if (error instanceof CheckpointError) return error;
  const name = (error as { name?: string } | null)?.name;
  return new CheckpointError(
    name === 'QuotaExceededError'
      ? 'quota'
      : name === 'VersionError'
        ? 'unsupported'
        : name === 'SecurityError' || name === 'InvalidStateError'
          ? 'unavailable'
          : 'storage',
  );
}
export function checkpointRecord(name: string, world: string): string {
  if (
    !name.trim() ||
    name.length > 80 ||
    typeof world !== 'string' ||
    world.length > WORLD_MAX_BYTES ||
    new TextEncoder().encode(world).byteLength > WORLD_MAX_BYTES
  )
    throw new CheckpointError('invalid');
  // Inspect metadata only. Complete ecological validation belongs to the worker's existing load path.
  const source = JSON.parse(world);
  if (!source || !integer(source.tick, 0, 1e9) || !integer(source.settings?.seed, 0, 4294967295))
    throw new CheckpointError('invalid');
  return JSON.stringify({ version: 1, name, tick: source.tick, seed: source.settings.seed, world });
}
export function classifyCheckpoint(slot: number, value: unknown): Checkpoint {
  if (value === undefined) return { slot };
  if (
    typeof value !== 'string' ||
    value.length > RECORD_MAX_BYTES ||
    new TextEncoder().encode(value).byteLength > RECORD_MAX_BYTES
  )
    return { slot, problem: 'Uninspectable stored value; preserved read-only.', readonly: true };
  try {
    const record = JSON.parse(value);
    if (record?.version !== 1)
      return {
        slot,
        problem: 'Unsupported checkpoint declaration; preserved read-only.',
        readonly: true,
      };
    if (Object.keys(record).length !== 5 || checkpointRecord(record.name, record.world) !== value)
      throw new CheckpointError('invalid');
    return {
      slot,
      token: value,
      name: record.name,
      tick: record.tick,
      seed: record.seed,
      world: record.world,
    };
  } catch {
    return {
      slot,
      token: value,
      problem: 'Corrupt checkpoint. Restore is unavailable; explicit deletion is available.',
    };
  }
}
// Native request callbacks run after transaction admission; catch synchronous
// storage failures here so quota errors retain their actionable classification.
function guarded(fail: (error: unknown) => void, callback: () => void): () => void {
  return () => {
    try {
      callback();
    } catch (error) {
      fail(error);
    }
  };
}
export function createCheckpoints(
  options: {
    factory?: () => IDBFactory | undefined;
    status?: (message: string) => void;
    invalidated?: () => void;
  } = {},
) {
  let database: IDBDatabase | undefined;
  let opening: IDBOpenDBRequest | undefined;
  let active: IDBTransaction | undefined;
  let activeStatus: ((message: string) => void) | undefined;
  let invalidateActive: (() => void) | undefined;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const status = (message: string): void => {
    if (!disposed) options.status?.(message);
  };
  const close = (): void => {
    if (database) {
      database.onversionchange = database.onclose = null;
      database.close();
      database = undefined;
    }
  };
  const abort = (): void => {
    try {
      active?.abort();
    } catch {
      activeStatus?.(messages.pending);
    }
  };
  async function open(): Promise<void> {
    if (disposed) throw new CheckpointError('unavailable');
    if (opening || active) throw new CheckpointError('busy');
    if (database) return;
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        const factory = options.factory ? options.factory() : globalThis.indexedDB;
        if (!factory) throw new CheckpointError('unavailable');
        request = factory.open(CHECKPOINT_DATABASE, 1);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      opening = request;
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        status(
          'Checkpoint open timed out. Its native request is still pending; close other tabs and wait.',
        );
        reject(new CheckpointError('pending'));
      }, 5000);
      const finish = (): void => {
        clearTimeout(timer);
        request.onblocked = request.onerror = request.onsuccess = request.onupgradeneeded = null;
        if (opening === request) opening = undefined;
      };
      request.onblocked = () =>
        status('Checkpoint opening is blocked. Close other EvoLab tabs; the world continues.');
      request.onupgradeneeded = (event) => {
        try {
          if (expired || disposed || event.oldVersion !== 0) request.transaction!.abort();
          else request.result.createObjectStore('entries');
        } catch {
          request.transaction?.abort();
        }
      };
      request.onerror = () => {
        const error = storageError(request.error);
        finish();
        reject(error);
      };
      request.onsuccess = () => {
        const connection = request.result;
        finish();
        if (expired || disposed) {
          connection.close();
          if (expired)
            status('Late checkpoint open closed. Refresh explicitly to read current entries.');
          reject(new CheckpointError('unavailable'));
          return;
        }
        if (
          connection.version !== 1 ||
          connection.objectStoreNames.length !== 1 ||
          !connection.objectStoreNames.contains('entries')
        ) {
          connection.close();
          reject(new CheckpointError('unsupported'));
          return;
        }
        database = connection;
        connection.onversionchange = () => {
          invalidateActive?.();
          abort();
          close();
          options.invalidated?.();
          status('Another tab changed the checkpoint. Confirmations cancelled; Retry explicitly.');
        };
        connection.onclose = () => {
          invalidateActive?.();
          abort();
          close();
          options.invalidated?.();
          status('The checkpoint connection closed. The list is stale; Retry explicitly.');
        };
        resolve();
      };
    });
  }
  function transaction<Result>(
    mode: IDBTransactionMode,
    operation: (
      store: IDBObjectStore,
      accept: (result: Result) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<Result> {
    if (disposed || !database) return Promise.reject(new CheckpointError('unavailable'));
    if (opening || active) return Promise.reject(new CheckpointError('busy'));
    return new Promise((resolve, reject) => {
      let native: IDBTransaction;
      try {
        native = database!.transaction('entries', mode);
      } catch (error) {
        close();
        reject(storageError(error));
        return;
      }
      active = native;
      let result: Result,
        failure: CheckpointError | undefined,
        expired = false,
        invalidated = false,
        presentation = true;
      const phaseStatus = (message: string): void => {
        if (presentation) status(message);
      };
      activeStatus = phaseStatus;
      const timer = setTimeout(() => {
        expired = true;
        phaseStatus(messages.pending);
        abort();
        reject(new CheckpointError('pending'));
      }, 10000);
      operationTimer = timer;
      // A revoked read still owns its native transaction until terminal delivery.
      // Its deadline and presentation are independent of that ownership.
      invalidateActive = () => {
        invalidated = true;
        if (mode === 'readonly') {
          presentation = false;
          clearTimeout(timer);
          operationTimer = undefined;
        }
      };
      const finish = (): boolean => {
        if (active !== native) return false;
        clearTimeout(timer);
        operationTimer = undefined;
        activeStatus = invalidateActive = undefined;
        native.oncomplete = native.onabort = native.onerror = null;
        active = undefined;
        return true;
      };
      const fail = (error: unknown): void => {
        failure = storageError(error);
        abort();
      };
      native.onerror = (event) => {
        const error = (event.target as IDBRequest | null)?.error;
        if (error) failure ??= storageError(error);
      };
      native.onabort = () => {
        const error = failure ?? storageError(native.error);
        if (!finish()) return;
        if (expired || (invalidated && mode === 'readwrite')) {
          phaseStatus('Native operation aborted; no write from it committed. Refresh explicitly.');
        }
        reject(error);
      };
      native.oncomplete = () => {
        if (!finish()) return;
        if (expired || (invalidated && mode === 'readwrite')) {
          phaseStatus(
            mode === 'readwrite'
              ? `Native write committed${expired ? ' after the deadline' : ''}. Refresh to inspect the committed record.`
              : 'Native read settled. Refresh explicitly.',
          );
        }
        if (disposed) reject(new CheckpointError('unavailable'));
        else resolve(result);
      };
      try {
        const store = native.objectStore('entries');
        if (store.keyPath !== null || store.autoIncrement || store.indexNames.length)
          throw new CheckpointError('unsupported');
        operation(
          store,
          (value) => {
            result = value;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  }
  async function list(): Promise<{ rows: Checkpoint[]; count: number; bytes: number }> {
    await open();
    return transaction('readonly', (store, accept, fail) => {
      const rows: Checkpoint[] = [];
      let bytes = 0;
      const count = store.count();
      count.onsuccess = guarded(fail, () => {
        for (let slot = 1; slot <= CHECKPOINT_CAPACITY; slot++) {
          const request = store.get(slot);
          request.onsuccess = guarded(fail, () => {
            const value: unknown = request.result;
            rows.push(classifyCheckpoint(slot, value));
            if (typeof value === 'string') bytes += new TextEncoder().encode(value).byteLength;
            if (rows.length === CHECKPOINT_CAPACITY) accept({ rows, count: count.result, bytes });
          });
        }
      });
    });
  }
  async function access(entry: Checkpoint, replacement?: string | null): Promise<Checkpoint> {
    if (!integer(entry.slot, 1, CHECKPOINT_CAPACITY) || entry.readonly)
      throw new CheckpointError('conflict');
    if (
      replacement !== undefined &&
      replacement !== null &&
      !classifyCheckpoint(entry.slot, replacement).world
    )
      throw new CheckpointError('invalid');
    await open();
    return transaction(
      replacement === undefined ? 'readonly' : 'readwrite',
      (store, accept, fail) => {
        const count = store.count();
        count.onsuccess = guarded(fail, () => {
          if (replacement && count.result > CHECKPOINT_CAPACITY) {
            fail(new CheckpointError('full'));
            return;
          }
          const request = store.get(entry.slot);
          request.onsuccess = guarded(fail, () => {
            const current = classifyCheckpoint(entry.slot, request.result);
            if (current.readonly || current.token !== entry.token) {
              fail(new CheckpointError('conflict'));
              return;
            }
            if (replacement && current.token === undefined && count.result >= CHECKPOINT_CAPACITY) {
              fail(new CheckpointError('full'));
              return;
            }
            if (replacement === null) store.delete(entry.slot);
            else if (replacement !== undefined) store.put(replacement, entry.slot);
            accept(
              replacement === undefined
                ? current
                : classifyCheckpoint(entry.slot, replacement === null ? undefined : replacement),
            );
          });
        });
      },
    );
  }
  return {
    open,
    list,
    access,
    get busy(): boolean {
      return !!opening || !!active;
    },
    dispose(): void {
      disposed = true;
      clearTimeout(operationTimer);
      abort();
      close();
    },
  };
}
