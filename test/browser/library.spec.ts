import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type WorldFile } from '../../src/model';
import { serializeBlueprint, parseBlueprint } from '../../src/blueprint';
import { encodeRecord, libraryCandidate, LIBRARY_DATABASE } from '../../src/library';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const third = '00000000-0000-4000-8000-000000000003';
const candidate = (name = '  <literal> 🌿  ') =>
  libraryCandidate(
    {
      cells: [7, 3, 4, 5, 6, 8].map((type, position) => ({
        x: (position % 3) - 1,
        y: Math.floor(position / 3),
        type: type as 3 | 4 | 5 | 6 | 7 | 8,
      })),
      preference: 0.1234567890123456,
      tolerance: 0.4567890123456789,
      tempo: 11,
    },
    name,
    'literal <script> text\ncomplete traits',
    { captureTick: 42, seed: 91 },
  );

async function database(page: Page, writes: [string, unknown][] = [], clear = false) {
  return page.evaluate(
    async ({ name, writes, clear }) =>
      new Promise<[string, unknown][]>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('entries');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const connection = request.result;
          const transaction = connection.transaction(
            'entries',
            writes.length || clear ? 'readwrite' : 'readonly',
          );
          const store = transaction.objectStore('entries');
          if (clear) store.clear();
          for (const [key, value] of writes) store.put(value, key);
          const rows: [string, unknown][] = [];
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            if (cursor.result) {
              rows.push([String(cursor.result.key), cursor.result.value]);
              cursor.result.continue();
            }
          };
          transaction.oncomplete = () => {
            connection.close();
            resolve(rows);
          };
          transaction.onabort = () => {
            connection.close();
            reject(transaction.error);
          };
        };
      }),
    { name: LIBRARY_DATABASE, writes, clear },
  );
}
async function openLibrary(page: Page) {
  await page.locator('#local-library > summary').click();
  await expect(page.locator('#library-status')).toContainText('refreshed');
}
async function download(page: Page, selector: string): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const stream = await (await pending).createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function pausedSave(page: Page) {
  const bytes = await download(page, '#save'),
    world = JSON.parse(bytes.toString()) as WorldFile;
  await expect(page.locator('#tick')).toHaveText(`TICK ${world.tick.toLocaleString()}`);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  return bytes;
}
async function fixture(page: Page) {
  await page.goto('/');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await pausedSave(page);
  const world = new Ecosystem({ ...DEFAULTS, nutrients: 10, mutation: 0, climate: 0 }, false);
  world.spawn(founder(0), 40, 40);
  const saved = world.save();
  await page.locator('#file').setInputFiles({
    name: 'world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const observed = JSON.parse((await pausedSave(page)).toString()) as WorldFile;
  const selected = observed.organisms[0];
  await page.getByTitle('Inspect organism (I)').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const at = await page.locator('#world').evaluate((canvas: HTMLCanvasElement, selected) => {
    const rect = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (selected.x + 0.5) * scale,
      y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (selected.y + 0.5) * scale,
    };
  }, selected);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#inspector')).toContainText('Organism 1');
  return pausedSave(page);
}

async function deliveryProbe(page: Page) {
  await page.addInitScript(() => {
    const state = {
      holdWorker: '',
      heldWorker: [] as { worker: Worker; event: MessageEvent }[],
      holdDatabase: false,
      holdDatabaseMode: '' as '' | IDBTransactionMode,
      heldDatabase: [] as (() => void)[],
      databaseTransactions: 0,
      holdOpen: false,
      heldOpen: [] as (() => void)[],
      openCalls: 0,
    };
    (window as any).libraryProbe = state;
    window.Worker = new Proxy(window.Worker, {
      construct(target, args: ConstructorParameters<typeof Worker>, newTarget) {
        const worker: Worker = Reflect.construct(target, args, newTarget);
        worker.addEventListener('message', (event) => {
          if (state.holdWorker !== event.data.type) return;
          event.stopImmediatePropagation();
          if (!state.heldWorker.length) state.heldWorker.push({ worker, event });
        });
        return worker;
      },
    });
    const nativeTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof nativeTransaction>) {
      state.databaseTransactions++;
      const transaction = nativeTransaction.apply(this, args);
      transaction.addEventListener('complete', (event) => {
        if (!state.holdDatabase && state.holdDatabaseMode !== transaction.mode) return;
        event.stopImmediatePropagation();
        if (!state.heldDatabase.length) {
          const callback = transaction.oncomplete;
          state.heldDatabase.push(() => callback?.call(transaction, event));
        }
      });
      return transaction;
    };
    const nativeOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args: Parameters<typeof nativeOpen>) {
      state.openCalls++;
      const request = nativeOpen.apply(this, args);
      request.addEventListener('success', (event) => {
        if (!state.holdOpen) return;
        event.stopImmediatePropagation();
        if (!state.heldOpen.length) {
          const callback = request.onsuccess;
          state.heldOpen.push(() => callback?.call(request, event));
        }
      });
      return request;
    };
  });
}

async function releaseWorker(page: Page) {
  await page.evaluate(() => {
    const state = (window as any).libraryProbe;
    state.holdWorker = '';
    for (const { worker, event } of state.heldWorker.splice(0))
      worker.dispatchEvent(new MessageEvent('message', { data: event.data }));
  });
}

async function releaseDatabase(page: Page) {
  await page.evaluate(() => {
    const state = (window as any).libraryProbe;
    state.holdDatabase = false;
    state.holdDatabaseMode = '';
    for (const callback of state.heldDatabase.splice(0)) callback();
  });
}

test('native abort rollback and a failed post-commit refresh never invent an unsaved outcome', async ({
  page,
}, info) => {
  const before = await fixture(page);
  await database(page, [[first, encodeRecord(candidate(), 1)]]);
  await openLibrary(page);
  const original = await database(page);
  await page.evaluate(() => {
    const native = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof native>) {
      const request = native.apply(this, args);
      this.transaction.abort();
      return request;
    };
    (window as any).restoreLibraryAdd = () => {
      IDBObjectStore.prototype.add = native;
    };
  });
  await page.locator('#library-save').click();
  await expect(page.locator('#library-status')).toContainText('Local storage failed');
  await expect(page.locator('#library-candidate')).toBeVisible();
  expect(await database(page)).toEqual(original);
  const source = await download(page, '#library-export-candidate');
  expect(parseBlueprint(source.toString()).name).toBe('Untitled organism');
  await page.evaluate(() => {
    (window as any).restoreLibraryAdd();
    const native = IDBDatabase.prototype.transaction;
    let failRead = true;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof native>) {
      const transaction = native.apply(this, args);
      if (args[1] === 'readonly' && failRead) {
        failRead = false;
        queueMicrotask(() => transaction.abort());
      }
      return transaction;
    };
    (window as any).restoreLibraryTransaction = () => {
      IDBDatabase.prototype.transaction = native;
    };
  });
  await page.locator('#library-add').click();
  await expect(page.locator('#library-status')).toContainText(
    'committed outcome is unchanged; refresh failed',
  );
  await expect(page.locator('#library-candidate')).toBeHidden();
  await page.evaluate(() => (window as any).restoreLibraryTransaction());
  expect((await database(page)).length).toBe(2);
  await page.locator('#library-refresh').click();
  await expect(page.locator('#library-count')).toContainText('2 / 100');
  for (let repeat = 0; repeat < 3; repeat++) expect(await pausedSave(page)).toEqual(before);
  await info.attach('native-rollback-and-committed-refresh-failure.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      initialPhysical: original.length,
      abortedWritePhysical: original.length,
      committedPhysical: 2,
      failedRefreshDidNotUndoCommit: true,
      abortedAddFaultInjected: true,
      nativeQuotaExhaustionProved: false,
    }),
  });
});

