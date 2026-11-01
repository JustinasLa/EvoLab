import {
  BLUEPRINT_MAX_BYTES,
  parseBlueprint,
  serializeBlueprint,
  type BlueprintFile,
} from './blueprint';
import { integer, cloneGenome, type Genome } from './model';

export const LIBRARY_DATABASE = 'evolab-organism-library';
export const LIBRARY_CAPACITY = 100;
export const LIBRARY_RECORD_BYTES = 20_480;
export interface Provenance {
  captureTick?: number;
  seed?: number;
}
export interface LibraryCandidate {
  blueprint: BlueprintFile;
  provenance?: Provenance;
}
export interface LibraryEntry extends LibraryCandidate {
  kind: 'valid';
  id: string;
  revision: number;
  token: string;
}
export interface LibraryProblem {
  kind: 'damaged' | 'unsupported' | 'unknown';
  id?: string;
  reason: string;
  token?: string;
}
export type LibraryRow = LibraryEntry | LibraryProblem;
export interface LibrarySnapshot {
  count: number;
  rows: LibraryRow[];
}
export type LibraryCode =
  | 'busy'
  | 'unavailable'
  | 'unsupported'
  | 'quota'
  | 'storage'
  | 'pending'
  | 'conflict'
  | 'full'
  | 'collision'
  | 'invalid';
const messages: Record<LibraryCode, string> = {
  busy: 'Library busy. Wait for the native operation to settle; no action was queued.',
  unavailable:
    'Library unavailable. Check browser storage permissions, or export a blueprint instead.',
  unsupported:
    'This library schema is unsupported. Use a compatible build. No stored data was changed.',
  quota:
    'Library could not save: storage is full. Export the unsaved blueprint, remove entries you choose, or free browser space.',
  storage: 'Local storage failed. The list may be stale. Refresh explicitly or export a blueprint.',
  pending:
    'Native storage has not settled. The write outcome is uncertain; wait, then Refresh. Do not assume it was not saved.',
  conflict:
    'The entry changed or disappeared. Refresh and review it again; no replacement was made.',
  full: 'The library is full or overfull. Remove an entry you choose; no entries were evicted.',
  collision: 'Could not allocate a unique local ID after three attempts. Nothing was saved.',
  invalid:
    'This blueprint cannot fit a valid local record. Check its name and anatomy, or export it instead.',
};
export class LibraryError extends Error {
  constructor(public code: LibraryCode) {
    super(messages[code]);
  }
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, limit: number): value is string =>
  typeof value === 'string' &&
  value.length <= limit &&
  new TextEncoder().encode(value).byteLength <= limit;
