import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type WorldFile } from '../../src/model';
import { newController } from '../../src/neural';
import { parseBlueprint } from '../../src/blueprint';
import { nativeDownload, registerNativeEvidence, attachWorld } from './sensory-evidence';

registerNativeEvidence();
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
const design = async (page: Page) =>
  parseBlueprint((await nativeDownload(page, '#export-blueprint')).toString('utf8'));

async function load(page: Page, file: WorldFile) {
  await page.locator('#file').setInputFiles({
    name: 'neural-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}

test('native neural designer and collection preserve parameters, paused placement and exact Step', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  const reference = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  await load(page, reference.save());
  await page.locator('#organism-tab').click();
  await page.locator('#neural-enabled').focus();
  await page.locator('#neural-enabled').press('Space');
  await expect(page.locator('#neural-enabled')).toBeChecked();
  await expect(page.locator('#behavior-status')).toContainText('Neural controller v1');
  await page.getByText('Weights and biases', { exact: true }).click();
  await page.getByLabel('Neural weight 0', { exact: true }).fill('0.125');
  await page.getByLabel('Neural weight 0', { exact: true }).press('Tab');
  await page.getByLabel('Neural bias 4', { exact: true }).fill('0.75');
  await page.getByLabel('Neural bias 4', { exact: true }).press('Tab');
  const enabled = await design(page);
  expect(enabled.genome.controller).toEqual({
    ...newController(),
    weights: [0.125, ...Array(39).fill(0)],
    biases: [0, 0, 0, 0, 0.75, 0, 0, 0],
  });
  expect(await saved(page)).toEqual(reference.save());
  await page.locator('#blueprint-name').fill('Neural inherited');
  await page.locator('#local-library > summary').click();
  await expect(page.locator('#library-status')).toContainText('refreshed');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  await page.locator('#clear-design').click();
  await expect(page.locator('#neural-enabled')).not.toBeChecked();
  await page.locator('#library-load').click();
  await page.locator('#library-confirm').click();
  expect((await design(page)).genome).toEqual(enabled.genome);
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
  await page.locator('#step').click();
  reference.step();
  expect(await saved(page)).toEqual(reference.save());
  for (const width of [320, 390, 800, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await attachWorld(info, 'neural-placement.json', reference.save());
});

test('native neural worlds retain costly evaluation, mutation and rejected-load continuation', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  const reference = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 }, false);
  const genome = founder(0);
  genome.controller = newController();
  genome.tempo = 2;
  const parent = reference.spawn(genome, 60, 60)!;
  parent.age = 32;
  parent.energy = 40;
  await load(page, reference.save());
  const loaded = await saved(page);
  while (reference.tick < loaded.tick) reference.step();
  expect(loaded).toEqual(reference.save());
  for (let tick = 0; tick < 12; tick++) {
    await page.locator('#step').click();
    reference.step();
  }
  const before = await saved(page);
  expect(before).toEqual(reference.save());
  expect(before.births).toBeGreaterThan(0);
  for (const mutate of [
    (file: WorldFile) => {
      file.organisms[0].genome.controller!.weights.push(0);
    },
    (file: WorldFile) => {
      file.organisms[0].genome.controller!.biases[0] = 5;
    },
    (file: WorldFile) => {
      delete file.organisms[0].neuralBlocked;
    },
  ]) {
    const invalid = structuredClone(before);
    mutate(invalid);
    await page.locator('#file').setInputFiles({
      name: 'invalid-neural.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(invalid)),
    });
    await expect(page.locator('#notice')).toContainText('Invalid');
    expect(await saved(page)).toEqual(before);
  }
  await load(page, before);
  const restored = await saved(page);
  while (reference.tick < restored.tick) reference.step();
  expect(restored).toEqual(reference.save());
  await page.locator('#step').click();
  reference.step();
  expect(await saved(page)).toEqual(reference.save());
  await attachWorld(info, 'neural-births.json', reference.save());
});