test('native request ConstraintError retries a new UUID and stops after three collisions without overwriting', async ({
  page,
}, info) => {
  const before = await fixture(page);
  const original = encodeRecord(candidate('original collision owner'), 1);
  await database(page, [[first, original]]);
  await openLibrary(page);
  await page.evaluate(
    ({ first, second }) => {
      const evidence = { ids: [] as string[], errors: [] as unknown[], aborts: [] as string[] };
      const nativeTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args: Parameters<typeof nativeTransaction>) {
        const transaction = nativeTransaction.apply(this, args);
        transaction.addEventListener('error', (event) => {
          evidence.errors.push({
            requestError: (event.target as IDBRequest).error?.name,
            transactionError: transaction.error?.name ?? null,
          });
        });
        transaction.addEventListener('abort', () => evidence.aborts.push(transaction.error!.name));
        return transaction;
      };
      const nativeId = crypto.randomUUID.bind(crypto);
      crypto.randomUUID = () => {
        const id = evidence.ids.length ? second : first;
        evidence.ids.push(id);
        return id as ReturnType<Crypto['randomUUID']>;
      };
      (window as any).collisionEvidence = evidence;
      (window as any).restoreCollisionProbe = () => {
        crypto.randomUUID = nativeId;
        IDBDatabase.prototype.transaction = nativeTransaction;
      };
    },
    { first, second },
  );
  await page.locator('#blueprint-name').fill('collision retry candidate');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-status')).toContainText('committed');
  const retried = await page.evaluate(() => structuredClone((window as any).collisionEvidence));
  expect(retried).toEqual({
    ids: [first, second],
    errors: [{ requestError: 'ConstraintError', transactionError: null }],
    aborts: ['ConstraintError'],
  });
  const committed = await database(page);
  expect(committed[0]).toEqual([first, original]);
  expect(parseBlueprint(JSON.parse(committed[1][1] as string).blueprint).name).toBe(
    'collision retry candidate',
  );
  await page.evaluate((id) => {
    const evidence = (window as any).collisionEvidence;
    evidence.ids = [];
    evidence.errors = [];
    evidence.aborts = [];
    crypto.randomUUID = () => {
      evidence.ids.push(id);
      return id as ReturnType<Crypto['randomUUID']>;
    };
  }, first);
  await page.locator('#blueprint-name').fill('three collision candidate');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-status')).toContainText('after three attempts');
  const bounded = await page.evaluate(() => structuredClone((window as any).collisionEvidence));
  expect(bounded.ids).toEqual([first, first, first]);
  expect(bounded.errors).toEqual(
    Array.from({ length: 3 }, () => ({ requestError: 'ConstraintError', transactionError: null })),
  );
  expect(bounded.aborts).toEqual(['ConstraintError', 'ConstraintError', 'ConstraintError']);
  expect(await database(page)).toEqual(committed);
  expect(parseBlueprint((await download(page, '#library-export-candidate')).toString()).name).toBe(
    'three collision candidate',
  );
  await page.evaluate(() => (window as any).restoreCollisionProbe());
  expect(await pausedSave(page)).toEqual(before);
  await info.attach('native-request-collision-retries.json', {
    contentType: 'application/json',
    body: JSON.stringify({ retried, bounded, committed, ecologicalBytesUnchanged: true }),
  });
});

test('request-level quota fault injection retains native rollback, actionable status and an exportable candidate', async ({
  page,
}, info) => {
  const before = await fixture(page);
  const original = [[first, encodeRecord(candidate('retained owner'), 1)]] as [string, unknown][];
  await database(page, original);
  await openLibrary(page);
  await page.evaluate((id) => {
    const nativeAdd = IDBObjectStore.prototype.add;
    const evidence = { addCalls: 0, errors: [] as unknown[], aborts: [] as string[] };
    IDBObjectStore.prototype.add = function (value) {
      evidence.addCalls++;
      const transaction = this.transaction;
      const request = nativeAdd.call(this, value, id);
      request.addEventListener('error', () => {
        Object.defineProperty(request, 'error', {
          value: new DOMException('', 'QuotaExceededError'),
        });
      });
      transaction.addEventListener('error', (event) => {
        evidence.errors.push({
          injectedRequestError: (event.target as IDBRequest).error?.name,
          transactionErrorBeforeAbort: transaction.error?.name ?? null,
        });
      });
      transaction.addEventListener('abort', () => evidence.aborts.push(transaction.error!.name));
      return request;
    };
    (window as any).quotaFaultEvidence = evidence;
    (window as any).restoreQuotaFault = () => {
      IDBObjectStore.prototype.add = nativeAdd;
    };
  }, first);
  await page.locator('#blueprint-name').fill('request quota candidate');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-status')).toContainText('storage is full');
  await expect(page.locator('#library-status')).toContainText('Export the unsaved blueprint');
  expect(await database(page)).toEqual(original);
  expect(parseBlueprint((await download(page, '#library-export-candidate')).toString()).name).toBe(
    'request quota candidate',
  );
  const evidence = await page.evaluate(() => structuredClone((window as any).quotaFaultEvidence));
  expect(evidence).toEqual({
    addCalls: 1,
    errors: [{ injectedRequestError: 'QuotaExceededError', transactionErrorBeforeAbort: null }],
    aborts: ['ConstraintError'],
  });
  await page.evaluate(() => (window as any).restoreQuotaFault());
  expect(await pausedSave(page)).toEqual(before);
  await info.attach('injected-request-quota-native-rollback.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      ...evidence,
      injection:
        'Request error getter overridden during a real duplicate-key error; default native ConstraintError abort supplies rollback.',
      physicalQuotaExhaustionProved: false,
      ecologicalBytesUnchanged: true,
    }),
  });
});

test('future native database declarations remain read-only and never offer damaged repair', async ({
  page,
}, info) => {
  const before = await fixture(page);
  const token = encodeRecord(candidate(), 1);
  await page.evaluate(
    async ({ name, id, token }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 2);
        request.onupgradeneeded = () => request.result.createObjectStore('entries');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const connection = request.result,
            transaction = connection.transaction('entries', 'readwrite');
          transaction.objectStore('entries').add(token, id);
          transaction.oncomplete = () => {
            connection.close();
            resolve();
          };
          transaction.onabort = () => reject(transaction.error);
        };
      }),
    { name: LIBRARY_DATABASE, id: first, token },
  );
  await page.locator('#local-library > summary').click();
  await expect(page.locator('#library-status')).toContainText('schema is unsupported');
  await expect(page.locator('[data-repair-id]')).toHaveCount(0);
  await page.locator('#library-save').click();
  await expect(page.locator('#library-status')).toContainText('schema is unsupported');
  await expect(page.locator('#library-candidate')).toBeVisible();
  const current = await page.evaluate(
    async ({ name, id }) =>
      new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const connection = request.result,
            transaction = connection.transaction('entries', 'readonly');
          const row = transaction.objectStore('entries').get(id);
          transaction.oncomplete = () => {
            connection.close();
            resolve(row.result);
          };
        };
      }),
    { name: LIBRARY_DATABASE, id: first },
  );
  expect(current).toBe(token);
  for (let repeat = 0; repeat < 3; repeat++) expect(await pausedSave(page)).toEqual(before);
  await info.attach('native-future-database.json', {
    contentType: 'application/json',
    body: JSON.stringify({ databaseVersion: 2, unchangedStoredToken: token, repairOffered: false }),
  });
});

