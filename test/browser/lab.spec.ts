import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, type Frame, type LegacyWorldFile } from '../../src/model';

declare global {
  interface Window {
    telemetryEvidence: { frame: Frame | null; points: number[][] };
  }
}

async function observeTelemetry(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    window.telemetryEvidence = { frame: null, points: [] };
    window.Worker = new Proxy(window.Worker, {
      construct(target, args: ConstructorParameters<typeof Worker>, newTarget) {
        const worker: Worker = Reflect.construct(target, args, newTarget);
        worker.addEventListener('message', ({ data }) => {
          if (data.type === 'frame') window.telemetryEvidence.frame = data.frame;
        });
        return worker;
      },
    });
    const clear = CanvasRenderingContext2D.prototype.clearRect,
      move = CanvasRenderingContext2D.prototype.moveTo,
      line = CanvasRenderingContext2D.prototype.lineTo;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'chart') window.telemetryEvidence.points = [];
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.moveTo = function (x, y) {
      if (this.canvas.id === 'chart') window.telemetryEvidence.points.push([x, y]);
      return move.call(this, x, y);
    };
    CanvasRenderingContext2D.prototype.lineTo = function (x, y) {
      if (this.canvas.id === 'chart') window.telemetryEvidence.points.push([x, y]);
      return line.call(this, x, y);
    };
  });
}

async function telemetryFrame(
  page: import('@playwright/test').Page,
): Promise<Pick<Frame, 'stats' | 'telemetry'>> {
  return page.evaluate(() => {
    const { stats, telemetry } = window.telemetryEvidence.frame!;
    return { stats, telemetry };
  });
}

