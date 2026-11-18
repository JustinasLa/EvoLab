import { EXPERIMENT_RULES_VERSION } from './experiment-model';
import { integer, WORLD_MAX_BYTES } from './model';

// Automatic recovery is a separate IndexedDB database. It never opens, counts or
// migrates the five manual checkpoint slots in `evolab-world-checkpoints`.
export const RECOVERY_DATABASE = 'evolab-world-recovery';
export const RECOVERY_CAPACITY = 2;
export const RECOVERY_INTERVAL_MS = 60_000;
// One tab owns capture at a time. A lease that has not been renewed for 2.5
// capture intervals is abandoned (closed, hidden or crashed tab) and claimable.
export const RECOVERY_LEASE_MS = 150_000;
const RECORD_MAX_BYTES = WORLD_MAX_BYTES * 6 + 1024;
const LEASE_MAX_BYTES = 512;
const TIME_MAX = 8.64e15;
const IDENTITY = /^[0-9a-z-]{1,64}$/;
const SLOTS = [1, 2] as const;

export interface RecoveryClaim {
  owner: string;
  generation: string;
  sequence: number;
  savedAt: number;
}
export interface RecoverySnapshot {
  slot: number;
  token?: string;
  owner?: string;
  generation?: string;
  sequence?: number;
  savedAt?: number;
  tick?: number;
  seed?: number;
  worldVersion?: number;
  rulesVersion?: number;
  world?: string;
  problem?: string;
  readonly?: boolean;
}
export interface RecoveryLease {
  owner: string;
  generation: string;
  renewedAt: number;
}
export interface RecoveryInspection {
  rows: RecoverySnapshot[];
  lease: RecoveryLease | 'unsupported' | null;
  count: number;
}
const messages = {
  busy: 'Recovery storage busy. This capture was skipped, not queued.',
  unavailable:
    'Recovery storage unavailable in this browser profile. The world continues; download or checkpoint it instead.',
  unsupported:
    'Recovery storage holds unsupported data. It was preserved read-only and nothing was saved.',
  quota:
    'Recovery storage is full. The previous recovery snapshot was kept; the world continues and the next interval retries.',
  storage:
    'Recovery storage failed. The previous recovery snapshot was kept; the next interval retries.',
  pending:
    'Recovery storage has not settled. A write may still commit; captures are skipped until it does.',
  owned: 'Another EvoLab tab owns automatic recovery. This tab skipped its capture.',
  stale: 'A newer recovery snapshot from this tab already exists. The older capture was discarded.',
  full: 'Both recovery slots hold unsupported records. They were preserved; nothing was saved.',
  invalid:
    'Recovery snapshot exceeds its bounds or lacks complete world metadata. Nothing was saved.',
};
export type RecoveryCode = keyof typeof messages;
export class RecoveryError extends Error {
  constructor(public code: RecoveryCode) {
    super(messages[code]);
  }
}
function storageError(error: unknown): RecoveryError {
  if (error instanceof RecoveryError) return error;
  const name = (error as { name?: string } | null)?.name;
  return new RecoveryError(
    name === 'QuotaExceededError'
      ? 'quota'
      : name === 'VersionError'
        ? 'unsupported'
        : name === 'SecurityError' || name === 'InvalidStateError'
          ? 'unavailable'
          : 'storage',
  );
}
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const validClaim = (claim: RecoveryClaim): boolean =>
  IDENTITY.test(claim.owner) &&
  IDENTITY.test(claim.generation) &&
  integer(claim.sequence, 1, Number.MAX_SAFE_INTEGER) &&
  integer(claim.savedAt, 0, TIME_MAX);