test('current-run capture rejects loaded/saved acknowledgements and waits for successful frames or failed-load recovery', async ({
  page,
}, info) => {
  await deliveryProbe(page);
  const before = await fixture(page);
  const capture = page.locator('#capture-selected');
  await capture.focus();
  await page.evaluate(() => {
    (window as any).libraryProbe.holdWorker = 'error';
  });
  await page.locator('#file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).libraryProbe.heldWorker.length))
    .toBe(1);
  await expect(capture).toBeDisabled();
  await expect(page.locator('#specimen-details > summary')).toBeFocused();
  expect(await download(page, '#save')).toEqual(before);
  await expect(capture).toBeDisabled();
  await releaseWorker(page);
  await expect(page.locator('#notice')).toContainText('Not a valid EvoLab');
  await expect(capture).toBeEnabled();
  await expect(page.locator('#save')).toBeFocused();
  for (let repeat = 0; repeat < 3; repeat++) expect(await pausedSave(page)).toEqual(before);
  await page.evaluate(() => {
    (window as any).libraryProbe.holdWorker = 'frame';
  });
  await page
    .locator('#file')
    .setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: before });
  await expect(page.locator('#notice')).toContainText('World restored');
  await expect(capture).toBeDisabled();
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await download(page, '#save');
  await expect(capture).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => (window as any).libraryProbe.heldWorker.length))
    .toBe(1);
  await releaseWorker(page);
  await expect(capture).toBeDisabled();
  await info.attach('accepted-observation-gaps.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      failedLoadSavedWorld: createHash('sha256').update(before).digest('hex'),
      failedLoadRepeatedSaves: 3,
      loadedAckEligible: false,
      savedAckEligible: false,
      retainedWorkerMessages: await page.evaluate(
        () => (window as any).libraryProbe.heldWorker.length,
      ),
    }),
  });
});

test('native read completion cannot resurrect an older designer replacement after invalid or cancelled newer intent', async ({
  page,
}, info) => {
  await deliveryProbe(page);
  const before = await fixture(page);
  await database(page, [[first, encodeRecord(candidate('old library replacement'), 1)]]);
  await openLibrary(page);
  await page.locator('#blueprint-name').fill('current designer');
  await page.evaluate(() => {
    (window as any).libraryProbe.holdDatabase = true;
  });
  await page.locator('#library-load').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
    .toBe(1);
  await page.locator('#blueprint-file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.locator('#designer-file-status')).toContainText('standalone EvoLab');
  const status = await page.locator('#designer-file-status').textContent();
  await releaseDatabase(page);
  await expect(page.locator('#library-dialog')).toBeHidden();
  await expect(page.locator('#blueprint-name')).toHaveValue('current designer');
  await expect(page.locator('#designer-file-status')).toHaveText(status!);
  await page.locator('#library-load').click();
  await expect(page.locator('#library-dialog')).toBeVisible();
  await page.evaluate(() => {
    (window as any).libraryProbe.holdDatabase = true;
  });
  await page.locator('#library-confirm').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
    .toBe(1);
  await page.locator('#blueprint-file').setInputFiles({
    name: 'new.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeBlueprint(candidate('new designer').blueprint)),
  });
  await expect(page.locator('#blueprint-name')).toHaveValue('new designer');
  await releaseDatabase(page);
  await expect(page.locator('#blueprint-name')).toHaveValue('new designer');
  await page.evaluate(() => {
    (window as any).libraryProbe.holdDatabase = true;
  });
  await page.locator('#library-load').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
    .toBe(1);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#import-blueprint').click();
  await chooser;
  await page.locator('#blueprint-file').dispatchEvent('cancel');
  await releaseDatabase(page);
  await expect(page.locator('#library-dialog')).toBeHidden();
  await expect(page.locator('#blueprint-name')).toHaveValue('new designer');
  for (let repeat = 0; repeat < 3; repeat++) expect(await pausedSave(page)).toEqual(before);
  await info.attach('native-replacement-ownership.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      fullPausedWorldBytes: before.length,
      initialReadInvalidSupersession: true,
      finalReadValidSupersession: true,
      domCancellationOnly: true,
      nativeOSPickerCancellationProved: false,
    }),
  });
});

for (const action of ['refresh', 'delete', 'repair'] as const) {
  test(`versionchange revokes native ${action} refresh delivery and followup ownership`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await deliveryProbe(page);
    const before = await fixture(page);
    const original = encodeRecord(candidate('target'), 1);
    const neighbor = encodeRecord(candidate('neighbor'), 1);
    const stored: [string, unknown][] = [
      [
        first,
        action === 'repair' ? JSON.stringify({ ...JSON.parse(original), revision: 0 }) : original,
      ],
      [second, neighbor],
    ];
    await database(page, stored);
    await openLibrary(page);
    const design = await download(page, '#export-blueprint');
    if (action === 'refresh') {
      const added: [string, string] = [third, encodeRecord(candidate('not yet displayed'), 1)];
      await database(page, [added]);
      stored.push(added);
    } else
      await page
        .locator(action === 'repair' ? `[data-repair-id="${first}"]` : '#library-delete')
        .click();
    await page.evaluate(() => {
      (window as any).libraryProbe.holdDatabaseMode = 'readonly';
    });
    await page.locator(action === 'refresh' ? '#library-refresh' : '#library-confirm').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
      .toBe(1);
    if (action !== 'refresh')
      await expect(page.locator('#library-status')).toContainText('Write committed');
    const rows = await page.locator('#library-rows').innerHTML();
    const transactions = await page.evaluate(
      () => (window as any).libraryProbe.databaseTransactions,
    );
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
    });
    const upgrade = await page.evaluate(
      (name) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name, 2);
          let versions: number[] = [];
          request.onupgradeneeded = (event) => {
            versions = [event.oldVersion, event.newVersion!];
            request.transaction!.abort();
          };
          request.onerror = (event) => {
            event.preventDefault();
            resolve({ versions, error: request.error?.name });
          };
          request.onsuccess = () => {
            request.result.close();
            reject(new Error('Expected upgrade abort'));
          };
        }),
      LIBRARY_DATABASE,
    );
    expect(upgrade).toEqual({ versions: [1, 2], error: 'AbortError' });
    await expect(page.locator('#library-status')).toContainText('Another tab changed');
    const status = await page.locator('#library-status').textContent();
    await page.locator('#library-refresh').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.evaluate(() => (window as any).libraryProbe.databaseTransactions)).toBe(
      transactions,
    );
    expect(await page.evaluate(() => (window as any).libraryProbe.heldDatabase.length)).toBe(1);
    await page.evaluate(() => {
      const capture = document.querySelector('#capture-selected')!;
      const nativeSetAttribute = capture.setAttribute;
      (window as any).lateCaptureUpdates = 0;
      capture.setAttribute = function (...args) {
        (window as any).lateCaptureUpdates++;
        nativeSetAttribute.apply(this, args);
      };
    });
    const heldBeyondDeadlineMs = await page.evaluate(async () => {
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 10100));
      return performance.now() - start;
    });
    expect(heldBeyondDeadlineMs).toBeGreaterThanOrEqual(10000);
    await expect(page.locator('#library-status')).toHaveText(status!);
    expect(await page.evaluate(() => (window as any).lateCaptureUpdates)).toBe(0);
    expect(await page.evaluate(() => (window as any).libraryProbe.databaseTransactions)).toBe(
      transactions,
    );
    await releaseDatabase(page);
    await expect(page.locator('#library-status')).toHaveText(status!);
    if (action !== 'refresh') expect(status).toContain('Write committed');
    expect(await page.locator('#library-rows').innerHTML()).toBe(rows);
    await expect(page.locator('#library-dialog')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await page.evaluate(() => (window as any).lateCaptureUpdates)).toBe(0);
    expect(await page.evaluate(() => (window as any).libraryProbe.databaseTransactions)).toBe(
      transactions,
    );
    const surviving = action === 'refresh' ? stored : [[second, neighbor]];
    expect(await database(page)).toEqual(surviving);
    expect(await download(page, '#export-blueprint')).toEqual(design);
    expect(await pausedSave(page)).toEqual(before);
    await page.screenshot({
      path: info.outputPath(`library-${action}-refresh-versionchange.png`),
      fullPage: true,
    });
    await page.locator('#library-refresh').click();
    await expect(page.locator('#library-status')).toContainText('Library refreshed');
    await expect(page.locator('#library-rows > li')).toHaveCount(surviving.length);
    expect(await database(page)).toEqual(surviving);
    expect(errors).toEqual([]);
    await info.attach('preserved-world.json', { contentType: 'application/json', body: before });
    await info.attach('preserved-designer.json', { contentType: 'application/json', body: design });
    await info.attach(`native-${action}-refresh-versionchange.json`, {
      contentType: 'application/json',
      body: JSON.stringify({
        action,
        heldBeyondDeadlineMs,
        upgrade,
        actualNativeVersionchange: true,
        upgradeAbortedWithoutSchemaChange: true,
        completedReadonlyDeliveryHeld: true,
        nativeOwnerRetainedUntilTerminalDelivery: true,
        staleSnapshotAndFollowupSuppressed: true,
        status,
        exactSurvivingRows: surviving,
        explicitRetrySucceeded: true,
        pageErrors: errors,
        designerSha256: createHash('sha256').update(design).digest('hex'),
        ecologicalSha256: createHash('sha256').update(before).digest('hex'),
        limits:
          'Real IndexedDB versionchange with completed callback delivery held by instrumentation; not physical slow disk.',
      }),
    });
  });
}

