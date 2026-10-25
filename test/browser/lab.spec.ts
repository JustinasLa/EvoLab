import { test, expect } from '@playwright/test';

test('evolves, pauses, replays, exports, and resumes from a champion', async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('data:'))
      external.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Life finds a weird way.' })).toBeVisible();
  await expect(page.locator('#generation')).not.toHaveText('000', { timeout: 20000 });
  await page.getByRole('button', { name: 'Pause evolution' }).click();
  await expect(page.locator('#status')).toHaveText('Evolution paused');
  await page.waitForTimeout(300);
  const generation = await page.locator('#generation').textContent();
  const before = await page
    .locator('#world')
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.waitForTimeout(300);
  expect(await page.locator('#generation').textContent()).toBe(generation);
  const after = await page
    .locator('#world')
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  expect(after).not.toBe(before);
  await page.getByRole('combobox', { name: 'Replay speed' }).selectOption('2');
  await page.locator('.survivor').first().click();
  await expect(page.getByRole('button', { name: 'Follow latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Follow latest' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save champion' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const saved = Buffer.concat(chunks);
  expect(JSON.parse(saved.toString()).version).toBe(1);
  await page
    .locator('#file')
    .setInputFiles({ name: 'champion.json', mimeType: 'application/json', buffer: saved });
  await expect(page.locator('#notice')).toContainText('Champion loaded');
  await expect(page.locator('#generation')).not.toHaveText('000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('applies new habitats only on restart and rejects invalid imports', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Steps', exact: false }).click();
  await page.locator('#gravity').fill('1.6');
  await page.getByRole('combobox', { name: 'POPULATION', exact: true }).selectOption('12');
  await expect(page.locator('#habitat-label')).toContainText('MEADOW');
  await page.getByRole('button', { name: 'Begin new experiment' }).click();
  await expect(page.locator('#habitat-label')).toContainText('STEPS / 1.60');
  await expect(page.locator('#population')).toHaveText('12 creatures');
  await expect(page.locator('#generation')).not.toHaveText('000', { timeout: 20000 });
  await page.locator('#file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":100}'),
  });
  await expect(page.locator('#notice')).toContainText('Not a valid');
  await page.getByRole('button', { name: 'Gaps', exact: false }).click();
  await page.getByRole('button', { name: 'Begin new experiment' }).click();
  await expect(page.locator('#habitat-label')).toContainText('GAPS');
  await page.getByRole('button', { name: 'Pause evolution' }).click();
  await expect(page.locator('#status')).toHaveText('Evolution paused');
});
