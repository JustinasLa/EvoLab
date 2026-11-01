import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { BatchExport } from '../../src/experiment-batch';

declare global {
  interface Window {
    batchNative: {
      result: BatchExport | null;
      created: number;
      terminated: number;
      hold: boolean;
      release: (() => void) | null;
      readStarted: boolean;
      releaseRead: (() => void) | null;
    };
  }
}
const selector = (name: string) => `[data-batch="${name}"]`;
async function download(page: Page, target: string): Promise<string> {
  const pending = page.waitForEvent('download');
  await page.locator(target).click();
  const file = await pending;
  const text = await readFile((await file.path())!, 'utf8');
  await expect(page.locator(target)).toBeEnabled();
  return text;
}
async function run(page: Page, intervention = 'none', duration = 31, delay = 12) {
  await page.locator(selector('intervention')).selectOption(intervention);
  await page.locator(selector('duration')).fill(String(duration));
  await page.locator(selector('delay')).fill(String(delay));
  await page.locator(selector('start')).click();
  await expect(page.locator(selector('status'))).toContainText('Batch stopped.');
  return await page.evaluate(() => window.batchNative.result!);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const records = (window.batchNative = {
      result: null,
      created: 0,
      terminated: 0,
      hold: false,
      release: null,
      readStarted: false,
      releaseRead: null,
    } as Window['batchNative']);
    const Native = Worker;
    window.Worker = class extends Native {
      batch: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.batch = String(url).includes('batch-worker');
        if (this.batch) records.created++;
        this.addEventListener('message', (event) => {
          if (this.batch && event.data.type === 'complete') {
            records.result = event.data.result;
            if (records.hold) {
              const handler = this.onmessage;
              records.release = () => handler?.call(this, event);
              event.stopImmediatePropagation();
            }
          }
        });
      }
      override terminate() {
        if (this.batch) records.terminated++;
        super.terminate();
      }
    };
  });
  await page.goto('/');
  await expect(page.locator('#tick')).toContainText('TICK');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#experiment-batches').evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
});
test('native independent pairs export and replay without modifying the complete paused sandbox', async ({
  page,
}) => {
  const sandbox = await download(page, '#save');
  await page.locator(selector('burn')).fill('2');
  const result = await run(page);
  expect(result.runs.map((entry) => entry.status)).toEqual(['complete', 'complete']);
  expect(result.runs[0].recipe!.checkpoint).not.toBe(result.runs[1].recipe!.checkpoint);
  for (const entry of result.runs) {
    expect(entry.recipe!.control).toEqual(entry.recipe!.treatment);
    expect(entry.recipe!.control.samples.map((sample) => sample.tick)).toEqual([2, 32, 33]);
    expect(entry.recipe!.plan.treatmentTick).toBe(14);
  }
  await expect(page.locator(selector('report'))).toContainText(
    '2/2 independent seed pairs complete',
  );
  await expect(page.locator(`${selector('report')} svg`)).toHaveAttribute('role', 'img');
  const encoded = await download(page, selector('export'));
  expect(JSON.parse(encoded)).toEqual(result);
  await page.locator(selector('file')).setInputFiles({
    name: 'batch.json',
    mimeType: 'application/json',
    buffer: Buffer.from(encoded),
  });
  await expect(page.locator(selector('report'))).toContainText(
    '2 replay checks, not additional replicates',
  );
  expect((await page.evaluate(() => window.batchNative.result!)).runs).toEqual(
    result.runs.map((entry) => ({ ...entry, reproduced: true })),
  );
  expect(await download(page, '#save')).toBe(sandbox);
  await page.locator('#step').click();
  await expect(page.locator('#tick')).toContainText(String(JSON.parse(sandbox).tick + 1));
  const stepped = JSON.parse(await download(page, '#save'));
  expect(stepped.tick).toBe(JSON.parse(sandbox).tick + 1);
});
test('native shade extinction, paired differences and failed replay evidence remain honest', async ({
  page,
}) => {
  await page.locator(selector('seeds')).fill('42');
  const result = await run(page, 'shade', 300, 0);
  expect(result.runs[0].recipe!.treatment.extinction).toMatchObject({
    cause: 'energy',
    tick: expect.any(Number),
  });
  await expect(page.locator(selector('report'))).toContainText('control 0/1, treatment 1/1');
  await expect(page.locator(selector('report'))).toContainText('Undefined');
  const sandbox = await download(page, '#save');
  result.runs[0].recipe!.control.samples[0].meanPreference = 0.99;
  await page.locator(selector('file')).setInputFiles({
    name: 'tampered.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(result)),
  });
  await expect(page.locator(selector('report'))).toContainText(
    '0/1 independent seed pairs complete; 1 failed',
  );
  await expect(page.locator(selector('report'))).toContainText('replay differs');
  expect(await download(page, '#save')).toBe(sandbox);
});
test('native cancellation exports incomplete outcomes and duplicate seeds are rejected before a worker starts', async ({
  page,
}) => {
  await page.locator(selector('duration')).fill('3600');
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-batch="start"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-batch="cancel"]')!.click();
  });
  await expect(page.locator(selector('report'))).toContainText('1 cancelled, 1 not run');
  const partial = JSON.parse(await download(page, selector('export'))) as BatchExport;
  expect(partial.runs.map((entry) => entry.status)).toEqual(['cancelled', 'pending']);
  const created = await page.evaluate(() => window.batchNative.created);
  await page.locator(selector('seeds')).fill('42,42');
  await page.locator(selector('start')).click();
  await expect(page.locator(selector('status'))).toContainText('unique uint32 seeds');
  expect(await page.evaluate(() => window.batchNative.created)).toBe(created);
  await expect(page.locator(selector('report'))).toBeEmpty();
});
test('sandbox import and comparison ownership reject late native completion', async ({ page }) => {
  const sandbox = await download(page, '#save');
  await page.locator(selector('duration')).fill('1');
  for (const action of ['world-import', 'comparison']) {
    await page.evaluate(() => {
      window.batchNative.hold = true;
      window.batchNative.release = null;
    });
    await page.locator(selector('start')).click();
    await expect.poll(() => page.evaluate(() => !!window.batchNative.release)).toBe(true);
    if (action === 'world-import') {
      await page.locator('#file').setInputFiles({
        name: 'invalid-world.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{}'),
      });
      await expect(page.locator('#notice')).toContainText('valid EvoLab');
    } else {
      await page.locator('#comparisons').evaluate((element: HTMLDetailsElement) => {
        element.open = true;
      });
      await page.locator('#comparison-duration').fill('1');
      await page.locator('#comparison-delay').fill('0');
      await page.locator('#comparison-start').click();
      await expect(page.locator('#comparison-status')).toContainText('Complete:');
    }
    await page.evaluate(() => window.batchNative.release!());
    await expect(page.locator(selector('report'))).toBeEmpty();
    await expect(page.locator(selector('export'))).toBeDisabled();
    expect(await download(page, '#save')).toBe(sandbox);
  }
});
test('late native file reads and oversized imports do not launch workers', async ({ page }) => {
  const sandbox = await download(page, '#save');
  await page.addScriptTag({
    content: `{
    const original = File.prototype.text;
    File.prototype.text = function() {
      if (this.name !== 'held-batch.json') return original.call(this);
      window.batchNative.readStarted = true;
      return new Promise(resolve => window.batchNative.releaseRead = () => original.call(this).then(resolve));
    };
  }`,
  });
  await page.locator(selector('file')).setInputFiles({
    name: 'held-batch.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect.poll(() => page.evaluate(() => window.batchNative.readStarted)).toBe(true);
  await page.locator(selector('cancel')).click();
  await page.evaluate(() => window.batchNative.releaseRead!());
  await expect(page.locator(selector('status'))).toContainText('read cancelled');
  await page.locator(selector('file')).setInputFiles({
    name: 'too-large.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(16_000_001, 32),
  });
  await expect(page.locator(selector('status'))).toContainText('exceeds 16 MB');
  expect(await page.evaluate(() => window.batchNative.created)).toBe(0);
  expect(await download(page, '#save')).toBe(sandbox);
});
