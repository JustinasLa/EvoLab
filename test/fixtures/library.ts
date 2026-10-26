import { vi } from 'vitest';
export function libraryHarness() {
  const values = new Map<IDBValidKey, unknown>();
  const faults: {
    openError?: string;
    blocked?: boolean;
    openStall?: boolean;
    upgrade?: boolean;
    version?: number;
    wrongNames?: boolean;
    keyPath?: string;
    autoIncrement?: boolean;
    indexes?: boolean;
    transactionThrow?: string;
    requestError?: string;
    commitError?: string;
    txStall?: boolean;
    completionStall?: IDBTransactionMode;
    abortThrow?: boolean;
    createThrow?: boolean;
    storeThrow?: boolean;
  } = {};
  let current: any, openRequest: any;
  const connection: any = {
    version: 1,
    objectStoreNames: { length: 1, contains: () => true },
    close: vi.fn(),
    createObjectStore: vi.fn(() => {
      if (faults.createThrow) throw new Error('create');
    }),
    transaction: vi.fn((_stores: string, mode: IDBTransactionMode) => {
      if (faults.transactionThrow) throw new DOMException('', faults.transactionThrow);
      const working = new Map(values);
      let count = 0,
        finished = false;
      let heldCompletion: (() => void) | undefined;
      const native: any = {
        error: null,
        abort: vi.fn(() => {
          if (faults.abortThrow) throw new Error('native pending');
          if (finished) return;
          finished = true;
          queueMicrotask(() => native.onabort?.());
        }),
        objectStore: () => {
          if (faults.storeThrow) throw new Error('store');
          return store;
        },
      };
      const complete = () => {
        if (count || finished || faults.txStall) return;
        queueMicrotask(() => {
          if (count || finished || faults.txStall) return;
          if (faults.commitError) {
            native.error = new DOMException('', faults.commitError);
            native.onerror?.({ target: native });
            native.abort();
            return;
          }
          finished = true;
          values.clear();
          for (const [key, value] of working) values.set(key, value);
          if (faults.completionStall === mode) heldCompletion = () => native.oncomplete?.();
          else native.oncomplete?.();
        });
      };
      const request = (compute: () => unknown) => {
        const result: any = { result: undefined, error: null };
        count++;
        queueMicrotask(() => {
          count--;
          if (finished) return;
          try {
            if (faults.requestError) throw new DOMException('', faults.requestError);
            result.result = compute();
            result.onsuccess?.();
          } catch (error) {
            result.error = error;
            const event = new Event('error', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'target', { value: result });
            result.onerror?.(event);
            native.onerror?.(event);
            native.error = error;
            native.abort();
          }
          complete();
        });
        return result;
      };
      const store: any = {
        keyPath: faults.keyPath ?? null,
        autoIncrement: !!faults.autoIncrement,
        indexNames: { length: faults.indexes ? 1 : 0 },
        count: () => request(() => working.size),
        get: (key: IDBValidKey) => request(() => working.get(key)),
        put: (value: unknown, key: IDBValidKey) => request(() => working.set(key, value)),
        add: (value: unknown, key: IDBValidKey) =>
          request(() => {
            if (working.has(key)) throw new DOMException('', 'ConstraintError');
            working.set(key, value);
          }),
        delete: (key: IDBValidKey) => request(() => working.delete(key)),
        openCursor: () => {
          const rows = [...working].sort(([left], [right]) =>
            String(left).localeCompare(String(right)),
          );
          let position = 0;
          const cursor: any = {};
          const deliver = () => {
            count++;
            queueMicrotask(() => {
              count--;
              if (finished) return;
              const row = rows[position++];
              cursor.result = row ? { key: row[0], value: row[1], continue: deliver } : null;
              cursor.onsuccess?.();
              complete();
            });
          };
          deliver();
          return cursor;
        },
      };
      current = {
        native,
        complete,
        releaseCompletion: () => {
          const callback = heldCompletion;
          heldCompletion = undefined;
          callback?.();
        },
      };
      queueMicrotask(complete);
      return native;
    }),
  };
  const deliverOpen = () => {
    if (faults.openError) {
      openRequest.error = new DOMException('', faults.openError);
      openRequest.onerror?.();
      return;
    }
    if (faults.upgrade) openRequest.onupgradeneeded?.({ oldVersion: 0 });
    connection.version = faults.version ?? 1;
    connection.objectStoreNames = {
      length: faults.wrongNames ? 2 : 1,
      contains: () => !faults.wrongNames,
    };
    openRequest.onsuccess?.();
  };
  const factory = {
    open: vi.fn(() => {
      openRequest = { result: connection, transaction: { abort: vi.fn() } };
      queueMicrotask(() => {
        if (faults.blocked) openRequest.onblocked?.();
        if (!faults.openStall) deliverOpen();
      });
      return openRequest;
    }),
  } as unknown as IDBFactory;
  return {
    factory,
    values,
    faults,
    connection,
    deliverOpen,
    get request() {
      return openRequest;
    },
    get current() {
      return current;
    },
  };
}
