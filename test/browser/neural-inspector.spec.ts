import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type ControlState, type WorldFile } from '../../src/model';
import { newController } from '../../src/neural';
import { nativeDownload, nativeSummary, registerNativeEvidence } from './sensory-evidence';

registerNativeEvidence();
declare global {
  interface Window {
    neuralNative: ControlState | null;
  }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.neuralNative = null;
    window.Worker = new Proxy(window.Worker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget) as Worker;
        worker.addEventListener('message', ({ data }) => {
          const state = data.state ?? data.recovery?.state;
          if (state) window.neuralNative = state;
        });
        return worker;
      },
    });
  });
});
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
const idle = async (page: Page) =>
  expect.poll(async () => (await nativeSummary(page)).pending.length).toBe(0);

async function load(page: Page, file: WorldFile) {
  await page.locator('#file').setInputFiles({
    name: 'observed-neural-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await idle(page);
}
async function cell(page: Page, x: number, y: number, mobile: boolean) {
  await page.locator('#world').scrollIntoViewIfNeeded();
  const point = await page.locator('#world').evaluate(
    (canvas: HTMLCanvasElement, target) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
      return {
        x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (target.x + 0.5) * scale,
        y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (target.y + 0.5) * scale,
      };
    },
    { x, y },
  );
  if (mobile) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await idle(page);
}
async function inspect(page: Page, x: number, y: number, mobile: boolean) {
  await page.locator('button[data-tool="inspect"]').click();
  await cell(page, x, y, mobile);
}
function fixture() {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  const controller = newController();
  controller.weights[0] = -0.125;
  controller.weights[6] = 0.25;
  const genome = { ...founder(0), tempo: 2, controller };
  genome.cells.push({ x: 1, y: -1, type: 8 }, { x: 1, y: 1, type: 5 });
  const organism = world.spawn(genome, 60, 60, undefined, undefined, 0)!;
  world.spawn(founder(0), 100, 100);
  return { world, organism };
}

test('native neural inspector is read-only, keyboard accessible and usable on narrow touch screens', async ({
  page,
  isMobile,
}, info) => {
  const setup = fixture();
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await load(page, setup.world.save());
  const before = await saved(page);
  const reference = Ecosystem.load(JSON.stringify(before));
  await inspect(page, 60, 60, isMobile);
  const summary = page.locator('#neural-inspector > summary');
  await summary.focus();
  await summary.press('Space');
  await idle(page);
  await expect(page.locator('#neural-data')).toContainText('no evaluation captured yet');
  reference.selectNeural(setup.organism.id, true);
  for (let step = 0; step < 2; step++) {
    await page.locator('#step').click();
    await idle(page);
    reference.step();
  }
  await expect
    .poll(() => page.evaluate(() => window.neuralNative?.neural))
    .toEqual(reference.neuralObservation());
  const region = page.getByRole('region', { name: 'Neural activity data' });
  await expect(region.locator('svg[role="img"]')).toHaveCount(1);
  await expect(region.locator('circle')).toHaveCount(14);
  await expect(region.locator('line')).toHaveCount(40);
  await expect(region.locator('table')).toHaveCount(3);
  await expect(region).toContainText('not proof of why a controller succeeded');
  await expect(region).toContainText('-0.125');
  await region.focus();
  await region.press('ArrowRight');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await region.press('Space');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(region).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await info.attach('neural-inspector', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  expect(await saved(page)).toEqual(reference.save());
  await summary.focus();
  await summary.press('Space');
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.neuralNative?.neural ?? null)).toBeNull();
  await summary.press('Enter');
  await idle(page);
  await expect(region).toContainText('no evaluation captured yet');
  expect(await saved(page)).toEqual(reference.save());
  await inspect(page, 100, 100, isMobile);
  await expect(region).toContainText('no neural controller');
  await expect(region.locator('svg')).toHaveCount(0);
});

test('native neural history prunes, preserves failed-load evidence, records death and clears replacement identities', async ({
  page,
  isMobile,
}) => {
  const setup = fixture();
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await load(page, setup.world.save());
  const before = await saved(page);
  const reference = Ecosystem.load(JSON.stringify(before));
  await inspect(page, 60, 60, isMobile);
  const summary = page.locator('#neural-inspector > summary');
  if (isMobile) await summary.tap();
  else await summary.click();
  await idle(page);
  reference.selectNeural(setup.organism.id, true);
  const target = reference.tick + 30;
  await page.locator('#target-tick').fill(String(target));
  await page.locator('#run-to-tick').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect.poll(() => page.evaluate(() => window.neuralNative?.world.stats.tick)).toBe(target);
  while (reference.tick < target) reference.step();
  const region = page.locator('#neural-data');
  await expect(region).toContainText('Pruned');
  await expect
    .poll(() => page.evaluate(() => window.neuralNative?.neural))
    .toEqual(reference.neuralObservation());
  await expect(region.locator('table').nth(1).locator('tbody tr')).toHaveCount(12);
  expect(await saved(page)).toEqual(reference.save());
  const observed = reference.neuralObservation();
  await page.locator('#file').setInputFiles({
    name: 'bad-neural.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.locator('#notice')).toContainText('Not a valid EvoLab ecosystem');
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.neuralNative?.neural)).toEqual(observed);
  await expect(region).toContainText('Pruned');
  await page.locator('button[data-tool="erase"]').click();
  await cell(page, 60, 60, isMobile);
  await expect(region).toContainText('selected organism is dead');
  await expect(region).toContainText('death');
  await load(page, before);
  await expect(region).toContainText('no selected organism');
  await inspect(page, 60, 60, isMobile);
  await expect(region).toContainText('no evaluation captured yet');
  await expect(region.locator('svg')).toHaveCount(0);
  await page.locator('[data-tab="ecosystem"]').click();
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.neuralNative?.neural ?? null)).toBeNull();
});