async function importTelemetryWorld(
  page: import('@playwright/test').Page,
  world: object,
): Promise<void> {
  await page.locator('#file').setInputFiles({
    name: 'telemetry-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if (await page.getByRole('button', { name: 'Ⅱ Pause', exact: true }).isVisible())
    await pause(page);
}

async function stepTo(page: import('@playwright/test').Page, target: number): Promise<void> {
  let tick = (await telemetryFrame(page)).stats.tick;
  expect(tick).toBeLessThanOrEqual(target);
  while (tick < target) {
    await page.getByTitle('Advance one tick while paused').click();
    tick++;
    await expect(page.locator('#tick')).toHaveText(`TICK ${tick.toLocaleString('en-US')}`);
  }
}
import { WIDTH, HEIGHT, index, type WorldFile } from '../../src/model';
test('Even Hub-style cards retain the dark palette and crisp cellular editor', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  const appearance = await page.evaluate(() => {
    const styles = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    return {
      surface: styles('.population-section').backgroundColor,
      accent: styles('#pause').backgroundColor,
      habitat: styles('.habitat').backgroundColor,
      cardRadius: styles('.population-section').borderRadius,
      inset: styles('.population-section').padding,
      screenMargin: styles('.workspace').paddingLeft,
      sectionGap: styles('.panel').gap,
      buttonRadius: styles('#pause').borderRadius,
      typeface: styles('.topbar').fontFamily,
      readoutTypeface: styles('.world-label').fontFamily,
      activeTab: styles('#organism-tab').backgroundColor,
      inactiveTab: styles('#ecosystem-tab').backgroundColor,
    };
  });
  expect(appearance).toEqual({
    surface: 'rgb(34, 39, 39)',
    accent: 'rgb(216, 232, 121)',
    habitat: 'rgb(9, 15, 22)',
    cardRadius: '6px',
    inset: '16px',
    screenMargin: '12px',
    sectionGap: '12px',
    buttonRadius: '6px',
    typeface: 'Arial, Helvetica, sans-serif',
    readoutTypeface: '"DM Mono", monospace',
    activeTab: 'rgb(48, 55, 55)',
    inactiveTab: 'rgba(0, 0, 0, 0)',
  });
  await page.getByRole('tab', { name: 'Organism', exact: true }).click();
  await expect(page.locator('#organism-panel')).toBeVisible();
  await expect(page.locator('#editor button').first()).toHaveCSS('border-radius', '0px');
  await expect(page.locator('#organism-tab')).toHaveCSS('background-color', 'rgb(48, 55, 55)');
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await expect(page.locator('#ecosystem-panel')).toBeVisible();
});

test('all controls share the sidebar without crowding the habitat at every layout width', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'EvoLab / Drift' })).toContainText('drift');
  for (const width of [360, 390, 760, 780, 1024, 1280, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => {
      const habitat = document.querySelector('#world')!.getBoundingClientRect();
      const tools = document.querySelector('.tool-dock')!.getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
      return {
        fits: document.documentElement.scrollWidth <= innerWidth,
        toolsOutside: tools.left >= habitat.right || tools.top >= habitat.bottom,
        panelsSeparate: sidebar.left >= habitat.right || sidebar.top >= habitat.bottom,
        habitatFillsWorkspace:
          innerWidth <= 760 || (habitat.top === sidebar.top && habitat.bottom === sidebar.bottom),
        pageFits: innerWidth <= 760 || document.documentElement.scrollHeight <= innerHeight,
        controlsFit: [...document.querySelectorAll('.sidebar button, .sidebar select')].every(
          (button) => button.scrollWidth <= button.clientWidth,
        ),
        controlsInSidebar: [
          '.topbar',
          '.simulation-controls',
          '.world-heading',
          '.tool-dock',
          '.tool-options',
          '.world-bottom',
          '.tabs',
          '.panel',
          'footer',
        ].every((selector) => document.querySelector(selector)!.closest('.sidebar') !== null),
        unobstructed: document.querySelector('.world-stage')!.children.length === 1,
      };
    });
    expect(layout).toEqual({
      fits: true,
      toolsOutside: true,
      panelsSeparate: true,
      habitatFillsWorkspace: true,
      pageFits: true,
      controlsFit: true,
      controlsInSidebar: true,
      unobstructed: true,
    });
  }
  const habitat = await page.locator('#world').boundingBox();
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByText('World settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Reseed world' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Reseed world' })).toBeInViewport();
  expect(await page.locator('#world').boundingBox()).toEqual(habitat);
  await page.getByText('Cell legend & shortcuts', { exact: true }).click();
  await expect(page.locator('.cell-legend')).toBeVisible();
  await expect(page.locator('.footer-note')).toContainText('Space: pause');
  await expect(page.getByRole('link', { name: 'Source', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close help' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

async function pause(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Ⅱ Pause', exact: true }).click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(page.getByTitle('Advance one tick while paused')).toBeEnabled();
  await page.waitForTimeout(150);
}
async function coordinate(
  page: import('@playwright/test').Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  await page.locator('#world').scrollIntoViewIfNeeded();
  return page.locator('#world').evaluate(
    (canvas: HTMLCanvasElement, p) => {
      const rect = canvas.getBoundingClientRect(),
        scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
      return {
        x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (p.x + 0.5) * scale,
        y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (p.y + 0.5) * scale,
      };
    },
    { x, y },
  );
}
async function downloadWorld(page: import('@playwright/test').Page): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save world' }).click();
  const download = await downloadPromise,
    stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function readWorld(page: import('@playwright/test').Page): Promise<WorldFile> {
  return JSON.parse((await downloadWorld(page)).toString());
}
async function importWorld(page: import('@playwright/test').Page, world: WorldFile): Promise<void> {
  await page.locator('#file').setInputFiles({
    name: 'world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world)),
  });
}
async function extinctionFixture(
  page: import('@playwright/test').Page,
  cause: 'age' | 'energy' | 'empty' | 'living',
  offset = 1,
): Promise<WorldFile> {
  const world = await readWorld(page);
  world.settings = { ...world.settings, climate: 0, nutrients: 0 };
  world.tick = 417;
  const history = new Ecosystem(world.settings, false);
  for (let tick = 0; tick < world.tick; tick++) history.step();
  world.telemetry = history.save().telemetry;
  world.food = [index(5, 5)];
  world.walls = [index(6, 6)];
  world.eventUntil = 0;
  world.eventOffset = 0;
  world.organisms =
    cause === 'empty'
      ? []
      : [
          {
            ...world.organisms[0],
            x: 120,
            y: 78,
            rotation: 0,
            age: cause === 'age' ? 976 - offset : 0,
            energy: cause === 'energy' ? 0.001 : 10,
            genome: { cells: [{ x: 0, y: 0, type: 3 }], preference: 0.5, tolerance: 0.3, tempo: 2 },
          },
        ];
  return world;
}
async function paintCell(
  page: import('@playwright/test').Page,
  tool: string,
  x: number,
  y: number,
): Promise<void> {
  await page.locator(`button[data-tool="${tool}"]`).click();
  const at = await coordinate(page, x, y);
  await page.mouse.click(at.x, at.y);
}
async function expectPausedWorld(
  page: import('@playwright/test').Page,
  tick: number,
): Promise<void> {
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(page.locator('#pause')).toContainText('Resume');
  await expect(page.locator('#step')).toBeEnabled();
  await expect(page.locator('#tick')).toHaveText(`TICK ${tick.toLocaleString()}`);
}

test.describe('pause on total extinction', () => {
  for (const speed of [1, 4, 12]) {
    test(`default ON stops at the first extinct logical tick at ${speed}×`, async ({ page }) => {
      const errors: string[] = [],
        external: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (
          !request.url().startsWith('http://127.0.0.1:4173') &&
          !request.url().startsWith('data:')
        )
          external.push(request.url());
      });
      await page.goto('/');
      await expect(page.locator('#pause-on-extinction')).toBeChecked();
      await pause(page);
      const offset = speed === 1 ? 1 : 2;
      const fixture = await extinctionFixture(page, 'age', offset);
      const expected = Ecosystem.load(JSON.stringify(fixture));
      for (let step = 0; step < offset; step++) expected.step();
      await page.locator('#speed').selectOption(String(speed));
      await importWorld(page, fixture);
      await expectPausedWorld(page, fixture.tick + offset);
      await expect(page.locator('#population')).toHaveText('0');
      await expect(page.locator('#extinction-summary')).toContainText(
        `total extinction at tick ${fixture.tick + offset}`,
      );
      await expect(page.locator('#extinction-summary')).toContainText('Last removal: age limit.');
      await expect(page.locator('#extinction-summary')).toHaveAttribute('aria-live', 'polite');
      await expect(page.locator('#lineages')).toContainText('quiet');
      expect(await readWorld(page)).toEqual(expected.save());
      await page.waitForTimeout(200);
      expect(await readWorld(page)).toEqual(expected.save());
      await page.locator('#pause').click();
      await expectPausedWorld(page, fixture.tick + offset);
      await expect(page.locator('#notice')).toContainText(
        'Place an organism, or turn off Pause on extinction and press Resume.',
      );
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
    });
  }

  test('energy exhaustion, invalid import and the multiline summary remain honest at desktop and narrow widths', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await pause(page);
    const fixture = await extinctionFixture(page, 'energy');
    await page.locator('#speed').selectOption('12');
    await importWorld(page, fixture);
    await expectPausedWorld(page, 418);
    await expect(page.locator('#extinction-summary')).toContainText('energy exhaustion');
    const saved = await readWorld(page);
    await importWorld(page, { ...saved, version: 99 } as unknown as WorldFile);
    await expect(page.locator('#notice')).toContainText('Not a valid EvoLab ecosystem');
    await expectPausedWorld(page, saved.tick);
    await expect(page.locator('#population')).toHaveText('0');
    await expect(page.locator('#pause-on-extinction')).toBeChecked();
    await expect(page.locator('#inspector')).toContainText('Click any organism');
    await expect(page.locator('#lineages')).toContainText('quiet');
    expect(await readWorld(page)).toEqual(saved);
    await page.waitForTimeout(200);
    expect(await readWorld(page)).toEqual(saved);
    const measurements: unknown[] = [];
    for (const width of [360, 390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.locator('#speed').focus();
      await page.keyboard.press('Tab');
      await expect(page.locator('#pause-on-extinction')).toBeFocused();
      const geometry = await page.evaluate(() => {
        const summary = document.querySelector<HTMLElement>('#extinction-summary')!;
        const label = document.querySelector<HTMLElement>('.extinction-preference')!;
        const habitat = document.querySelector('#world')!.getBoundingClientRect();
        const header = document.querySelector('.topbar')!.getBoundingClientRect();
        return {
          width: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          summaryWidth: summary.clientWidth,
          summaryContentWidth: summary.scrollWidth,
          summaryHeight: summary.getBoundingClientRect().height,
          labelHeight: label.getBoundingClientRect().height,
          summaryOutsideHabitat: header.left >= habitat.right || header.top >= habitat.bottom,
          focusOutline: getComputedStyle(document.querySelector('#pause-on-extinction')!)
            .outlineStyle,
        };
      });
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      expect(geometry.summaryContentWidth).toBeLessThanOrEqual(geometry.summaryWidth);
      expect(geometry.labelHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.summaryOutsideHabitat).toBe(true);
      expect(geometry.focusOutline).toBe('solid');
      measurements.push(geometry);
      for (const panel of ['ecosystem', 'organism']) {
        await page.locator(`#${panel}-tab`).click();
        await expect(page.locator('#pause-on-extinction')).toBeVisible();
        await expect(page.locator('#extinction-summary')).toBeVisible();
      }
    }
    const measurementsPath = testInfo.outputPath('extinction-layout.json');
    await writeFile(measurementsPath, JSON.stringify(measurements, null, 2));
    await testInfo.attach('extinction-layout', {
      path: measurementsPath,
      contentType: 'application/json',
    });
    if (testInfo.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#pause-on-extinction').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('extinction-summary.png') });
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(page.locator('#help-dialog')).toContainText('reloading restores ON');
    await expect(page.locator('#help-dialog')).toContainText(
      'display refresh adds no chart samples',
    );
    await page.getByRole('button', { name: 'Close help' }).click();
  });

  test('empty imports preserve the world and allow exact Step, view changes, editing and placement without auto-resume', async ({
    page,
  }) => {
    await page.goto('/');
    await pause(page);
    const fixture = await extinctionFixture(page, 'empty');
    await importWorld(page, fixture);
    await expectPausedWorld(page, 417);
    await expect(page.locator('#extinction-summary')).toContainText(
      'Original extinction cause unavailable',
    );
    expect(await readWorld(page)).toEqual(Ecosystem.load(JSON.stringify(fixture)).save());
    await page.locator('#zoom-in').click();
    await page.locator('#zoom-out').click();
    await page.locator('#fit').click();
    await paintCell(page, 'inspect', 40, 40);
    await expect(page.locator('#inspector')).toContainText('Click any organism');
    await page.locator('button[data-tool="pan"]').click();
    const at = await coordinate(page, 120, 78);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 18, at.y + 12);
    await page.mouse.up();
    await page.locator('#fit').click();
    expect(await readWorld(page)).toEqual(Ecosystem.load(JSON.stringify(fixture)).save());
    await page.locator('#brush').evaluate((input: HTMLInputElement) => {
      input.value = '0';
      input.dispatchEvent(new Event('input'));
    });
    await paintCell(page, 'food', 20, 20);
    await paintCell(page, 'wall', 25, 25);
    const edited = await readWorld(page);
    expect(edited.tick).toBe(417);
    expect(edited.food).toContain(index(20, 20));
    expect(edited.walls).toContain(index(25, 25));
    await page.locator('#step').click();
    await expectPausedWorld(page, 418);
    const stepped = Ecosystem.load(JSON.stringify(edited));
    stepped.step();
    expect(await readWorld(page)).toEqual(stepped.save());
    await expect(page.locator('#extinction-summary')).toContainText('tick 417');
    await paintCell(page, 'plant', 120, 78);
    await expect(page.locator('#population')).toHaveText('1');
    await expect(page.locator('#extinction-summary')).toBeHidden();
    await expectPausedWorld(page, 418);
    const planted = await readWorld(page);
    await page.waitForTimeout(200);
    expect(await readWorld(page)).toEqual(planted);
    await page.locator('#pause').click();
    await expect(page.locator('#run-state')).toHaveText('LIVE');
    await expect(page.locator('#tick')).not.toHaveText('TICK 418');
  });

  for (const alreadyPaused of [true, false]) {
    test(`default ON manual last erase retains its command tick while previously ${alreadyPaused ? 'paused' : 'running'}`, async ({
      page,
    }) => {
      await page.goto('/');
      await pause(page);
      const fixture = await extinctionFixture(page, 'living');
      await page.locator('#speed').selectOption('1');
      await importWorld(page, fixture);
      await expect(page.locator('#notice')).toContainText('World restored');
      if (alreadyPaused) await pause(page);
      await expect(page.locator('#pause-on-extinction')).toBeChecked();
      await page.locator('#brush').evaluate((input: HTMLInputElement) => {
        input.value = '0';
        input.dispatchEvent(new Event('input'));
      });
      await paintCell(page, 'erase', 120, 78);
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
      await expect(page.locator('#population')).toHaveText('0');
      const saved = await readWorld(page);
      await expectPausedWorld(page, saved.tick);
      await expect(page.locator('#extinction-summary')).toContainText(
        `total extinction at tick ${saved.tick}`,
      );
      await expect(page.locator('#extinction-summary')).toContainText('manual erasure');
      expect(saved.deaths).toBe(fixture.deaths + 1);
      expect(saved.food).toEqual(fixture.food);
      expect(saved.walls).toEqual(fixture.walls);
      await page.waitForTimeout(200);
      expect(await readWorld(page)).toEqual(saved);
    });
  }

  test('failed load retains manually paused selection and chosen OFF without advancing or resuming', async ({
    page,
  }) => {
    await page.goto('/');
    await pause(page);
    const fixture = await extinctionFixture(page, 'living');
    await importWorld(page, fixture);
    await expect(page.locator('#notice')).toContainText('World restored');
    await pause(page);
    await paintCell(page, 'inspect', 120, 78);
    await expect(page.locator('#inspector')).toContainText(`Organism ${fixture.organisms[0].id}`);
    await page.locator('#pause-on-extinction').uncheck();
    const saved = await readWorld(page);
    const invalid = structuredClone(saved);
    invalid.organisms.push({ ...invalid.organisms[0], id: invalid.nextId++ });
    await importWorld(page, invalid);
    await expect(page.locator('#notice')).toContainText('Invalid or overlapping organism');
    await expectPausedWorld(page, saved.tick);
    await expect(page.locator('#pause-on-extinction')).not.toBeChecked();
    await expect(page.locator('#inspector')).toContainText(`Organism ${fixture.organisms[0].id}`);
    await expect(page.locator('#extinction-summary')).toBeHidden();
    expect(await readWorld(page)).toEqual(saved);
    await page.waitForTimeout(200);
    expect(await readWorld(page)).toEqual(saved);
  });

  test('late failed-load recovery keeps newer settings aligned with saves and reseeding', async ({
    page,
  }, testInfo) => {
    await observeTelemetry(page);
    await page.addInitScript(() => {
      const delivery = { nutrients: null as number | null, release: () => {} };
      Object.assign(window, { recoveryDelivery: delivery });
      window.Worker = class extends Worker {
        set onmessage(handler: ((this: Worker, event: MessageEvent) => void) | null) {
          super.onmessage = (event) => {
            if (event.data.type === 'error' && event.data.recovery) {
              delivery.nutrients = event.data.recovery.settings.nutrients;
              delivery.release = () => handler?.call(this, event);
            } else handler?.call(this, event);
          };
        }
      };
    });
    await page.goto('/');
    await pause(page);
    const fixture = await extinctionFixture(page, 'empty');
    await importWorld(page, fixture);
    await expectPausedWorld(page, fixture.tick);
    const before = await readWorld(page);
    const summary = await page.locator('#extinction-summary').textContent();
    const points = await page.evaluate(() => window.telemetryEvidence.points);
    expect(before.telemetry.samples).toHaveLength(13);
    await importWorld(page, { ...fixture, version: 99 } as unknown as WorldFile);
    await expect.poll(() => page.evaluate('window.recoveryDelivery.nutrients')).toBe(0);
    await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
    await page.getByText('World settings', { exact: true }).click();
    await page.locator('#nutrients').fill('3');
    await page.locator('#mutation').fill('0.37');
    await page.locator('#climate').fill('0.25');
    await page.locator('#nutrients').fill('7');
    const expected = {
      ...before,
      settings: { ...before.settings, nutrients: 7, mutation: 0.37, climate: 0.25 },
    };
    expect(await readWorld(page)).toEqual(expected);
    await page.evaluate('window.recoveryDelivery.release()');
    await expect(page.locator('#notice')).toContainText('version 2 or 3');
    await expect(page.locator('#nutrients')).toHaveValue('7');
    await expect(page.locator('#nutrients-value')).toHaveText('7%');
    await expect(page.locator('#mutation-value')).toHaveText('37%');
    await expect(page.locator('#climate-value')).toHaveText('25%');
    await expectPausedWorld(page, fixture.tick);
    await expect(page.locator('#extinction-summary')).toHaveText(summary!);
    expect(await page.evaluate(() => window.telemetryEvidence.points)).toEqual(points);
    expect((await telemetryFrame(page)).telemetry).toEqual(before.telemetry);
    expect(await readWorld(page)).toEqual(expected);
    await page.waitForTimeout(200);
    expect(await readWorld(page)).toEqual(expected);
    await page.getByRole('button', { name: 'Reseed world' }).click();
    await pause(page);
    const reseeded = await readWorld(page);
    expect(reseeded.settings).toEqual(expected.settings);
    await expect(page.locator('#nutrients-value')).toHaveText('7%');
    await testInfo.attach('settings-recovery-evidence', {
      body: JSON.stringify({
        snapshotNutrients: 0,
        displayedNutrients: await page.locator('#nutrients').inputValue(),
        retainedTick: before.tick,
        savedSettings: expected.settings,
        reseededSettings: reseeded.settings,
        pausedWorldUnchangedExceptSettings: true,
        telemetryUnchanged: true,
        historyTicks: before.telemetry.samples.map((sample) => sample.tick),
        pending: before.telemetry.pending,
      }),
      contentType: 'application/json',
    });
  });

  test('OFF never resumes implicitly, survives replacement, and reload restores ON', async ({
    page,
  }) => {
    await page.goto('/');
    await pause(page);
    const fixture = await extinctionFixture(page, 'empty');
    await importWorld(page, fixture);
    await expectPausedWorld(page, 417);
    await page.locator('#pause-on-extinction').uncheck();
    await page.waitForTimeout(200);
    await expectPausedWorld(page, 417);
    expect(await readWorld(page)).toEqual(Ecosystem.load(JSON.stringify(fixture)).save());
    await importWorld(page, { ...fixture, version: 99 } as unknown as WorldFile);
    await expect(page.locator('#notice')).toContainText('Not a valid EvoLab ecosystem');
    await expectPausedWorld(page, 417);
    await expect(page.locator('#pause-on-extinction')).not.toBeChecked();
    await page.locator('#pause').click();
    await expect(page.locator('#run-state')).toHaveText('LIVE');
    await expect(page.locator('#tick')).not.toHaveText('TICK 417');
    await expect(page.locator('#population')).toHaveText('0');
    await expect(page.locator('#extinction-summary')).toContainText('Empty world running');
    await pause(page);
    await page.locator('#ecosystem-tab').click();
    await page.getByText('World settings', { exact: true }).click();
    await page.locator('#reset').click();
    await expect(page.locator('#pause-on-extinction')).not.toBeChecked();
    await expect(page.locator('#population')).toHaveText('1');
    await importWorld(page, fixture);
    await expect(page.locator('#notice')).toContainText('World restored');
    await expect(page.locator('#pause-on-extinction')).not.toBeChecked();
    await expect(page.locator('#run-state')).toHaveText('LIVE');
    await expect(page.locator('#tick')).not.toHaveText('TICK 417');
    await expect(page.locator('#population')).toHaveText('0');
    await page.reload();
    await expect(page.locator('#pause-on-extinction')).toBeChecked();
    await expect(page.locator('#extinction-summary')).toBeHidden();
    await expect(page.locator('#world')).toHaveAttribute('data-tool', 'pan');
    await expect(page.locator('#organism-tab')).toHaveAttribute('aria-selected', 'true');
  });
});

for (const terminalTick of [90, 91]) {
  for (const cause of ['age', 'energy'] as const) {
    test(`integrated ${cause} extinction at tick ${terminalTick} retains exact cadence and save continuation`, async ({
      page,
    }, testInfo) => {
      await observeTelemetry(page);
      await page.goto('/');
      await pause(page);
      const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0 }, false);
      const organism = reference.spawn(
        {
          cells: [{ x: 0, y: 0, type: 3 }],
          preference: 0.5,
          tolerance: 0.3,
          tempo: 2,
        },
        40,
        40,
      )!;
      organism.energy = 10;
      for (let tick = 0; tick < terminalTick - 1; tick++) reference.step();
      organism.age = cause === 'age' ? 975 : 0;
      organism.energy = cause === 'energy' ? 0.001 : 5;
      const fixture = reference.save();
      await page.locator('#speed').selectOption('12');
      await importWorld(page, fixture);
      await expectPausedWorld(page, terminalTick);
      reference.step();
      const terminal = await readWorld(page);
      expect(terminal).toEqual(reference.save());
      expect((await telemetryFrame(page)).telemetry).toEqual(terminal.telemetry);
      expect(terminal.telemetry.samples.map((sample) => sample.tick)).toEqual([30, 60, 90]);
      expect(terminal.telemetry.samples.at(-1)!.population).toBe(terminalTick === 90 ? 0 : 1);
      expect(terminal.telemetry.pending.deaths[cause]).toBe(terminalTick === 90 ? 0 : 1);
      await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
      const points = await page.evaluate(() => window.telemetryEvidence.points);
      expect(points).toHaveLength(3);
      await importWorld(page, { ...terminal, version: 99 } as unknown as WorldFile);
      await expect(page.locator('#notice')).toContainText('version 2 or 3');
      expect(await readWorld(page)).toEqual(terminal);
      expect(await page.evaluate(() => window.telemetryEvidence.points)).toEqual(points);
      await page.waitForTimeout(160);
      expect(await readWorld(page)).toEqual(terminal);
      await testInfo.attach(`terminal-${cause}-${terminalTick}`, {
        body: JSON.stringify({
          tick: terminal.tick,
          cause,
          telemetry: terminal.telemetry,
          savedWorldMatchesRealEngine: true,
          failedLoadPreservedHistory: true,
          noSyntheticSample: true,
        }),
        contentType: 'application/json',
      });
      await testInfo.attach(`terminal-${cause}-${terminalTick}-screen`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      await importWorld(page, terminal);
      await expectPausedWorld(page, terminalTick);
      await expect(page.locator('#extinction-summary')).toContainText(
        'Original extinction cause unavailable',
      );
      expect(await readWorld(page)).toEqual(terminal);
      await stepTo(page, 120);
      for (let tick = terminalTick; tick < 120; tick++) reference.step();
      expect(await readWorld(page)).toEqual(reference.save());
      expect((await telemetryFrame(page)).telemetry.samples.at(-1)).toMatchObject({
        tick: 120,
        population: 0,
        deaths: { [cause]: terminalTick === 90 ? 0 : 1 },
      });
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
    });
  }
}

test('restores real worker telemetry, renders its population projection and downloads unchanged paused history', async ({
  page,
}) => {
  await observeTelemetry(page);
  const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false),
    genome = {
      cells: [{ x: 0, y: 0, type: 7 as const }],
      preference: 0.5,
      tolerance: 0.12,
      tempo: 2,
    };
  reference.spawn(genome, 20, 20);
  for (let tick = 0; tick < 30; tick++) reference.step();
  reference.paint('plant', 40, 40, 0, genome);
  for (let tick = 0; tick < 35; tick++) reference.step();
  reference.paint('erase', 20, 20, 0, genome);
  const fixture = reference.save();
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await importTelemetryWorld(page, fixture);
  let frame = await telemetryFrame(page);
  expect(frame.stats.tick).toBeGreaterThanOrEqual(fixture.tick);
  for (let tick = fixture.tick; tick < frame.stats.tick; tick++) reference.step();
  expect(frame.telemetry).toEqual(reference.save().telemetry);
  expect(frame.telemetry.samples.slice(0, 2).map((sample) => sample.population)).toEqual([1, 2]);
  expect(frame.telemetry.pending.deaths.manual).toBe(1);
  const before = frame.telemetry;
  await page.getByTitle('Inspect organism (I)').click();
  const at = await coordinate(page, 40, 40);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#inspector')).toContainText('Organism 2');
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  for (const width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const rendered = await page.evaluate(() => ({
      telemetry: window.telemetryEvidence.frame!.telemetry,
      points: window.telemetryEvidence.points,
      width: (document.querySelector('#chart') as HTMLCanvasElement).width,
      fits: document.documentElement.scrollWidth <= innerWidth,
      chartOutsideHabitat: (() => {
        const chart = document.querySelector('#chart')!.getBoundingClientRect(),
          world = document.querySelector('#world')!.getBoundingClientRect();
        return chart.left >= world.right || chart.top >= world.bottom;
      })(),
    }));
    expect(rendered.telemetry).toEqual(before);
    expect(rendered.points).toHaveLength(before.samples.length);
    const maximum = Math.max(10, ...before.samples.map((sample) => sample.population));
    expect(rendered.points).toEqual(
      before.samples.map((sample, index) => [
        (index / Math.max(1, before.samples.length - 1)) * rendered.width,
        64 - (sample.population / maximum) * 58,
      ]),
    );
    expect(rendered.fits).toBe(true);
    expect(rendered.chartOutsideHabitat).toBe(true);
    await test.info().attach(`restored-population-chart-${width}`, {
      body: await page.locator('.population-section').screenshot(),
      contentType: 'image/png',
    });
  }
  frame = await telemetryFrame(page);
  expect(frame.telemetry).toEqual(before);
  const downloaded = JSON.parse((await downloadWorld(page)).toString());
  expect(downloaded.telemetry).toEqual(before);
  expect(downloaded.version).toBe(3);
  expect(downloaded.telemetry.version).toBe(1);
  expect(downloaded.telemetry.intervalTicks).toBe(30);
  const restored = Ecosystem.load(JSON.stringify(downloaded));
  expect(restored.save()).toEqual(reference.save());
  for (let tick = 0; tick < 100; tick++) {
    reference.step();
    restored.step();
  }
  expect(restored.save()).toEqual(reference.save());
});