for (const phase of ['initial', 'final']) {
  test(`Organism departure cancels the ${phase} native library read without releasing its pending owner or stealing focus`, async ({
    page,
  }, info) => {
    await deliveryProbe(page);
    const before = await fixture(page);
    await database(page, [[first, encodeRecord(candidate('must not publish'), 1)]]);
    await openLibrary(page);
    await page.locator('#blueprint-name').fill('retained designer');
    await page.locator('#blueprint-description').fill('retained description');
    const design = await download(page, '#export-blueprint');
    if (phase === 'final') {
      await page.locator('#library-load').click();
      await expect(page.locator('#library-dialog')).toBeVisible();
    }
    await page.evaluate(() => {
      (window as any).libraryProbe.holdDatabase = true;
    });
    await page.locator(phase === 'initial' ? '#library-load' : '#library-confirm').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
      .toBe(1);
    const transactions = await page.evaluate(
      () => (window as any).libraryProbe.databaseTransactions,
    );
    const ecosystem = page.locator('[data-tab="ecosystem"]');
    await ecosystem.click();
    await ecosystem.focus();
    await expect(page.locator('#library-status')).toContainText('Load into designer cancelled');
    await expect(page.locator('#library-status')).toContainText('no longer visible');
    const cancelled = await page.locator('#library-status').textContent();
    await page.locator('#library-refresh').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.evaluate(() => (window as any).libraryProbe.databaseTransactions)).toBe(
      transactions,
    );
    expect(await page.evaluate(() => (window as any).libraryProbe.heldDatabase.length)).toBe(1);
    await releaseDatabase(page);
    await expect(page.locator('#library-dialog')).toBeHidden();
    await expect(page.locator('#blueprint-name')).toHaveValue('retained designer');
    await expect(page.locator('#blueprint-description')).toHaveValue('retained description');
    await expect(page.locator('#ecosystem-panel')).toBeVisible();
    await expect(page.locator('#organism-panel')).toBeHidden();
    await expect(page.locator('button[data-tool="inspect"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(ecosystem).toBeFocused();
    await expect(page.locator('#library-status')).toHaveText(cancelled!);
    expect(await page.evaluate(() => (window as any).libraryProbe.databaseTransactions)).toBe(
      transactions,
    );
    await page.screenshot({
      path: info.outputPath(`library-${phase}-read-tab-cancel.png`),
      fullPage: true,
    });
    expect(await pausedSave(page)).toEqual(before);
    await page.locator('[data-tab="organism"]').click();
    expect(await download(page, '#export-blueprint')).toEqual(design);
    await page.locator('#library-load').click();
    await expect(page.locator('#library-dialog')).toBeVisible();
    await page.locator('#library-confirm').click();
    await expect(page.locator('#blueprint-name')).toHaveValue('must not publish');
    await info.attach(`native-${phase}-read-tab-cancellation.json`, {
      contentType: 'application/json',
      body: JSON.stringify({
        phase,
        fullId: first,
        cancelled,
        nativeOwnerHeldUntilTerminalCallback: true,
        transactionsBeforeAndAfterCancellation: transactions,
        noModalReopenOrPanelReturnOrToolChangeOrFocusTheft: true,
        designerSha256Unchanged: createHash('sha256').update(design).digest('hex'),
        ecologicalSha256Unchanged: createHash('sha256').update(before).digest('hex'),
        newExplicitLoadAfterTerminalSettlementSucceeded: true,
      }),
    });
  });
}

for (const action of ['create', 'duplicate', 'rename', 'replace', 'delete', 'repair']) {
  for (const phase of ['write', 'refresh']) {
    test(`native newer row selection survives ${action} ${phase} completion`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await deliveryProbe(page);
      const before = await fixture(page);
      const source = candidate('target');
      const original = encodeRecord(source, 1);
      const expected: [string, string][] = [
        [
          first,
          action === 'repair' ? JSON.stringify({ ...JSON.parse(original), revision: 0 }) : original,
        ],
        [second, encodeRecord(candidate('neighbor'), 1)],
        [third, encodeRecord(candidate('newer explicit selection'), 1)],
      ];
      await database(page, expected);
      await openLibrary(page);
      if (action === 'create' || action === 'replace') {
        await page
          .locator(action === 'create' ? '#blueprint-file' : '#library-file')
          .setInputFiles({
            name: 'blueprint.json',
            mimeType: 'application/json',
            buffer: Buffer.from(
              serializeBlueprint(
                candidate(action === 'create' ? 'created' : 'replacement').blueprint,
              ),
            ),
          });
        if (action === 'create')
          await expect(page.locator('#blueprint-name')).toHaveValue('created');
        else await expect(page.locator('#library-candidate')).toBeVisible();
      }
      if (action === 'repair') await page.locator(`[data-repair-id="${first}"]`).click();
      else if (action === 'rename' || action === 'replace' || action === 'delete') {
        await page.locator(`#library-${action}`).click();
        if (action === 'rename') await page.locator('#library-rename-name').fill('renamed');
      }
      await page.evaluate((phase) => {
        (window as any).libraryProbe.holdDatabaseMode =
          phase === 'write' ? 'readwrite' : 'readonly';
      }, phase);
      await page
        .locator(
          action === 'create'
            ? '#library-save'
            : action === 'duplicate'
              ? '#library-duplicate'
              : '#library-confirm',
        )
        .click();
      await expect
        .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
        .toBe(1);
      if (phase === 'refresh')
        await expect(page.locator('#library-status')).toContainText('Write committed');
      await page.locator(`[data-library-id="${third}"]`).click();
      await expect(page.locator('#library-selection')).toContainText('newer explicit selection');
      await page.evaluate(() => {
        document.body.tabIndex = -1;
        document.body.focus();
        document.body.removeAttribute('tabindex');
      });
      await releaseDatabase(page);
      await expect(page.locator('#capture-selected')).toHaveAttribute('aria-disabled', 'false');
      await expect(page.locator('#library-status')).toContainText('Write committed');
      await expect(page.locator('#library-selection')).toContainText('newer explicit selection');
      await expect(page.locator(`[data-library-id="${third}"]`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
      const stored = await database(page);
      if (action === 'create' || action === 'duplicate') {
        const id = stored.find(([id]) => !expected.some(([original]) => id === original))?.[0];
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expected.push([
          id!,
          encodeRecord(
            action === 'duplicate' ? source : { blueprint: candidate('created').blueprint },
            1,
          ),
        ]);
      } else if (action === 'delete' || action === 'repair') expected.shift();
      else
        expected[0] = [
          first,
          encodeRecord(
            action === 'rename'
              ? { ...source, blueprint: { ...source.blueprint, name: 'renamed' } }
              : { blueprint: candidate('replacement').blueprint },
            2,
          ),
        ];
      expected.sort(([left], [right]) => left.localeCompare(right));
      expect(stored).toEqual(expected);
      await expect(page.locator('#library-count')).toContainText(`${expected.length} / 100`);
      if (
        (action === 'delete' && phase === 'write') ||
        (action === 'rename' && phase === 'refresh')
      )
        await page.screenshot({
          path: info.outputPath(`library-${action}-${phase}-newer-selection.png`),
          fullPage: true,
        });
      expect(await pausedSave(page)).toEqual(before);
      expect(errors).toEqual([]);
      await info.attach(`native-${action}-${phase}-newer-selection.json`, {
        contentType: 'application/json',
        body: JSON.stringify({
          action,
          phase,
          selectedFullId: third,
          nativeCompletionDeliveryHeld: true,
          selectedAfterAdmissionAndBeforeDelivery: true,
          noOldFocusRecovery: true,
          exactCommittedRows: stored,
          pageErrors: errors,
          ecologicalSha256: createHash('sha256').update(before).digest('hex'),
        }),
      });
    });
  }
}

for (const action of ['delete', 'repair']) {
  test(`native ${action} postcommit refresh supersession suppresses older focus recovery`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await deliveryProbe(page);
    const before = await fixture(page);
    const original = encodeRecord(candidate('target'), 1);
    const neighbor = encodeRecord(candidate('neighbor'), 1);
    await database(page, [
      [
        first,
        action === 'repair' ? JSON.stringify({ ...JSON.parse(original), revision: 0 }) : original,
      ],
      [second, neighbor],
    ]);
    await openLibrary(page);
    await page
      .locator(action === 'repair' ? `[data-repair-id="${first}"]` : '#library-delete')
      .click();
    await page.evaluate(() => {
      (window as any).libraryProbe.holdDatabaseMode = 'readonly';
    });
    await page.locator('#library-confirm').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
      .toBe(1);
    await expect(page.locator('#library-status')).toContainText('Write committed');
    await page.locator('#library-refresh').click();
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
    });
    await releaseDatabase(page);
    await expect(page.locator('#library-status')).toContainText('Library refreshed');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await database(page)).toEqual([[second, neighbor]]);
    expect(await pausedSave(page)).toEqual(before);
    expect(errors).toEqual([]);
    await info.attach(`native-${action}-postcommit-refresh-supersession.json`, {
      contentType: 'application/json',
      body: JSON.stringify({
        action,
        completedWriteAndDelayedReadonlyRefresh: true,
        newerRefreshOwnsFollowup: true,
        noOldFocusRecovery: true,
        exactSurvivingRows: [[second, neighbor]],
        pageErrors: errors,
        disposalAndSameRootRemountEvidence:
          'Separate UI storage-event harness, not this native case',
        ecologicalSha256: createHash('sha256').update(before).digest('hex'),
      }),
    });
  });
}

