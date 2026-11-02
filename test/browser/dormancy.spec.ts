import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULT_DORMANCY } from '../../src/dormancy';
import { DEFAULTS, founder, type WorldFile } from '../../src/model';
import { parseBlueprint } from '../../src/blueprint';
import { attachWorld, nativeDownload, registerNativeEvidence } from './sensory-evidence';

registerNativeEvidence();
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
async function load(page: Page, file: WorldFile) {
  await page.locator('#file').setInputFiles({
    name: 'dormancy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}
async function start(page: Page) {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}
async function inspect(page: Page) {
  await page.locator('button[data-tool="inspect"]').click();
  const canvas = page.locator('#world');
  await canvas.scrollIntoViewIfNeeded();
  const point = await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect(),
      scale = Math.min(element.clientWidth / 240, element.clientHeight / 156);
    return {
      x: rect.left + (element.clientWidth - 240 * scale) / 2 + 60.5 * scale,
      y: rect.top + (element.clientHeight - 156 * scale) / 2 + 60.5 * scale,
    };
  });
  await page.mouse.click(point.x, point.y);
}

test('native inherited dormancy controls and library preserve a paused world and export traits only', async ({
  page,
}) => {
  await start(page);
  const before = await saved(page);
  await page.locator('#organism-tab').click();
  await expect(page.locator('#dormancy-enabled')).not.toBeChecked();
  await expect(page.locator('#dormancy-capacity')).toBeDisabled();
  await page.locator('#dormancy-enabled').focus();
  await page.locator('#dormancy-enabled').press('Space');
  for (const [field, value] of [
    ['capacity', '32'],
    ['enterStress', '0.2'],
    ['wakeStress', '0.03'],
    ['enterEnergy', '4'],
    ['wakeEnergy', '12'],
  ]) {
    await page.locator(`#dormancy-${field}`).fill(value);
    await expect(page.locator(`#dormancy-${field}`)).toBeFocused();
  }
  const design = parseBlueprint((await nativeDownload(page, '#export-blueprint')).toString('utf8'));
  expect(design.genome.dormancy).toEqual({
    version: 1,
    capacity: 32,
    enterStress: 0.2,
    wakeStress: 0.03,
    enterEnergy: 4,
    wakeEnergy: 12,
  });
  expect(design.genome).not.toHaveProperty('reserves');
  await page.locator('#blueprint-name').fill('Stored-energy design');
  await page.locator('#local-library > summary').click();
  await expect(page.locator('#library-status')).toContainText('refreshed');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  await page.locator('#clear-design').click();
  await expect(page.locator('#dormancy-enabled')).not.toBeChecked();
  await page.locator('#library-load').click();
  await page.locator('#library-confirm').click();
  await expect(page.locator('#dormancy-capacity')).toHaveValue('32');
  for (const width of [320, 390, 800, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  expect(await saved(page)).toEqual(before);
});

test('real worker retains dormant state through inspection, exact step, rejected import and funded waking', async ({
  page,
}, info) => {
  await start(page);
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  const genome = { ...founder(0), tolerance: 0.12, dormancy: { ...DEFAULT_DORMANCY } };
  const organism = world.spawn(genome, 60, 60)!;
  organism.energy = 20;
  organism.reserves!.stored = 12.3456789012345;
  world.shock('heat');
  world.eventUntil = 120;
  world.step();
  await load(page, world.save());
  const loaded = await saved(page);
  while (world.tick < loaded.tick) world.step();
  expect(loaded).toEqual(world.save());
  await inspect(page);
  await expect(page.locator('#inspector')).toContainText('Dormancy: Dormant');
  expect(await saved(page)).toEqual(world.save());
  const design = parseBlueprint(
    (await nativeDownload(page, '#export-organism-blueprint')).toString('utf8'),
  );
  expect(design.genome).toEqual(genome);
  expect(design.genome).not.toHaveProperty('reserves');
  const invalid = world.save();
  invalid.organisms[0].reserves!.stored = 65;
  await page.locator('#file').setInputFiles({
    name: 'bad-reserve.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.locator('#notice')).toContainText('Invalid organism reserves');
  expect(await saved(page)).toEqual(world.save());
  await page.locator('#step').click();
  world.step();
  expect(await saved(page)).toEqual(world.save());
  expect(organism.reserves!.dormant).toBe(true);
  await load(page, world.save());
  const restored = await saved(page);
  while (world.tick < restored.tick) world.step();
  expect(restored).toEqual(world.save());
  expect(world.tick).toBeLessThan(119);
  await page.locator('#target-tick').fill('119');
  await page.locator('#run-to-tick').click();
  await expect(page.locator('#tick')).toHaveText('TICK 119');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  while (world.tick < 119) world.step();
  expect(await saved(page)).toEqual(world.save());
  await page.locator('#step').click();
  world.step();
  expect(await saved(page)).toEqual(world.save());
  expect(organism.reserves!.dormant).toBe(false);
  expect(world.telemetry.samples.at(-1)!.reserves!.exitSpent).toBe(1.5);
  await inspect(page);
  await expect(page.locator('#inspector')).toContainText('Dormancy: Active');
  await attachWorld(info, 'dormancy-continuation.json', world.save());
});