test('legacy history begins empty, only exact Step 29→30 samples, and corrupt telemetry preserves the paused world/chart', async ({
  page,
}) => {
  await observeTelemetry(page);
  const legacy: LegacyWorldFile = {
    version: 2,
    settings: { seed: 77, mutation: 0.12, nutrients: 5, climate: 0.8 },
    random: 77,
    tick: 0,
    births: 0,
    deaths: 0,
    nextId: 1,
    nextSpecies: 5,
    eventUntil: 0,
    eventOffset: 0,
    food: [],
    walls: [],
    organisms: [],
  };
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await importTelemetryWorld(page, legacy);
  expect((await telemetryFrame(page)).telemetry).toMatchObject({ originTick: 0, samples: [] });
  expect(await page.evaluate(() => window.telemetryEvidence.points)).toEqual([]);
  await stepTo(page, 29);
  expect((await telemetryFrame(page)).telemetry.samples).toEqual([]);
  await stepTo(page, 30);
  const history = (await telemetryFrame(page)).telemetry.samples;
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    tick: 30,
    population: 0,
    meanPreference: null,
    meanTolerance: null,
  });
  await stepTo(page, 31);
  expect((await telemetryFrame(page)).telemetry.samples).toEqual(history);
  expect(await page.evaluate(() => window.telemetryEvidence.points)).toHaveLength(1);
  const before = (await telemetryFrame(page)).telemetry,
    invalid: any = Ecosystem.load(JSON.stringify(legacy)).save();
  invalid.telemetry.intervalTicks = 12;
  await page.locator('#file').setInputFiles({
    name: 'bad-telemetry.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.locator('#notice')).toContainText('Invalid ecosystem telemetry');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  expect((await telemetryFrame(page)).telemetry).toEqual(before);
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => window.telemetryEvidence.points)).toHaveLength(1);
  await stepTo(page, 32);
  expect((await telemetryFrame(page)).telemetry.samples).toEqual(history);
  const downloaded = JSON.parse((await downloadWorld(page)).toString());
  expect(downloaded.tick).toBe(32);
  expect(downloaded.telemetry).toEqual((await telemetryFrame(page)).telemetry);
  expect(Ecosystem.load(JSON.stringify(downloaded)).save()).toEqual(downloaded);
});