for (const phase of ['initial', 'final']) {
  test(`versionchange cancels the ${phase} completed native replacement read before delayed delivery`, async ({
    page,
  }, info) => {
    await deliveryProbe(page);
    const before = await fixture(page);
    const stored = [[first, encodeRecord(candidate('must not publish'), 1)]] as [string, string][];
    await database(page, stored);
    await openLibrary(page);
    await page.locator('#blueprint-name').fill('retained designer');
    await page.locator('#blueprint-description').fill('retained description');
    const design = await download(page, '#export-blueprint');
    if (phase === 'final') {
      await page.locator('#library-load').click();
      await expect(page.locator('#library-dialog')).toBeVisible();
    }
    await page.evaluate(() => {
      (window as any).libraryProbe.holdDatabase = true;
    });
    await page.locator(phase === 'initial' ? '#library-load' : '#library-confirm').click();
    await expect
      .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
      .toBe(1);
    const transactions = await page.evaluate(
      () => (window as any).libraryProbe.databaseTransactions,
    );
    await page.locator('#blueprint-description').focus();
    await page.evaluate(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(name, 2);
          request.onupgradeneeded = () => request.transaction!.abort();
          request.onerror = (event) => {
            event.preventDefault();
            resolve();
          };
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        }),
      LIBRARY_DATABASE,
    );
    await expect(page.locator('#library-status')).toContainText('Another tab changed');
    const status = await page.locator('#library-status').textContent();
    await page.locator('#library-refresh').evaluate((button: HTMLButtonElement) => button.click());
    expect(await page.evaluate(() => (window as any).libraryProbe.databaseTransactions)).toBe(
      transactions,
    );
    expect(await page.evaluate(() => (window as any).libraryProbe.heldDatabase.length)).toBe(1);
    await page.evaluate(() => {
      const capture = document.querySelector('#capture-selected')!;
      const nativeSetAttribute = capture.setAttribute;
      (window as any).lateCaptureUpdates = 0;
      capture.setAttribute = function (...args) {
        (window as any).lateCaptureUpdates++;
        nativeSetAttribute.apply(this, args);
      };
    });
    const heldBeyondDeadlineMs = await page.evaluate(async () => {
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 10100));
      return performance.now() - start;
    });
    expect(heldBeyondDeadlineMs).toBeGreaterThanOrEqual(10000);
    await expect(page.locator('#library-status')).toHaveText(status!);
    expect(await page.evaluate(() => (window as any).lateCaptureUpdates)).toBe(0);
    expect(await page.evaluate(() => (window as any).libraryProbe.databaseTransactions)).toBe(
      transactions,
    );
    await releaseDatabase(page);
    await expect(page.locator('#library-dialog')).toBeHidden();
    await expect(page.locator('#blueprint-name')).toHaveValue('retained designer');
    await expect(page.locator('#blueprint-description')).toHaveValue('retained description');
    await expect(page.locator('#organism-panel')).toBeVisible();
    await expect(page.locator('#ecosystem-panel')).toBeHidden();
    await expect(page.locator('button[data-tool="inspect"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('#blueprint-description')).toBeFocused();
    await expect(page.locator('#library-status')).toHaveText(status!);
    expect(await page.evaluate(() => (window as any).lateCaptureUpdates)).toBe(0);
    expect(await page.evaluate(() => (window as any).libraryProbe.databaseTransactions)).toBe(
      transactions,
    );
    expect(await database(page)).toEqual(stored);
    expect(await download(page, '#export-blueprint')).toEqual(design);
    expect(await pausedSave(page)).toEqual(before);
    await page.screenshot({
      path: info.outputPath(`library-${phase}-read-versionchange.png`),
      fullPage: true,
    });
    await page.locator('#library-refresh').click();
    await expect(page.locator('#library-status')).toContainText('Library refreshed');
    await page.locator('#library-load').click();
    await expect(page.locator('#library-dialog')).toBeVisible();
    await page.locator('#library-confirm').click();
    await expect(page.locator('#blueprint-name')).toHaveValue('must not publish');
    expect(await database(page)).toEqual(stored);
    expect(await pausedSave(page)).toEqual(before);
    await info.attach('preserved-world.json', { contentType: 'application/json', body: before });
    await info.attach('preserved-designer.json', { contentType: 'application/json', body: design });
    await info.attach(`native-${phase}-read-versionchange.json`, {
      contentType: 'application/json',
      body: JSON.stringify({
        phase,
        heldBeyondDeadlineMs,
        explicitRetrySucceeded: true,
        fullId: first,
        actualNativeVersionchange: true,
        completedTransactionCallbackDeliveryHeld: true,
        nativeOwnerRetainedUntilTerminalDelivery: true,
        noModalPublicationToolPanelChangeOrFocusTheft: true,
        status,
        designerSha256: createHash('sha256').update(design).digest('hex'),
        ecologicalSha256: createHash('sha256').update(before).digest('hex'),
      }),
    });
  });
}

