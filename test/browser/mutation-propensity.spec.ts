import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type WorldFile } from '../../src/model';
import { parseBlueprint } from '../../src/blueprint';
import {
  nativeDownload,
  registerNativeEvidence,
  attachWorld,
  nativeSummary,
} from './sensory-evidence';
registerNativeEvidence();
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
const design = async (page: Page, selector = '#export-blueprint') =>
  parseBlueprint((await nativeDownload(page, selector)).toString('utf8'));
async function load(page: Page, file: WorldFile) {
  await page.locator('#file').setInputFiles({
    name: 'propensity-world.json',
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

test('explicit inherited designer, local library, placement and capture preserve full paused worlds', async ({
  page,
}, info) => {
  await start(page);
  const reference = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 }, false);
  await load(page, reference.save());
  await page.locator('#organism-tab').click();
  const before = await saved(page);
  await expect(page.locator('#inherited-mutation')).not.toBeChecked();
  await expect(page.locator('#propensity')).toBeDisabled();
  await page.locator('#inherited-mutation').focus();
  await page.locator('#inherited-mutation').press('Space');
  await expect(page.locator('#inherited-mutation')).toBeChecked();
  await expect(page.locator('#propensity')).toBeEnabled();
  await page.locator('#propensity').focus();
  await page.locator('#propensity').press('Home');
  await page.locator('#propensity').press('ArrowRight');
  await expect(page.locator('#propensity-value')).toHaveText('0.01');
  await expect(page.locator('#propensity')).toBeFocused();
  const enabled = await design(page);
  expect(enabled.genome.mutationPropensity).toBe(0.01);
  expect(await saved(page)).toEqual(before);
  await page.locator('#blueprint-name').fill('Inherited design');
  await page.locator('#local-library > summary').click();
  await expect(page.locator('#library-status')).toContainText('refreshed');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  expect((await design(page, '#library-export')).genome).toEqual(enabled.genome);
  await page.locator('#clear-design').click();
  await expect(page.locator('#inherited-mutation')).not.toBeChecked();
  await page.locator('#library-load').click();
  await page.locator('#library-confirm').click();
  await expect(page.locator('#inherited-mutation')).toBeChecked();
  expect((await design(page)).genome).toEqual(enabled.genome);
  for (const width of [320, 390, 800, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await page.locator('#propensity').scrollIntoViewIfNeeded();
    const box = (await page.locator('#propensity').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await page.locator('#plant-design').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const point = await page.locator('#world').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + 50.5 * scale,
      y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + 50.5 * scale,
    };
  });
  await page.mouse.click(point.x, point.y);
  const placed = reference.paint('plant', 50, 50, 0, enabled.genome);
  reference.appendIntervention({ kind: 'placement', detail: placed.placement! });
  await expect(page.locator('#population')).toHaveText('1');
  expect(await saved(page)).toEqual(reference.save());
  await page.locator('[data-tool="inspect"]').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const inspectedPoint = await page.locator('#world').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + 50.5 * scale,
      y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + 50.5 * scale,
    };
  });
  await page.mouse.click(inspectedPoint.x, inspectedPoint.y);
  await expect(page.locator('#inspector')).toContainText('inherited multiplier 0.01');
  await page.locator('#copy-organism').click();
  expect((await design(page)).genome).toEqual(enabled.genome);
  expect(await saved(page)).toEqual(reference.save());
  await page.locator('#step').click();
  reference.step();
  expect(await saved(page)).toEqual(reference.save());
  await attachWorld(info, 'propensity-placement.json', reference.save());
});

test('real worker inherits bounded propensity at actual funded births and preserves rejected-load continuation', async ({
  page,
}, info) => {
  await start(page);
  const reference = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false),
    genome = founder(0);
  genome.mutationPropensity = 0;
  const parent = reference.spawn(genome, 60, 60)!;
  parent.age = 32;
  parent.energy = 40;
  // Fixed seed3668339987 gives an independent self trial changing zero with global gate zero.
  reference.random.state = 3668339987;
  await load(page, reference.save());
  await page.locator('#step').click();
  const birth = await saved(page);
  while (reference.tick < birth.tick) reference.step();
  expect(birth).toEqual(reference.save());
  expect(birth.births).toBeGreaterThanOrEqual(1);
  const child = birth.organisms.find((o) => o.generation === 1)!;
  expect(child.genome.mutationPropensity).toBeGreaterThan(0);
  expect(child.genome.mutationPropensity).toBeLessThanOrEqual(0.1);
  expect({ ...child.genome, mutationPropensity: 0 }).toEqual(genome);
  expect(birth.telemetry.pending.energy.reproductionSpent).toBe(
    birth.telemetry.pending.energy.offspringGranted + 2 * birth.births,
  );
  for (const bad of [
    {
      ...structuredClone(birth),
      organisms: birth.organisms.map((o, i) =>
        i ? o : { ...o, genome: { ...o.genome, mutationPropensity: 1.1 } },
      ),
    },
    { ...structuredClone(birth), version: 13 },
  ]) {
    await page.locator('#file').setInputFiles({
      name: 'invalid-propensity.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(bad)),
    });
    await expect(page.locator('#notice')).toContainText('Invalid');
    expect(await saved(page)).toEqual(birth);
  }
  await load(page, birth);
  const restored = await saved(page);
  while (reference.tick < restored.tick) reference.step();
  expect(restored).toEqual(reference.save());
  await page.locator('#step').click();
  reference.step();
  expect(await saved(page)).toEqual(reference.save());
  expect((await nativeSummary(page)).pending).toEqual([]);
  await attachWorld(info, 'propensity-birth.json', birth);
});
