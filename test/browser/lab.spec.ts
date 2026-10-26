import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { WIDTH, HEIGHT, index, type WorldFile } from '../../src/model';
import { Ecosystem } from '../../src/ecosystem';
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
    await importWorld(page, { ...fixture, version: 99 } as unknown as WorldFile);
    await expect.poll(() => page.evaluate('window.recoveryDelivery.nutrients')).toBe(0);
    await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
    await page.getByText('World settings', { exact: true }).click();
    await page.locator('#nutrients').fill('3');
    await page.locator('#mutation').fill('0.37');
    await page.locator('#climate').fill('0.24');
    await page.locator('#nutrients').fill('7');
    const expected = {
      ...before,
      settings: { ...before.settings, nutrients: 7, mutation: 0.37, climate: 0.24 },
    };
    expect(await readWorld(page)).toEqual(expected);
    await page.evaluate('window.recoveryDelivery.release()');
    await expect(page.locator('#notice')).toContainText('version 2');
    await expect(page.locator('#nutrients')).toHaveValue('7');
    await expect(page.locator('#nutrients-value')).toHaveText('7%');
    await expect(page.locator('#mutation-value')).toHaveText('37%');
    await expect(page.locator('#climate-value')).toHaveText('24%');
    await expectPausedWorld(page, fixture.tick);
    await expect(page.locator('#extinction-summary')).toHaveText(summary!);
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
  expect(world.version).toBe(2);
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