for (const designer of [false, true]) {
  test(`expired native blueprint reader cannot publish to designer=${designer} before terminal cleanup`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      type HeldRead = { reader: FileReader; load?: () => void; terminal?: () => void };
      const state = {
        reads: 0,
        aborts: 0,
        pending: undefined as HeldRead | undefined,
        oldTerminal: undefined as (() => void) | undefined,
      };
      (window as any).readerProbe = state;
      window.FileReader = new Proxy(window.FileReader, {
        construct(target, args: ConstructorParameters<typeof FileReader>, newTarget) {
          const reader: FileReader = Reflect.construct(target, args, newTarget);
          state.reads++;
          const held: HeldRead = { reader };
          state.pending = held;
          reader.abort = () => {
            state.aborts++;
          };
          reader.addEventListener('load', (event) => {
            event.stopImmediatePropagation();
            const callback = reader.onload;
            held.load = () => callback?.call(reader, event);
          });
          reader.addEventListener('loadend', (event) => {
            event.stopImmediatePropagation();
            const callback = reader.onloadend;
            held.terminal = () => callback?.call(reader, event);
          });
          return reader;
        },
      });
    });
    const before = await fixture(page);
    const stored = [[first, encodeRecord(candidate('stored'), 1)]] as [string, string][];
    await database(page, stored);
    await openLibrary(page);
    await page.locator('#blueprint-name').fill('retained designer');
    const design = await download(page, '#export-blueprint');
    const expired = serializeBlueprint(candidate('expired candidate').blueprint);
    const input = designer ? '#blueprint-file' : '#library-file';
    const otherInput = designer ? '#library-file' : '#blueprint-file';
    const payload = {
      name: 'expired.json',
      mimeType: 'application/json',
      buffer: Buffer.from(expired),
    };
    await page.locator(input).setInputFiles(payload);
    await expect
      .poll(() => page.evaluate(() => !!(window as any).readerProbe.pending?.terminal))
      .toBe(true);
    expect(await page.evaluate(() => (window as any).readerProbe.pending.reader.readyState)).toBe(
      2,
    );
    expect(await page.evaluate(() => (window as any).readerProbe.pending.reader.result)).toBe(
      expired,
    );
    const statusId = designer ? '#designer-file-status' : '#library-status';
    await page.locator(statusId).filter({ hasText: 'Blueprint read timed out.' }).waitFor();
    const timeout = await page.locator(statusId).textContent();
    expect(await page.evaluate(() => (window as any).readerProbe.aborts)).toBe(1);
    await page.evaluate(() => (window as any).readerProbe.pending.load());
    await expect(page.locator(statusId)).toHaveText(timeout!);
    await expect(page.locator('#library-candidate')).toBeHidden();
    await expect(page.locator('#blueprint-name')).toHaveValue('retained designer');
    expect(await database(page)).toEqual(stored);
    expect(await download(page, '#export-blueprint')).toEqual(design);
    expect(await pausedSave(page)).toEqual(before);
    await page.screenshot({
      path: info.outputPath(`library-reader-expiry-designer-${designer}.png`),
      fullPage: true,
    });
    await page.locator(otherInput).setInputFiles(payload);
    expect(await page.evaluate(() => (window as any).readerProbe.reads)).toBe(1);
    await expect(page.locator('#library-status')).toContainText('Busy');
    await page.evaluate(() => {
      const state = (window as any).readerProbe;
      state.oldTerminal = state.pending.terminal;
      state.pending.terminal();
      state.pending = undefined;
    });
    const retry = serializeBlueprint(candidate('explicit retry').blueprint);
    await page.locator(input).setInputFiles({
      name: 'retry.json',
      mimeType: 'application/json',
      buffer: Buffer.from(retry),
    });
    await expect
      .poll(() => page.evaluate(() => !!(window as any).readerProbe.pending?.terminal))
      .toBe(true);
    expect(await page.evaluate(() => (window as any).readerProbe.reads)).toBe(2);
    const pendingInput = await page.locator(input).inputValue();
    expect(pendingInput).not.toBe('');
    await page.evaluate(() => (window as any).readerProbe.oldTerminal());
    await expect(page.locator(input)).toHaveValue(pendingInput);
    await page.locator(otherInput).setInputFiles(payload);
    expect(await page.evaluate(() => (window as any).readerProbe.reads)).toBe(2);
    await page.evaluate(() => {
      const state = (window as any).readerProbe;
      state.pending.load();
      state.pending.terminal();
      state.pending = undefined;
    });
    await expect(page.locator(input)).toHaveValue('');
    if (designer) {
      await expect(page.locator('#blueprint-name')).toHaveValue('explicit retry');
      await expect(page.locator('#designer-file-status')).toContainText('loaded into designer');
      await expect(page.locator('#library-candidate')).toBeHidden();
    } else {
      await expect(page.locator('#blueprint-name')).toHaveValue('retained designer');
      await expect(page.locator('#library-candidate-name')).toHaveText('explicit retry');
      await expect(page.locator('#library-status')).toContainText('Imported an unsaved blueprint');
    }
    expect(await database(page)).toEqual(stored);
    expect(await pausedSave(page)).toEqual(before);
    expect(errors).toEqual([]);
    await info.attach(`native-reader-expiry-designer-${designer}.json`, {
      contentType: 'application/json',
      body: JSON.stringify({
        designer,
        actualNativeFileReader: true,
        actualTenSecondDeadline: true,
        injectedAbortAndTerminalDeliveryHold: true,
        lateValidLoadSuppressed: true,
        timeout,
        noCandidateDesignerStorageOrSuccessResurrection: true,
        exactSurvivingRows: stored,
        blockedSecondReaderBeforeTerminal: true,
        staleTerminalCannotReleaseNewOwnerOrClearItsInput: true,
        explicitRetrySucceeded: true,
        reads: 2,
        pageErrors: errors,
        designerSha256: createHash('sha256').update(design).digest('hex'),
        ecologicalSha256: createHash('sha256').update(before).digest('hex'),
        limits:
          'Native file bytes read successfully; load/loadend delivery and abort are deliberately held. Not physical slow disk or native OS-picker cancellation.',
      }),
    });
  });
}

test('native committed-but-late completion and late open retain ownership until actual terminal callbacks', async ({
  page,
}, info) => {
  await deliveryProbe(page);
  await fixture(page);
  await openLibrary(page);
  await page.clock.install();
  await page.evaluate(() => {
    (window as any).libraryProbe.holdDatabase = true;
  });
  await page.locator('#library-save').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).libraryProbe.heldDatabase.length))
    .toBe(1);
  await page.clock.fastForward(10001);
  await expect(page.locator('#library-status')).toContainText('uncertain');
  await page.locator('#library-add').click();
  await expect(page.locator('#library-status')).toContainText('busy');
  await releaseDatabase(page);
  await expect(page.locator('#library-status')).toContainText('committed after');
  await page.locator('#library-refresh').click();
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  const committed = await database(page);
  await page.reload();
  await page.clock.install();
  await page.evaluate(() => {
    (window as any).libraryProbe.holdOpen = true;
  });
  await page.locator('#local-library > summary').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).libraryProbe.heldOpen.length))
    .toBe(1);
  await page.clock.fastForward(5001);
  await expect(page.locator('#library-status')).toContainText('uncertain');
  await page.locator('#library-refresh').click();
  await page.locator('#library-refresh').click();
  expect(await page.evaluate(() => (window as any).libraryProbe.openCalls)).toBe(1);
  await page.evaluate(() => {
    const state = (window as any).libraryProbe;
    state.holdOpen = false;
    for (const callback of state.heldOpen.splice(0)) callback();
  });
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  expect(await database(page)).toEqual(committed);
  await info.attach('native-late-settlement.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      committedRecords: committed,
      timedOutNativeOpCount: 1,
      nativeOpenCountWhilePending: 1,
      claimedNoncommitAtTimeout: false,
    }),
  });
});

