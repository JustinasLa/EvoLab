import { expect, test } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, WORLD_VERSION } from '../../src/model';
import { nativeDownload, registerNativeEvidence } from './sensory-evidence';

registerNativeEvidence();

test('finite nutrient reset, paused field inspection, exact continuation and rejected corrupt import', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#ecosystem-tab').click();
  await page.getByText('Nutrient cycle (experimental)', { exact: true }).click();
  await page.locator('#nutrient-next').check();
  await page.locator('.world-settings > summary').click();
  await page.locator('#reset').click();
  await expect(page.locator('#reset-payload')).toContainText('finite 149760 N');
  await page.locator('#confirm-reset').click();
  await expect(page.locator('#run-state')).toHaveText('LIVE');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(page.locator('#nutrient-summary')).toContainText('149760/149760 N');
  await page.locator('#nutrient-layer').selectOption('minerals');
  await page.locator('#nutrient-x').fill('120');
  await page.locator('#nutrient-y').fill('78');
  await expect(page.locator('#nutrient-cell')).toContainText('mineral N');
  const saved = JSON.parse((await nativeDownload(page)).toString());
  expect(saved.version).toBe(WORLD_VERSION);
  const reference = Ecosystem.load(JSON.stringify(saved));
  await page.locator('#nutrient-layer').selectOption('detritus');
  await page.locator('#step').click();
  reference.step();
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  const corrupt = reference.save();
  corrupt.nutrientCycle!.detritus[0]++;
  await page.locator('#file').setInputFiles({
    name: 'corrupt-nutrients.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(corrupt)),
  });
  await expect(page.locator('#notice')).toContainText('conservation');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  const legacy = new Ecosystem(DEFAULTS).save();
  await page.locator('#file').setInputFiles({
    name: 'disabled.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  await expect(page.locator('#nutrient-summary')).toContainText('Disabled');
});
