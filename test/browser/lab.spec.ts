import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  positions,
  Random,
  type WorldFile,
  type Genome,
  type CellType,
  type Frame,
  type LegacyWorldFile,
} from '../../src/model';
import { parseBlueprint, serializeBlueprint, BLUEPRINT_MAX_BYTES } from '../../src/blueprint';
import { Ecosystem } from '../../src/ecosystem';

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

async function requestPause(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Ⅱ Pause', exact: true }).click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(page.getByTitle('Advance one tick while paused')).toBeEnabled();
}
async function pause(page: import('@playwright/test').Page): Promise<Buffer> {
  await requestPause(page);
  return downloadPausedWorld(page);
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
async function downloadPausedWorld(page: import('@playwright/test').Page): Promise<Buffer> {
  const bytes = await downloadWorld(page),
    world = JSON.parse(bytes.toString()) as WorldFile;
  await expect(page.locator('#tick')).toHaveText(`TICK ${world.tick.toLocaleString()}`);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(page.getByTitle('Advance one tick while paused')).toBeEnabled();
  await test.info().attach('pause-completion.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      savedTick: world.tick,
      displayedTick: await page.locator('#tick').textContent(),
      worldBytes: bytes.length,
    }),
  });
  return bytes;
}

async function downloadBlueprint(
  page: import('@playwright/test').Page,
  selector = '#export-blueprint',
) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('evolab-blueprint.json');
  const stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  return { bytes, file: parseBlueprint(bytes.toString('utf8')) };
}

const sharedGenome = (): Genome => ({
  cells: [3, 4, 5, 6, 7, 8].map((type, offset) => ({
    x: (offset % 3) - 1,
    y: Math.floor(offset / 3),
    type: type as CellType,
  })),
  preference: 0.1234567890123456,
  tolerance: 0.4567890123456789,
  tempo: 11,
});