function provenanceValid(value: unknown): value is Provenance {
  return (
    object(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => key === 'captureTick' || key === 'seed') &&
    (!Object.hasOwn(value, 'captureTick') ||
      integer(value.captureTick, 0, Number.MAX_SAFE_INTEGER)) &&
    (!Object.hasOwn(value, 'seed') || integer(value.seed, 0, 4294967295))
  );
}
export function projectGenome(genome: Genome): Genome {
  try {
    return cloneGenome(genome);
  } catch {
    throw new LibraryError('invalid');
  }
}
export function libraryCandidate(
  genome: Genome,
  name: string,
  description: string,
  provenance?: Provenance,
): LibraryCandidate {
  const candidate = {
    blueprint: parseBlueprint(
      serializeBlueprint({ genome: projectGenome(genome), name, description }),
    ),
    ...(provenance === undefined ? {} : { provenance: { ...provenance } }),
  };
  encodeRecord(candidate, 1);
  return candidate;
}
export function encodeRecord(candidate: LibraryCandidate, revision: number): string {
  if (
    !integer(revision, 1, Number.MAX_SAFE_INTEGER) ||
    (candidate.provenance !== undefined && !provenanceValid(candidate.provenance))
  )
    throw new LibraryError('invalid');
  const token = JSON.stringify({
    recordVersion: 1,
    revision,
    blueprint: serializeBlueprint(candidate.blueprint),
    ...(candidate.provenance === undefined ? {} : { provenance: candidate.provenance }),
  });
  if (!bounded(token, LIBRARY_RECORD_BYTES)) throw new LibraryError('invalid');
  return token;
}
export function classifyRecord(key: unknown, value: unknown): LibraryRow {
  const id = uuid(key) ? key : undefined;
  const problem = (kind: LibraryProblem['kind'], reason: string): LibraryProblem => ({
    kind,
    ...(id ? { id } : {}),
    reason,
  });
  if (!id || !bounded(value, LIBRARY_RECORD_BYTES))
    return problem(
      'unknown',
      'Uninspectable key, type or record size; browser-storage recovery only.',
    );
  let record: unknown;
  try {
    record = JSON.parse(value);
  } catch {
    return problem('unknown', 'Uninspectable JSON; browser-storage recovery only.');
  }
  if (!object(record) || !integer(record.recordVersion, 1, Number.MAX_SAFE_INTEGER))
    return problem('unknown', 'Unknown record declaration; preserved read-only.');
  if (record.recordVersion !== 1)
    return problem('unsupported', 'Unsupported record version; preserved read-only.');
  if (!bounded(record.blueprint, BLUEPRINT_MAX_BYTES))
    return problem('unknown', 'Uninspectable embedded blueprint; preserved read-only.');
  let declaration: unknown;
  try {
    declaration = JSON.parse(record.blueprint);
  } catch {
    return problem('unknown', 'Uninspectable blueprint JSON; preserved read-only.');
  }
  if (!object(declaration) || typeof declaration.format !== 'string' || !declaration.format)
    return problem('unknown', 'Unknown blueprint declaration; preserved read-only.');
  if (declaration.format !== 'evolab-organism-blueprint')
    return problem('unsupported', 'Unsupported blueprint format; preserved read-only.');
  if (!integer(declaration.version, 1, Number.MAX_SAFE_INTEGER))
    return problem('unknown', 'Unknown blueprint version; preserved read-only.');
  if (
    declaration.version !== 1 &&
    declaration.version !== 2 &&
    declaration.version !== 3 &&
    declaration.version !== 4
  )
    return problem('unsupported', 'Unsupported blueprint version; preserved read-only.');
  let reason = 'Invalid supported record envelope.';
  try {
    if (
      Object.keys(record).some(
        (key) => !['recordVersion', 'revision', 'blueprint', 'provenance'].includes(key),
      ) ||
      !integer(record.revision, 1, Number.MAX_SAFE_INTEGER)
    )
      throw new LibraryError('invalid');
    reason = 'Invalid supported provenance.';
    if (Object.hasOwn(record, 'provenance') && !provenanceValid(record.provenance))
      throw new LibraryError('invalid');
    reason = 'Invalid supported blueprint.';
    const blueprint = parseBlueprint(record.blueprint);
    return {
      kind: 'valid',
      id,
      revision: record.revision,
      token: value,
      blueprint,
      ...(record.provenance === undefined
        ? {}
        : { provenance: { ...(record.provenance as Provenance) } }),
    };
  } catch {
    return { kind: 'damaged', id, token: value, reason };
  }
}
function storageError(error: unknown): LibraryError {
  if (error instanceof LibraryError) return error;
  const name = object(error) ? error.name : undefined;
  return new LibraryError(
    name === 'QuotaExceededError'
      ? 'quota'
      : name === 'ConstraintError'
        ? 'collision'
        : name === 'VersionError'
          ? 'unsupported'
          : name === 'SecurityError' || name === 'InvalidStateError'
            ? 'unavailable'
            : 'storage',
  );
}
export type LibraryMutation =
  | { type: 'create'; candidate: LibraryCandidate }
  | { type: 'duplicate'; entry: LibraryEntry }
  | { type: 'rename'; entry: LibraryEntry; name: string }
  | { type: 'replace'; entry: LibraryEntry; candidate: LibraryCandidate }
  | { type: 'delete'; entry: LibraryEntry }
  | { type: 'repair'; entry: LibraryProblem };

