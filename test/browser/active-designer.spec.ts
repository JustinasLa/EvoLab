import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type WorldFile } from '../../src/model';
import { parseBlueprint } from '../../src/blueprint';
import {
  assertNativeStreams,
  attachWorld,
  nativeDownload,
  nativeSummary,
  registerNativeEvidence,
} from './sensory-evidence';

registerNativeEvidence();

async function emptyPaused(page: Page): Promise<Ecosystem> {
  const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0, mutation: 0, climate: 0 }, false);
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#file').setInputFiles({
    name: 'empty.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(reference.save())),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.getByRole('tab', { name: 'Organism', exact: true }).click();
  return reference;
}
const blueprint = async (page: Page, selector = '#export-blueprint') =>
  parseBlueprint((await nativeDownload(page, selector)).toString('utf8'));
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));

async function fitControls(page: Page): Promise<void> {
  for (const width of [320, 390, 800, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const control of await page.locator('#reaction-editor select').all()) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
}

test('explicit active creation, native keyboard edits and placement retain complete paused engine continuity', async ({
  page,
}, info) => {
  const reference = await emptyPaused(page);
  expect(await saved(page)).toEqual(reference.save());
  await page.locator('#new-active-design').click();
  await expect(page.locator('#behavior-status')).toContainText('Active reactions');
  const fresh = await blueprint(page);
  expect(fresh.genome).toEqual({
    ...founder(1),
    behavior: {
      version: 2,
      mode: 'evolved',
      reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
    },
  });
  await fitControls(page);
  const food = page.getByRole('combobox', { name: 'Food', exact: true });
  await food.focus();
  await food.press('End');
  await expect(food).toHaveValue('flee');
  await expect(food).toBeFocused();
  await food.press('r');
  await food.press('m');
  await page.getByRole('combobox', { name: 'Walls', exact: true }).selectOption('ignore');
  await page
    .getByRole('combobox', { name: 'Harmless organisms', exact: true })
    .selectOption('chase');
  const edited = await blueprint(page);
  expect(edited.genome).toEqual({
    ...fresh.genome,
    behavior: {
      version: 2,
      mode: 'evolved',
      reactions: { food: 'flee', wall: 'ignore', harmless: 'chase', dangerous: 'flee' },
    },
  });
  expect(await saved(page)).toEqual(reference.save());
  await page.locator('#plant-design').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const point = await page.locator('#world').evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + 50.5 * scale,
      y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + 50.5 * scale,
    };
  });
  await page.mouse.click(point.x, point.y);
  const outcome = reference.paint('plant', 50, 50, 0, edited.genome);
  expect(outcome.placement).toBeDefined();
  reference.appendIntervention({ kind: 'placement', detail: outcome.placement! });
  await expect(page.locator('#population')).toHaveText('1');
  expect(await saved(page)).toEqual(reference.save());
  await page.locator('#step').click();
  reference.step();
  await expect(page.locator('#tick')).toHaveText('TICK 1');
  expect(await saved(page)).toEqual(reference.save());
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await attachWorld(info, 'active-designer-independent-reference.json', reference.save());
  assertNativeStreams(page, 6);
  expect((await nativeSummary(page)).pending).toEqual([]);
});

test('active local library round trip keeps saved tables detached from later edits and legacy Reset', async ({
  page,
}) => {
  const reference = await emptyPaused(page);
  const before = await nativeDownload(page);
  await page.locator('#new-active-design').click();
  await page.locator('#blueprint-name').fill('Active local design');
  await page.locator('#blueprint-description').fill('Retain all four reactions');
  await page.locator('#reaction-dangerous').selectOption('ignore');
  const active = await blueprint(page);
  await page.locator('#local-library > summary').click();
  await expect(page.locator('#library-status')).toContainText('refreshed');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  const stored = await blueprint(page, '#library-export');
  expect(stored).toEqual(active);
  await page.locator('#reaction-dangerous').selectOption('chase');
  await page.locator('#clear-design').click();
  await expect(page.locator('#behavior-status')).toContainText('Legacy behavior');
  await expect(page.locator('#reaction-editor')).toHaveCount(0);
  await page.locator('#library-load').click();
  await expect(page.locator('#library-dialog')).toBeVisible();
  await page.locator('#library-confirm').click();
  await expect(page.locator('#reaction-dangerous')).toHaveValue('ignore');
  expect(await blueprint(page)).toEqual(active);
  expect(await nativeDownload(page)).toEqual(before);
  expect(JSON.parse(before.toString())).toEqual(reference.save());
  assertNativeStreams(page, 5);
  const native = await nativeSummary(page);
  expect(native.pending).toEqual([]);
  expect(native.activeUrls).toEqual([]);
  expect(native.overflow).toBe(false);
});