test('standalone inspector and designer downloads round-trip full traits before explicit paused placement', async ({
  page,
}, testInfo) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/') && !request.url().startsWith('blob:'))
      external.push(request.url());
  });
  await page.goto('/');
  const beforeBytes = await pause(page),
    before = JSON.parse(beforeBytes.toString()) as WorldFile;
  const selected = before.organisms[0];
  await page.getByTitle('Inspect organism (I)').click();
  const at = await coordinate(page, selected.x, selected.y);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#inspector')).toContainText(`Organism ${selected.id}`);
  const inspector = await downloadBlueprint(page, '#export-organism-blueprint');
  expect(inspector.file.genome).toEqual(selected.genome);
  expect(Object.keys(inspector.file).sort()).toEqual([
    'description',
    'format',
    'genome',
    'name',
    'version',
  ]);
  expect(Object.keys(inspector.file.genome).sort()).toEqual([
    'cells',
    'preference',
    'tempo',
    'tolerance',
  ]);
  expect(inspector.file).toMatchObject({
    format: 'evolab-organism-blueprint',
    version: 1,
    description: '',
  });
  await page.locator('#blueprint-file').setInputFiles({
    name: 'inspected.json',
    mimeType: 'application/json',
    buffer: inspector.bytes,
  });
  await expect(page.locator('#notice')).toContainText('loaded into the designer');
  const name = '../<img onerror=alert(1)> 🌿',
    description = '<script>literal only</script>\n' + 'd'.repeat(970);
  await page.getByLabel('Blueprint name', { exact: true }).fill(name);
  await page.getByLabel('Description', { exact: true }).fill(description);
  const customized = await downloadBlueprint(page);
  expect(customized.file).toMatchObject({ name, description, genome: selected.genome });
  await page
    .locator('#blueprint-file')
    .setInputFiles({ name: 'renamed.json', mimeType: 'text/plain', buffer: customized.bytes });
  await expect(page.getByLabel('Blueprint name', { exact: true })).toHaveValue(name);
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue(description);
  const genome = sharedGenome(),
    payload = { name, description, genome };
  const file = {
    name: 'complete.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeBlueprint(payload)),
  };
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.locator('#blueprint-file').setInputFiles(file);
    await expect(page.locator('#notice')).toContainText('loaded into the designer');
    expect((await downloadBlueprint(page)).file).toMatchObject(payload);
    await expect(page.locator('#blueprint-file')).toHaveValue('');
  }
  expect(await page.locator('img, script:not([src]), [onerror]').count()).toBe(0);
  await expect(page.locator('#world')).toHaveAttribute('data-tool', 'pan');
  await expect(page.locator('#specimen-details')).not.toHaveAttribute('open');
  await page.getByLabel('Blueprint name', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('blueprint-designer.png'), fullPage: true });
  expect(await downloadWorld(page)).toEqual(beforeBytes);
  const occupied = new Set(before.organisms.flatMap((organism) => positions(organism)));
  const walls = new Set(before.walls);
  let location: { x: number; y: number } | undefined;
  for (let y = 5; y < HEIGHT - 5 && !location; y++)
    for (let x = 5; x < WIDTH - 5 && !location; x++)
      if (
        positions({ genome, x, y, rotation: 0 }).every(
          (position) => !occupied.has(position) && !walls.has(position),
        )
      )
        location = { x, y };
  expect(location).toBeDefined();
  let target = await coordinate(page, location!.x, location!.y);
  await page.mouse.click(target.x, target.y);
  expect(await downloadWorld(page)).toEqual(beforeBytes);
  await page.locator('#plant-design').click();
  await expect(page.locator('#world')).toBeInViewport();
  target = await coordinate(page, location!.x, location!.y);
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('#population')).toHaveText(String(before.organisms.length + 1));
  const after = JSON.parse((await downloadWorld(page)).toString()) as WorldFile;
  const planted = after.organisms.find((organism) => organism.id === before.nextId)!;
  const direction = new Random(before.random).int(4);
  expect(planted).toEqual({
    id: before.nextId,
    species: before.nextSpecies,
    ...location!,
    rotation: 0,
    direction,
    age: 0,
    energy: 14,
    generation: 0,
    children: 0,
    ancestry: [],
    genome,
  });
  expect(after.tick).toBe(before.tick);
  await page.getByTitle('Inspect organism (I)').click();
  target = await coordinate(page, location!.x - 1, location!.y);
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('#inspector')).toContainText(`Organism ${planted.id}`);
  expect((await downloadBlueprint(page, '#export-organism-blueprint')).file.genome).toEqual(genome);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.getByTitle('Advance one tick while paused').click();
  const stepped = JSON.parse((await downloadWorld(page)).toString()) as WorldFile;
  expect(stepped.tick).toBe(before.tick + 1);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await testInfo.attach('blueprint-acceptance.json', {
    contentType: 'application/json',
    body: JSON.stringify(
      {
        project: testInfo.project.name,
        beforeTick: before.tick,
        afterPlacementTick: after.tick,
        afterStepTick: stepped.tick,
        beforePopulation: before.organisms.length,
        afterPlacementPopulation: after.organisms.length,
        freshId: planted.id,
        freshLineage: planted.species,
        functionalTypes: planted.genome.cells.map((cell) => cell.type),
        preference: planted.genome.preference,
        tolerance: planted.genome.tolerance,
        tempo: planted.genome.tempo,
        pausedWorldBytesUnchangedBeforeExplicitPlacement: true,
        inspectorAndDesignerDownloadRoundTripsExact: true,
        consoleErrors: errors,
        externalRequests: external,
      },
      null,
      2,
    ),
  });
});