/** Wrap one complete native Save with bounded identity and provenance metadata. */
export function recoveryRecord(
  claim: RecoveryClaim,
  world: string,
  rulesVersion: number = EXPERIMENT_RULES_VERSION,
): string {
  if (
    !validClaim(claim) ||
    !integer(rulesVersion, 1, 1e6) ||
    typeof world !== 'string' ||
    world.length > WORLD_MAX_BYTES ||
    bytes(world) > WORLD_MAX_BYTES
  )
    throw new RecoveryError('invalid');
  let source;
  try {
    // Inspect metadata only. Complete ecological validation belongs to the worker's load path.
    source = JSON.parse(world);
  } catch {
    throw new RecoveryError('invalid');
  }
  if (
    !source ||
    !integer(source.version, 1, 1e6) ||
    !integer(source.tick, 0, 1e9) ||
    !integer(source.settings?.seed, 0, 4294967295)
  )
    throw new RecoveryError('invalid');
  return JSON.stringify({
    format: 'evolab-recovery',
    version: 1,
    owner: claim.owner,
    generation: claim.generation,
    sequence: claim.sequence,
    savedAt: claim.savedAt,
    tick: source.tick,
    seed: source.settings.seed,
    worldVersion: source.version,
    rulesVersion,
    world,
  });
}
export function classifyRecovery(
  slot: number,
  value: unknown,
  present = value !== undefined,
): RecoverySnapshot {
  if (!present) return { slot };
  if (
    typeof value !== 'string' ||
    value.length > RECORD_MAX_BYTES ||
    bytes(value) > RECORD_MAX_BYTES
  )
    return { slot, problem: 'Uninspectable stored value; preserved read-only.', readonly: true };
  let record;
  try {
    record = JSON.parse(value);
  } catch {
    return { slot, token: value, problem: 'Corrupt recovery snapshot; replaceable.' };
  }
  if (record?.format !== 'evolab-recovery' || record.version !== 1)
    return {
      slot,
      problem: 'Unsupported recovery declaration; preserved read-only.',
      readonly: true,
    };
  try {
    if (
      Object.keys(record).length !== 11 ||
      recoveryRecord(record, record.world, record.rulesVersion) !== value
    )
      throw new RecoveryError('invalid');
  } catch {
    return { slot, token: value, problem: 'Corrupt recovery snapshot; replaceable.' };
  }
  return {
    slot,
    token: value,
    owner: record.owner,
    generation: record.generation,
    sequence: record.sequence,
    savedAt: record.savedAt,
    tick: record.tick,
    seed: record.seed,
    worldVersion: record.worldVersion,
    rulesVersion: record.rulesVersion,
    world: record.world,
  };
}
export function classifyLease(value: unknown): RecoveryLease | 'unsupported' | null {
  if (value === undefined) return null;
  try {
    if (typeof value !== 'string' || bytes(value) > LEASE_MAX_BYTES) throw new Error();
    const lease = JSON.parse(value);
    const exact = {
      version: 1,
      owner: lease.owner,
      generation: lease.generation,
      renewedAt: lease.renewedAt,
    };
    if (
      JSON.stringify(exact) !== value ||
      !validClaim({ ...lease, sequence: 1, savedAt: lease.renewedAt })
    )
      throw new Error();
    return { owner: lease.owner, generation: lease.generation, renewedAt: lease.renewedAt };
  } catch {
    return 'unsupported';
  }
}
export const leaseRecord = (claim: RecoveryClaim): string =>
  JSON.stringify({
    version: 1,
    owner: claim.owner,
    generation: claim.generation,
    renewedAt: claim.savedAt,
  });
/** A fresh lease of another tab blocks capture; one outside the window either way is abandoned. */
export const leaseBlocks = (lease: RecoveryLease, claim: RecoveryClaim): boolean =>
  lease.owner !== claim.owner && Math.abs(claim.savedAt - lease.renewedAt) < RECOVERY_LEASE_MS;

/**
 * Choose the slot a transaction replaces: an empty slot first, otherwise the oldest
 * replaceable (corrupt or supported) record. Unsupported records are never chosen.
 */
