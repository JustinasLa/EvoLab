import { expect, test } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, WORLD_VERSION } from '../../src/model';
import { nativeDownload, registerNativeEvidence } from './sensory-evidence';

registerNativeEvidence();

test('biological shade reset, source-separated inspection, exact step and rejected native import', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#ecosystem-tab').click();
  await page.getByText('Biological shade (experimental)', { exact: true }).click();
  await expect(page.locator('#biological-shade-summary')).toContainText('Disabled');
  await page.locator('#biological-shade-next').check();
  await page.locator('.world-settings > summary').click();
  const original = JSON.parse((await nativeDownload(page)).toString());
  await page.locator('#reset').click();
  await expect(page.locator('#reset-payload')).toContainText('enabled, costly armor-cast shade');
  await page.locator('#cancel-reset').click();
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(original);
  await page.locator('#reset').click();
  await page.locator('#confirm-reset').click();
  await expect(page.locator('#run-state')).toHaveText('LIVE');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  expect(JSON.parse((await nativeDownload(page)).toString()).biologicalShade).toEqual({
    version: 1,
    enabled: true,
  });

  const reference = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false, {
    biologicalShade: true,
    nutrientCycle: true,
  });
  const source = reference.spawn(
    {
      cells: [
        { x: 0, y: 0, type: 7 },
        { x: 1, y: 0, type: 4 },
      ],
      preference: 0.5,
      tolerance: 0.12,
      tempo: 12,
      behavior: { version: 1, mode: 'legacy' },
    },
    120,
    78,
  )!;
  reference.changeShadeMode(true);
  reference.paintShade({ rulesVersion: 1, tool: 'shade', radius: 0, units: 2 }, 120, 78);
  reference.changeRefugeMode(true);
  reference.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 3 }, 120, 78);
  const load = async (file: unknown) =>
    page.locator('#file').setInputFiles({
      name: 'biological-shade.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });
  await load(reference.save());
  await expect(page.locator('#notice')).toContainText('World restored');
  await expect(page.locator('#biological-shade-summary')).toContainText('1 living armor cells');
  await page.locator('#biological-shade-x').fill('120');
  await page.locator('#biological-shade-y').fill('78');
  await expect(page.locator('#biological-shade-cell')).toContainText(
    'living armor 4/16 biological shade, painted 2/16',
  );
  await expect(page.locator('#biological-shade-cell')).toContainText('combined transmission 0.625');
  await expect(page.locator('#biological-shade-cell')).toContainText('painted temperature 0.03');
  await page.locator('#fit').click();
  await page.locator('button[data-tool="inspect"]').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const at = await page.locator('#world').evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + 120.5 * scale,
      y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + 78.5 * scale,
    };
  });
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#inspector')).toContainText(`Organism ${source.id}`);
  await expect(page.locator('#inspector')).toContainText('Biological source: living armor');
  await expect(page.locator('#inspector')).toContainText('additional upkeep 0.008');
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  await page.locator('#step').click();
  reference.step();
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  await load({ ...reference.save(), biologicalShade: { version: 1, enabled: true, units: [] } });
  await expect(page.locator('#notice')).toContainText('Invalid biological shade mode');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  expect(reference.save().version).toBe(WORLD_VERSION);
  await load(reference.save());
  await expect(page.locator('#notice')).toContainText('World restored');
  await page.locator('#step').click();
  reference.step();
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
  const disabled = new Ecosystem(DEFAULTS, true, { nutrientCycle: true }).save();
  await load({ ...disabled, version: 17, biologicalShade: { previouslyUnowned: true } });
  await expect(page.locator('#notice')).toContainText('World restored');
  await page.locator('#ecosystem-tab').click();
  await expect(page.locator('#biological-shade-summary')).toContainText('Disabled');
  expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(disabled);
});