test.describe('blueprint file rejection and cancellation', () => {
  const payload = {
    name: 'Saved draft',
    description: 'Keep this\nexact description',
    genome: sharedGenome(),
  };
  const valid = serializeBlueprint(payload),
    parsed = JSON.parse(valid);
  const malformed = [
    {
      name: 'invalid JSON',
      text: '{broken',
      notice: 'Could not parse this blueprint. Choose a valid JSON file.',
    },
    {
      name: 'unsupported version',
      text: JSON.stringify({ ...parsed, version: 99 }),
      notice: 'Unsupported blueprint version. Expected version 1.',
    },
    {
      name: 'disconnected cells',
      text: JSON.stringify({
        ...parsed,
        genome: {
          ...parsed.genome,
          cells: [
            { x: 0, y: 0, type: 3 },
            { x: 2, y: 0, type: 4 },
          ],
        },
      }),
      notice: 'Blueprint needs 1–16 connected cells and valid temperature and tempo traits.',
    },
    {
      name: 'duplicate cells',
      text: JSON.stringify({
        ...parsed,
        genome: {
          ...parsed.genome,
          cells: [
            { x: 0, y: 0, type: 3 },
            { x: 0, y: 0, type: 4 },
          ],
        },
      }),
      notice: 'Blueprint needs 1–16 connected cells and valid temperature and tempo traits.',
    },
    {
      name: 'invalid temperature trait',
      text: JSON.stringify({ ...parsed, genome: { ...parsed.genome, preference: 2 } }),
      notice: 'Blueprint needs 1–16 connected cells and valid temperature and tempo traits.',
    },
    {
      name: 'unknown root key',
      text: JSON.stringify({ ...parsed, id: 27 }),
      notice: 'Choose a standalone EvoLab organism blueprint.',
    },
    {
      name: 'byte oversize',
      text: ' '.repeat(BLUEPRINT_MAX_BYTES + 1),
      notice: 'Blueprint files must be 16 KiB or smaller.',
    },
    {
      name: 'multibyte oversize',
      text: '🌿'.repeat(4500),
      notice: 'Blueprint files must be 16 KiB or smaller.',
    },
  ];

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await requestPause(page);
    await page.locator('#blueprint-file').setInputFiles({
      name: 'draft.json',
      mimeType: 'application/json',
      buffer: Buffer.from(valid),
    });
    await expect(page.locator('#notice')).toHaveText(
      'Blueprint loaded into the designer. Place it explicitly to add an organism.',
    );
    await expect(page.locator('#blueprint-file')).toHaveValue('');
    await page.locator('#plant-design').click();
    await expect(page.locator('#notice')).toHaveText('Click in the world to place your organism.');
    await expect(page.locator('#world')).toHaveAttribute('data-tool', 'plant');
  });

  async function expectRetainedDesign(page: import('@playwright/test').Page) {
    await expect(page.getByLabel('Blueprint name', { exact: true })).toHaveValue(payload.name);
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue(payload.description);
    await expect(page.locator('#world')).toHaveAttribute('data-tool', 'plant');
    expect((await downloadBlueprint(page)).file).toEqual({
      format: 'evolab-organism-blueprint',
      version: 1,
      ...payload,
    });
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
  }

  for (const fixture of malformed) {
    test(`${fixture.name} preserves paused world and current designer`, async ({
      page,
    }, testInfo) => {
      const downloads: string[] = [];
      page.on('download', (download) => downloads.push(download.suggestedFilename()));
      const before = await downloadPausedWorld(page);
      await expect(page.locator('#notice')).toHaveText(
        'World saved, including every organism and its ancestry.',
      );
      const started = performance.now();
      await page.locator('#blueprint-file').setInputFiles({
        name: 'bad.json',
        mimeType: 'application/json',
        buffer: Buffer.from(fixture.text),
      });
      await expect(page.locator('#notice')).toHaveText(fixture.notice);
      await expect(page.locator('#blueprint-file')).toHaveValue('');
      const settled = {
        notice: await page.locator('#notice').textContent(),
        inputValue: await page.locator('#blueprint-file').inputValue(),
        elapsedMs: performance.now() - started,
      };
      await expectRetainedDesign(page);
      const after = await downloadWorld(page);
      expect(after).toEqual(before);
      expect(downloads).toHaveLength(3);
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
      await testInfo.attach('blueprint-rejection.json', {
        contentType: 'application/json',
        body: JSON.stringify({
          fixture: fixture.name,
          downloads,
          inputBytes: Buffer.byteLength(fixture.text),
          settledBeforeExportAndSave: settled,
          worldBytes: { before: before.length, after: after.length },
          worldSha256: {
            before: createHash('sha256').update(before).digest('hex'),
            after: createHash('sha256').update(after).digest('hex'),
          },
          worldBytesEqual: after.equals(before),
          designer: payload,
        }),
      });
    });
  }

  test('cancelled selection preserves settled notice, paused world and current designer', async ({
    page,
  }, testInfo) => {
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    const before = await downloadPausedWorld(page),
      notice = 'World saved, including every organism and its ancestry.';
    await expect(page.locator('#notice')).toHaveText(notice);
    await expect(page.locator('#blueprint-file')).toHaveValue('');
    await page.locator('#blueprint-file').setInputFiles([]);
    await expect(page.locator('#notice')).toHaveText(notice);
    await expect(page.locator('#blueprint-file')).toHaveValue('');
    await expectRetainedDesign(page);
    const after = await downloadWorld(page);
    expect(after).toEqual(before);
    expect(downloads).toHaveLength(3);
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    await testInfo.attach('blueprint-cancellation.json', {
      contentType: 'application/json',
      body: JSON.stringify({
        settledNotice: notice,
        downloads,
        inputValue: await page.locator('#blueprint-file').inputValue(),
        worldBytes: { before: before.length, after: after.length },
        worldSha256: {
          before: createHash('sha256').update(before).digest('hex'),
          after: createHash('sha256').update(after).digest('hex'),
        },
        worldBytesEqual: after.equals(before),
        designer: payload,
      }),
    });
  });
});