test('restores the full 180-sample ring in the existing chart across desktop/mobile widths', async ({
  page,
}) => {
  await observeTelemetry(page);
  const reference = new Ecosystem(DEFAULTS, false);
  for (let tick = 0; tick < 5430; tick++) reference.step();
  const fixture = reference.save();
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await importTelemetryWorld(page, fixture);
  const frame = await telemetryFrame(page);
  for (let tick = fixture.tick; tick < frame.stats.tick; tick++) reference.step();
  expect(frame.telemetry).toEqual(reference.save().telemetry);
  expect(frame.telemetry.samples).toHaveLength(180);
  for (const width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => window.telemetryEvidence.points.length)).toBe(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await telemetryFrame(page)).telemetry).toEqual(frame.telemetry);
    await test.info().attach(`wrapped-population-chart-${width}`, {
      body: await page.locator('.population-section').screenshot(),
      contentType: 'image/png',
    });
  }
  const downloaded = JSON.parse((await downloadWorld(page)).toString());
  expect(downloaded.telemetry).toEqual(frame.telemetry);
  expect(downloaded.telemetry.samples[0].tick).toBe(60);
  expect(downloaded.telemetry.samples.at(-1).tick).toBe(5430);
  expect(downloaded.telemetry.samples.at(-1).tick - downloaded.telemetry.samples[0].fromTick).toBe(
    5400,
  );
  expect(Ecosystem.load(JSON.stringify(downloaded)).save()).toEqual(downloaded);
});

