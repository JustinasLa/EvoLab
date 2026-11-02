import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, type Genome, type WorldFile } from '../../src/model';
import { newController } from '../../src/neural';
import { newSenses } from '../../src/senses';
import { parseBlueprint } from '../../src/blueprint';
import { nativeDownload, registerNativeEvidence, attachWorld } from './sensory-evidence';

registerNativeEvidence();
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
const design = async (page: Page) =>
  parseBlueprint((await nativeDownload(page, '#export-blueprint')).toString('utf8'));

async function load(page: Page, world: Ecosystem) {
  await page.locator('#file').setInputFiles({
    name: 'local-senses-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world.save())),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  const loaded = await saved(page);
  while (world.tick < loaded.tick) world.step();
  expect(loaded).toEqual(world.save());
}

test('explicit native v2 designer preserves bounded sensors and topology through blueprints and library', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  const before = await saved(page);
  await page.locator('#organism-tab').click();
  await page.locator('#neural-enabled').check();
  await page.locator('[data-sense="enabled"]').check();
  await page.locator('[data-sense="orientation"]').selectOption('3');
  await page.locator('[data-sense="range"]').fill('8');
  await page.locator('[data-sense="range"]').press('Tab');
  await page.locator('[data-sense="fov"]').selectOption('4');
  await page.locator('[data-sense="temperature"]').check();
  await expect(page.locator('#behavior-status')).toContainText('Neural controller v2');
  await page.getByText('Weights and biases', { exact: true }).click();
  await page.getByLabel('Neural weight 55', { exact: true }).fill('0.25');
  await page.getByLabel('Neural weight 55', { exact: true }).press('Tab');
  const enabled = await design(page);
  expect(enabled.genome.senses).toEqual({
    version: 1,
    orientation: 3,
    range: 8,
    fov: 4,
    temperature: true,
  });
  expect(enabled.genome.controller!.weights).toHaveLength(56);
  expect(enabled.genome.controller!.weights[55]).toBe(0.25);
  await page.locator('#blueprint-name').fill('Expanded local senses');
  await page.locator('#local-library > summary').click();
  await expect(page.locator('#library-status')).toContainText('refreshed');
  await page.locator('#library-save').click();
  await expect(page.locator('#library-count')).toContainText('1 / 100');
  await page.locator('#clear-design').click();
  await page.locator('#library-load').click();
  await page.locator('#library-confirm').click();
  expect((await design(page)).genome).toEqual(enabled.genome);
  await page.locator('[data-sense="enabled"]').uncheck();
  const predecessor = await design(page);
  expect(predecessor.genome.controller).toEqual(newController());
  expect(predecessor.genome.senses).toBeUndefined();
  expect(await saved(page)).toEqual(before);
});

test('native selected v2 observation records only actual paid local samples and preserves exact paused continuation', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  const reference = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  const genome: Genome = {
    cells: [
      { x: 0, y: 0, type: 8 },
      { x: 0, y: 1, type: 5 },
    ],
    preference: 0.5,
    tolerance: 0.2,
    tempo: 2,
    behavior: { version: 1, mode: 'legacy' },
    controller: newController(2),
    senses: { ...newSenses(), temperature: true },
  };
  const organism = reference.spawn(genome, 60, 60)!;
  reference.changeRefugeMode(true);
  reference.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 20 }, 60, 60);
  await load(page, reference);
  await page.getByTitle('Inspect organism (I)').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const point = await page.locator('#world').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + 60.5 * scale,
      y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + 60.5 * scale,
    };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#inspector')).toContainText(`Organism ${organism.id}`);
  await expect(page.locator('#inspector')).toContainText('Neural controller v2');
  for (let tick = 0; tick < 2; tick++) {
    await page.locator('#step').click();
    reference.step();
  }
  await expect(page.locator('#perception-observation')).toContainText(
    'Actual controller v2 perception',
  );
  await expect(page.locator('#perception-observation')).toContainText('temperature 0.032');
  await expect(page.locator('#perception-observation')).toContainText('(60,60) = 0.7');
  const before = await saved(page);
  expect(before).toEqual(reference.save());
  await page.locator('#perception-enabled').check();
  expect(await saved(page)).toEqual(before);
  const blueprint = parseBlueprint(
    (await nativeDownload(page, '#export-organism-blueprint')).toString('utf8'),
  );
  expect(blueprint.genome).toEqual(genome);
  const malformed = structuredClone(before);
  malformed.organisms[0].genome.senses!.range = 9;
  await page.locator('#file').setInputFiles({
    name: 'invalid-local-senses.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(page.locator('#notice')).toContainText('Invalid');
  expect(await saved(page)).toEqual(before);
  await page.locator('#step').click();
  reference.step();
  expect(await saved(page)).toEqual(reference.save());
  await attachWorld(info, 'local-senses-exact-continuation.json', reference.save());
});
