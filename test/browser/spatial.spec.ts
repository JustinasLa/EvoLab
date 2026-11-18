import { expect, test } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { wrappedScene } from '../fixtures/spatial';
import { nativeDownload, registerNativeEvidence } from './sensory-evidence';

registerNativeEvidence();

test('native spatial capture records real events without changing ecology or pause', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#ecosystem-tab').click();
  const panel = page.locator('#spatial-events');
  await panel.locator('summary').click();
  await expect(page.locator('#spatial-status')).toContainText('Capture off');
  const { world } = wrappedScene();
  await page.locator('#file').setInputFiles({
    name: 'spatial.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world.save())),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const reference = Ecosystem.load((await nativeDownload(page)).toString());
  await page.locator('#spatial-capture').check();
  await expect(page.locator('#spatial-status')).toContainText(
    `Capturing at tick ${reference.tick}. Coverage began at tick ${reference.tick} (capture enabled)`,
  );
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  reference.observeSpatial(true);
  const row = page.locator('#spatial-windows tbody tr').first();
  const recorded = () => {
    const t = reference.spatialSummary()!.windows.at(-1)!.totals;
    return t.attacks + t.births + t.feedings + t.starvationDeaths + t.ageDeaths;
  };
  // Live ticks before the pause vary, so step until the reference engine records an event.
  for (let covered = 1; covered <= 24 && (covered === 1 || recorded() === 0); covered++) {
    await page.locator('#step').click();
    reference.step();
    await expect(row.locator('td').first()).toHaveText(`Pending (${covered} ticks covered)`);
  }
  expect(recorded()).toBeGreaterThan(0);
  const [expectedWindow] = reference.spatialSummary()!.windows.slice(-1);
  const t = expectedWindow.totals;
  const round = (value: number) => String(Math.round(value * 1000) / 1000);
  const cells = await row.locator('td').allTextContents();
  expect(cells.slice(1)).toEqual(
    [
      t.births,
      t.starvationDeaths,
      t.ageDeaths,
      t.manualRemovals,
      t.feedings,
      round(t.feedingEnergy),
      t.attacks,
      round(t.attackDrained),
      round(t.attackGained),
      expectedWindow.activeBins,
    ].map(String),
  );
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  await page.locator('#spatial-windows').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#file').setInputFiles({
    name: 'invalid-spatial.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.locator('#notice')).toContainText('Not a valid EvoLab ecosystem');
  expect(await row.locator('td').allTextContents()).toEqual(cells);
  await page.locator('#file').setInputFiles({
    name: 'spatial-reload.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(reference.save())),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  await expect(page.locator('#spatial-status')).toContainText(
    `Coverage began at tick ${reference.tick} (world reset or import cleared earlier evidence)`,
  );
  await page.locator('#spatial-capture').uncheck();
  await expect(page.locator('#spatial-status')).toContainText('Capture off');
  await expect(page.locator('#spatial-windows')).toBeEmpty();
});
