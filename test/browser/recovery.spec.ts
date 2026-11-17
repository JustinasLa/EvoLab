import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import type { WorldFile } from '../../src/model';

// Read every key of an existing EvoLab database without creating or upgrading it.
async function entries(page: Page, name: string): Promise<Record<string, string>> {
  return page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return {};
    const request = indexedDB.open(name);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Record<string, string>>((resolve, reject) => {
        const store = db.transaction('entries', 'readonly').objectStore('entries');
        const keys = store.getAllKeys(),
          values = store.getAll();
        values.onsuccess = () =>
          resolve(
            Object.fromEntries(
              keys.result.map((key, index) => [String(key), values.result[index]]),
            ),
          );
        values.onerror = () => reject(values.error);
      });
    } finally {
      db.close();
    }
  }, name);
}
async function download(page: Page): Promise<string> {
  await expect(page.locator('#save')).toBeEnabled();
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const file = await pending,
    chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
async function open(page: Page) {
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}
async function step(page: Page) {
  const tick = Number((await page.locator('#tick').textContent())!.replace(/\D/g, ''));
  await page.locator('#step').click();
  await expect(page.locator('#tick')).toHaveText(`TICK ${(tick + 1).toLocaleString()}`);
}
async function capture(page: Page) {
  await page.clock.fastForward(61_000);
  await expect(page.locator('#recovery-status')).toContainText('Recovery snapshot saved');
}
const record = (value: string) => JSON.parse(value);

test('opt-in recovery stores complete Saves apart from checkpoints, rotates two slots and never restores', async ({
  page,
}, info) => {
  await open(page);
  await page.locator('#local-checkpoints > summary').click();
  await page.locator('#checkpoint-refresh').click();
  await expect(page.locator('#checkpoint-status')).toContainText('refreshed');
  await page.locator('#checkpoint-save').click();
  await expect(page.locator('#checkpoint-status')).toContainText('Complete checkpoint saved.');
  const manual = await entries(page, 'evolab-world-checkpoints');
  expect(Object.keys(manual)).toEqual(['1']);

  await page.locator('#local-recovery > summary').click();
  const toggle = page.locator('#recovery-enabled');
  await expect(toggle).not.toBeChecked();
  await page.clock.fastForward(61_000);
  expect(await entries(page, 'evolab-world-recovery')).toEqual({});
  await toggle.check();
  await expect(page.locator('#recovery-status')).toContainText('Automatic recovery on');
  await capture(page);
  const first = record((await entries(page, 'evolab-world-recovery'))['1']);
  // The stored world is byte-identical to the ordinary complete Save of the paused world.
  expect(first.world).toBe(await download(page));
  expect(first).toMatchObject({ format: 'evolab-recovery', version: 1, sequence: 1 });

  // Unchanged paused world: further foreground time stores nothing new.
  await page.clock.fastForward(61_000);
  await page.clock.fastForward(61_000);
  expect(record((await entries(page, 'evolab-world-recovery'))['1']).sequence).toBe(1);

  await step(page);
  await capture(page);
  await step(page);
  await capture(page);
  const stored = await entries(page, 'evolab-world-recovery');
  expect(Object.keys(stored).sort()).toEqual(['1', '2', 'lease']);
  const ticks = [record(stored['1']).tick, record(stored['2']).tick];
  expect(ticks).toEqual([first.tick + 2, first.tick + 1]);
  await expect(page.locator('#recovery-usage')).toContainText(
    `2 / 2 recovery snapshots · newest tick ${first.tick + 2}`,
  );
  expect(await entries(page, 'evolab-world-checkpoints')).toEqual(manual);

  // The newest recovery world continues exactly like the live world.
  const expected = Ecosystem.load(record(stored['1']).world);
  for (let tick = 0; tick < 5; tick++) {
    await step(page);
    expected.step();
  }
  expect(JSON.parse(await download(page)) as WorldFile).toEqual(expected.save());

  // Reload keeps the preference and both snapshots but starts a fresh world.
  await page.reload();
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#local-recovery > summary').click();
  await expect(page.locator('#recovery-enabled')).toBeChecked();
  await expect(page.locator('#recovery-usage')).toContainText('2 / 2 recovery snapshots');
  const reloaded = await entries(page, 'evolab-world-recovery');
  expect(reloaded['1']).toBe(stored['1']);
  expect(reloaded['2']).toBe(stored['2']);
  expect(await entries(page, 'evolab-world-checkpoints')).toEqual(manual);
  expect(
    await page
      .locator('#local-recovery')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await info.attach('recovery-ticks.json', {
    contentType: 'application/json',
    body: JSON.stringify({ firstTick: first.tick, storedTicks: ticks }),
  });
});

test('a second tab skips capture while another tab owns the recovery lease', async ({
  context,
}) => {
  const owner = await context.newPage();
  await open(owner);
  await owner.locator('#local-recovery > summary').click();
  await owner.locator('#recovery-enabled').check();
  await capture(owner);
  const before = await entries(owner, 'evolab-world-recovery');

  const other = await context.newPage();
  await open(other);
  await other.locator('#local-recovery > summary').click();
  // The preference is local to the browser profile, so it is already on.
  await expect(other.locator('#recovery-enabled')).toBeChecked();
  await other.clock.fastForward(61_000);
  await expect(other.locator('#recovery-status')).toContainText(
    'Another EvoLab tab owns automatic recovery',
  );
  await expect(other.locator('#run-state')).toHaveText('PAUSED');
  expect(await entries(other, 'evolab-world-recovery')).toEqual(before);
});
