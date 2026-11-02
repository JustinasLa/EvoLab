import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder } from '../../src/model';

async function saved(page: Page) {
  await expect(page.locator('#save')).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.locator('#save').click();
  return readFile((await (await download).path())!, 'utf8');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#tick')).toContainText('TICK');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#events > summary').click();
});

test('keyboard and mobile bookmarks replay/seek without replacing or advancing the complete sandbox', async ({
  page,
}) => {
  const original = await saved(page);
  await page.locator('#event-record').click();
  await expect(page.locator('#event-select option')).toHaveCount(3);
  await page.locator('#event-select').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#event-detail')).toContainText('First observed');
  await page.locator('#event-open').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#event-status')).toContainText('Verified original complete endpoint');
  await expect(page.locator('#event-canvas')).toBeVisible();
  await page.locator('#event-seek').click();
  await expect(page.locator('#event-status')).toContainText('Verified original complete endpoint');
  expect(await saved(page)).toBe(original);
  await page.locator('#event-stop').click();
  await expect(page.locator('#event-window')).toContainText('Recording off');
  await expect(page.locator('#event-canvas')).toBeHidden();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
});

test('revisits a real terminal lineage, verifying the original endpoint before showing an earlier tick', async ({
  page,
}) => {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0, mutation: 0 }, false);
  const organism = world.spawn({ ...founder(0), cells: [{ x: 0, y: 0, type: 7 }] }, 40, 40)!;
  organism.age = 900;
  organism.energy = 10;
  await page.locator('#file').setInputFiles({
    name: 'terminal.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world.save())),
  });
  await expect(page.locator('#run-state')).toHaveText('LIVE');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#event-record').click();
  await expect(page.locator('#event-select option')).toHaveCount(2);
  await page.locator('#target-tick').fill('76');
  await page.locator('#run-to-tick').click();
  await expect(page.locator('#event-select option')).toHaveCount(3);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const endpoint = await saved(page);
  await page.locator('#event-select').selectOption('3');
  await expect(page.locator('#event-detail')).toContainText('Lineage');
  await page.locator('#event-open').click();
  await expect(page.locator('#event-status')).toContainText('Viewing tick 76, population 0');
  const source = await page.locator('#event-tick').getAttribute('min');
  await page.locator('#event-tick').fill(source!);
  await page.locator('#event-seek').click();
  await expect(page.locator('#event-status')).toContainText(`Viewing tick ${source}, population 1`);
  expect(await saved(page)).toBe(endpoint);
});

test('rejects late native replay completion after cancellation and a rejected world import', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const gate = ((window as any).eventGate = { release: null, hold: true });
    const Native = Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('event-replay-worker'))
          this.addEventListener('message', (event) => {
            if (event.data.type === 'complete' && gate.hold) {
              const callback = this.onmessage;
              gate.release = () => callback?.call(this, event);
              event.stopImmediatePropagation();
            }
          });
      }
    };
  });
  await page.reload();
  await expect(page.locator('#tick')).toContainText('TICK');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#events > summary').click();
  await page.locator('#event-record').click();
  await page.locator('#event-open').click();
  await page.waitForFunction(() => !!(window as any).eventGate.release);
  await page.locator('#event-cancel').click();
  await page.evaluate(() => (window as any).eventGate.release());
  await expect(page.locator('#event-canvas')).toBeHidden();
  await page.evaluate(() => {
    (window as any).eventGate.release = null;
  });
  await page.locator('#event-open').click();
  await page.waitForFunction(() => !!(window as any).eventGate.release);
  await page
    .locator('#file')
    .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.locator('#event-window')).toContainText('Recording off');
  await page.evaluate(() => (window as any).eventGate.release());
  await expect(page.locator('#event-canvas')).toBeHidden();
  await expect(page.locator('#event-status')).not.toContainText('Verified');
});
