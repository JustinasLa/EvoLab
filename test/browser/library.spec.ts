import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type WorldFile } from '../../src/model';
import { serializeBlueprint, parseBlueprint } from '../../src/blueprint';
import { encodeRecord, libraryCandidate, LIBRARY_DATABASE } from '../../src/library';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
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
  const world = new Ecosystem({ ...DEFAULTS, nutrients: 100, mutation: 0, climate: 0 }, false);
  world.spawn(founder(0), 40, 40);
  const saved = world.save();
  await page
    .locator('#file')
    .setInputFiles({
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
    await expect(page.locator('[data-repair-index]')).toHaveCount(1);
    await page.locator('[data-repair-index]').click();
    await database(other, [[first, replacement]]);
    await page.locator('#library-confirm').click();
    await expect(page.locator('#library-status')).toContainText('changed or disappeared');
    expect(await database(page)).toEqual([[first, replacement]]);
  }
  await database(page, [[first, damaged]], true);
  for (const tab of [page, other]) {
    await tab.locator('#library-refresh').click();
    await expect(tab.locator('[data-repair-index]')).toHaveCount(1);
    await tab.locator('[data-repair-index]').click();
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
  await expect
    .poll(async () => await page.locator('#tick').textContent())
    .not.toBe(`TICK ${before.tick.toLocaleString()}`);
  await expect(capture).toBeFocused();
  expect(await capture.evaluate((node, old) => node === old, handle)).toBe(true);
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await pausedSave(page);
  for (const width of [320, 390, 760, 1120, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#local-library').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const id of ['capture-selected', 'library-refresh', 'library-save', 'library-import']) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: info.outputPath(`library-reflow-${width}.png`), fullPage: true });
  }
});