export function createLibrary(
  options: {
    factory?: () => IDBFactory | undefined;
    randomId?: () => string;
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
    if (disposed) throw new LibraryError('unavailable');
    if (opening || active) throw new LibraryError('busy');
    if (database) return;
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        const factory = options.factory ? options.factory() : globalThis.indexedDB;
        if (!factory) throw new LibraryError('unavailable');
        request = factory.open(LIBRARY_DATABASE, 1);
      } catch (error) {
        reject(storageError(error));
        return;
      }
      opening = request;
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        status(
          'Library open timed out. Its native request is still pending; close other tabs and wait.',
        );
        reject(new LibraryError('pending'));
      }, 5000);
      const finish = (): void => {
        clearTimeout(timer);
        request.onblocked = request.onerror = request.onsuccess = request.onupgradeneeded = null;
        if (opening === request) opening = undefined;
      };
      request.onblocked = () =>
        status('Library opening is blocked. Close other EvoLab tabs; the world continues.');
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
            status('Late library open closed. Refresh explicitly to read current entries.');
          reject(new LibraryError('unavailable'));
          return;
        }
        if (
          connection.version !== 1 ||
          connection.objectStoreNames.length !== 1 ||
          !connection.objectStoreNames.contains('entries')
        ) {
          connection.close();
          reject(new LibraryError('unsupported'));
          return;
        }
        database = connection;
        connection.onversionchange = () => {
          invalidateActive?.();
          abort();
          close();
          options.invalidated?.();
          status('Another tab changed the library. Confirmations cancelled; Retry explicitly.');
        };
        connection.onclose = () => {
          invalidateActive?.();
          abort();
          close();
          options.invalidated?.();
          status('The library connection closed. The list is stale; Retry explicitly.');
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
    settled?: (committed: boolean, expired: boolean) => void,
  ): Promise<Result> {
    if (disposed || !database) return Promise.reject(new LibraryError('unavailable'));
    if (opening || active) return Promise.reject(new LibraryError('busy'));
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
        failure: LibraryError | undefined,
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
        reject(new LibraryError('pending'));
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
          if (settled && !disposed) settled(false, expired);
          else
            phaseStatus(
              'Native operation aborted; no write from it committed. Refresh explicitly.',
            );
        }
        reject(error);
      };
      native.oncomplete = () => {
        if (!finish()) return;
        if (expired || (invalidated && mode === 'readwrite')) {
          if (settled && !disposed) settled(true, expired);
          else
            phaseStatus(
              mode === 'readwrite'
                ? `Native write committed${expired ? ' after the deadline' : ''}. Refresh to inspect the committed record.`
                : 'Native read settled. Refresh explicitly.',
            );
        }
        if (disposed) reject(new LibraryError('unavailable'));
        else resolve(result);
      };
      try {
        const store = native.objectStore('entries');
        if (store.keyPath !== null || store.autoIncrement || store.indexNames.length)
          throw new LibraryError('unsupported');
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
  async function list(): Promise<LibrarySnapshot> {
    await open();
    return transaction('readonly', (store, accept) => {
      const rows: LibraryRow[] = [];
      const count = store.count();
      count.onsuccess = () => {
        const total = count.result;
        accept({ count: total, rows });
        if (!total) return;
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          rows.push(classifyRecord(cursor.result.key, cursor.result.value));
          if (rows.length < LIBRARY_CAPACITY) cursor.result.continue();
        };
      };
    });
  }
  async function read(entry: LibraryEntry): Promise<LibraryEntry> {
    return transaction('readonly', (store, accept, fail) => {
      const request = store.get(entry.id);
      request.onsuccess = () => {
        const current = classifyRecord(entry.id, request.result);
        if (current.kind !== 'valid' || current.token !== entry.token)
          fail(new LibraryError('conflict'));
        else accept(current);
      };
    });
  }
  async function mutate(
    action: LibraryMutation,
    settled?: (committed: boolean, expired: boolean) => void,
  ): Promise<string> {
    const adding = action.type === 'create' || action.type === 'duplicate';
    const candidate =
      action.type === 'create' || action.type === 'replace' ? action.candidate : undefined;
    if (candidate) encodeRecord(candidate, 1);
    for (let attempt = 0; ; attempt++) {
      if (disposed || opening || active) throw new LibraryError(disposed ? 'unavailable' : 'busy');
      let id: string;
      try {
        id = adding
          ? options.randomId
            ? options.randomId()
            : globalThis.crypto.randomUUID()
          : action.entry.id!;
      } catch {
        throw new LibraryError('unavailable');
      }
      if (!uuid(id)) throw new LibraryError('unavailable');
      try {
        return await transaction<string>(
          'readwrite',
          (store, accept, fail) => {
            const count = store.count();
            count.onsuccess = () => {
              if (
                (adding && count.result >= LIBRARY_CAPACITY) ||
                (count.result > LIBRARY_CAPACITY && !['delete', 'repair'].includes(action.type))
              ) {
                fail(new LibraryError('full'));
                return;
              }
              const write = (value: LibraryCandidate, revision: number, add: boolean): void => {
                try {
                  const token = encodeRecord(value, revision);
                  if (add) store.add(token, id);
                  else store.put(token, id);
                  accept(id);
                } catch (error) {
                  fail(error);
                }
              };
              if (action.type === 'create') {
                write(action.candidate, 1, true);
                return;
              }
              const target = action.entry;
              if (!uuid(target.id) || !bounded(target.token, LIBRARY_RECORD_BYTES)) {
                fail(new LibraryError('conflict'));
                return;
              }
              const request = store.get(target.id);
              request.onsuccess = () => {
                const current = classifyRecord(target.id, request.result);
                if (
                  current.token !== target.token ||
                  (action.type === 'repair'
                    ? current.kind !== 'damaged' ||
                      target.kind !== 'damaged' ||
                      current.reason !== target.reason
                    : current.kind !== 'valid')
                ) {
                  fail(new LibraryError('conflict'));
                  return;
                }
                if (action.type === 'delete' || action.type === 'repair') {
                  store.delete(target.id!);
                  accept(target.id!);
                  return;
                }
                const entry = current as LibraryEntry;
                if (action.type === 'duplicate') write(entry, 1, true);
                else if (action.type === 'rename' && action.name === entry.blueprint.name)
                  accept(id);
                else
                  write(
                    action.type === 'replace'
                      ? action.candidate
                      : {
                          blueprint: { ...entry.blueprint, name: action.name },
                          ...(entry.provenance ? { provenance: entry.provenance } : {}),
                        },
                    entry.revision + 1,
                    false,
                  );
              };
            };
          },
          settled,
        );
      } catch (error) {
        if (
          !database ||
          !(error instanceof LibraryError) ||
          error.code !== 'collision' ||
          !adding ||
          attempt === 2
        )
          throw error;
      }
    }
  }
  return {
    open,
    list,
    read,
    mutate,
    get busy(): boolean {
      return !!opening || !!active;
    },
    cancel(): void {
      clearTimeout(operationTimer);
      operationTimer = undefined;
      abort();
    },
    dispose(): void {
      disposed = true;
      clearTimeout(operationTimer);
      operationTimer = undefined;
      abort();
      close();
    },
  };
}