test('Pan and Organism are the defaults and dragging changes only the camera', async ({ page }) => {
  const expectDefaults = async (): Promise<void> => {
    await expect(page.locator('.tool-dock [aria-pressed="true"]')).toHaveAttribute(
      'data-tool',
      'pan',
    );
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute(
      'id',
      'organism-tab',
    );
    await expect(page.locator('#world')).toHaveAttribute('data-tool', 'pan');
    await expect(page.locator('#world')).toHaveCSS('cursor', 'grab');
    await expect(page.locator('#tool-hint')).toHaveText('Drag to move the world. Scroll to zoom.');
    await expect(page.locator('#brush-control')).toBeHidden();
    await expect(page.locator('#organism-panel')).toBeVisible();
    await expect(page.locator('#ecosystem-panel')).toBeHidden();
  };
  await page.goto('/');
  await expectDefaults();
  await pause(page);
  const saved = await downloadWorld(page),
    rendered = await page
      .locator('#world')
      .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()),
    center = await coordinate(page, WIDTH / 2, HEIGHT / 2);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 30, center.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => page.locator('#world').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()))
    .not.toBe(rendered);
  expect(await downloadWorld(page)).toEqual(saved);
  await expect(page.locator('#specimen-details')).not.toHaveAttribute('open');
  await page.getByTitle('Inspect organism (I)').click();
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.reload();
  await expectDefaults();
});