test('blueprint labels, keyboard focus and multiline fields fit intermediate and narrow layouts', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const before = await pause(page);
  const name = 'n'.repeat(80),
    description = 'Description line\n'.repeat(50);
  await page.getByLabel('Blueprint name', { exact: true }).fill(name);
  await page.getByLabel('Description', { exact: true }).fill(description);
  for (const width of [780, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const selector of [
      '#blueprint-name',
      '#blueprint-description',
      '#import-blueprint',
      '#export-blueprint',
      '#plant-design',
    ]) {
      const element = page.locator(selector);
      await element.scrollIntoViewIfNeeded();
      const bounds = await element.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    const layout = await page.locator('.designer-section').evaluate((section) => ({
      contentWidth: section.scrollWidth,
      availableWidth: section.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    }));
    expect(layout.contentWidth).toBeLessThanOrEqual(layout.availableWidth);
    await testInfo.attach(`blueprint-layout-${width}.json`, {
      contentType: 'application/json',
      body: JSON.stringify(layout, null, 2),
    });
    await page.getByLabel('Blueprint name', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Description', { exact: true })).toBeFocused();
    await expect(page.getByLabel('Description', { exact: true })).toHaveCSS(
      'outline-style',
      'solid',
    );
    await page.keyboard.press('Tab');
    await expect(page.locator('#import-blueprint')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#export-blueprint')).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`blueprint-layout-${width}.png`),
      fullPage: true,
    });
  }
  expect((await downloadBlueprint(page)).file).toMatchObject({ name, description });
  expect(await downloadWorld(page)).toEqual(before);
});