test('native library reload, exact standalone bytes, explicit mutations and complete paused-world neutrality', async ({
  page,
}, info) => {
  const before = await fixture(page);
  await database(page, [
    [first, encodeRecord(candidate(), 1)],
    [second, encodeRecord(candidate('neighbor'), 1)],
  ]);
  await openLibrary(page);
  await page.locator(`[data-library-id="${first}"]`).click();
  const exported = await download(page, '#library-export');
  expect(parseBlueprint(exported.toString())).toEqual(candidate().blueprint);
  expect(exported.toString()).toBe(serializeBlueprint(candidate().blueprint));
  await page.locator('#library-load').click();
  await expect(page.locator('#library-dialog')).toBeVisible();
  await expect(page.locator('#library-cancel')).toBeFocused();
  await page.locator('#library-confirm').click();
  await expect(page.locator('#blueprint-name')).toHaveValue(candidate().blueprint.name);
  expect(await download(page, '#export-blueprint')).toEqual(exported);
  await page.locator('#library-duplicate').click();
  await expect(page.locator('#library-count')).toContainText('3 / 100');
  const duplicated = await database(page);
  expect(
    duplicated.filter(
      ([, value]) =>
        JSON.parse(value as string).blueprint === serializeBlueprint(candidate().blueprint),
    ),
  ).toHaveLength(2);
  await page.locator(`[data-library-id="${first}"]`).click();
  await page.locator('#library-rename').click();
  await page.locator('#library-rename-name').fill('  renamed <b> 🌿  ');
  await page.locator('#library-confirm').click();
  await expect(page.locator(`[data-library-id="${first}"]`)).toContainText('renamed <b>');
  await page
    .locator('#library-file')
    .setInputFiles({ name: 'incoming.json', mimeType: 'application/json', buffer: exported });
  await expect(page.locator('#library-candidate')).toBeVisible();
  expect(await download(page, '#library-export-candidate')).toEqual(exported);
  await page.locator('#library-replace').click();
  await expect(page.locator('#library-dialog-description')).toContainText(first);
  await page.locator('#library-confirm').click();
  await expect(page.locator('#library-candidate')).toBeHidden();
  const replaced = JSON.parse((await database(page)).find(([id]) => id === first)![1] as string);
  expect(replaced.revision).toBe(3);
  expect(replaced.provenance).toBeUndefined();
  const beforeDelete = await database(page);
  await page.locator('#library-delete').click();
  await page.locator('#library-cancel').click();
  expect(await database(page)).toEqual(beforeDelete);
  await page.locator('#library-delete').click();
  await page.locator('#library-confirm').click();
  await expect(page.locator('#library-count')).toContainText('2 / 100');
  await expect(page.locator(`[data-library-id="${second}"]`)).toBeFocused();
  for (let repeat = 0; repeat < 3; repeat++) expect(await pausedSave(page)).toEqual(before);
  const persisted = await database(page);
  await page.reload();
  await openLibrary(page);
  expect(await database(page)).toEqual(persisted);
  await page.screenshot({ path: info.outputPath('native-library-reload.png'), fullPage: true });
  await info.attach('native-library-neutrality.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      worldSHA256: createHash('sha256').update(before).digest('hex'),
      bytes: before.length,
      repeatedSaves: 3,
      nativeRecords: persisted,
    }),
  });
});

test('native overlapping two-page cap, full-string CAS and repair eligibility races', async ({
  page,
  context,
}, info) => {
  await page.goto('/');
  const base = encodeRecord(candidate(), 1);
  const initial: [string, unknown][] = Array.from({ length: 99 }, (_, position) => [
    `00000000-0000-4000-8000-${String(position + 1).padStart(12, '0')}`,
    position % 2 ? base : '{}',
  ]);
  await database(page, initial, true);
  const other = await context.newPage();
  await other.goto('/');
  await Promise.all([openLibrary(page), openLibrary(other)]);
  await Promise.all([
    page.locator('#library-save').click(),
    other.locator('#library-save').click(),
  ]);
  await expect.poll(async () => (await database(page)).length).toBe(100);
  await expect
    .poll(
      async () =>
        [
          await page.locator('#library-status').textContent(),
          await other.locator('#library-status').textContent(),
        ].filter((text) => text?.includes('full or overfull')).length,
    )
    .toBe(1);
  expect((await database(page)).filter(([id]) => initial.some(([key]) => id === key))).toHaveLength(
    99,
  );
  for (const tab of [page, other]) {
    if (await tab.locator('#library-candidate').isVisible())
      await tab.locator('#library-discard').click();
  }
  await database(page, [[first, base]], true);
  for (const tab of [page, other]) {
    await tab.locator('#library-refresh').click();
    await expect(tab.locator('#library-count')).toContainText('1 / 100');
    await tab.locator(`[data-library-id="${first}"]`).click();
    await tab.locator('#library-rename').click();
    await tab.locator('#library-rename-name').fill(tab === page ? 'first tab' : 'second tab');
  }
  await Promise.all([
    page.locator('#library-confirm').click(),
    other.locator('#library-confirm').click(),
  ]);
  await expect
    .poll(async () => JSON.parse((await database(page))[0][1] as string).revision)
    .toBe(2);
  await expect
    .poll(
      async () =>
        [
          await page.locator('#library-status').textContent(),
          await other.locator('#library-status').textContent(),
        ].filter((text) => text?.includes('changed or disappeared')).length,
    )
    .toBe(1);
  const damaged = JSON.stringify({
    recordVersion: 1,
    revision: 0,
    blueprint: serializeBlueprint(candidate().blueprint),
  });
  const futureBlueprint = JSON.stringify({ ...candidate().blueprint, version: 2, extra: true });
  const replacements = [
    JSON.stringify({ recordVersion: 2, extra: true }),
    JSON.stringify({ recordVersion: 1, revision: 1, blueprint: futureBlueprint }),
    base,
    damaged.replace('"revision":0', '"revision":-1'),
  ];
  for (const replacement of replacements) {
    await database(page, [[first, damaged]], true);
    await page.locator('#library-refresh').click();
    await expect(page.locator('[data-repair-id]')).toHaveCount(1);
    await page.locator('[data-repair-id]').click();
    await database(other, [[first, replacement]]);
    await page.locator('#library-confirm').click();
    await expect(page.locator('#library-status')).toContainText('changed or disappeared');
    expect(await database(page)).toEqual([[first, replacement]]);
  }
  await database(page, [[first, damaged]], true);
  for (const tab of [page, other]) {
    await tab.locator('#library-refresh').click();
    await expect(tab.locator('[data-repair-id]')).toHaveCount(1);
    await tab.locator('[data-repair-id]').click();
  }
  await Promise.all([
    page.locator('#library-confirm').click(),
    other.locator('#library-confirm').click(),
  ]);
  await expect.poll(async () => (await database(page)).length).toBe(0);
  await info.attach('native-cross-tab-races.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      initialPhysical: 99,
      committedCap: 100,
      conflictingCASRevision: 2,
      repairReplacementStrings: replacements,
      finalPhysical: (await database(page)).length,
    }),
  });
  await other.close();
});

test('native damaged repair retains its full UUID across preceding row insertion and removal', async ({
  page,
}, info) => {
  const before = await fixture(page);
  const third = '00000000-0000-4000-8000-000000000003';
  const valid = encodeRecord(candidate('valid neighbor'), 1);
  const damaged = encodeRecord(candidate('damaged target'), 1).replace(
    '"revision":1',
    '"revision":0',
  );
  const neighbor = encodeRecord(candidate('damaged neighbor'), 1).replace(
    '"revision":1',
    '"revision":-1',
  );
  await openLibrary(page);
  const evidence = [];
  for (const change of ['insertion', 'removal', 'sole damaged row']) {
    const rows: [string, unknown][] = [[second, damaged]];
    if (change !== 'sole damaged row') rows.push([third, neighbor]);
    if (change !== 'insertion') rows.push([first, valid]);
    await database(page, rows, true);
    await page.locator('#library-refresh').click();
    const target = page.locator(`[data-repair-id="${second}"]`);
    await expect(target).toBeEnabled();
    const handle = await target.elementHandle();
    const changed = rows.filter(([id]) => id !== first);
    if (change === 'insertion') changed.push([first, valid]);
    await database(page, changed, true);
    await page.locator('#library-refresh').click();
    await expect(page.locator('#library-count')).toContainText(`${changed.length} / 100`);
    expect(await target.evaluate((node, previous) => node === previous, handle)).toBe(true);
    await target.click();
    await expect(page.locator('#library-dialog-description')).toContainText(`Local ID ${second}.`);
    await expect(page.locator('#library-dialog-description')).not.toContainText(third);
    await page.locator('#library-confirm').click();
    await expect(page.locator('#library-status')).toContainText('committed');
    const survivors = changed
      .filter(([id]) => id !== second)
      .sort(([left], [right]) => left.localeCompare(right));
    expect(await database(page)).toEqual(survivors);
    evidence.push({ change, confirmedFullId: second, survivors });
  }
  expect(await pausedSave(page)).toEqual(before);
  await info.attach('native-stable-repair-identity.json', {
    contentType: 'application/json',
    body: JSON.stringify(evidence),
  });
});

