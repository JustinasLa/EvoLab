import { expect, test } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { roleScene } from '../fixtures/roles';
import { nativeDownload, registerNativeEvidence } from './sensory-evidence';

registerNativeEvidence();

test('native role observations preserve exact ecology, paused inspection and replacement ownership', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#ecosystem-tab').click();
  const panel = page.locator('#ecological-roles');
  await panel.locator('summary').click();
  await expect(page.locator('#roles-coverage')).toContainText('0 completed ticks covered');
  const { world } = roleScene();
  await page.locator('#file').setInputFiles({
    name: 'roles.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world.save())),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const captured = JSON.parse((await nativeDownload(page)).toString());
  const reference = Ecosystem.load(JSON.stringify(captured));
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  await page.locator('#step').click();
  reference.step();
  await expect(page.locator('#roles-coverage')).toContainText(
    `${reference.tick} completed ticks covered`,
  );
  await expect(panel).toContainText(
    'photosynthesis + food consumption (origin unknown) + stinger gain',
  );
  await expect(panel).toContainText('Extinct; interaction evidence retained');
  await expect(panel.getByRole('table')).toHaveCount(2);
  await expect(panel).toContainText(
    'Food origin, scavenging and food-producer identity are unknown',
  );
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  const retained = await page.locator('#roles-tables').textContent();
  await page.locator('#ecosystem-tab').click();
  await page.locator('#roles-tables').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await panel.locator('summary').focus();
  await page.keyboard.press('Space');
  await expect(panel).not.toHaveAttribute('open');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.keyboard.press('Space');
  await expect(panel).toHaveAttribute('open');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#file').setInputFiles({
    name: 'invalid-roles.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.locator('#notice')).toContainText('Not a valid EvoLab ecosystem');
  expect(await page.locator('#roles-tables').textContent()).toBe(retained);
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  await page.locator('#file').setInputFiles({
    name: 'roles-reload.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(reference.save())),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  await expect(page.locator('#roles-coverage')).toContainText(
    `Session began at tick ${reference.tick}`,
  );
});