test('blueprint imports retain telemetry until explicit placement and preserve save/load continuation', async ({
  page,
}, testInfo) => {
  await observeTelemetry(page);
  const initial = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false),
    stationary = {
      cells: [{ x: 0, y: 0, type: 7 as const }],
      preference: 0.5,
      tolerance: 0.12,
      tempo: 2,
    };
  initial.spawn(stationary, 20, 20);
  initial.spawn(stationary, 40, 40);
  for (let tick = 0; tick < 65; tick++) initial.step();
  initial.paint('erase', 20, 20, 0, stationary);
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await importWorld(page, initial.save());
  const beforeBytes = await downloadPausedWorld(page),
    before = JSON.parse(beforeBytes.toString()) as WorldFile,
    reference = Ecosystem.load(beforeBytes.toString()),
    payload = {
      name: 'Telemetry-safe blueprint',
      description: 'Designer only',
      genome: sharedGenome(),
    },
    points = await page.evaluate(() => window.telemetryEvidence.points);
  expect(before.telemetry.samples.map((sample) => sample.tick)).toEqual([30, 60]);
  expect(before.telemetry.pending.deaths.manual).toBe(1);
  expect(before.telemetry.pending.energy.upkeepSpent).toBeGreaterThan(0);
  await page.locator('#blueprint-file').setInputFiles({
    name: 'retained.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeBlueprint(payload)),
  });
  await expect(page.locator('#notice')).toHaveText(
    'Blueprint loaded into the designer. Place it explicitly to add an organism.',
  );
  await expect(page.locator('#blueprint-file')).toHaveValue('');
  expect((await telemetryFrame(page)).telemetry).toEqual(before.telemetry);
  await page.locator('#blueprint-file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{broken'),
  });
  await expect(page.locator('#notice')).toHaveText(
    'Could not parse this blueprint. Choose a valid JSON file.',
  );
  await expect(page.locator('#blueprint-file')).toHaveValue('');
  expect((await telemetryFrame(page)).telemetry).toEqual(before.telemetry);
  await page.locator('#blueprint-file').setInputFiles([]);
  await expect(page.locator('#blueprint-file')).toHaveValue('');
  expect((await telemetryFrame(page)).telemetry).toEqual(before.telemetry);
  expect(await page.evaluate(() => window.telemetryEvidence.points)).toEqual(points);
  expect((await downloadBlueprint(page)).file).toMatchObject(payload);
  expect(await downloadWorld(page)).toEqual(beforeBytes);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#plant-design').click();
  const target = await coordinate(page, 80, 80);
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('#population')).toHaveText(String(before.organisms.length + 1));
  reference.paint('plant', 80, 80, 0, payload.genome);
  const placed = JSON.parse((await downloadWorld(page)).toString()) as WorldFile;
  expect(placed).toEqual(reference.save());
  expect(placed.telemetry).toEqual(before.telemetry);
  expect(placed.tick).toBe(before.tick);
  expect(placed.births).toBe(before.births);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const boundary = Math.ceil((before.tick + 1) / 30) * 30;
  await stepTo(page, boundary);
  for (let tick = before.tick; tick < boundary; tick++) reference.step();
  const continued = JSON.parse((await downloadWorld(page)).toString()) as WorldFile;
  expect(continued).toEqual(reference.save());
  expect(continued.telemetry.samples.at(-1)!.tick).toBe(boundary);
  await importWorld(page, continued);
  const restored = JSON.parse((await downloadWorld(page)).toString()) as WorldFile;
  for (let tick = boundary; tick < restored.tick; tick++) reference.step();
  expect(restored).toEqual(reference.save());
  await stepTo(page, restored.tick + 1);
  reference.step();
  expect((await telemetryFrame(page)).telemetry).toEqual(reference.save().telemetry);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await testInfo.attach('blueprint-telemetry-integration.json', {
    contentType: 'application/json',
    body: JSON.stringify({ before, placed, continued, restored, exactStepTick: restored.tick + 1 }),
  });
});

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
  const saved = await pause(page),
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
  const saved = await pause(page);
  await expect(page.locator('#population')).toHaveText('1');
  await expect(page.locator('#births')).toHaveText('0');
  await expect(page.locator('#generation')).toHaveText('GEN 0');
  const world = JSON.parse(saved.toString()) as WorldFile,
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
}, testInfo) => {
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
  const pausedWorld = JSON.parse((await pause(page)).toString()) as WorldFile,
    tick = await page.locator('#tick').textContent();
  await page.waitForTimeout(200);
  await expect(page.locator('#tick')).toHaveText(tick!);
  const observedTick = await page.locator('#tick').textContent();
  await page.getByTitle('Advance one tick while paused').click();
  await expect(page.locator('#tick')).toHaveText(`TICK ${(pausedWorld.tick + 1).toLocaleString()}`);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await testInfo.attach('pause-stability-and-step.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      savedTick: pausedWorld.tick,
      displayedTick: tick,
      afterObservation: observedTick,
      afterStep: await page.locator('#tick').textContent(),
    }),
  });
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
