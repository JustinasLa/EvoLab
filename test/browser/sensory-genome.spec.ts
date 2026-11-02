import { expect, test, type Page, type TestInfo } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Ecosystem } from '../../src/ecosystem';
import {
  DEFAULTS,
  cloneGenome,
  founder,
  migrateHistoricalGenome,
  type Genome,
  type WorldFile,
} from '../../src/model';
import { parseBlueprint, serializeBlueprint } from '../../src/blueprint';
import {
  baselineFixtures,
  restoreHistoricalWorld,
  storedSensoryGenome,
} from '../fixtures/sensory-legacy';
import {
  attachWorld,
  nativeDownload,
  nativeSummary,
  registerNativeEvidence,
  assertNativeStreams,
} from './sensory-evidence';

registerNativeEvidence();

const advance = (world: Ecosystem, ticks: number) => {
  for (let tick = 0; tick < ticks; tick++) world.step();
};
const rawWorld = (bytes: Buffer): WorldFile => JSON.parse(bytes.toString('utf8'));

async function pauseReady(page: Page): Promise<void> {
  await expect(page.locator('#population')).not.toHaveText('—');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(page.locator('#save')).toBeEnabled();
}

async function importPaused(page: Page, text: string): Promise<number> {
  const previous = (await nativeSummary(page)).responses.length;
  await page.locator('#file').setInputFiles({
    name: 'sensory-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  const native = await nativeSummary(page),
    loaded = native.responses.slice(previous).find((response: any) => response.type === 'loaded');
  expect(loaded).toBeDefined();
  const posted = native.posts.find(
    (post: any) =>
      post.type === 'load' && post.runId === loaded.runId && post.requestId === loaded.requestId,
  );
  expect(posted).toBeDefined();
  if (JSON.parse(text).organisms.length) expect(loaded.paused).toBe(false);
  await pauseReady(page);
  // Display credits are independent of command receipts and suppressed offscreen.
  await page.locator('#world').scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      const native = await nativeSummary(page);
      const frame = native.responses.findLast(
        (response: any) => response.type === 'frame' && response.runId === loaded.runId,
      );
      const control = native.responses.findLast(
        (response: any) => response.runId === loaded.runId && response.paused === true,
      );
      return !!frame && !!control && frame.tick === control.tick;
    })
    .toBe(true);
  const paused = await nativeSummary(page),
    frames = paused.responses.filter(
      (response: any) => response.type === 'frame' && response.runId === loaded.runId,
    );
  expect(paused.firstFrames[loaded.runId].selected).toBeNull();
  expect(paused.pending).toEqual([]);
  return frames.at(-1).tick;
}

async function emptyHabitat(page: Page): Promise<Ecosystem> {
  const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0 }, false);
  await page.goto('/');
  await pauseReady(page);
  expect(await importPaused(page, JSON.stringify(reference.save()))).toBe(0);
  return reference;
}