test('new and reseeded worlds begin with one creature and no births', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#population')).toHaveText('1');
  await pause(page);
  await expect(page.locator('#population')).toHaveText('1');
  await expect(page.locator('#births')).toHaveText('0');
  await expect(page.locator('#species-count')).toHaveText('1 lineage');
  await expect(page.locator('#world-count')).toHaveText('1 organism · 1 lineage');
  await expect(page.locator('#lineages .lineage')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByText('World settings', { exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Leaf food chance' })).toHaveValue('5');
  await expect(page.getByText('Nutrient rain', { exact: true })).toHaveCount(0);
  await page.locator('#seed').fill('100');
  await page.getByRole('button', { name: 'Reseed world' }).click();
  await expect(page.locator('#world-label')).toHaveText('WORLD 0100');
  await pause(page);
  await expect(page.locator('#population')).toHaveText('1');
  await expect(page.locator('#births')).toHaveText('0');
  await expect(page.locator('#generation')).toHaveText('GEN 0');
  const world = JSON.parse((await downloadWorld(page)).toString()) as WorldFile,
    [organism] = world.organisms;
  expect(world.organisms).toHaveLength(1);
  expect(organism.rotation).toBe(0);
  const allowed = new Set(
    organism.genome.cells
      .filter((cell) => cell.type === 4)
      .flatMap((cell) =>
        [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ].map(
          ([offsetX, offsetY]) =>
            ((organism.y + cell.y + offsetY + HEIGHT) % HEIGHT) * WIDTH +
            ((organism.x + cell.x + offsetX + WIDTH) % WIDTH),
        ),
      ),
  );
  expect(world.food.every((position) => allowed.has(position))).toBe(true);
});

test('a live ecosystem evolves, pauses, paints, inspects and restores a whole world', async ({
  page,
}) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4173') && !r.url().startsWith('data:'))
      external.push(r.url());
  });
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await expect
    .poll(async () => Number((await page.locator('#births').textContent())?.replaceAll(',', '')))
    .toBeGreaterThan(0);
  await pause(page);
  const tick = await page.locator('#tick').textContent();
  await page.waitForTimeout(200);
  await expect(page.locator('#tick')).toHaveText(tick!);
  await page.getByTitle('Advance one tick while paused').click();
  await expect(page.locator('#tick')).not.toHaveText(tick!);
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByRole('button', { name: 'Show temperature' }).click();
  await expect(page.locator('#thermal')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Cold snap' }).click();
  await expect(page.locator('#weather')).toContainText('Cold snap');
  await expect(page.locator('[data-shock="bloom"]')).toHaveCount(0);
  const saved = await downloadWorld(page),
    world = JSON.parse(saved.toString());
  expect(world.version).toBe(3);
  expect(world.organisms.length).toBeGreaterThan(1);
  const o = world.organisms[0],
    c = o.genome.cells[0];
  let dx = c.x,
    dy = c.y;
  for (let i = 0; i < o.rotation; i++) [dx, dy] = [-dy, dx];
  await page.getByTitle('Inspect organism (I)').click();
  const pos = await coordinate(page, (o.x + dx + 240) % 240, (o.y + dy + 156) % 156);
  await page.mouse.click(pos.x, pos.y);
  await expect(page.locator('#inspector')).toContainText(`Organism ${o.id}`);
  await expect(page.locator('#specimen-details')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Edit this organism' }).click();
  await expect(page.locator('#specimen-details')).not.toHaveAttribute('open');
  await expect(page.locator('#notice')).toContainText('Anatomy copied');
  await page.getByRole('button', { name: 'Place in world' }).click();
  await expect(page.locator('button[data-tool="plant"]')).toHaveAttribute('aria-pressed', 'true');
  const population = Number(await page.locator('#population').textContent());
  for (let y = 40; y < 100; y += 10) {
    const at = await coordinate(page, 120, y);
    await page.mouse.click(at.x, at.y);
  }
  await expect
    .poll(async () => Number(await page.locator('#population').textContent()))
    .toBeGreaterThan(population);
  await page
    .locator('#file')
    .setInputFiles({ name: 'world.json', mimeType: 'application/json', buffer: saved });
  await expect(page.locator('#notice')).toContainText('World restored');
  await expect(page.locator('#population')).toHaveText(String(world.organisms.length));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
test('designer, world tools, camera, shortcuts and invalid saves behave in Chrome', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await pause(page);
  await page.getByRole('tab', { name: 'Organism', exact: true }).click();
  await page.getByRole('button', { name: 'Cell 4, 4', exact: true }).click();
  await page.getByRole('button', { name: 'Place in world' }).click();
  await expect(page.locator('#notice')).toContainText('connected');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Motor', exact: true }).click();
  await expect(page.locator('#cell-description')).toContainText('Moves');
  await page.getByRole('button', { name: 'Cell 0, 1', exact: true }).click();
  await page.locator('#preference').fill('0.75');
  await expect(page.locator('#preference-value')).toHaveText('30°');
  await expect(page.locator('#brush-control')).toBeHidden();
  await page.getByTitle('Paint nutrients (F)').click();
  await expect(page.locator('#brush-control')).toBeVisible();
  await page.getByRole('slider', { name: 'Radius' }).fill('5');
  await expect(page.locator('#brush-value')).toHaveText('5 cells');
  let at = await coordinate(page, 100, 80);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 20, at.y + 10, { steps: 5 });
  await page.mouse.up();
  await page.getByTitle('Paint walls (W)').click();
  await page.mouse.click(at.x, at.y);
  await page.getByTitle('Erase life and terrain (E)').click();
  await page.mouse.click(at.x, at.y);
  await page.getByTitle('Zoom in', { exact: true }).click();
  await page.getByTitle('Pan world (H)').click();
  await expect(page.locator('#brush-control')).toBeHidden();
  await expect(page.locator('#tool-hint')).toContainText('Drag');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 30, at.y + 30);
  await page.mouse.up();
  await page.getByTitle('Fit world', { exact: true }).click();
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByText('World settings', { exact: true }).click();
  await page.locator('#mutation').fill('0.25');
  await page.locator('#nutrients').fill('10');
  await page.locator('#seed').fill('123');
  await page.getByRole('button', { name: 'Reseed world' }).click();
  await expect(page.locator('#world-label')).toHaveText('WORLD 0123');
  await page.locator('#file').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":1}'),
  });
  await expect(page.locator('#notice')).toContainText('version 2');
  await page.getByTitle('How this world works').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close help' }).click();
  await page.locator('#world').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.keyboard.press('f');
  await expect(page.locator('button[data-tool="food"]')).toHaveAttribute('aria-pressed', 'true');
  if (test.info().project.name === 'desktop') {
    await page.setViewportSize({ width: 780, height: 768 });
    expect(
      await page
        .locator('.tool-dock button')
        .evaluateAll((buttons) => buttons.every((b) => b.scrollWidth <= b.clientWidth)),
    ).toBe(true);
  }
});