export function recoveryTarget(rows: RecoverySnapshot[], claim: RecoveryClaim): number {
  if (rows.some((row) => row.owner === claim.owner && row.sequence! >= claim.sequence))
    throw new RecoveryError('stale');
  const empty = rows.find((row) => row.token === undefined && !row.readonly);
  if (empty) return empty.slot;
  const replaceable = rows
    .filter((row) => !row.readonly)
    .sort((left, right) => (left.savedAt ?? -1) - (right.savedAt ?? -1));
  if (!replaceable.length) throw new RecoveryError('full');
  return replaceable[0].slot;
}
function guarded(fail: (error: unknown) => void, callback: () => void): () => void {
  return () => {
    try {
      callback();
    } catch (error) {
      fail(error);
    }
  };
}
export function createRecovery(options: { factory?: () => IDBFactory | undefined } = {}) {
  let database: IDBDatabase | undefined;
  let working = false,
    disposed = false;
  let active: IDBTransaction | undefined;
  const close = (): void => {
    if (database) {
      database.onversionchange = database.onclose = null;
      database.close();
      database = undefined;
    }
  };
  function connect(): Promise<IDBDatabase> {
    if (database) return Promise.resolve(database);
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        const factory = options.factory ? options.factory() : globalThis.indexedDB;
        if (!factory) throw new RecoveryError('unavailable');
        request = factory.open(RECOVERY_DATABASE, 1);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      let expired = false;
      // An expired open keeps this store busy until the native request settles.
      const timer = setTimeout(() => {
        expired = true;
        reject(new RecoveryError('pending'));
      }, 5000);
      const settle = (): void => {
        clearTimeout(timer);
        request.onblocked = request.onerror = request.onsuccess = request.onupgradeneeded = null;
        if (expired) working = false;
      };
      request.onupgradeneeded = (event) => {
        try {
          if (expired || disposed || event.oldVersion !== 0) request.transaction!.abort();
          else request.result.createObjectStore('entries');
        } catch {
          request.transaction?.abort();
        }
      };
      request.onerror = () => {
        settle();
        reject(storageError(request.error));
      };
      request.onsuccess = () => {
        const connection = request.result;
        settle();
        if (expired || disposed) {
          connection.close();
          reject(new RecoveryError('unavailable'));
          return;
        }
        if (
          connection.version !== 1 ||
          connection.objectStoreNames.length !== 1 ||
          !connection.objectStoreNames.contains('entries')
        ) {
          connection.close();
          reject(new RecoveryError('unsupported'));
          return;
        }
        database = connection;
        connection.onversionchange = connection.onclose = () => {
          try {
            active?.abort();
          } catch {
            // The native terminal callback still releases ownership.
          }
          close();
        };
        resolve(connection);
      };
    });
  }
  function transaction<Result>(
    connection: IDBDatabase,
    mode: IDBTransactionMode,
    operation: (
      store: IDBObjectStore,
      accept: (result: Result) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<Result> {
    return new Promise((resolve, reject) => {
      let native: IDBTransaction;
      try {
        native = connection.transaction('entries', mode);
      } catch (error) {
        close();
        reject(storageError(error));
        return;
      }
      active = native;
      let result: Result,
        failure: RecoveryError | undefined,
        expired = false;
      const abort = (): void => {
        try {
          native.abort();
        } catch {
          // Already finished; its terminal callback decides the outcome.
        }
      };
      // An expired write may still commit, so ownership stays until terminal delivery.
      const timer = setTimeout(() => {
        expired = true;
        abort();
        reject(new RecoveryError('pending'));
      }, 10000);
      const finish = (): void => {
        clearTimeout(timer);
        native.oncomplete = native.onabort = native.onerror = null;
        if (active === native) active = undefined;
        if (expired) working = false;
      };
      const fail = (error: unknown): void => {
        failure ??= storageError(error);
        abort();
      };
      native.onerror = (event) => {
        const error = (event.target as IDBRequest | null)?.error;
        if (error) failure ??= storageError(error);
      };
      native.onabort = () => {
        finish();
        reject(failure ?? storageError(native.error));
      };
      native.oncomplete = () => {
        finish();
        if (disposed) reject(new RecoveryError('unavailable'));
        else resolve(result);
      };
      try {
        const store = native.objectStore('entries');
        if (store.keyPath !== null || store.autoIncrement || store.indexNames.length)
          throw new RecoveryError('unsupported');
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
  // Read the two slots, the lease and the physical count in one native transaction.
  function read(
    store: IDBObjectStore,
    fail: (error: unknown) => void,
    then: (inspection: RecoveryInspection) => void,
  ): void {
    const count = store.count();
    count.onsuccess = guarded(fail, () => {
      const values: unknown[] = [];
      let delivered = 0;
      for (const [index, key] of [...SLOTS, 'lease'].entries()) {
        const request = store.get(key);
        request.onsuccess = guarded(fail, () => {
          values[index] = request.result;
          if (++delivered < 3) return;
          const known = values.filter((value) => value !== undefined).length;
          if (count.result > known) throw new RecoveryError('unsupported');
          then({
            rows: SLOTS.map((slot, position) => classifyRecovery(slot, values[position])),
            lease: classifyLease(values[2]),
            count: count.result,
          });
        });
      }
    });
  }
  async function exclusive<Result>(
    mode: IDBTransactionMode,
    operation: (
      store: IDBObjectStore,
      accept: (result: Result) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<Result> {
    if (disposed) throw new RecoveryError('unavailable');
    if (working) throw new RecoveryError('busy');
    working = true;
    let settled = true;
    try {
      return await transaction(await connect(), mode, operation);
    } catch (error) {
      if (error instanceof RecoveryError && error.code === 'pending') settled = false;
      throw error;
    } finally {
      if (settled) working = false;
    }
  }
  return {
    inspect(): Promise<RecoveryInspection> {
      return exclusive('readonly', (store, accept, fail) => read(store, fail, accept));
    },
    /**
     * Persist one complete record transactionally. The replaced slot is only lost when
     * the new record and the renewed lease commit together; any abort keeps both slots.
     */
    commit(
      claim: RecoveryClaim,
      record: string,
    ): Promise<Omit<RecoveryInspection, 'count'> & { slot: number }> {
      const row = classifyRecovery(1, record);
      if (
        row.owner !== claim.owner ||
        row.generation !== claim.generation ||
        row.sequence !== claim.sequence ||
        row.savedAt !== claim.savedAt
      )
        return Promise.reject(new RecoveryError('invalid'));
      return exclusive('readwrite', (store, accept, fail) =>
        read(store, fail, (inspection) => {
          if (inspection.lease === 'unsupported') throw new RecoveryError('unsupported');
          if (inspection.lease && leaseBlocks(inspection.lease, claim))
            throw new RecoveryError('owned');
          const slot = recoveryTarget(inspection.rows, claim);
          store.put(record, slot);
          store.put(leaseRecord(claim), 'lease');
          accept({
            slot,
            lease: { owner: claim.owner, generation: claim.generation, renewedAt: claim.savedAt },
            rows: inspection.rows.map((row) =>
              row.slot === slot ? classifyRecovery(slot, record) : row,
            ),
          });
        }),
      );
    },
    get busy(): boolean {
      return working;
    },
    dispose(): void {
      disposed = true;
      try {
        active?.abort();
      } catch {
        // Native terminal delivery still releases the transaction.
      }
      close();
    },
  };
}