test('native Enter and Space capture preserve focus through live frames and bounded reflow', async ({
  page,
}, info) => {
  const before = JSON.parse((await fixture(page)).toString()) as WorldFile;
  const capture = page.locator('#capture-selected');
  await capture.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(capture).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('#library-count')).toContainText('2 / 100');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const records = (await database(page)).map(([, value]) => JSON.parse(value as string));
  expect(
    records.every(
      (record) =>
        record.provenance.captureTick === before.tick && !Object.hasOwn(record.provenance, 'seed'),
    ),
  ).toBe(true);
  const handle = await capture.elementHandle();
  await page.locator('#pause').click();
  await capture.focus();
  const focusedTick = await page.locator('#tick').textContent();
  await expect.poll(async () => await page.locator('#tick').textContent()).not.toBe(focusedTick);
  await expect(capture).toBeFocused();
  expect(await capture.evaluate((node, old) => node === old, handle)).toBe(true);
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await pausedSave(page);
  for (const width of [320, 390, 760, 1120, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#local-library').scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll<HTMLElement>('body *')]
        .map((node) => ({
          id: node.id,
          tag: node.tagName,
          right: node.getBoundingClientRect().right,
          width: node.getBoundingClientRect().width,
        }))
        .filter((node) => node.right > innerWidth + 1 && node.width)
        .slice(0, 20),
    }));
    expect(layout, JSON.stringify(layout)).toMatchObject({ scroll: width });
    for (const id of ['capture-selected', 'library-refresh', 'library-save', 'library-import']) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: info.outputPath(`library-reflow-${width}.png`), fullPage: true });
  }
});

for (const scenario of [
  'sole delete',
  'disappeared',
  'vanished next',
  'vanished previous',
  'vanished preferred',
]) {
  test(`native two-tab selection remains deliberately empty after ${scenario}`, async ({
    page,
    context,
  }, info) => {
    const before = await fixture(page);
    const design = await download(page, '#export-blueprint');
    const other = await context.newPage();
    await other.goto('/');
    await other.locator('#pause').click();
    const a = encodeRecord(candidate('A'), 1);
    const b = encodeRecord(candidate('B'), 1);
    const c = encodeRecord(candidate('C unseen'), 1);
    const unseen =
      scenario === 'vanished preferred' ? '00000000-0000-4000-8000-000000000004' : third;
    const expectedRows =
      scenario === 'vanished preferred'
        ? [
            [first, a],
            [unseen, c],
          ]
        : [[unseen, c]];
    const initialRows: [string, string][] = [[first, a]];
    if (scenario.startsWith('vanished')) initialRows.push([second, b]);
    if (scenario === 'vanished preferred') initialRows.push([third, c]);
    await database(other, initialRows);
    await openLibrary(page);
    if (scenario === 'vanished previous' || scenario === 'vanished preferred')
      await page.locator(`[data-library-id="${second}"]`).click();
    // Update from a genuine second native connection without changing the displayed snapshot.
    await database(
      other,
      scenario === 'vanished preferred'
        ? [
            [first, a],
            [second, b],
            [unseen, c],
          ]
        : scenario === 'vanished next'
          ? [
              [first, a],
              [unseen, c],
            ]
          : scenario === 'vanished previous'
            ? [
                [second, b],
                [unseen, c],
              ]
            : scenario === 'disappeared'
              ? [[unseen, c]]
              : [
                  [first, a],
                  [unseen, c],
                ],
      true,
    );
    if (scenario === 'disappeared') await page.locator('#library-refresh').click();
    else {
      await page.locator('#library-delete').click();
      await page.locator('#library-confirm').click();
    }
    await expect(page.locator('#library-rows > li')).toHaveCount(expectedRows.length);
    const assertNone = async () => {
      await expect(page.locator('#library-selection')).toHaveText('No selected entry.');
      await expect(page.locator('[data-library-id][aria-pressed="true"]')).toHaveCount(0);
      for (const action of ['load', 'rename', 'duplicate', 'export', 'delete'])
        await expect(page.locator(`#library-${action}`)).toBeDisabled();
    };
    await assertNone();
    if (scenario !== 'disappeared') await expect(page.locator('#library-heading')).toBeFocused();
    await page.locator('#library-refresh').focus();
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.locator('#library-refresh').click();
      await expect(page.locator('#library-status')).toContainText('Library refreshed');
      await assertNone();
      await expect(page.locator('#library-refresh')).toBeFocused();
    }
    await page.locator(`[data-library-id="${unseen}"]`).click();
    await page.locator('#library-load').focus();
    await page.locator('#library-refresh').evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator('#library-status')).toContainText('Library refreshed');
    await expect(page.locator(`[data-library-id="${unseen}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('#library-selection')).toContainText(unseen);
    for (const action of ['load', 'rename', 'duplicate', 'export', 'delete'])
      await expect(page.locator(`#library-${action}`)).toBeEnabled();
    await expect(page.locator('#library-load')).toBeFocused();
    expect(await database(other)).toEqual(expectedRows);
    expect(await download(page, '#export-blueprint')).toEqual(design);
    expect(await pausedSave(page)).toEqual(before);
    await info.attach('selection-preserved-world.json', {
      contentType: 'application/json',
      body: before,
    });
    await info.attach('selection-preserved-designer.json', {
      contentType: 'application/json',
      body: design,
    });
    await info.attach('native-deliberate-no-selection.json', {
      contentType: 'application/json',
      body: JSON.stringify({
        scenario,
        exactRows: expectedRows,
        deliberateNoneAcrossRefreshes: true,
        explicitSelection: unseen,
        worldBytes: before.length,
        worldSha256: createHash('sha256').update(before).digest('hex'),
        designerBytes: design.length,
        designerSha256: createHash('sha256').update(design).digest('hex'),
      }),
    });
    await other.close();
  });
}

test('composed library operations preserve complete world5 and measurement intervention exports', async ({
  page,
}, info) => {
  await fixture(page);
  await page.locator('#ecosystem-tab').click();
  await page.locator('[data-shock="heat"]').click();
  const before = await pausedSave(page);
  const world = JSON.parse(before.toString()) as WorldFile;
  expect(world.version).toBe(5);
  expect(world.telemetry.version).toBe(2);
  expect(world.interventions.version).toBe(1);
  expect(world.interventions.entries).toHaveLength(1);
  await page.locator('#ecosystem-tab').click();
  const measurements = await download(page, '#measurements-json');
  const csv = await download(page, '#measurements-csv');
  await page.locator('#organism-tab').click();
  const original = encodeRecord(candidate('composed design'), 1);
  await database(page, [[first, original]]);
  await openLibrary(page);
  await page.locator('#library-load').click();
  await page.locator('#library-confirm').click();
  await expect(page.locator('#blueprint-name')).toHaveValue('composed design');
  await page.locator('#library-delete').click();
  await page.locator('#library-confirm').click();
  await expect(page.locator('#library-selection')).toHaveText('No selected entry.');
  expect(await database(page)).toEqual([]);
  expect(await pausedSave(page)).toEqual(before);
  await page.locator('#ecosystem-tab').click();
  expect(await download(page, '#measurements-json')).toEqual(measurements);
  expect(await download(page, '#measurements-csv')).toEqual(csv);
  await info.attach('composed-world5.json', { contentType: 'application/json', body: before });
  await info.attach('composed-measurements.json', {
    contentType: 'application/json',
    body: measurements,
  });
  await info.attach('composed-measurements.csv', { contentType: 'text/csv', body: csv });
  await info.attach('native-composed-preservation.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      worldVersion: world.version,
      telemetryVersion: world.telemetry.version,
      interventionVersion: world.interventions.version,
      fullWorldEqual: true,
      fullJSONExportEqual: true,
      fullCSVExportEqual: true,
      buffers: [before, measurements, csv].map((buffer) => ({
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      })),
    }),
  });
});
