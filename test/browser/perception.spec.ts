import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, index, type Genome, type Perception, type WorldFile } from '../../src/model';
import {
  assertNativeStreams,
  nativeDownload,
  nativeSummary,
  registerNativeEvidence,
} from './sensory-evidence';

registerNativeEvidence();
declare global {
  interface Window {
    perceptionNative: { state: any; rays: number; occlusions: number };
  }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = (window.perceptionNative = { state: null, rays: 0, occlusions: 0 });
    window.Worker = new Proxy(window.Worker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        worker.addEventListener('message', ({ data }) => {
          const observation = data.state ?? data.recovery?.state;
          if (observation) state.state = observation;
        });
        return worker;
      },
    });
    const original = CanvasRenderingContext2D.prototype.strokeRect;
    CanvasRenderingContext2D.prototype.strokeRect = function (...args) {
      if (this.canvas.id === 'world') {
        if (this.strokeStyle === '#58bce5') state.rays++;
        if (this.strokeStyle === '#edae57') state.occlusions++;
      }
      return original.apply(this, args);
    };
  });
});
const save = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
async function inspect(page: Page, x: number, y: number) {
  await page.locator('button[data-tool="inspect"]').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const point = await page.locator('#world').evaluate(
    (canvas: HTMLCanvasElement, { x, y }) => {
      const rect = canvas.getBoundingClientRect(),
        scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
      return {
        x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (x + 0.5) * scale,
        y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (y + 0.5) * scale,
      };
    },
    { x, y },
  );
  await page.mouse.click(point.x, point.y);
  await expect.poll(async () => (await nativeSummary(page)).pending.length).toBe(0);
}

test('selected native perception observes actual steps, stays read-only with render off, and clears stale identities', async ({
  page,
}) => {
  test.setTimeout(60000);
  const setup = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 }, false),
    genome: Genome = {
      cells: [
        { x: 0, y: 0, type: 8 },
        { x: 1, y: 0, type: 5 },
        { x: 1, y: 1, type: 3 },
      ],
      preference: 0.5,
      tolerance: 0.2,
      tempo: 2,
      behavior: {
        version: 2,
        mode: 'evolved',
        reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
      },
    };
  setup.spawn(genome, 60, 60)!.energy = 100;
  setup.food[index(60, 55)] = 1;
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#file').setInputFiles({
    name: 'active.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(setup.save())),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const initial = await save(page),
    reference = Ecosystem.load(JSON.stringify(initial)),
    organism = initial.organisms[0];
  await inspect(page, organism.x, organism.y);
  reference.selectPerception(organism.id);
  await expect(page.locator('#perception-observation')).toContainText('No retained perception');
  await page.locator('#perception-enabled').check();
  for (let step = 0; step < 2; step++) {
    await page.locator('#step').click();
    reference.step();
    await expect(page.locator('#tick')).toHaveText(
      `TICK ${reference.tick.toLocaleString('en-US')}`,
    );
  }
  let trace = reference.perception()!;
  expect(trace).not.toBeNull();
  expect(await page.evaluate(() => window.perceptionNative.state.perception)).toEqual(trace);
  await expect(page.locator('#perception-observation')).toContainText(
    `Last perception at tick ${trace.tick}`,
  );
  await page.locator('#world').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.perceptionNative.rays)).toBeGreaterThan(0);
  expect(await save(page)).toEqual(reference.save());
  const posts = (await nativeSummary(page)).posts.filter((p: any) => p.type !== 'flow-ack').length;
  await page.locator('#perception-enabled').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#perception-enabled')).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(page.locator('#perception-enabled')).toBeChecked();
  expect((await nativeSummary(page)).posts.filter((p: any) => p.type !== 'flow-ack')).toHaveLength(
    posts,
  );
  await page.locator('#render-habitat').uncheck();
  const target = reference.tick + 30;
  await page.locator('#target-tick').fill(String(target));
  await page.locator('#run-to-tick').click();
  await expect(page.locator('#tick')).toHaveText(`TICK ${target.toLocaleString('en-US')}`);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  while (reference.tick < target) reference.step();
  trace = reference.perception()!;
  expect(await save(page)).toEqual(reference.save());
  expect(await page.evaluate(() => window.perceptionNative.state.perception)).toEqual(trace);
  await expect(page.locator('#perception-observation')).toContainText(
    `Last perception at tick ${trace.tick}`,
  );
  const before = await nativeDownload(page);
  const malformed = JSON.parse(before.toString('utf8'));
  malformed.lineageArchive.summaries.at(-1).foundingGenome.behavior.reactions.food = 'attack';
  await page.locator('#file').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(page.locator('#notice')).toContainText('lineage archive');
  expect(await nativeDownload(page)).toEqual(before);
  expect(await page.evaluate(() => window.perceptionNative.state.perception)).toEqual(trace);
  for (const width of [320, 390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#perception-enabled').scrollIntoViewIfNeeded();
    const box = (await page.locator('#perception-enabled').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await page
    .locator('#file')
    .setInputFiles({ name: 'same-ids.json', mimeType: 'application/json', buffer: before });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#perception-observation')).toContainText('No retained perception');
  const restored = await save(page),
    selected = restored.organisms.find((o) => o.id === organism.id)!;
  await inspect(page, selected.x, selected.y);
  await page.locator('#step').click();
  await page.locator('#step').click();
  await expect(page.locator('#perception-observation')).toContainText('Last perception');
  await inspect(page, 220, 140); // empty selection clears previous trace immediately
  await expect(page.locator('#perception-observation')).toContainText('No retained perception');
  const current = await save(page),
    live = current.organisms.find((o) => o.id === organism.id)!;
  await inspect(page, live.x, live.y);
  await page.locator('#step').click();
  await page.locator('#step').click();
  const dying = (await save(page)).organisms.find((o) => o.id === organism.id)!;
  await page.locator('button[data-tool="erase"]').click();
  await page.locator('#brush').fill('0');
  await page.locator('#world').scrollIntoViewIfNeeded();
  const point = await page.locator('#world').evaluate((canvas: HTMLCanvasElement, o) => {
    const rect = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (o.x + 0.5) * scale,
      y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (o.y + 0.5) * scale,
    };
  }, dying);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#organism-observed')).toContainText('Stale');
  await expect(page.locator('#perception-observation')).toContainText('No retained perception');
  expect(await page.evaluate(() => window.perceptionNative.state.perception)).toBeNull();
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByText('World settings', { exact: true }).click();
  await page.locator('#reset').click();
  await page.locator('#confirm-reset').click();
  await expect(page.locator('#perception-observation')).toContainText('No retained perception');
  assertNativeStreams(page, 8);
});
