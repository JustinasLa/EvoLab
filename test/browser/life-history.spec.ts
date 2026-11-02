import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type WorldFile } from '../../src/model';
import { parseBlueprint } from '../../src/blueprint';
import { nativeDownload, nativeSummary, registerNativeEvidence } from './sensory-evidence';
registerNativeEvidence();
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
async function start(page: Page) {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}
async function load(page: Page, file: WorldFile, success = true) {
  const previous = (await nativeSummary(page)).responses.length;
  await page.locator('#file').setInputFiles({
    name: 'life-history.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect
    .poll(async () =>
      (await nativeSummary(page)).responses
        .slice(previous)
        .some((response: { type: string }) => response.type === (success ? 'loaded' : 'error')),
    )
    .toBe(true);
  await expect(page.locator('#notice')).toContainText(success ? 'World restored' : 'Invalid');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}
// Populated imports resume under the existing UI contract. The native paused
// capture establishes the exact completed boundary before Step assertions.
async function restore(page: Page, reference: Ecosystem) {
  await load(page, reference.save());
  const actual = await saved(page);
  expect(actual.tick).toBeGreaterThanOrEqual(reference.tick);
  while (reference.tick < actual.tick) reference.step();
  expect(actual).toEqual(reference.save());
}
async function inspectAt(page: Page, x: number, y: number) {
  await page.locator('button[data-tool="inspect"]').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const point = await page.locator('#world').evaluate(
    (canvas, at) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
      return {
        x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (at.x + 0.5) * scale,
        y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (at.y + 0.5) * scale,
      };
    },
    { x, y },
  );
  await page.mouse.click(point.x, point.y);
}
const design = async (page: Page, selector = '#export-blueprint') =>
  parseBlueprint((await nativeDownload(page, selector)).toString('utf8'));

test('life-history designer, local library and captures preserve explicit traits and paused ecology', async ({
  page,
}) => {
  await start(page);
  const reference = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  await restore(page, reference);
  await page.locator('#organism-tab').click();
  const before = await saved(page);
  await expect(page.locator('#inherited-life-history')).not.toBeChecked();
  await expect(page.locator('#life-maturity')).toBeDisabled();
  await page.locator('#inherited-life-history').focus();
  await page.locator('#inherited-life-history').press('Space');
  for (const key of ['maturity', 'investment', 'maintenance']) {
    await page.locator(`#life-${key}`).focus();
    await page.locator(`#life-${key}`).press('End');
    await expect(page.locator(`#life-${key}-value`)).toHaveText('2');
    await expect(page.locator(`#life-${key}`)).toBeFocused();
  }
  await page.locator('#neural-enabled').check();
  const enabled = await design(page);
  expect(enabled.genome.controller).toBeDefined();
  expect(enabled.genome.lifeHistory).toEqual({
    version: 1,
    maturity: 2,
    investment: 2,
    maintenance: 2,
  });
  expect(await saved(page)).toEqual(before);
  await page.locator('#blueprint-name').fill('Long-lived investment');
  await page.locator('#local-library > summary').click();
  await expect(page.locator('#library-status')).toContainText('refreshed');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  expect((await design(page, '#library-export')).genome).toEqual(enabled.genome);
  await page.locator('#clear-design').click();
  await expect(page.locator('#inherited-life-history')).not.toBeChecked();
  await page.locator('#library-load').click();
  await page.locator('#library-confirm').click();
  expect((await design(page)).genome).toEqual(enabled.genome);
  await expect(page.locator('#neural-enabled')).toBeChecked();
  expect(await saved(page)).toEqual(before);
  const placed = reference.spawn(enabled.genome, 120, 78)!;
  await restore(page, reference);
  await inspectAt(page, placed.x, placed.y);
  await page.locator('#organism-tab').click();
  await page
    .locator('#specimen-details')
    .evaluate((node) => ((node as HTMLDetailsElement).open = true));
  await expect(page.locator('#inspector')).toContainText(`Organism ${placed.id}`);
  await expect(page.locator('#inspector')).toContainText('birth cadence 17');
  expect((await design(page, '#export-organism-blueprint')).genome).toEqual(enabled.genome);
  await page.locator('#copy-organism').click();
  await expect(page.locator('#inherited-life-history')).toBeChecked();
  expect(await saved(page)).toEqual(reference.save());
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await page.locator('#life-maintenance').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

test('native worker keeps exact step, funded mutations, bounded outcomes and full restoration', async ({
  page,
}) => {
  await start(page);
  const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0.4 }, false);
  const genome = founder(0);
  genome.cells = [{ x: 0, y: 0, type: 7 }];
  genome.lifeHistory = { version: 1, maturity: 1, investment: 2, maintenance: 2 };
  const parent = world.spawn(genome, 120, 78)!;
  parent.age = 30;
  parent.energy = 100;
  await restore(page, world);
  for (let tick = 0; tick < 4; tick++) {
    const at = world.tick;
    await page.locator('#step').click();
    world.step();
    await expect(page.locator('#tick')).toHaveText(`TICK ${at + 1}`);
  }
  const expected = world.save();
  expect(await saved(page)).toEqual(expected);
  const birth = expected.lineageArchive.events.find((e) => e.kind === 'reproduction')!;
  expect(birth.kind).toBe('reproduction');
  if (birth.kind !== 'reproduction') throw new Error('Missing birth');
  expect(birth.payment!.parentPaid).toBeCloseTo(
    birth.payment!.offspringGranted + birth.payment!.overhead,
    12,
  );
  await page.locator('#ecosystem-tab').click();
  await page.locator('#lineage-explorer > summary').click();
  await expect(page.locator('#life-history-outcomes')).toContainText('reached maturity');
  await page.locator('#birth-select').selectOption(`${birth.tick}:${birth.parentOrganismId}`);
  await expect(page.locator('#birth-detail')).toContainText('Actual parental payment');
  await expect(page.locator('#birth-detail')).toContainText('Parent age 34');
  const malformed = structuredClone(expected);
  malformed.organisms[0].genome.lifeHistory!.maintenance = 3;
  await load(page, malformed, false);
  expect(await saved(page)).toEqual(expected);
  await restore(page, world);
  await page.locator('#step').click();
  world.step();
  await expect(page.locator('#tick')).toHaveText(`TICK ${world.tick}`);
  expect(await saved(page)).toEqual(world.save());
});