async function importBlueprint(page: Page, text: string): Promise<void> {
  await page.getByRole('tab', { name: 'Organism', exact: true }).click();
  await page.locator('#blueprint-file').setInputFiles({
    name: 'sensory-blueprint.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.locator('#notice')).toContainText('Blueprint loaded into the designer');
}

async function atCell(page: Page, x: number, y: number): Promise<void> {
  await page.locator('#world').scrollIntoViewIfNeeded();
  const at = await page.locator('#world').evaluate(
    (canvas: HTMLCanvasElement, at) => {
      const rect = canvas.getBoundingClientRect(),
        scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
      return {
        x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (at.x + 0.5) * scale,
        y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (at.y + 0.5) * scale,
      };
    },
    { x, y },
  );
  await page.mouse.click(at.x, at.y);
}

async function plant(
  page: Page,
  reference: Ecosystem,
  genome: Genome,
  x = 50,
  y = 50,
): Promise<void> {
  await page.locator('#plant-design').click();
  await atCell(page, x, y);
  const outcome = reference.paint('plant', x, y, 0, genome);
  expect(outcome.placement).toBeDefined();
  reference.appendIntervention({ kind: 'placement', detail: outcome.placement! });
  await expect(page.locator('#population')).toHaveText(String(reference.organisms.size));
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}

async function inspect(page: Page, x: number, y: number, id: number): Promise<void> {
  await page.getByTitle('Inspect organism (I)').click();
  await atCell(page, x, y);
  await expect(page.locator('#inspector')).toContainText(`Organism ${id}`);
}

async function clean(page: Page, info: TestInfo, downloads: number): Promise<void> {
  assertNativeStreams(page, downloads);
  const native = await nativeSummary(page);
  expect(native.pending).toEqual([]);
  expect(native.activeUrls).toEqual([]);
  expect(native.overflow).toBe(false);
  const created = native.responses.filter((response: any) => response.type === 'saved').length;
  await info.attach('sensory-case-receipt.json', {
    body: JSON.stringify(
      { expectedNativeDownloads: downloads, savedWorldResponses: created, native },
      null,
      2,
    ),
    contentType: 'application/json',
  });
}

test('B1 genuine blueprint1 migrates passively through complete native exports and paused placement', async ({
  page,
}, info) => {
  const old = JSON.parse(baselineFixtures['blueprint1.json']);
  const deepText = baselineFixtures[`${info.project.name}-deepest-supported-world5.json`];
  const reference = Ecosystem.load(deepText);
  await attachWorld(info, 'B1-genuine-historical-input.json', JSON.parse(deepText));
  await page.goto('/');
  await pauseReady(page);
  const completed = await importPaused(page, deepText);
  advance(reference, completed - reference.tick);
  expect(rawWorld(await nativeDownload(page))).toEqual(reference.save());
  await attachWorld(info, 'B1-after-load-independent-reference.json', reference.save());
  await importBlueprint(page, baselineFixtures['blueprint1.json']);
  await expect(page.locator('#behavior-status')).toHaveText(
    'Legacy behavior — steering uses legacy rules.',
  );
  const blueprint = parseBlueprint(
    (await nativeDownload(page, '#export-blueprint')).toString('utf8'),
  );
  expect(blueprint).toEqual({
    ...old,
    version: 5,
    genome: { ...old.genome, behavior: { version: 1, mode: 'legacy' } },
  });
  await plant(page, reference, blueprint.genome, 220, 140);
  expect(rawWorld(await nativeDownload(page))).toEqual(reference.save());
  await attachWorld(info, 'B1-after-placement-independent-reference.json', reference.save());
  await page.locator('#step').click();
  reference.step();
  expect(rawWorld(await nativeDownload(page))).toEqual(reference.save());
  await attachWorld(info, 'B1-after-step-independent-reference.json', reference.save());
  await clean(page, info, 4);
});

test('B2 stored-evolved complete native designer lifecycle preserves opaque data and actual Load resumption', async ({
  page,
}, info) => {
  const reference = await emptyHabitat(page),
    genome = storedSensoryGenome();
  await attachWorld(info, 'B2-input-genome.json', genome);
  await attachWorld(info, 'B2-initial-independent-reference.json', reference.save());
  expect(rawWorld(await nativeDownload(page))).toEqual(reference.save());
  await importBlueprint(
    page,
    serializeBlueprint({ name: '  Stored λ🌱  ', description: '<script>inert</script>', genome }),
  );
  await page.locator('[data-cell="7"]').click();
  await page.locator('#editor [data-x="0"][data-y="0"]').click();
  await page.locator('#preference').fill('0.75');
  const edited = cloneGenome(genome);
  edited.cells[0].type = 7;
  edited.preference = 0.75;
  const exported = parseBlueprint(
    (await nativeDownload(page, '#export-blueprint')).toString('utf8'),
  );
  expect(exported.genome).toEqual(edited);
  expect(exported.name).toBe('  Stored λ🌱  ');
  await plant(page, reference, edited);
  const plantedBytes = await nativeDownload(page),
    planted = rawWorld(plantedBytes);
  expect(planted).toEqual(reference.save());
  await attachWorld(info, 'B2-after-placement-independent-reference.json', reference.save());
  expect(planted.births).toBe(0);
  expect(planted.interventions.entries.at(-1)?.kind).toBe('placement');
  await inspect(page, 50, 50, planted.organisms[0].id);
  await expect(page.locator('#inspector')).toContainText(
    'Stored reactions — inactive; steering uses legacy rules.',
  );
  await page.locator('#copy-organism').click();
  expect(
    parseBlueprint((await nativeDownload(page, '#export-blueprint')).toString('utf8')).genome,
  ).toEqual(edited);
  const continuation = Ecosystem.load(plantedBytes.toString('utf8'));
  const pausedTick = await importPaused(page, plantedBytes.toString('utf8'));
  advance(continuation, pausedTick - planted.tick);
  const after = rawWorld(await nativeDownload(page));
  expect(after).toEqual(continuation.save());
  await attachWorld(info, 'B2-independent-reference.json', continuation.save());
  await clean(page, info, 5);
});

test('B3 strict malformed blueprint2 never defaults a missing reaction or changes the designer/world', async ({
  page,
}, info) => {
  const reference = await emptyHabitat(page),
    valid = serializeBlueprint({
      name: 'Retain all',
      description: 'λ literal',
      genome: storedSensoryGenome(),
    });
  await importBlueprint(page, valid);
  const original = parseBlueprint(
    (await nativeDownload(page, '#export-blueprint')).toString('utf8'),
  );
  const before = await nativeDownload(page);
  expect(rawWorld(before)).toEqual(reference.save());
  const draft = await page.locator('#editor').innerHTML(),
    posts = (await nativeSummary(page)).posts.length;
  const malformed = JSON.parse(valid);
  delete malformed.genome.behavior.reactions.dangerous;
  await attachWorld(info, 'B3-valid-input.json', JSON.parse(valid));
  await attachWorld(info, 'B3-invalid-input.json', malformed);
  await attachWorld(info, 'B3-unchanged-independent-reference.json', reference.save());
  await page.locator('#blueprint-file').setInputFiles({
    name: 'incomplete-v2.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(page.locator('#notice')).toContainText('valid temperature and tempo traits');
  await expect(page.locator('#blueprint-name')).toHaveValue(original.name);
  await expect(page.locator('#blueprint-description')).toHaveValue(original.description);
  await expect(page.locator('#behavior-status')).toContainText('Stored reactions — inactive');
  expect(await page.locator('#editor').innerHTML()).toBe(draft);
  expect((await nativeSummary(page)).posts.length).toBe(posts);
  expect(await nativeDownload(page)).toEqual(before);
  await clean(page, info, 3);
});

test('B4 malformed last current genome rejects atomically with native selected retained-world recovery', async ({
  page,
}, info) => {
  const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0 }, false);
  reference.spawn(storedSensoryGenome(), 40, 40)!.energy = 100;
  reference.spawn(founder(0), 90, 90)!.energy = 100;
  const initial = JSON.stringify(reference.save());
  await page.goto('/');
  await pauseReady(page);
  const completed = await importPaused(page, initial);
  advance(reference, completed);
  const before = await nativeDownload(page),
    saved = rawWorld(before),
    selected = saved.organisms[0];
  expect(saved).toEqual(reference.save());
  await inspect(page, selected.x, selected.y, selected.id);
  const malformed = structuredClone(saved);
  malformed.organisms.at(-1)!.genome.behavior = {
    version: 1,
    mode: 'evolved',
    reactions: { food: 'ignore', wall: 'ignore', harmless: 'ignore', dangerous: 'CHASE' as never },
  };
  const responses = (await nativeSummary(page)).responses.length;
  await page.locator('#file').setInputFiles({
    name: 'malformed-current.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(page.locator('#notice')).toContainText('organism');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await expect(page.locator('#inspector')).toContainText(`Organism ${selected.id}`);
  const native = await nativeSummary(page),
    response = native.responses.slice(responses).find((entry: any) => entry.type === 'error');
  expect(response).toMatchObject({ operation: 'load', paused: true });
  expect(native.responses.slice(responses).some((entry: any) => entry.type === 'loaded')).toBe(
    false,
  );
  expect(await nativeDownload(page)).toEqual(before);
  expect(
    parseBlueprint((await nativeDownload(page, '#export-organism-blueprint')).toString('utf8'))
      .genome,
  ).toEqual(selected.genome);
  await attachWorld(info, 'B4-independent-retained-reference.json', reference.save());
  await clean(page, info, 3);
});

test('B5 real populated native Load/Pause/Step matches complete independent continuations at 1,4,12×', async ({
  page,
}, info) => {
  const oldInitial = JSON.parse(baselineFixtures['native-B5-baseline-initial.json']);
  const setup = Ecosystem.load(JSON.stringify(oldInitial));
  for (const [offset, source] of oldInitial.organisms.entries()) {
    const genome = migrateHistoricalGenome(source.genome);
    if (offset === 1)
      genome.behavior = {
        version: 1,
        mode: 'evolved',
        reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
      };
    if (offset === 2)
      genome.behavior = {
        version: 1,
        mode: 'evolved',
        reactions: { food: 'flee', wall: 'ignore', harmless: 'chase', dangerous: 'ignore' },
      };
    setup.organisms.get(source.id)!.genome = genome;
  }
  assert.deepStrictEqual(restoreHistoricalWorld(setup.save()), oldInitial);
  advance(setup, 90);
  assert.deepStrictEqual(
    restoreHistoricalWorld(setup.save()),
    JSON.parse(baselineFixtures['native-B5-baseline-tick90.json']),
  );
  expect(setup.births).toBe(17);
  expect(setup.organisms.size).toBe(20);
  const fixture = JSON.stringify(setup.save()),
    digest = createHash('sha256').update(fixture).digest('hex');
  await attachWorld(info, 'B5-F-before-app.json', setup.save());
  await page.goto('/');
  await pauseReady(page);
  const rounds: object[] = [];
  for (const speed of [1, 4, 12]) {
    const reference = Ecosystem.load(fixture);
    await page.locator('#speed').selectOption(String(speed));
    const before = await nativeSummary(page),
      pausedTick = await importPaused(page, fixture);
    expect(pausedTick).toBeGreaterThanOrEqual(90);
    expect((pausedTick - 90) % speed).toBe(0);
    let native = await nativeSummary(page);
    const loaded = native.responses
      .slice(before.responses.length)
      .find((entry: any) => entry.type === 'loaded');
    expect(loaded).toMatchObject({ tick: 90, paused: false });
    expect(native.firstFrames[loaded.runId].selected).toBeNull();
    expect(native.firstFrames[loaded.runId].tick).toBeGreaterThanOrEqual(90);
    expect(native.firstFrames[loaded.runId].tick).toBeLessThanOrEqual(pausedTick);
    const acknowledgement = native.responses
      .slice(before.responses.length)
      .findLast(
        (entry: any) =>
          entry.type === 'control' && entry.operation === 'pause' && entry.paused === true,
      );
    expect(acknowledgement).toBeDefined();
    const prior = native.responses
      .filter((entry: any) => entry.runId === loaded.runId && entry.type === 'frame')
      .at(-1);
    expect(acknowledgement.tick).toBe(pausedTick);
    expect(prior.tick).toBe(pausedTick);
    advance(reference, pausedTick - 90);
    const paused = rawWorld(await nativeDownload(page));
    expect(paused).toEqual(reference.save());
    await attachWorld(info, `B5-speed${speed}-P-independent-reference.json`, reference.save());
    const stepPosts = (await nativeSummary(page)).posts.filter(
      (post: any) => post.type === 'step',
    ).length;
    await page.locator('#step').click();
    await expect(page.locator('#tick')).toHaveText(
      `TICK ${(pausedTick + 1).toLocaleString('en-US')}`,
    );
    reference.step();
    const stepped = rawWorld(await nativeDownload(page));
    expect(stepped).toEqual(reference.save());
    await attachWorld(info, `B5-speed${speed}-Pplus1-independent-reference.json`, reference.save());
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    native = await nativeSummary(page);
    expect(native.posts.filter((post: any) => post.type === 'step')).toHaveLength(stepPosts + 1);
    expect(native.pending).toEqual([]);
    rounds.push({
      speed,
      fixtureSHA256: digest,
      loaded,
      acknowledgement,
      pausedTick,
      stepTick: stepped.tick,
      population: stepped.organisms.length,
      random: stepped.random,
    });
  }
  const native = await nativeSummary(page);
  expect(native.posts.filter((post: any) => post.type === 'load')).toHaveLength(3);
  expect(native.responses.filter((entry: any) => entry.type === 'saved')).toHaveLength(6);
  await attachWorld(info, 'B5-native-rounds.json', rounds);
  await clean(page, info, 6);
});

test('B6 read-only inactive disclosure fits four widths and observation/camera/keyboard preserve complete worlds', async ({
  page,
}, info) => {
  const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0 }, false),
    genome = storedSensoryGenome();
  reference.spawn(genome, 40, 40)!.energy = 100;
  const fixture = JSON.stringify(reference.save());
  await attachWorld(info, 'B6-input-world.json', JSON.parse(fixture));
  await page.goto('/');
  await pauseReady(page);
  const completed = await importPaused(page, fixture);
  advance(reference, completed);
  const before = await nativeDownload(page);
  expect(rawWorld(before)).toEqual(reference.save());
  await attachWorld(info, 'B6-independent-reference.json', reference.save());
  await importBlueprint(
    page,
    serializeBlueprint({ name: 'Read only λ', description: 'No steering activation', genome }),
  );
  await inspect(page, 40, 40, 1);
  const layouts: { width: number; innerWidth: number; scrollWidth: number; fits: boolean }[] = [];
  for (const width of [320, 390, 780, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('tab', { name: 'Organism', exact: true }).click();
    await expect(page.locator('#behavior-status')).toHaveText(
      'Stored reactions — inactive; steering uses legacy rules.',
    );
    await expect(page.locator('#inspector')).toContainText(
      'Stored reactions — inactive; steering uses legacy rules.',
    );
    await expect(page.locator('[data-reaction], #reaction-editor')).toHaveCount(0);
    await page.getByLabel('Blueprint name', { exact: true }).focus();
    await page.keyboard.press('i');
    await expect(page.getByLabel('Blueprint name', { exact: true })).toBeFocused();
    await expect(page.locator('#world')).toHaveAttribute('data-tool', 'inspect');
    await page.getByLabel('Blueprint name', { exact: true }).fill('Read only λ');
    await page.locator('#zoom-in').click();
    await page.locator('#zoom-out').click();
    await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
    await page.locator('#thermal').click();
    await page.locator('#thermal').click();
    await page.getByRole('tab', { name: 'Organism', exact: true }).click();
    expect(page.viewportSize()?.width).toBe(width);
    layouts.push(
      await page.evaluate((requestedWidth) => {
        const root = document.documentElement;
        const nodes = [...document.querySelectorAll<HTMLElement>('body *')];
        const overflowing = nodes
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return box.width > 0 && (box.left < -0.5 || box.right > requestedWidth + 0.5);
          })
          .map((node) => ({
            tag: node.tagName,
            id: node.id,
            left: node.getBoundingClientRect().left,
            right: node.getBoundingClientRect().right,
          }));
        return {
          requestedWidth,
          innerWidth,
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          visualWidth: visualViewport?.width,
          visualScale: visualViewport?.scale,
          deviceScaleFactor: devicePixelRatio,
          overflowing,
          fits:
            innerWidth === requestedWidth &&
            root.clientWidth === requestedWidth &&
            root.scrollWidth <= requestedWidth &&
            document.body.scrollWidth <= requestedWidth &&
            overflowing.length === 0,
        };
      }, width),
    );
    await page.screenshot({ path: info.outputPath(`B6-inactive-${width}.png`), fullPage: true });
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
  }
  expect(
    parseBlueprint((await nativeDownload(page, '#export-blueprint')).toString('utf8')).genome,
  ).toEqual(genome);
  expect(await nativeDownload(page)).toEqual(before);
  await clean(page, info, 3);
  await attachWorld(info, 'B6-complete-layout-evidence.json', layouts);
  expect(layouts.map((layout) => layout.fits)).toEqual([true, true, true, true]);
});

test('C1 active rays use the native worker with exact paused continuation at every speed', async ({
  page,
}, info) => {
  const setup = new Ecosystem(
    { ...DEFAULTS, seed: 42, nutrients: 0, mutation: 0, climate: 0 },
    false,
  );
  const source: Genome = {
    cells: [
      { x: 0, y: 0, type: 8 },
      { x: 1, y: 0, type: 5 },
      { x: 1, y: -1, type: 3 },
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
  const parent = setup.spawn(source, 60, 60)!;
  parent.age = 28;
  parent.energy = 17.95;
  parent.direction = 0;
  setup.food[58 * 240 + 60] = 1;
  const fixture = JSON.stringify(setup.save());
  await page.goto('/');
  await pauseReady(page);
  for (const speed of [1, 4, 12]) {
    await page.locator('#speed').selectOption(String(speed));
    const tick = await importPaused(page, fixture),
      reference = Ecosystem.load(fixture);
    advance(reference, tick);
    expect(rawWorld(await nativeDownload(page))).toEqual(reference.save());
    await page.locator('#step').click();
    await expect(page.locator('#tick')).toHaveText(`TICK ${(tick + 1).toLocaleString('en-US')}`);
    reference.step();
    expect(rawWorld(await nativeDownload(page))).toEqual(reference.save());
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    await attachWorld(info, `C1-active-speed${speed}.json`, reference.save());
  }
  await clean(page, info, 6);
});

test('C2 explicit active import/placement and complete failed-import recovery retain the native world', async ({
  page,
}, info) => {
  const reference = await emptyHabitat(page),
    source: Genome = {
      ...founder(1),
      cells: [
        { x: 0, y: 0, type: 8 },
        { x: 1, y: 0, type: 5 },
      ],
      behavior: {
        version: 2,
        mode: 'evolved',
        reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
      },
    };
  const active = serializeBlueprint({
    name: 'Active design',
    description: 'Explicit opt-in',
    genome: source,
  });
  await importBlueprint(page, active);
  await expect(page.locator('#behavior-status')).toContainText('Active reactions');
  expect(
    parseBlueprint((await nativeDownload(page, '#export-blueprint')).toString('utf8')).genome,
  ).toEqual(source);
  await plant(page, reference, source, 220, 140);
  const before = await nativeDownload(page);
  expect(rawWorld(before)).toEqual(reference.save());
  const old = JSON.parse(active);
  old.version = 2;
  await page.locator('#blueprint-file').setInputFiles({
    name: 'old-active.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(old)),
  });
  await expect(page.locator('#notice')).toContainText('Blueprint needs');
  await expect(page.locator('#behavior-status')).toContainText('Active reactions');
  const candidate = JSON.parse(before.toString('utf8'));
  candidate.lineageArchive.summaries.at(-1).foundingGenome.behavior.reactions.dangerous = 'attack';
  await page.locator('#file').setInputFiles({
    name: 'bad-active.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(candidate)),
  });
  await expect(page.locator('#notice')).toContainText('lineage archive');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  expect(await nativeDownload(page)).toEqual(before);
  await page.locator('#step').click();
  reference.step();
  await expect(page.locator('#tick')).toHaveText('TICK 1');
  expect(rawWorld(await nativeDownload(page))).toEqual(reference.save());
  await clean(page, info, 4);
});
