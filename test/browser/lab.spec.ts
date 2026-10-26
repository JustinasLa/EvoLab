import { test, expect } from '@playwright/test';
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
      construct(target, args: ConstructorParameters<typeof Worker>) {
        const worker = new target(...args);
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

async function importWorld(page: import('@playwright/test').Page, world: object): Promise<void> {
  await page.locator('#file').setInputFiles({
    name: 'telemetry-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
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
import { WIDTH, HEIGHT, type WorldFile } from '../../src/model';
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
  await importWorld(page, fixture);
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
  await importWorld(page, legacy);
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
  await importWorld(page, fixture);
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
