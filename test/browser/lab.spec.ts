import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  DEFAULTS,
  founder,
  WIDTH,
  HEIGHT,
  index,
  positions,
  Random,
  observedOrganism,
  encodeLegacyValue,
  type WorldFile,
  type Genome,
  type CellType,
  type Frame,
  type LegacyWorldFile,
  type ControlState,
  type AcceptedTelemetrySource,
} from '../../src/model';
import { parseBlueprint, serializeBlueprint, BLUEPRINT_MAX_BYTES } from '../../src/blueprint';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';
import { Ecosystem } from '../../src/ecosystem';
import {
  syntheticHistoricalWorld,
  restoreHistoricalWorld,
  restoreHistoricalGenome,
  inverseOpaque,
} from '../fixtures/sensory-legacy';
import { registerNativeEvidence } from './sensory-evidence';

registerNativeEvidence();
import {
  advance,
  legacyV3,
  legacyV4,
  legacyV5,
  legacyV6,
  legacyV7,
  legacyV8,
} from '../fixtures/telemetry';
import { fixtureText, acceptedReference, predecessor } from '../fixtures/refuges';
import { localTemperature, refugeSummary } from '../../src/refuges';
import { DEFAULT_TERRAIN, generateTerrain } from '../../src/terrain';
import { readFileSync } from 'node:fs';
import {
  admissionGenome,
  relationshipEviction,
  paginationEviction,
  contradictoryPruning,
  impossibleReadmission,
  omittedNewestAdmission,
  retainedAdjacentExtinction,
  sameTickLineages,
  falsePruningClaim,
  prunedCreationOrder,
  reversedPrunedParent,
  readmittedParentOrder,
  reversedReadmittedParent,
  relatedChildMembership,
  omittedRelatedChild,
  missingFinalExtinction,
  extinctionOccupancyContradiction,
} from '../fixtures/lineage';

declare global {
  interface Window {
    nativeLease: {
      posts: {
        stream: string;
        requestId: number;
        runId: number;
        at: number;
        monotonicMs: number;
      }[];
      dispatches: {
        stream: string;
        requestId: number;
        filename: string;
        at: number;
        monotonicMs: number;
      }[];
    };
    refugePixels: { tick: number; climate: number; offset: number; colors: number[][] } | null;
    terrainNative: {
      frame: Frame | null;
      frameRunId: number | null;
      frameRevision: number | null;
      stateRevision: number | null;
      selected: any;
      playback: any;
      lifecycle: {
        type: string;
        paused: boolean;
        runId: number;
        requestId: number;
        completedTick: number;
        postedSequence: number;
        receivedSequence: number;
        pausePostedSequence: number | null;
        pauseAcknowledgedSequence: number | null;
        pageStateBeforePause: string | null;
      }[];
      errors: any[];
      saved: number;
      manual: any | null;
      fullDesign: any | null;
      pauseOnLifecycle: boolean;
      fifoPauses: number;
    };
    publicationFault: {
      arm: () => Promise<void>;
      terminals: number;
      failures: number;
      visible: boolean | null;
      failureMessage: string | null;
      latest: object | null;
      pendingAtArm: number | null;
    };
    measurementReadGate: {
      blocked: boolean;
      ready: boolean;
      counts: { calls: number; active: number; maximum: number };
      release: () => void;
    };
    measurementGate: {
      processingBlocked: boolean;
      deliveryBlocked: boolean;
      holdLifecycle: boolean;
      framesBlocked: boolean;
      counts: {
        E: number;
        S: number;
        M: number;
        viewCommands: number;
        paintCommands: number;
        beginCommands: number;
        C: number;
        L: number;
        completedL: number;
        serializedE: number;
        serializedS: number;
        nativePosts: number;
        maximum: number;
        terminated: number;
      };
      pending: Map<number, object>;
      releasePosts: () => void;
      releaseResults: () => void;
      nextLifecycle: () => Promise<void>;
      waitForDrain: () => Promise<void>;
      releaseFrame: () => void;
      failEndpoint: () => void;
    };
    telemetryEvidence: {
      current: ControlState | null;
      source: AcceptedTelemetrySource | null;
      points: number[][];
      loadText: string | null;
    };
    telemetryPerformance: {
      enabled: boolean;
      action: string;
      records: {
        action: string;
        durationMs: number;
        callbackMs: number;
        nodes: number;
        view: string;
        sample: string;
      }[];
    };
  }
}

// Passive, bounded evidence for the 22 added executions. Native posting,
// anchor activation, driver download events and complete reads retain their
// ordinary implementation and clocks; no lease or scheduling timer is replaced.
const nativeLeaseRecords = new WeakMap<
  import('@playwright/test').Page,
  {
    requests: { stream: string; at: number }[];
    downloads: { filename: string; at: number }[];
    reads: { filename: string; bytes: number; sha256: string; at: number }[];
  }
>();
const leaseCase = (title: string) =>
  /^B23-/.test(title) ||
  /^native post-success (refuge-mode|paint-refuge|clear-refuges) /.test(title) ||
  title.includes('genuine world7 migration');
function leaseRequest(page: import('@playwright/test').Page, stream: string) {
  const records = nativeLeaseRecords.get(page);
  if (!records) return;
  if (records.requests.length === 32) throw new Error('Native lease request evidence exceeded32');
  records.requests.push({ stream, at: Date.now() });
}
async function leaseRead(page: import('@playwright/test').Page, filename: string, bytes: Buffer) {
  const records = nativeLeaseRecords.get(page);
  if (!records) return;
  if (records.reads.length === 32) throw new Error('Native complete-read evidence exceeded32');
  records.reads.push({
    filename,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    at: Date.now(),
  });
  await test.info().attach(`native-complete-read-${records.reads.length}-${filename}`, {
    body: bytes,
    contentType: filename.endsWith('.csv') ? 'text/csv' : 'application/json',
  });
}
test.beforeEach(async ({ page }, info) => {
  if (!leaseCase(info.title)) return;
  const records = { requests: [], downloads: [], reads: [] } as NonNullable<
    ReturnType<typeof nativeLeaseRecords.get>
  >;
  nativeLeaseRecords.set(page, records);
  page.on('download', (download) => {
    if (records.downloads.length === 32) throw new Error('Native download evidence exceeded32');
    records.downloads.push({ filename: download.suggestedFilename(), at: Date.now() });
  });
  await page.addInitScript(() => {
    const evidence = (window.nativeLease = { posts: [], dispatches: [] } as Window['nativeLease']);
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(post, worker, args) {
        const result = Reflect.apply(post, worker, args),
          command = args[0];
        if (command?.type === 'save' || command?.type === 'export-measurements') {
          if (evidence.posts.length === 32) throw new Error('Native post evidence exceeded32');
          evidence.posts.push({
            stream: command.type === 'save' ? 'save' : 'measurement',
            requestId: command.commandId,
            runId: command.runId,
            at: Date.now(),
            monotonicMs: performance.now(),
          });
        }
        return result;
      },
    });
    document.addEventListener(
      'click',
      (event) => {
        const link = event.target;
        if (!(link instanceof HTMLAnchorElement) || !link.href.startsWith('blob:')) return;
        const stream = link.download.startsWith('evolab-world-')
          ? 'save'
          : link.download.startsWith('evolab-measurements-')
            ? 'measurement'
            : null;
        if (!stream) return;
        if (evidence.dispatches.length === 32)
          throw new Error('Native dispatch evidence exceeded32');
        const posted = evidence.posts.findLast((entry) => entry.stream === stream);
        evidence.dispatches.push({
          stream,
          requestId: posted?.requestId ?? -1,
          filename: link.download,
          at: Date.now(),
          monotonicMs: performance.now(),
        });
      },
      true,
    );
  });
});
test.afterEach(async ({ page }, info) => {
  const records = nativeLeaseRecords.get(page);
  if (!records) return;
  const browser = await page.evaluate(() => window.nativeLease),
    intervals = ['save', 'measurement'].flatMap((stream) => {
      const dispatches = browser.dispatches.filter((entry) => entry.stream === stream);
      return dispatches.slice(1).map((entry, position) => ({
        stream,
        fromRequest: dispatches[position].requestId,
        toRequest: entry.requestId,
        milliseconds: entry.monotonicMs - dispatches[position].monotonicMs,
      }));
    });
  await info.attach('native-download-lease-times.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      browser,
      driver: records,
      intervals,
      naturalLeaseMilliseconds: 1000,
      qualification:
        'Observed real native posts, blob-link dispatches, driver downloads and complete stream reads. Independent-stream intervals can overlap other work; these are not additional serial idle waits.',
    }),
  });
  expect(browser.dispatches.length).toBe(records.downloads.length);
  expect(records.reads.length).toBe(records.downloads.length);
  expect(records.requests.length).toBe(records.reads.length);
  for (const entry of browser.dispatches) {
    expect(entry.requestId).toBeGreaterThan(0);
    expect(
      browser.posts.some(
        (posted) => posted.requestId === entry.requestId && posted.stream === entry.stream,
      ),
    ).toBe(true);
  }
  nativeLeaseRecords.delete(page);
});

async function observeTerrainNative(
  page: import('@playwright/test').Page,
  pauseAt: 'lifecycle-post' | 'lifecycle-receipt' = 'lifecycle-post',
): Promise<void> {
  await page.addInitScript((pauseAt) => {
    window.terrainNative = {
      frame: null,
      frameRunId: null,
      frameRevision: null,
      stateRevision: null,
      selected: null,
      playback: null,
      lifecycle: [],
      errors: [],
      saved: 0,
      manual: null,
      fullDesign: null,
      pauseOnLifecycle: true,
      fifoPauses: 0,
    };
    window.Worker = new Proxy(window.Worker, {
      construct(target, args, newTarget) {
        const worker: Worker = Reflect.construct(target, args, newTarget);
        let sequence = 0,
          pendingLifecycle: {
            operation: string;
            runId: number;
            requestId: number;
            postedSequence: number;
            received: boolean;
            pausePostedSequence: number | null;
          } | null = null,
          awaitingPause: Window['terrainNative']['lifecycle'][number] | null = null;
        worker.postMessage = new Proxy(worker.postMessage, {
          apply(post, receiver, messages) {
            const result = Reflect.apply(post, receiver, messages);
            if (messages[0].type === 'start' || messages[0].type === 'load') {
              pendingLifecycle = {
                operation: messages[0].type,
                runId: messages[0].runId,
                requestId: messages[0].commandId,
                postedSequence: ++sequence,
                received: false,
                pausePostedSequence: null,
              };
              awaitingPause = null;
            }
            return result;
          },
        });
        const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage')!;
        let handler: ((event: MessageEvent) => void) | null = null;
        Object.defineProperty(worker, 'onmessage', {
          get: () => handler,
          set(next: ((event: MessageEvent) => void) | null) {
            handler = next;
            descriptor.set!.call(worker, (event: MessageEvent) => {
              next?.(event);
              const data = event.data;
              const receipt = window.terrainNative.lifecycle.at(-1);
              if (
                pauseAt === 'lifecycle-post' &&
                window.terrainNative.pauseOnLifecycle &&
                data.operation === pendingLifecycle?.operation &&
                data.commandId === pendingLifecycle?.requestId &&
                receipt &&
                data.state &&
                !data.state.playback.paused
              ) {
                receipt.pausePostedSequence = ++sequence;
                awaitingPause = receipt;
                document.getElementById('pause')!.click();
                window.terrainNative.fifoPauses++;
              }
            });
          },
        });
        let source: any = null;
        worker.addEventListener('message', ({ data }) => {
          if (data.telemetry) source = data.telemetry;
          if (data.recovery?.telemetry) source = data.recovery.telemetry;
          const evidence = window.terrainNative;
          if (data.state) {
            evidence.stateRevision = data.state.revision;
            evidence.selected = data.state.selected;
            evidence.playback = data.state.playback;
          }
          if (evidence.frame && source) {
            evidence.frame.telemetry = source.telemetry;
            evidence.frame.interventions = source.interventions;
          }
          if (data.type === 'frame') {
            evidence.frame = {
              ...data.frame,
              telemetry: source?.telemetry,
              interventions: source?.interventions,
            };
            evidence.frameRunId = data.runId;
            evidence.frameRevision = data.state.revision;
            evidence.selected = data.state.selected;
            evidence.playback = data.state.playback;
          }
          if (data.type === 'control' && data.operation === 'pause') {
            evidence.playback = data.state.playback;
            if (awaitingPause?.runId === data.runId && data.state.playback.paused) {
              awaitingPause.pauseAcknowledgedSequence = ++sequence;
              awaitingPause = null;
            }
          }
          if (data.type === 'manual-result') evidence.manual = data;
          if (data.type === 'design-captured') evidence.fullDesign = data;
          if (data.type === 'saved') evidence.saved++;
          if (data.type === 'error') {
            evidence.errors.push(data);
            if (evidence.errors.length > 4) evidence.errors.shift();
          }
          const posted = pendingLifecycle;
          if (
            ((data.type === 'control' && data.operation === 'start') || data.type === 'loaded') &&
            posted &&
            !posted.received &&
            data.operation === posted.operation &&
            data.type === (posted.operation === 'start' ? 'control' : 'loaded') &&
            data.runId === posted.runId &&
            data.commandId === posted.requestId
          ) {
            posted.received = true;
            const receipt: Window['terrainNative']['lifecycle'][number] = {
              type: data.type,
              paused: data.state.playback.paused,
              runId: data.runId,
              requestId: data.commandId,
              completedTick: data.state.world.stats.tick,
              postedSequence: posted.postedSequence,
              receivedSequence: ++sequence,
              pausePostedSequence: posted.pausePostedSequence,
              pauseAcknowledgedSequence: null,
              pageStateBeforePause: null,
            };
            evidence.lifecycle.push(receipt);
            if (evidence.lifecycle.length > 4) evidence.lifecycle.shift();
            if (posted.pausePostedSequence !== null) awaitingPause = receipt;
            // Run after this genuine message finishes dispatching to the application.
            // This ordinary timer does not replace or shorten any Worker timer.
            setTimeout(() => {
              if (
                pauseAt !== 'lifecycle-receipt' ||
                pendingLifecycle !== posted ||
                !evidence.pauseOnLifecycle
              )
                return;
              receipt.pageStateBeforePause = document.getElementById('run-state')!.textContent;
              if (!evidence.playback?.paused) {
                receipt.pausePostedSequence = ++sequence;
                awaitingPause = receipt;
                document.getElementById('pause')!.click();
                evidence.fifoPauses++;
              }
            }, 0);
          }
        });
        return worker;
      },
    });
  }, pauseAt);
}

async function terrainNativeFrame(page: import('@playwright/test').Page, recoveryRun?: number) {
  await page.locator('#world').scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate((recoveryRun) => {
        const evidence = window.terrainNative,
          lifecycle = evidence.lifecycle.at(-1),
          acknowledged =
            recoveryRun === undefined
              ? lifecycle?.paused || typeof lifecycle?.pauseAcknowledgedSequence === 'number'
              : evidence.errors.some(
                  (error) =>
                    error.operation === 'load' &&
                    error.runId === recoveryRun &&
                    error.recovery?.state.playback.paused,
                );
        return (
          !!evidence.frame &&
          evidence.frameRunId === (recoveryRun ?? lifecycle?.runId) &&
          evidence.frameRevision === evidence.stateRevision &&
          acknowledged &&
          evidence.playback?.paused &&
          document.getElementById('run-state')?.textContent === 'PAUSED'
        );
      }, recoveryRun),
    )
    .toBe(true);
  return page.evaluate(() => {
    const evidence = window.terrainNative,
      frame = evidence.frame!;
    return {
      frame: {
        ...frame,
        cells: Array.from(frame.cells),
        ids: Array.from(frame.ids),
        thermalRefuges: { ...frame.thermalRefuges, units: Array.from(frame.thermalRefuges.units) },
      },
      selected: evidence.selected,
      playback: evidence.playback,
    };
  });
}

function expectReceiptDrivenTerrainPauses(lifecycle: Window['terrainNative']['lifecycle']) {
  expect(lifecycle.length).toBeGreaterThan(0);
  for (const receipt of lifecycle) {
    expect(receipt.requestId).toBeGreaterThan(0);
    expect(receipt.postedSequence).toBeLessThan(receipt.receivedSequence);
    if (receipt.paused) {
      expect(receipt.pausePostedSequence).toBeNull();
      continue;
    }
    expect(receipt.pausePostedSequence).not.toBeNull();
    expect(receipt.receivedSequence).toBeLessThan(receipt.pausePostedSequence!);
    expect(receipt.pauseAcknowledgedSequence).not.toBeNull();
    expect(receipt.pausePostedSequence!).toBeLessThan(receipt.pauseAcknowledgedSequence!);
    expect(receipt.pageStateBeforePause).toBe('LIVE');
  }
}

function terrainExpectedFrame(world: Ecosystem) {
  const frame = world.frame();
  return {
    ...frame,
    cells: Array.from(frame.cells),
    ids: Array.from(frame.ids),
    thermalRefuges: { ...frame.thermalRefuges, units: Array.from(frame.thermalRefuges.units) },
  };
}

async function terrainSave(
  page: import('@playwright/test').Page,
  name: string,
): Promise<WorldFile> {
  const bytes = await downloadPausedWorld(page);
  await test.info().attach(name, { body: bytes, contentType: 'application/json' });
  await test.info().attach(`${name}-manifest.json`, {
    body: JSON.stringify({
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
    contentType: 'application/json',
  });
  return JSON.parse(bytes.toString());
}

async function terrainSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.locator('.world-settings').evaluate((details: HTMLDetailsElement) => {
    details.open = true;
  });
}

for (const preset of ['open-field', 'porous-ridges', 'chambered-refuges'] as const) {
  test(`terrain reset ${preset} freezes confirmation and preserves real native continuation`, async ({
    page,
  }) => {
    await observeTerrainNative(page);
    await page.goto('/');
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    const baseline = new Ecosystem();
    expect((await terrainNativeFrame(page)).frame).toEqual(terrainExpectedFrame(baseline));
    await terrainSettings(page);
    await page.locator('#terrain-preset').selectOption(preset);
    await expect(page.locator('#terrain-preview-caption')).toContainText('terrain seed 42');
    expect((await terrainNativeFrame(page)).frame).toEqual(terrainExpectedFrame(baseline));
    await page.locator('#reset').click();
    await page.locator('#cancel-reset').click();
    expect((await terrainNativeFrame(page)).frame).toEqual(terrainExpectedFrame(baseline));
    await page.locator('#reset').click();
    await expect(page.locator('#cancel-reset')).toBeFocused();
    await page.locator('#confirm-reset').click();
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    const reference = new Ecosystem(DEFAULTS, true, {
      terrain: { version: 1, preset, seed: null },
    });
    const initial = await terrainSave(page, `${preset}-reset.json`);
    expect(initial).toEqual(reference.save());
    expect(initial.tick).toBe(0);
    expect(initial.organisms).toHaveLength(1);
    expect(initial.food).toEqual([]);
    expect(initial.organisms[0]).toMatchObject({
      x: 120,
      y: 78,
      age: 0,
      energy: 13,
      children: 0,
      generation: 0,
    });
    expect(initial.walls).toEqual(
      Array.from(generateTerrain(initial.terrain, 42)).flatMap((value, cell) =>
        value ? [cell] : [],
      ),
    );
    await page.locator('#step').click();
    reference.step();
    await expect(page.locator('#tick')).toHaveText('TICK 1');
    expect((await terrainNativeFrame(page)).frame).toEqual(terrainExpectedFrame(reference));
    expect(reference.save().telemetry.pending.energy.leavesGained).toBeGreaterThan(0);
    const stepped = await terrainSave(page, `${preset}-step.json`);
    expect(stepped).toEqual(reference.save());
    await importTelemetryWorld(page, stepped);
    const observedTick = (await terrainNativeFrame(page)).frame.stats.tick;
    while (reference.tick < observedTick) reference.step();
    expect(await terrainSave(page, `${preset}-reload.json`)).toEqual(reference.save());
    await page.locator('#step').click();
    reference.step();
    await expect(page.locator('#tick')).toHaveText(`TICK ${reference.tick}`);
    expect((await terrainNativeFrame(page)).frame).toEqual(terrainExpectedFrame(reference));
  });
}

test('terrain whole-world actions preserve wrapped life, food, selection, pins and truthful measurement metadata', async ({
  page,
}) => {
  await observeTerrainNative(page);
  const reference = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  const body: Genome = {
    cells: [
      { x: 0, y: 0, type: 7 },
      { x: 1, y: 0, type: 7 },
      { x: 0, y: 1, type: 7 },
    ],
    preference: 0.5,
    tolerance: 0.3,
    tempo: 2,
    behavior: { version: 1 as const, mode: 'legacy' as const },
  };
  reference.spawn(body, 0, 0, undefined, undefined, 2);
  const recipe = { version: 1 as const, preset: 'chambered-refuges' as const, seed: 42 };
  const candidate = generateTerrain(recipe, 42),
    protectedCell = candidate.findIndex((value) => !!value);
  reference.spawn(body, protectedCell % WIDTH, Math.floor(protectedCell / WIDTH));
  advance(reference, 59);
  for (let cell = 0; cell < reference.food.length; cell++)
    if (!reference.occupied[cell]) reference.food[cell] = 1;
  reference.walls[index(200, 100)] = 1;
  reference.food[index(200, 100)] = 0;
  await page.goto('/');
  await importTelemetryWorld(page, reference.save());
  expect(await terrainSave(page, 'terrain-edit-before.json')).toEqual(reference.save());
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const origin = await coordinate(page, 0, 0);
  await page.mouse.click(origin.x, origin.y);
  await expect.poll(() => page.evaluate(() => window.terrainNative.selected?.id)).toBe(1);
  await terrainSettings(page);
  await page.locator('#telemetry-sample').selectOption('30');
  await page.locator('#clear-walls').click();
  reference.changeTerrain('clear');
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.manual?.operation))
    .toBe('clear-walls');
  expect((await terrainNativeFrame(page)).frame).toEqual(terrainExpectedFrame(reference));
  await page.locator('#terrain-preset').selectOption('chambered-refuges');
  await page.locator('#terrain-follow').uncheck();
  await page.locator('#terrain-seed').fill('42');
  await page.locator('#regenerate-walls').click();
  const regenerated = reference.changeTerrain('regenerate', recipe);
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.manual?.operation))
    .toBe('regenerate-walls');
  expect(regenerated.detail.protectedCells).toBeGreaterThan(0);
  expect(await terrainSave(page, 'terrain-edit-regenerated.json')).toEqual(reference.save());
  expect((await terrainNativeFrame(page)).selected.id).toBe(1);
  await expect(page.locator('#telemetry-sample')).toHaveValue('30');
  await page.locator('#regenerate-walls').click();
  await expect(page.locator('#notice')).toContainText('unchanged');
  await page.locator('#terrain-preset').selectOption('open-field');
  await page.locator('#regenerate-walls').click();
  reference.changeTerrain('regenerate', { version: 1, preset: 'open-field', seed: 42 });
  await page.locator('#terrain-seed').fill('43');
  await page.locator('#regenerate-walls').click();
  const recipeOnly = reference.changeTerrain('regenerate', {
    version: 1,
    preset: 'open-field',
    seed: 43,
  });
  expect(recipeOnly.detail.addedWalls + recipeOnly.detail.removedWalls).toBe(0);
  expect(await terrainSave(page, 'terrain-edit-recipe-only.json')).toEqual(reference.save());
  await page.locator('#step').click();
  reference.step();
  await expect(page.locator('#tick')).toHaveText('TICK 60');
  expect(await terrainSave(page, 'terrain-edit-boundary.json')).toEqual(reference.save());
  const json = restoreMeasurementZeros(
    JSON.parse((await downloadMeasurements(page, 'json')).toString()),
  );
  const csv = decodeDownloadedCsv(await downloadMeasurements(page, 'csv'));
  expect(csv).toEqual(json);
  expect(json.version).toBe(3);
  expect(json.snapshot.terrain).toEqual(reference.terrain);
  expect(json.interventions).toEqual(reference.save().interventions);
});

test('terrain imports preserve explicit cells and newer drafts while stale native wall owners cannot cross reset', async ({
  page,
}) => {
  await observeMeasurementOwnership(page);
  await observeTerrainNative(page);
  await page.goto('/');
  const legacy = JSON.parse(readFileSync('test/fixtures/terrain/legacy5-opaque.json', 'utf8'));
  await importTelemetryWorld(page, legacy);
  await expect(page.locator('#notice')).toContainText('World restored');
  const explicit = new Ecosystem().save();
  explicit.terrain = { version: 1, preset: 'open-field', seed: 99 };
  explicit.walls = [index(5, 5)];
  explicit.food = [index(6, 6)];
  const reference = Ecosystem.load(JSON.stringify(explicit));
  await importTelemetryWorld(page, explicit);
  const tick = (await terrainNativeFrame(page)).frame.stats.tick;
  while (reference.tick < tick) reference.step();
  expect(await terrainSave(page, 'terrain-explicit-authority.json')).toEqual(reference.save());
  await terrainSettings(page);
  await page.locator('#terrain-preset').selectOption('chambered-refuges');
  await page.locator('#file').setInputFiles({
    name: 'invalid-terrain.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...explicit, terrain: { ...explicit.terrain, seed: -1 } }),
    ),
  });
  await expect(page.locator('#notice')).toContainText('Invalid ecosystem wall recipe');
  await expect(page.locator('#terrain-preset')).toHaveValue('chambered-refuges');
  expect(await terrainSave(page, 'terrain-rejected-preserved.json')).toEqual(reference.save());
  await page.evaluate(() => {
    window.measurementGate.deliveryBlocked = true;
  });
  await page.locator('#clear-walls').click();
  await expect.poll(() => page.evaluate(() => window.measurementGate.pending.size)).toBe(1);
  await page.locator('#reset').click();
  await page.locator('#confirm-reset').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const reset = new Ecosystem(DEFAULTS, true, {
    terrain: { version: 1, preset: 'chambered-refuges', seed: 99 },
  });
  await page.evaluate(() => window.measurementGate.releaseResults());
  expect(await terrainSave(page, 'terrain-stale-owner-reset.json')).toEqual(reset.save());
  await expect(page.locator('#terrain-committed')).toContainText('Chambered refuges');
  expect(await page.evaluate(() => window.measurementGate.pending.size)).toBe(0);
});

test('terrain controls and reset dialog remain keyboard-accessible without view-driven mutation at all declared widths', async ({
  page,
}, testInfo) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url());
  });
  await observeTerrainNative(page);
  await page.goto('/');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const before = await terrainSave(page, 'terrain-layout-before.json');
  await terrainSettings(page);
  for (const width of [320, 390, 760, 780, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#terrain-preset').focus();
    await page.keyboard.press('ArrowDown');
    await page.locator('#terrain-follow').focus();
    await page.keyboard.press('Space');
    if (!(await page.locator('#terrain-follow').isChecked())) {
      await page.locator('#terrain-seed').fill('0');
      await page.locator('#terrain-seed').focus();
      await expect(page.locator('#terrain-seed')).toBeFocused();
    }
    await page.locator('#reset').click();
    await expect(page.locator('#cancel-reset')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#confirm-reset')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#reset-dialog')).not.toBeVisible();
    await expect(page.locator('#reset')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator('#regenerate-walls').scrollIntoViewIfNeeded();
    await expect(page.locator('#regenerate-walls')).toBeInViewport();
    const layout = await page.evaluate(() => ({
      caption: document.getElementById('terrain-preview-caption')!.getBoundingClientRect().width,
      sidebar: document.querySelector('.sidebar')!.getBoundingClientRect().width,
      color: getComputedStyle(document.getElementById('terrain-preview-caption')!).color,
      habitat: document.querySelector('canvas#world')!.getBoundingClientRect().width,
    }));
    expect(layout.caption).toBeGreaterThan(0);
    expect(layout.sidebar).toBeGreaterThan(0);
    expect(layout.habitat).toBeGreaterThan(0);
    await testInfo.attach(`terrain-layout-${width}.json`, {
      body: JSON.stringify(layout),
      contentType: 'application/json',
    });
  }
  await page
    .locator('.terrain-controls')
    .screenshot({ path: testInfo.outputPath('terrain-controls.png') });
  await page.locator('#zoom-in').click();
  const center = await coordinate(page, 120, 78);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 10, center.y + 10);
  await page.mouse.up();
  expect(await terrainSave(page, 'terrain-layout-after.json')).toEqual(before);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('D22-R1-001 native genuine legacy extensions survive three actual saves, resumed loads and exact paused Step', async ({
  page,
}) => {
  await observeTerrainNative(page, 'lifecycle-receipt');
  await page.goto('/');
  const original = JSON.parse(readFileSync('test/fixtures/terrain/legacy5-opaque.json', 'utf8'));
  const reference = Ecosystem.load(JSON.stringify(original));
  await importTelemetryWorld(page, original);
  const first = await terrainSave(page, 'opaque-successor-save1.json');
  while (reference.tick < first.tick) reference.step();
  expect(first).toEqual(reference.save());
  expect(first.settings).toEqual(original.settings);
  expect((first.organisms[0] as any).retained).toEqual(original.organisms[0].retained);
  await importTelemetryWorld(page, first);
  const second = await terrainSave(page, 'opaque-successor-save2.json');
  while (reference.tick < second.tick) reference.step();
  expect(second).toEqual(reference.save());
  await page.locator('#step').click();
  reference.step();
  await expect(page.locator('#tick')).toHaveText(`TICK ${reference.tick}`);
  expect(await terrainSave(page, 'opaque-successor-save3.json')).toEqual(reference.save());
  const lifecycle = await page.evaluate(() => window.terrainNative.lifecycle);
  expectReceiptDrivenTerrainPauses(lifecycle);
  const loads = lifecycle.filter((entry) => entry.type === 'loaded');
  expect(loads).toHaveLength(2);
  expect(loads.every((entry) => !entry.paused)).toBe(true);
  expect(await page.evaluate(() => window.terrainNative.fifoPauses)).toBe(3);
  await test.info().attach('native-opaque-protocol.json', {
    body: JSON.stringify({
      lifecycle,
      loads,
      ordinaryFifoPauses: await page.evaluate(() => window.terrainNative.fifoPauses),
      protocol:
        'Each actual start/load is correlated by operation, requestId and runId to its genuine resumed lifecycle receipt. After that message finishes dispatching to the application, an ordinary Pause is posted on the same real Worker endpoint and its native acknowledgement is awaited before the checkpoint. References advance independently to the observed tick. No engine, timer, lifecycle terminal or file bytes are replaced.',
    }),
    contentType: 'application/json',
  });
});

test('D22-R1-001 native accepted-cap legacy migration fails outbound nonfatally with no download and exact retained selection/Step', async ({
  page,
}, testInfo) => {
  await observeMeasurementOwnership(page);
  await observeTerrainNative(page, 'lifecycle-receipt');
  await page.goto('/');
  const original = JSON.parse(readFileSync('test/fixtures/terrain/legacy5-opaque.json', 'utf8'));
  original.organisms[0].padding = '';
  original.organisms[0].padding = 'x'.repeat(2500000 - Buffer.byteLength(JSON.stringify(original)));
  const input = JSON.stringify(original),
    reference = Ecosystem.load(input);
  expect(Buffer.byteLength(input)).toBe(2500000);
  expect(Buffer.byteLength(JSON.stringify(reference.save()))).toBeGreaterThan(2500000);
  await importTelemetryWorld(page, original);
  const tick = (await terrainNativeFrame(page)).frame.stats.tick;
  while (reference.tick < tick) reference.step();
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const center = await coordinate(page, 120, 78);
  await page.mouse.click(center.x, center.y);
  await expect.poll(() => page.evaluate(() => window.terrainNative.selected?.id)).toBe(1);
  const before = await terrainNativeFrame(page),
    ownersBefore = await page.evaluate(() => [...window.measurementGate.pending]);
  expect(before.frame).toEqual(terrainExpectedFrame(reference));
  expect(before.selected).toEqual(observedOrganism(reference.save().organisms[0]));
  expect((await refugeFullGenome(page)).genome).toEqual(
    refugeGraph(reference.save().organisms[0].genome),
  );
  expect(ownersBefore).toEqual([]);
  let downloads = 0;
  page.on('download', () => downloads++);
  const savedBefore = await page.evaluate(() => window.terrainNative.saved);
  await page.locator('#save').click();
  await expect(page.locator('#notice')).toContainText('World file exceeds 2.5 MB');
  expect(await terrainNativeFrame(page)).toEqual(before);
  expect(await page.evaluate(() => [...window.measurementGate.pending])).toEqual(ownersBefore);
  expect(await page.evaluate(() => window.terrainNative.saved)).toBe(savedBefore);
  expect(downloads).toBe(0);
  const failure = await page.evaluate(() => window.terrainNative.errors.at(-1));
  expect(failure).toMatchObject({ operation: 'save' });
  expect(failure).not.toHaveProperty('fatal');
  await page.locator('#step').click();
  reference.step();
  await expect(page.locator('#tick')).toHaveText(`TICK ${reference.tick}`);
  const after = await terrainNativeFrame(page);
  expect(after.frame).toEqual(terrainExpectedFrame(reference));
  expect(after.selected).toEqual(observedOrganism(reference.save().organisms[0]));
  expect(after.playback.paused).toBe(true);
  expectReceiptDrivenTerrainPauses(await page.evaluate(() => window.terrainNative.lifecycle));
  await testInfo.attach('accepted-cap-native-state.json', {
    body: JSON.stringify({
      inputBytes: Buffer.byteLength(input),
      inputSHA256: createHash('sha256').update(input).digest('hex'),
      migratedBytes: Buffer.byteLength(JSON.stringify(Ecosystem.load(input).save())),
      before,
      after,
      failure,
      ownersBefore,
      successfulDownloads: downloads,
      lifecycle: await page.evaluate(() => window.terrainNative.lifecycle),
      ordinaryFifoPauses: await page.evaluate(() => window.terrainNative.fifoPauses),
      frameIsNotCompleteWorld: true,
    }),
    contentType: 'application/json',
  });
});

test('unselected crossing manual spans remain clipped and disclosed with independent focused pins', async ({
  page,
}, testInfo) => {
  await observeTelemetry(page);
  const world = new Ecosystem(DEFAULTS, false),
    sequence = world.recordPaint(world.paint('food', 1, 1, 0, founder(0)), 'food', 0, 1, 1, null)!;
  advance(world, 45);
  world.recordPaint(world.paint('food', 2, 1, 0, founder(0)), 'food', 0, 2, 1, sequence);
  world.changeSettings({ nutrients: 6 });
  advance(world, 16);
  world.changeSettings({ nutrients: 7 });
  await page.goto('/');
  await importTelemetryWorld(page, world.save());
  const before = await downloadPausedWorld(page),
    layouts: object[] = [];
  expect(before).toEqual(Buffer.from(JSON.stringify(world.save())));
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.locator('#telemetry-sample').selectOption('30');
  for (const selection of ['2', 'latest']) {
    await page.locator('#telemetry-intervention').selectOption(selection);
    for (const view of ['population', 'food', 'adaptation']) {
      await page.locator('#telemetry-view').selectOption(view);
      await page.locator('#telemetry-intervention').focus();
      await expect(
        page.locator('.telemetry-manual-strip [data-first-tick="0"]').first(),
      ).toBeAttached();
      const layout = await page.evaluate(() => ({
        sample: (document.querySelector('#telemetry-sample') as HTMLSelectElement).value,
        manual: (document.querySelector('#telemetry-intervention') as HTMLSelectElement).value,
        focus: document.activeElement?.id,
        nodes: document.querySelector('#telemetry')!.querySelectorAll('*').length,
        fits: document.documentElement.scrollWidth <= innerWidth,
        domains: [...document.querySelectorAll('svg[data-start-tick]')].map((plot) => [
          plot.getAttribute('data-start-tick'),
          plot.getAttribute('data-end-tick'),
        ]),
        spans: [...document.querySelectorAll('.telemetry-manual-strip')].map((strip) => {
          const span = strip.querySelector('[data-first-tick="0"]')!;
          return {
            actualFirst: span.getAttribute('data-first-tick'),
            actualLast: span.getAttribute('data-last-tick'),
            anchor: span.getAttribute('data-anchor-tick'),
            clippedFirst: span.getAttribute('data-clipped-first-tick'),
            clippedLast: span.getAttribute('data-clipped-last-tick'),
            path: span.getAttribute('d'),
            title: span.textContent,
            groups: strip.querySelectorAll('.telemetry-manual-density').length,
            height: strip.getBoundingClientRect().height,
            inventedLatestAnchor: !!strip.querySelector('[data-first-tick="61"]'),
            selectedCrossing: !!strip.querySelector('[data-manual-sequence="1"]'),
          };
        }),
      }));
      expect(layout).toMatchObject({
        sample: '30',
        manual: selection,
        focus: 'telemetry-intervention',
        fits: true,
      });
      expect(layout.nodes).toBeLessThan(2000);
      expect(layout.domains.length).toBeGreaterThan(0);
      expect(layout.domains.every((domain) => JSON.stringify(domain) === '["30","60"]')).toBe(true);
      for (const span of layout.spans) {
        expect(span).toMatchObject({
          actualFirst: '0',
          actualLast: '45',
          anchor: 'none',
          clippedFirst: '30',
          clippedLast: '45',
          inventedLatestAnchor: false,
          selectedCrossing: false,
          height: 48,
        });
        expect(span.path).toMatch(/^M50,15H[\d.]+$/);
        expect(span.title).toContain('after completed ticks 0–45');
        expect(span.title).toContain('clipped for drawing only, continues beyond plotted domain');
        expect(span.groups).toBeLessThanOrEqual(32);
      }
      layouts.push({ selection, view, ...layout });
    }
  }
  await page
    .locator('#telemetry')
    .screenshot({ path: testInfo.outputPath('unselected-crossing-span.png') });
  expect(await downloadWorld(page)).toEqual(before);
  await testInfo.attach('unselected-crossing-spans.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      layouts,
      beforeSHA256: createHash('sha256').update(before).digest('hex'),
      fullBytesUnchanged: true,
    }),
  });
});

for (const operation of [
  'initial-start',
  'start',
  'load',
  'settings',
  'paint',
  'shock',
  'clear-walls',
  'regenerate-walls',
  'refuge-mode',
  'paint-refuge',
  'clear-refuges',
]) {
  test(`native post-success ${operation} publication fault preserves applied state and unrelated owners until explicit recovery`, async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const actualOperation = operation === 'initial-start' ? 'start' : operation,
      injection = `(() => {
        const nativePost = self.postMessage.bind(self), nativeTimeout = self.setTimeout.bind(self);
        let armed = ${operation === 'initial-start'}, failObservation = false, pending = 0, waiting = false, display = null, progress = null;
        const acknowledge = () => { if (waiting && pending === 0 && display === null && progress === null) { waiting = false; armed = true; nativePost({ type: '__publication_fault_armed', pending }); } };
        self.setTimeout = (callback, delay, ...args) => { pending++; return nativeTimeout((...values) => { pending--; try { callback(...values); } finally { acknowledge(); } }, delay, ...args); };
        self.addEventListener('message', event => { const data = event.data; if (data?.type === 'flow-ack') { if (data.channel === 'display' && display && data.runId === display.runId && data.sequence === display.sequence) display = null; if (data.channel === 'progress' && progress && data.runId === progress.runId && data.sequence === progress.sequence) progress = null; queueMicrotask(acknowledge); } if (data?.type === '__arm_publication_fault') { event.stopImmediatePropagation(); waiting = true; acknowledge(); } });
        self.postMessage = (data, ...args) => {
          if (failObservation && (data.type === 'frame' || data.type === 'progress')) { failObservation = false; throw new Error('Injected native-worker '+data.type+' publication fault after successful terminal'); }
          if (data.type === 'frame') display = { runId: data.runId, sequence: data.sequence };
          if (data.type === 'progress') progress = { runId: data.runId, sequence: data.sequence };
          nativePost(data, ...args);
          if (armed && data.operation === ${JSON.stringify(actualOperation)} && ['control', 'loaded', 'manual-result'].includes(data.type)) { armed = false; failObservation = true; }
        };
      })();\n`;
    await page.route('**/assets/worker-*.js', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: injection + (await response.text()) });
    });
    await observeMeasurementOwnership(page);
    await page.addInitScript(
      ({ initial, operation }) => {
        window.Worker = new Proxy(window.Worker, {
          construct(target, args, newTarget) {
            const worker: Worker = Reflect.construct(target, args, newTarget);
            if (initial) {
              window.measurementGate.deliveryBlocked = true;
              window.measurementGate.holdLifecycle = true;
            }
            let active = initial,
              waiter: (() => void) | null = null;
            const evidence = (window.publicationFault = {
              terminals: 0,
              failures: 0,
              visible: null as boolean | null,
              failureMessage: null as string | null,
              latest: null as object | null,
              pendingAtArm: null as number | null,
              arm: () =>
                new Promise<void>((resolve) => {
                  waiter = resolve;
                  worker.postMessage({ type: '__arm_publication_fault' });
                }),
            });
            worker.addEventListener('message', ({ data }) => {
              if (data.state) evidence.visible = data.state.display.visible;
              if (data.type === '__publication_fault_armed') {
                active = true;
                evidence.pendingAtArm = data.pending;
                const resolve = waiter;
                waiter = null;
                resolve?.();
              }
              if (active && data.operation === operation) {
                evidence.terminals++;
                evidence.latest = {
                  type: data.type,
                  operation: data.operation,
                  runId: data.runId,
                  requestId: data.commandId,
                  commandId: data.commandId,
                };
              }
              if (data.type === 'error' && data.fatal && !data.operation) {
                evidence.failures++;
                evidence.failureMessage = data.message;
              }
            });
            return worker;
          },
        });
      },
      { initial: operation === 'initial-start', operation: actualOperation },
    );
    await page.goto('/');
    let reference = new Ecosystem();
    let held: [number, object][] = [];
    if (operation !== 'initial-start') {
      await expect(page.locator('#population')).not.toHaveText('—');
      reference = new Ecosystem(DEFAULTS, false);
      advance(reference, 61);
      if (operation === 'clear-walls') reference.walls[index(200, 100)] = 1;
      if (operation === 'paint-refuge' || operation === 'clear-refuges') {
        reference.changeRefugeMode(true);
        if (operation === 'clear-refuges')
          reference.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 4 }, 1, 1);
      }
      await importTelemetryWorld(page, reference.save());
      expect(await downloadPausedWorld(page)).toEqual(
        Buffer.from(JSON.stringify(reference.save())),
      );
      await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
      await page.locator('#mutation').evaluate((input: HTMLInputElement) => {
        input.value = '0.2';
        input.dispatchEvent(new Event('input'));
      });
      reference.changeSettings({ mutation: 0.2 });
      if (operation === 'paint' || operation === 'paint-refuge') {
        await page
          .getByRole('button', {
            name: operation === 'paint-refuge' ? 'Warm' : 'Food',
            exact: true,
          })
          .click();
        await page.locator('#brush').evaluate((input: HTMLInputElement) => {
          input.value = '0';
          input.dispatchEvent(new Event('input'));
        });
        const first = await coordinate(page, 1, 1);
        await page.mouse.move(first.x, first.y);
        await page.mouse.down();
        if (operation === 'paint-refuge')
          reference.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 4 }, 1, 1);
        else referenceManualPaint(reference, 'food', 1, 1, 0, founder(0));
      }
      await page.locator('#world').scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => window.publicationFault.visible)).toBe(true);
      await page.evaluate(() => window.measurementGate.waitForDrain());
      await page.evaluate(() => window.publicationFault.arm());
      await page.evaluate(() => {
        window.measurementGate.deliveryBlocked = true;
        window.measurementGate.holdLifecycle = true;
      });
      if (operation === 'start') {
        await page.evaluate(() => {
          document.getElementById('reset')!.click();
          document.getElementById('confirm-reset')!.click();
        });
        reference = new Ecosystem(reference.settings);
      } else if (operation === 'load') {
        reference = new Ecosystem({ ...DEFAULTS, seed: 74, nutrients: 0 }, false);
        advance(reference, 65);
        await page.locator('#file').setInputFiles({
          name: 'post-success-candidate.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(reference.save())),
        });
      } else if (operation === 'settings') {
        await page.locator('#nutrients').evaluate((input: HTMLInputElement) => {
          input.value = '7';
          input.dispatchEvent(new Event('input'));
        });
        reference.changeSettings({ nutrients: 7 });
      } else if (operation === 'shock') {
        await page.evaluate(() =>
          document.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click(),
        );
        const before = { offset: reference.eventOffset, until: reference.eventUntil };
        reference.shock('heat');
        reference.appendIntervention({
          kind: 'shock',
          detail: {
            kind: 'heat',
            before,
            after: { offset: reference.eventOffset, until: reference.eventUntil },
          },
        });
      } else if (operation === 'refuge-mode') {
        await page.locator('#refuge-enabled').click();
        reference.changeRefugeMode(true);
      } else if (operation === 'clear-refuges') {
        await page.locator('#clear-refuges').click();
        reference.clearRefuges();
      } else if (operation === 'paint-refuge') {
        const next = await coordinate(page, 2, 1);
        await page.mouse.move(next.x, next.y);
        reference.paintRefuge(
          { rulesVersion: 1, tool: 'warm', radius: 0, units: 4 },
          2,
          1,
          reference.interventions.entries.at(-1)!.sequence,
        );
        await page.mouse.up();
      } else if (operation === 'clear-walls' || operation === 'regenerate-walls') {
        await page.locator(`#${operation}`).evaluate((button: HTMLButtonElement) => button.click());
        reference.changeTerrain(operation === 'clear-walls' ? 'clear' : 'regenerate');
      } else {
        const next = await coordinate(page, 2, 1);
        await page.mouse.move(next.x, next.y);
        reference.recordPaint(
          reference.paint('food', 2, 1, 0, founder(0)),
          'food',
          0,
          2,
          1,
          reference.interventionSnapshot().entries.at(-1)!.sequence,
        );
        await page.mouse.up();
      }
    }
    await expect(page.locator('#run-state')).toHaveText('STOPPED');
    await expect(page.locator('#notice')).toContainText('The action completed');
    await expect(page.locator('#notice')).toContainText('World preserved');
    await expect(page.locator('#step')).toBeDisabled();
    const stopped = await page.evaluate(() => ({
      ...window.publicationFault,
      arm: undefined,
      counts: { ...window.measurementGate.counts },
      pending: [...window.measurementGate.pending],
    }));
    expect(stopped.terminals).toBe(1);
    expect(stopped.failures).toBe(1);
    expect(stopped.failureMessage).toMatch(
      /Injected native-worker (frame|progress) publication fault/,
    );
    expect(stopped.counts.terminated).toBe(0);
    if (operation !== 'initial-start') expect(stopped.pendingAtArm).toBe(0);
    held = stopped.pending;
    expect(held).toHaveLength(1);
    await page
      .locator('#notice')
      .screenshot({ path: testInfo.outputPath('post-success-stopped-notice.png') });
    await page.evaluate(() => window.measurementGate.releaseResults());
    await page.evaluate(() => window.measurementGate.waitForDrain());
    await expect(page.locator('#run-state')).toHaveText('STOPPED');
    await page.locator('#file').setInputFiles({
      name: 'explicit-retained-recovery.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{}'),
    });
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    await expect(page.locator('#notice')).toContainText('Not a valid');
    await expect(page.locator('#save')).toBeEnabled();
    const recovered = await downloadPausedWorld(page);
    expect(recovered).toEqual(Buffer.from(JSON.stringify(reference.save())));
    if (!reference.organisms.size) {
      await page.locator('#pause-on-extinction').uncheck();
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
    }
    await page.locator('#pause').click();
    await expect(page.locator('#tick')).not.toHaveText(
      `TICK ${reference.tick.toLocaleString('en-US')}`,
    );
    const resumed = await pause(page),
      captured = JSON.parse(resumed.toString()) as WorldFile;
    expect(captured.tick).toBeGreaterThan(reference.tick);
    advance(reference, captured.tick - reference.tick);
    expect(captured).toEqual(reference.save());
    expect(pageErrors).toEqual([]);
    await testInfo.attach('native-post-success-fault-recovery.json', {
      contentType: 'application/json',
      body: JSON.stringify({
        operation,
        stopped,
        recoveredSHA256: createHash('sha256').update(recovered).digest('hex'),
        resumedSHA256: createHash('sha256').update(resumed).digest('hex'),
        injectionSHA256: createHash('sha256').update(injection).digest('hex'),
        limitation:
          'Actual built native Worker and engine, deliberate one-shot post-terminal publication exception and read-only native scheduler wrapper. Not an OS transport failure. Held callbacks are delivery gates, not physical cancellation.',
      }),
    });
  });
}

function telemetryScenario(
  state: 'empty' | 'single' | 'full-ring' | 'legacy' | 'extinct-paused',
): WorldFile {
  let world = new Ecosystem({ ...DEFAULTS, nutrients: 0, mutation: 0, climate: 0.8 }, false);
  if (state === 'empty') return world.save();
  if (state === 'extinct-paused') {
    const organism = world.spawn(
      {
        behavior: { version: 1 as const, mode: 'legacy' as const },
        cells: [{ x: 0, y: 0, type: 3 }],
        preference: 0.5,
        tolerance: 0.6,
        tempo: 2,
      },
      40,
      40,
    )!;
    organism.energy = 5;
    for (let tick = 0; tick < 90; tick++) world.step();
    organism.age = 975;
    organism.energy = 5;
    return world.save();
  }
  const intervals = state === 'single' ? 1 : 181;
  for (let interval = 0; interval < intervals; interval++) {
    world.food.fill(0);
    const organism = world.spawn(
      {
        behavior: { version: 1 as const, mode: 'legacy' as const },
        cells: Array.from({ length: 6 }, (_, cell) => ({
          x: cell % 3,
          y: Math.floor(cell / 3),
          type: (cell + 3) as import('../../src/model').CellType,
        })),
        preference: ((interval % 10) + 0.35) / 10,
        tolerance: 0.3,
        tempo: 4,
      },
      40,
      40,
    )!;
    organism.energy = 100;
    for (let tick = 0; tick < 30; tick++) world.step();
    for (const living of [...world.organisms.values()]) world.kill(living, 'manual');
  }
  if (state === 'legacy') {
    world = Ecosystem.load(JSON.stringify(legacyV3(world.save())));
    world.spawn(founder(0), 50, 50);
    for (let tick = 0; tick < 30; tick++) world.step();
    for (const living of [...world.organisms.values()]) world.kill(living, 'manual');
  }
  return world.save();
}

test('literal v3 telemetry migrates through the file input and real worker before measured continuation', async ({
  page,
}, testInfo) => {
  await observeTelemetry(page);
  let reference = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false);
  const genome: Genome = {
    behavior: { version: 1 as const, mode: 'legacy' as const },
    cells: [{ x: 0, y: 0, type: 7 }],
    preference: 0.1234567890123456,
    tolerance: 0.4567890123456789,
    tempo: 2,
  };
  reference.spawn(genome, 20, 20);
  reference.spawn({ ...genome, preference: 0.9876543210987654, tolerance: 0.3 }, 40, 40);
  for (const organism of reference.organisms.values()) organism.energy = 8;
  advance(reference, 65);
  reference.paint('erase', 20, 20, 0, genome);
  reference.paint('erase', 40, 40, 0, genome);
  const fixture = legacyV3(reference.save()),
    input = Buffer.from(JSON.stringify(fixture)),
    expected = (): WorldFile => reference.save();
  reference = Ecosystem.load(input.toString('utf8'));
  expect(fixture.version).toBe(3);
  expect(fixture.telemetry.version).toBe(1);
  expect(fixture.telemetry).not.toHaveProperty('adaptationOriginTick');
  expect(fixture.telemetry.samples.map((sample) => sample.tick)).toEqual([30, 60]);
  for (const sample of fixture.telemetry.samples) {
    expect(sample).not.toHaveProperty('adaptation');
    expect(sample.meanPreference).toBe(0.5555555550555555);
    expect(sample.meanTolerance).toBe(0.37839450617283943);
  }
  expect(fixture.telemetry.pending.deaths.manual).toBe(2);
  expect(fixture.telemetry.pending.energy.upkeepSpent).toBeGreaterThan(0);
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'literal-v3-telemetry-v1.json',
    mimeType: 'application/json',
    buffer: input,
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  const workerInput = await page.evaluate(() => window.telemetryEvidence.loadText);
  expect(Buffer.from(workerInput!)).toEqual(input);
  expect(JSON.parse(workerInput!)).toMatchObject({ version: 3, telemetry: { version: 1 } });
  const migratedBytes = await downloadPausedWorld(page),
    migrated = JSON.parse(migratedBytes.toString()) as WorldFile;
  expect(migrated).toEqual(expected());
  expect(migrated.version).toBe(9);
  expect(migrated.telemetry.version).toBe(2);
  expect(migrated.telemetry.originTick).toBe(fixture.telemetry.originTick);
  expect(migrated.telemetry.adaptationOriginTick).toBe(65);
  expect(migrated.telemetry.pending).toEqual(fixture.telemetry.pending);
  expect(
    migrated.telemetry.samples.map(({ adaptation, ...sample }) => {
      expect(adaptation).toBeNull();
      return sample;
    }),
  ).toEqual(fixture.telemetry.samples);
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByLabel('Telemetry view', { exact: true }).selectOption('adaptation');
  await page.getByLabel('Recorded sample', { exact: true }).selectOption('60');
  await expect(page.locator('#telemetry-details')).toContainText('not recorded');
  await expect(page.locator('#telemetry-details')).toContainText('0.5555555550555555');
  await expect(page.locator('[data-bin]')).toHaveCount(0);
  await expect(page.locator('[data-series="Outside tolerance"] [data-tick]')).toHaveCount(0);
  await expect(page.locator('[data-series="Preference"] [data-tick]')).toHaveCount(2);
  await page
    .locator('#telemetry-details')
    .screenshot({ path: testInfo.outputPath('v3-legacy-gaps.png') });
  expect(await downloadWorld(page)).toEqual(migratedBytes);
  await page.getByRole('tab', { name: 'Organism', exact: true }).click();
  await page.locator('#blueprint-file').setInputFiles({
    name: 'stationary-observation.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeBlueprint({ name: 'New observation', description: '', genome })),
  });
  await expect(page.locator('#notice')).toContainText('Blueprint loaded into the designer');
  await page.locator('#plant-design').click();
  const target = await coordinate(page, 80, 80);
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('#population')).toHaveText('1');
  referenceManualPaint(reference, 'plant', 80, 80, 0, genome);
  await stepTo(page, 90);
  advance(reference, 25);
  const measuredBytes = await downloadPausedWorld(page),
    measured = JSON.parse(measuredBytes.toString()) as WorldFile;
  expect(measured).toEqual(expected());
  expect(measured.telemetry.samples.at(-1)).toMatchObject({
    fromTick: 60,
    tick: 90,
    population: 1,
    deaths: { manual: 2 },
    adaptation: { preferenceBins: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0], stressedOrganisms: 0 },
  });
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByLabel('Recorded sample', { exact: true }).selectOption('90');
  await expect(page.locator('#telemetry-details caption')).toHaveText('Selected sample at tick 90');
  await expect(page.locator('[data-bin]')).toHaveCount(10);
  await expect(page.locator('[data-series="Outside tolerance"] [data-tick]')).toHaveCount(1);
  expect(
    await page
      .locator('[data-bin]')
      .evaluateAll((bars) => bars.map((bar) => Number(bar.getAttribute('data-count')))),
  ).toEqual(measured.telemetry.samples.at(-1)!.adaptation!.preferenceBins);
  await page
    .locator('#telemetry-plots figure')
    .last()
    .screenshot({ path: testInfo.outputPath('v3-next-boundary.png') });
  expect(await downloadWorld(page)).toEqual(measuredBytes);
  await importTelemetryWorld(page, measured);
  const restoredBytes = await downloadPausedWorld(page),
    restored = JSON.parse(restoredBytes.toString()) as WorldFile;
  advance(reference, restored.tick - reference.tick);
  expect(restored).toEqual(expected());
  expect(restored.telemetry.adaptationOriginTick).toBe(65);
  expect(await downloadWorld(page)).toEqual(restoredBytes);
  const boundary = (Math.floor(restored.tick / 30) + 1) * 30;
  await stepTo(page, boundary);
  advance(reference, boundary - reference.tick);
  const continuedBytes = await downloadPausedWorld(page),
    continued = JSON.parse(continuedBytes.toString()) as WorldFile;
  expect(continued).toEqual(expected());
  expect(continued.telemetry.samples.at(-1)!.adaptation).not.toBeNull();
  expect(await downloadWorld(page)).toEqual(continuedBytes);
  const evidence = {
    input: fixture,
    migrated,
    measured,
    restored,
    continued,
    inputSHA256: createHash('sha256').update(input).digest('hex'),
    workerInputSHA256: createHash('sha256').update(workerInput!).digest('hex'),
    downloadedSHA256: [migratedBytes, measuredBytes, restoredBytes, continuedBytes].map((bytes) =>
      createHash('sha256').update(bytes).digest('hex'),
    ),
  };
  await testInfo.attach('v3-migration-and-continuation.json', {
    contentType: 'application/json',
    body: JSON.stringify(evidence),
  });
  await writeFile(
    testInfo.outputPath('v3-migration-and-continuation.json'),
    JSON.stringify(evidence),
  );
});

for (const state of ['empty', 'single', 'full-ring', 'legacy', 'extinct-paused'] as const) {
  test(`telemetry ${state}: three honest views, accessible keyboard data and unchanged world across approved widths`, async ({
    page,
  }, testInfo) => {
    await observeTelemetry(page);
    const errors: string[] = [],
      requests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:4173/')) requests.push(request.url());
    });
    const fixture = telemetryScenario(state),
      reference = Ecosystem.load(JSON.stringify(fixture));
    if (state === 'extinct-paused') reference.step();
    await page.goto('/');
    await importTelemetryWorld(page, fixture, state === 'extinct-paused');
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    const checkpoint = await downloadWorld(page),
      expected = reference.save();
    expect(JSON.parse(checkpoint.toString())).toEqual(expected);
    await expect(page.locator('#tick')).toHaveText(`TICK ${expected.tick.toLocaleString('en-US')}`);
    await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
    const samples = expected.telemetry.samples,
      measurements: object[] = [];
    for (const width of state === 'full-ring'
      ? [360, 390, 640, 760, 780, 1024, 1280, 1600]
      : [360, 390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const view of ['population', 'food', 'adaptation']) {
        await page.getByLabel('Telemetry view', { exact: true }).selectOption(view);
        await expect(page.locator('#telemetry-status')).toContainText('View:');
        if (samples.length) {
          const sample = state === 'legacy' ? samples[0] : samples.at(-1)!;
          await page
            .getByLabel('Recorded sample', { exact: true })
            .selectOption(String(sample.tick));
          await expect(page.locator('#telemetry-details caption')).toHaveText(
            `Selected sample at tick ${sample.tick}`,
          );
          const details = await page.locator('#telemetry-details').textContent();
          expect(details).toContain(String(sample.population));
          if (view === 'adaptation' && sample.adaptation) {
            expect(
              await page
                .locator('[data-bin]')
                .evaluateAll((bars) => bars.map((bar) => Number(bar.getAttribute('data-count')))),
            ).toEqual(sample.adaptation.preferenceBins);
            expect(details).toContain(
              sample.population
                ? `${sample.adaptation.stressedOrganisms} / ${sample.population}`
                : 'stressed fraction undefined',
            );
          }
          if (view === 'adaptation' && !sample.adaptation) {
            expect(details).toContain('not recorded');
            await expect(page.locator('[data-bin]')).toHaveCount(0);
          }
        } else
          await expect(page.locator('#telemetry-plots')).toContainText(
            'Received history was empty at source tick',
          );
        const layout = await page.evaluate(() => {
          const section = document.querySelector('#telemetry')!,
            selects = [...section.querySelectorAll('select')],
            rect = (selector: string) =>
              document.querySelector(selector)!.getBoundingClientRect().toJSON();
          const luminance = (color: string) => {
              const channels = color
                .match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number);
              return channels.reduce((total, channel, position) => {
                const normalized = channel / 255;
                return (
                  total +
                  (normalized <= 0.04045
                    ? normalized / 12.92
                    : ((normalized + 0.055) / 1.055) ** 2.4) *
                    [0.2126, 0.7152, 0.0722][position]
                );
              }, 0);
            },
            contrast = (node: Element, color: string) => {
              let surface: Element | null = node;
              while (surface) {
                const background = getComputedStyle(surface).backgroundColor;
                if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') {
                  const foregroundLight = luminance(color),
                    backgroundLight = luminance(background);
                  return (
                    (Math.max(foregroundLight, backgroundLight) + 0.05) /
                    (Math.min(foregroundLight, backgroundLight) + 0.05)
                  );
                }
                surface = surface.parentElement;
              }
              throw new Error('No painted telemetry background');
            };
          return {
            width: innerWidth,
            zoomEquivalent:
              innerWidth === 640
                ? '1280 physical pixels at 200% CSS-pixel reflow equivalent'
                : null,
            fits: document.documentElement.scrollWidth <= innerWidth,
            nodes: section.querySelectorAll('*').length,
            habitat: rect('#world'),
            sidebar: rect('.sidebar'),
            telemetry: rect('#telemetry'),
            controls: selects.map((select) => ({
              height: select.getBoundingClientRect().height,
              label: document.querySelector(`label[for="${select.id}"]`)?.textContent,
            })),
            plots: [...section.querySelectorAll('svg')].map((svg) => ({
              width: svg.getBoundingClientRect().width,
              height: svg.getBoundingClientRect().height,
              viewBox: svg.getAttribute('viewBox'),
              titles: svg
                .getAttribute('aria-labelledby')!
                .split(' ')
                .map((id) => document.getElementById(id)?.textContent),
              labelSizes: [...svg.querySelectorAll('text')].map((label) =>
                parseFloat(getComputedStyle(label).fontSize),
              ),
              labelsContained: [...svg.querySelectorAll('text')].every((label) => {
                const bounds = label.getBoundingClientRect(),
                  plot = svg.getBoundingClientRect();
                return bounds.left >= plot.left - 1 && bounds.right <= plot.right + 1;
              }),
            })),
            textContrast: Math.min(
              ...[
                ...section.querySelectorAll(
                  'label, p, figcaption, li, th, td, caption, select, text',
                ),
              ]
                .filter((node) => node.textContent)
                .map((node) =>
                  contrast(
                    node,
                    getComputedStyle(node)[node.tagName === 'text' ? 'fill' : 'color'],
                  ),
                ),
            ),
            seriesContrast: Math.min(
              ...[
                ...section.querySelectorAll(
                  '[data-series] > *, [data-bin], .telemetry-axis, .telemetry-selection',
                ),
              ].map((node) => {
                const style = getComputedStyle(node);
                return contrast(node, style.stroke === 'none' ? style.fill : style.stroke);
              }),
            ),
            tableHeaders: section.querySelectorAll('th[scope]').length,
            summary: document.querySelector('#telemetry-summary')!.textContent,
          };
        });
        expect(layout.fits).toBe(true);
        expect(layout.nodes).toBeLessThan(2000);
        expect(layout.textContrast).toBeGreaterThanOrEqual(4.5);
        expect(layout.seriesContrast).toBeGreaterThanOrEqual(3);
        expect(
          layout.telemetry.left >= layout.habitat.right ||
            layout.telemetry.top >= layout.habitat.bottom,
        ).toBe(true);
        for (const control of layout.controls) {
          expect(control.height).toBeGreaterThanOrEqual(width <= 780 ? 44 : 36);
          expect(control.label).toBeTruthy();
        }
        for (const plot of layout.plots) {
          expect(plot.width).toBeGreaterThanOrEqual(180);
          expect(plot.titles.every(Boolean)).toBe(true);
          expect(plot.labelSizes.every((size) => size >= 12)).toBe(true);
          expect(plot.labelsContained).toBe(true);
        }
        if (samples.length) expect(layout.tableHeaders).toBeGreaterThan(2);
        measurements.push({ state, view, ...layout });
        if ([360, 390, 640, 1280].includes(width)) {
          await page.locator('#telemetry').scrollIntoViewIfNeeded();
          await testInfo.attach(`${state}-${view}-${width}-screen`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
          for (const [position, plot] of (await page.locator('#telemetry figure').all()).entries())
            await testInfo.attach(`${state}-${view}-${width}-plot-${position}`, {
              body: await plot.screenshot(),
              contentType: 'image/png',
            });
          if (state === 'full-ring' && width === 1280) {
            const sidebar = page.locator('.sidebar'),
              dimensions = await sidebar.evaluate((node) => ({
                height: node.clientHeight,
                fullHeight: node.scrollHeight,
              }));
            for (let offset = 0; offset < dimensions.fullHeight; offset += dimensions.height) {
              await sidebar.evaluate((node, top) => {
                node.scrollTop = top;
              }, offset);
              await testInfo.attach(`${state}-${view}-${width}-sidebar-${offset}`, {
                body: await sidebar.screenshot(),
                contentType: 'image/png',
              });
            }
          }
        }
      }
    }
    if (samples.length) {
      const select = page.getByLabel('Recorded sample', { exact: true });
      await select.focus();
      await select.press('Home');
      await select.press('ArrowDown');
      await expect(select).toHaveValue(String(samples[0].tick));
      await expect(select).toBeFocused();
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await expect(select).toBeFocused();
      const focus = await select.evaluate((node) => ({
        width: getComputedStyle(node).outlineWidth,
        style: getComputedStyle(node).outlineStyle,
      }));
      expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(2);
      expect(focus.style).not.toBe('none');
      await select.selectOption('latest');
      await expect(page.locator('#telemetry-details caption')).toHaveText(
        `Selected sample at tick ${samples.at(-1)!.tick}`,
      );
    }
    await page.locator('#thermal').click();
    await page.locator('#thermal').click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const after = await downloadWorld(page);
    expect(after).toEqual(checkpoint);
    await page.getByTitle('Advance one tick while paused').click();
    await expect(page.locator('#tick')).toHaveText(
      `TICK ${(expected.tick + 1).toLocaleString('en-US')}`,
    );
    reference.step();
    expect(JSON.parse((await downloadWorld(page)).toString())).toEqual(reference.save());
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    const evidence = JSON.stringify({
      project: testInfo.project.name,
      measurements,
      beforeSHA256: createHash('sha256').update(checkpoint).digest('hex'),
      afterSHA256: createHash('sha256').update(after).digest('hex'),
      serializedBytes: checkpoint.byteLength,
      noPageErrors: true,
      noExternalRequests: true,
      nativeIOSOrScreenReaderCertification: false,
    });
    await writeFile(testInfo.outputPath('telemetry-measurements.json'), evidence);
    await testInfo.attach(`telemetry-${state}-measurements`, {
      body: evidence,
      contentType: 'application/json',
    });
  });
}

test('full-ring telemetry retains raw render, selection and resize timings with bounded DOM', async ({
  page,
}, testInfo) => {
  await observeTelemetry(page);
  await page.addInitScript(() => {
    const metrics = (window.telemetryPerformance = {
      enabled: false,
      action: '',
      records: [] as Window['telemetryPerformance']['records'],
    });
    let start: number | null = null;
    const replace = Element.prototype.replaceChildren,
      append = Element.prototype.append,
      raf = window.requestAnimationFrame;
    Element.prototype.replaceChildren = function (...nodes) {
      if (metrics.enabled && this.id === 'telemetry-plots') start = performance.now();
      return replace.apply(this, nodes);
    };
    Element.prototype.append = function (...nodes) {
      const result = append.apply(this, nodes);
      if (
        start !== null &&
        this.id === 'telemetry-details' &&
        nodes.some((node) => node instanceof HTMLTableElement)
      ) {
        metrics.records.push({
          action: metrics.action,
          durationMs: performance.now() - start,
          callbackMs: 0,
          nodes: document.querySelector('#telemetry')!.querySelectorAll('*').length,
          view: (document.querySelector('#telemetry-view') as HTMLSelectElement).value,
          sample: (document.querySelector('#telemetry-sample') as HTMLSelectElement).value,
        });
        start = null;
      }
      return result;
    };
    window.requestAnimationFrame = (callback) =>
      raf.call(window, (timestamp) => {
        const started = performance.now(),
          length = metrics.records.length;
        callback(timestamp);
        if (metrics.records.length > length)
          metrics.records.at(-1)!.callbackMs = performance.now() - started;
      });
  });
  const fixture = telemetryScenario('full-ring');
  await page.goto('/');
  await importTelemetryWorld(page, fixture);
  const checkpoint = await downloadWorld(page);
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByLabel('Telemetry view', { exact: true }).selectOption('food');
  await expect(page.locator('[data-series="Eye"] [data-tick]')).toHaveCount(180);
  const samples = fixture.telemetry.samples;
  await page.evaluate(() => {
    window.telemetryPerformance.enabled = true;
  });
  for (let observation = 0; observation < 48; observation++) {
    const kind = ['render', 'selection', 'resize'][observation % 3];
    const count = await page.evaluate((action) => {
      window.telemetryPerformance.action = action;
      return window.telemetryPerformance.records.length;
    }, kind);
    if (kind === 'render')
      await page
        .getByLabel('Telemetry view', { exact: true })
        .selectOption(observation % 2 ? 'population' : 'food');
    else if (kind === 'selection')
      await page
        .getByLabel('Recorded sample', { exact: true })
        .selectOption(String(observation % 2 ? samples[0].tick : samples.at(-1)!.tick));
    else
      await page.setViewportSize({
        width:
          testInfo.project.name === 'desktop'
            ? page.viewportSize()!.width === 1280
              ? 1024
              : 1280
            : page.viewportSize()!.width === 360
              ? 390
              : 360,
        height: 800,
      });
    await expect
      .poll(() => page.evaluate(() => window.telemetryPerformance.records.length))
      .toBe(count + 1);
  }
  const measured = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    raw: window.telemetryPerformance.records.slice(6),
  }));
  expect(measured.raw).toHaveLength(42);
  expect(Math.max(...measured.raw.map((record) => record.nodes))).toBeLessThan(2000);
  const beforeNoObservation = await page.evaluate(() => window.telemetryPerformance.records.length);
  if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1600, height: 800 });
  await page.locator('#thermal').click();
  await page.locator('#thermal').click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(await page.evaluate(() => window.telemetryPerformance.records.length)).toBe(
    beforeNoObservation,
  );
  expect(await downloadWorld(page)).toEqual(checkpoint);
  const durations = measured.raw
      .map((record) => record.durationMs)
      .sort((left, right) => left - right),
    p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  const evidence = JSON.stringify({
    project: testInfo.project.name,
    host: {
      runtime: process.version,
      platform: platform(),
      cpu: cpus()[0]?.model,
      logicalCPUs: cpus().length,
      memoryBytes: totalmem(),
    },
    ...measured,
    measurement:
      'Synchronous DOM rebuild from telemetry plots replacement through selected-table append; callbackMs additionally includes whole animation callback. Six warm-ups excluded. Real built app and Worker, no CPU throttling; shared host/GC/layout noise remains.',
    medianMs: durations[Math.floor(durations.length / 2)],
    p95Ms: p95,
    targetMs: testInfo.project.name === 'desktop' ? 16 : 50,
    targetMet: p95 < (testInfo.project.name === 'desktop' ? 16 : 50),
    maxNodes: Math.max(...measured.raw.map((record) => record.nodes)),
    noObservationRedraws: 0,
    beforeSHA256: createHash('sha256').update(checkpoint).digest('hex'),
    nativeIOSOrScreenReaderCertification: false,
  });
  await writeFile(testInfo.outputPath('telemetry-performance.json'), evidence);
  await testInfo.attach('telemetry-full-ring-raw-performance', {
    body: evidence,
    contentType: 'application/json',
  });
});

async function observeTelemetry(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    window.telemetryEvidence = { current: null, source: null, points: [], loadText: null };
    let runId = 0,
      established = false;
    let posted: { commandId: number; runId: number; type: string } | null = null;
    const accept = (
      state: ControlState,
      source?: { revision: number; tick: number; telemetry: Frame['telemetry'] },
    ) => {
      const evidence = window.telemetryEvidence;
      if (!evidence.current || state.revision > evidence.current.revision) evidence.current = state;
      const current = evidence.current;
      if (
        source &&
        source.revision <= current.revision &&
        source.tick <= current.world.stats.tick &&
        (!evidence.source || source.revision > evidence.source.revision)
      )
        evidence.source = { ...source, runId, replacementId: current.replacementId };
    };
    Object.defineProperty(window.telemetryEvidence, 'points', {
      get: () =>
        [...document.querySelectorAll('[data-series="Population"] circle[data-tick]')].map(
          (mark) => [Number(mark.getAttribute('cx')), Number(mark.getAttribute('cy'))],
        ),
    });
    window.Worker = new Proxy(window.Worker, {
      construct(target, args: ConstructorParameters<typeof Worker>, newTarget) {
        const worker: Worker = Reflect.construct(target, args, newTarget);
        worker.postMessage = new Proxy(worker.postMessage, {
          apply(postMessage, receiver, messages) {
            const command = messages[0];
            if (command.type !== 'flow-ack')
              posted = { commandId: command.commandId, runId: command.runId, type: command.type };
            if (command.type === 'load') window.telemetryEvidence.loadText = command.text;
            if (command.type === 'start' || command.type === 'load') {
              runId = command.runId;
              established = false;
            }
            return Reflect.apply(postMessage, receiver, messages);
          },
        });
        worker.addEventListener('message', ({ data }) => {
          if (data.runId !== runId) return;
          if (data.type === 'frame' || data.type === 'progress') {
            if (established) accept(data.state, data.telemetry);
            return;
          }
          if (!posted || data.commandId !== posted.commandId || data.runId !== posted.runId) return;
          const command = posted;
          posted = null;
          const state = data.type === 'error' ? data.recovery?.state : data.state;
          const source = data.type === 'error' ? data.recovery?.telemetry : data.telemetry;
          if (!state) return;
          if (command.type === 'start' || command.type === 'load') {
            established = true;
            const previous = window.telemetryEvidence.current;
            window.telemetryEvidence.current = null;
            if (previous?.replacementId !== state.replacementId)
              window.telemetryEvidence.source = null;
          }
          if (established) accept(state, source);
        });
        return worker;
      },
    });
  });
}

async function telemetryFrame(
  page: import('@playwright/test').Page,
): Promise<Pick<Frame, 'stats' | 'telemetry'>> {
  return page.evaluate(() => {
    const { current, source } = window.telemetryEvidence;
    return { stats: current!.world.stats, telemetry: source!.telemetry };
  });
}

async function expectPopulationChart(
  page: import('@playwright/test').Page,
  populations: number[],
): Promise<void> {
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate((values) => {
        const svg = document.querySelector('#telemetry-plots svg') as SVGSVGElement | null;
        if (!svg) return values.length === 0;
        const width = svg.viewBox.baseVal.width,
          samples = window.telemetryEvidence.source!.telemetry.samples,
          start = samples.length === 1 ? samples[0].fromTick : samples[0].tick,
          end = samples.at(-1)!.tick;
        const expected = values.map((population, position) => [
          50 + ((samples[position].tick - start) / (end - start)) * (width - 64),
          144 - (population / Math.max(1, ...values)) * 128,
        ]);
        return JSON.stringify(window.telemetryEvidence.points) === JSON.stringify(expected);
      }, populations),
    )
    .toBe(true);
}

async function importTelemetryWorld(
  page: import('@playwright/test').Page,
  world: object,
  waitForExtinction = false,
): Promise<void> {
  const observedRun = await page.evaluate(
    () => window.terrainNative?.lifecycle.at(-1)?.runId ?? null,
  );
  await page.locator('#file').setInputFiles({
    name: 'telemetry-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if (observedRun !== null) {
    await expect
      .poll(() => page.evaluate(() => window.terrainNative.lifecycle.at(-1)?.runId ?? 0))
      .toBeGreaterThan(observedRun);
    await terrainNativeFrame(page);
    return;
  }
  if (waitForExtinction) await expect(page.locator('#run-state')).toHaveText('PAUSED');
  else if (await page.getByRole('button', { name: 'Ⅱ Pause', exact: true }).isVisible())
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
  leaseRequest(page, 'save');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save world' }).click();
  const download = await downloadPromise,
    stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  await leaseRead(page, download.suggestedFilename(), bytes);
  return bytes;
}
async function downloadMeasurements(page: import('@playwright/test').Page, format: 'json' | 'csv') {
  leaseRequest(page, 'measurement');
  const pending = page.waitForEvent('download');
  await page.locator(`#measurements-${format}`).click();
  const download = await pending,
    stream = await download.createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  await leaseRead(page, download.suggestedFilename(), bytes);
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^evolab-measurements-\\d+-tick-\\d+\\.${format}$`),
  );
  await test.info().attach(download.suggestedFilename(), {
    body: bytes,
    contentType: format === 'csv' ? 'text/csv' : 'application/json',
  });
  return bytes;
}
function referenceManualPaint(
  world: Ecosystem,
  tool: 'food' | 'wall' | 'erase' | 'plant',
  x: number,
  y: number,
  radius: number,
  genome: Genome,
) {
  const outcome = world.paint(tool, x, y, radius, genome);
  if (outcome.placement) world.appendIntervention({ kind: 'placement', detail: outcome.placement });
  else if (tool !== 'plant') world.recordPaint(outcome, tool, radius, x, y, null);
}
function restoreMeasurementZeros(envelope: any) {
  const paths = envelope.negativeZeroPaths as string[];
  expect(paths).toEqual([...paths].sort());
  expect(new Set(paths).size).toBe(paths.length);
  for (const path of paths) {
    const fields = path.slice(1).split('/'),
      last = fields.pop()!;
    let target = envelope;
    for (const field of fields) target = target[field];
    expect(target[last] === 0).toBe(true);
    target[last] = -0;
  }
  return envelope;
}
function decodeDownloadedCsv(bytes: Buffer) {
  const text = bytes.toString('utf8'),
    rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset];
    if (character === '"') {
      if (quoted && text[offset + 1] === '"') {
        field += '"';
        offset++;
      } else quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && character === '\r' && text[offset + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      offset++;
    } else field += character;
  }
  expect(quoted).toBe(false);
  expect(field).toBe('');
  expect(row).toEqual([]);
  const header = rows.shift()!;
  const literal = (value: string) => {
    expect(value.startsWith('s:')).toBe(true);
    return value.slice(2);
  };
  let envelope: any;
  for (const row of rows) {
    expect(row.length).toBe(header.length);
    const values = Object.fromEntries(header.map((key, index) => [key, row[index]])),
      type = literal(values.record_type);
    if (type === 'metadata') {
      envelope = JSON.parse(literal(values.metadata_json));
      envelope.telemetry.samples = [];
      envelope.interventions.entries = [];
    } else if (type === 'intervention')
      envelope.interventions.entries.push({
        sequence: Number(values['manual.sequence']),
        origin: literal(values['manual.origin']),
        kind: literal(values['manual.kind']),
        firstTick: Number(values['manual.firstTick']),
        lastTick: Number(values['manual.lastTick']),
        detail: JSON.parse(literal(values.metadata_json)),
      });
    else {
      const value: any = {};
      for (const [key, raw] of Object.entries(values)) {
        if (
          !raw ||
          ['record_type', 'record_index', 'adaptation_status', 'metadata_json'].includes(key)
        )
          continue;
        const fields = key.split('.'),
          last = fields.pop()!;
        let target = value;
        for (const field of fields)
          target = target[field] ??= ['cellCounts', 'preferenceBins'].includes(field) ? [] : {};
        target[last] = raw === 'null' ? null : Number(raw);
      }
      if (type === 'sample') {
        if (literal(values.adaptation_status) === 'legacy-unknown') value.adaptation = null;
        envelope.telemetry.samples.push(value);
      } else {
        expect(type).toBe('pending');
        envelope.telemetry.pending = value;
      }
    }
  }
  return restoreMeasurementZeros(envelope);
}
async function observeMeasurementOwnership(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    window.Worker = new Proxy(window.Worker, {
      construct(target, args, newTarget) {
        const worker: Worker = Reflect.construct(target, args, newTarget),
          nativePost = worker.postMessage.bind(worker),
          nativeTerminate = worker.terminate.bind(worker),
          pending = new Map<number, object>(),
          posts = new Map<number, any>(),
          results = new Map<number, MessageEvent>();
        let handler: ((this: Worker, event: MessageEvent) => void) | null = null,
          lifecycleWaiter: (() => void) | null = null,
          drainWaiter: (() => void) | null = null,
          latestFrame: MessageEvent | null = null;
        const counts = {
          E: 0,
          S: 0,
          M: 0,
          viewCommands: 0,
          paintCommands: 0,
          beginCommands: 0,
          C: 0,
          L: 0,
          completedL: 0,
          serializedE: 0,
          serializedS: 0,
          nativePosts: 0,
          maximum: 0,
          terminated: 0,
        };
        const gate = (window.measurementGate = {
          processingBlocked: false,
          deliveryBlocked: false,
          holdLifecycle: false,
          framesBlocked: false,
          counts,
          pending,
          releasePosts() {
            this.processingBlocked = false;
            for (const [id, command] of posts) {
              posts.delete(id);
              counts.nativePosts++;
              nativePost(command);
            }
          },
          releaseResults() {
            this.deliveryBlocked = false;
            for (const [id, event] of results) {
              results.delete(id);
              pending.delete(id);
              handler?.call(worker, event);
            }
          },
          nextLifecycle() {
            if (lifecycleWaiter) throw new Error('Only one lifecycle waiter allowed');
            return new Promise<void>((resolve) => {
              lifecycleWaiter = resolve;
            });
          },
          waitForDrain() {
            if (!pending.size) return Promise.resolve();
            if (drainWaiter) throw new Error('Only one drain waiter allowed');
            return new Promise<void>((resolve) => {
              drainWaiter = resolve;
            });
          },
          releaseFrame() {
            this.framesBlocked = false;
            const frame = latestFrame;
            latestFrame = null;
            if (frame) handler?.call(worker, frame);
          },
          failEndpoint() {
            worker.dispatchEvent(new MessageEvent('messageerror'));
          },
        });
        Object.defineProperty(worker, 'onmessage', {
          configurable: true,
          get: () => handler,
          set: (next) => {
            handler = next;
          },
        });
        worker.addEventListener('message', (event) => {
          const data = event.data,
            id = data.requestId ?? data.commandId;
          if (data.type === 'frame' && gate.framesBlocked) {
            latestFrame = event;
            return;
          }
          if (data.operation && pending.has(id)) {
            if (data.type === 'measurement-exported') counts.serializedE++;
            if (data.type === 'saved') counts.serializedS++;
            const lifecycle = ['start', 'load'].includes(data.operation);
            if (lifecycle) {
              counts.completedL++;
              const waiter = lifecycleWaiter;
              lifecycleWaiter = null;
              waiter?.();
            }
            if (gate.deliveryBlocked && (!lifecycle || gate.holdLifecycle)) {
              results.set(id, event);
              if (results.size > 36) throw new Error('Unbounded terminal gate');
              return;
            }
            pending.delete(id);
          }
          handler?.call(worker, event);
          if (!pending.size && drainWaiter) {
            const resolve = drainWaiter;
            drainWaiter = null;
            resolve();
          }
        });
        worker.postMessage = new Proxy(worker.postMessage, {
          apply(postMessage, receiver, messages) {
            const command = messages[0],
              id = command.requestId ?? command.commandId;
            if (id) {
              if (command.type === 'display-view') counts.viewCommands++;
              if (command.type === 'paint') counts.paintCommands++;
              if (command.type === 'begin-stroke') counts.beginCommands++;
              const category =
                command.type === 'export-measurements'
                  ? 'E'
                  : command.type === 'save'
                    ? 'S'
                    : command.type === 'end-stroke'
                      ? 'C'
                      : ['start', 'load'].includes(command.type)
                        ? 'L'
                        : 'M';
              counts[category]++;
              pending.set(id, { operation: command.type, runId: command.runId });
              counts.maximum = Math.max(counts.maximum, pending.size);
              if (pending.size > 36) throw new Error('Native ownership exceeded36');
              if (gate.processingBlocked) {
                posts.set(id, command);
                return;
              }
            }
            counts.nativePosts++;
            return Reflect.apply(postMessage, receiver, messages);
          },
        });
        worker.terminate = () => {
          nativeTerminate();
          counts.terminated++;
          pending.clear();
          posts.clear();
          results.clear();
          latestFrame = null;
        };
        return worker;
      },
    });
  });
}
test('D9-A5 actual native4096-command stroke closes once without a4097th paint or extra ecological effects', async ({
  page,
}) => {
  await observeMeasurementOwnership(page);
  await page.goto('/');
  await requestPause(page);
  const before = await downloadPausedWorld(page),
    reference = Ecosystem.load(before.toString()),
    beforeCounts = await page.evaluate(() => ({ ...window.measurementGate.counts }));
  await page.getByRole('button', { name: 'Food', exact: true }).click();
  await page.locator('#brush').evaluate((input: HTMLInputElement) => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const position = await coordinate(page, 10, 10);
  await page.evaluate(() => {
    window.measurementGate.framesBlocked = true;
  });
  await page.mouse.move(position.x, position.y);
  await page.mouse.down();
  await page.evaluate(async (position) => {
    const canvas = document.getElementById('world')!,
      gate = window.measurementGate;
    await gate.waitForDrain();
    for (let command = 1; command < 4096; command++) {
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1,
          isPrimary: true,
          clientX: position.x,
          clientY: position.y,
          bubbles: true,
        }),
      );
      await gate.waitForDrain();
    }
    canvas.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        isPrimary: true,
        clientX: position.x + 20,
        clientY: position.y,
        bubbles: true,
      }),
    );
    gate.releaseFrame();
  }, position);
  await page.mouse.up();
  const counts = await page.evaluate(() => window.measurementGate.counts);
  expect(counts.M - beforeCounts.M - (counts.viewCommands - beforeCounts.viewCommands)).toBe(4097);
  expect(counts.paintCommands - beforeCounts.paintCommands).toBe(4096);
  expect(counts.beginCommands - beforeCounts.beginCommands).toBe(1);
  expect(counts.C - beforeCounts.C).toBe(1);
  expect(counts.terminated).toBe(0);
  const outcome = reference.paint('food', 10, 10, 0, founder(0));
  reference.recordPaint(outcome, 'food', 0, 10, 10, null);
  const after = await downloadPausedWorld(page);
  expect(after).toEqual(Buffer.from(JSON.stringify(reference.save())));
  expect(JSON.parse(after.toString()).interventions.entries.at(-1).detail.successfulCommands).toBe(
    1,
  );
  await test.info().attach('native4096-stroke.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      counts,
      beforeCounts,
      beforeSHA256: createHash('sha256').update(before).digest('hex'),
      afterSHA256: createHash('sha256').update(after).digest('hex'),
      frameGate:
        'Only native frame delivery held, latest one retained; real engine and every manual terminal forwarded. Physical disk/touch and whole-heap bounds not measured.',
    }),
  });
});
test('D9-A7 actual native termination precedes abandonment of the sole held receipt under36 and a clean new Worker incarnation', async ({
  page,
}) => {
  await observeMeasurementOwnership(page);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.goto('/');
  await requestPause(page);
  await page.evaluate(() => {
    const gate = window.measurementGate,
      canvas = document.getElementById('world')!,
      rect = canvas.getBoundingClientRect();
    gate.deliveryBlocked = true;
    gate.holdLifecycle = true;
    document.getElementById('measurements-json')!.click();
    document.getElementById('save')!.click();
    document.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
    const pointer = (type: string) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          isPrimary: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
        }),
      );
    pointer('pointerdown');
    for (let point = 0; point < 31; point++) pointer('pointermove');
    pointer('pointerup');
    document.getElementById('reset')!.click();
    document.getElementById('confirm-reset')!.click();
    document.getElementById('confirm-reset')!.click();
  });
  await expect.poll(() => page.evaluate(() => window.measurementGate.counts.serializedE)).toBe(1);
  expect(await page.evaluate(() => window.measurementGate.counts.completedL)).toBe(1);
  expect(await page.evaluate(() => window.measurementGate.pending.size)).toBe(1);
  const held = await page.evaluate(() => ({ ...window.measurementGate.counts }));
  expect(held).toMatchObject({ serializedE: 1, serializedS: 0, terminated: 0, maximum: 1 });
  await page.evaluate(() => window.measurementGate.failEndpoint());
  expect(await page.evaluate(() => window.measurementGate.counts.terminated)).toBe(1);
  expect(await page.evaluate(() => window.measurementGate.pending.size)).toBe(0);
  await expect(page.locator('#run-state')).toHaveText('STOPPED');
  await page.evaluate(() => window.measurementGate.releaseResults());
  expect(downloads).toBe(0);
  await page.reload();
  await requestPause(page);
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  const fresh = JSON.parse((await downloadMeasurements(page, 'json')).toString());
  expect(fresh.snapshot.seed).toBe(DEFAULTS.seed);
  expect(downloads).toBe(1);
  expect(await page.evaluate(() => window.measurementGate.counts.L)).toBe(1);
  await test.info().attach('native-endpoint-incarnation.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      held,
      oldNativeTerminations: 1,
      freshDownloads: downloads,
      limitation:
        'messageerror signal injected by test; real native terminate method and new native construction forwarded unchanged. This is endpoint-abandonment evidence; mount-disposer/late-file callback permutations are separately unit-bridged, not OS crash evidence.',
    }),
  });
});
test('D9-A10 native file reads stay single-owner through cancellation, reset and a full lifecycle latch; equal-tick pins reset only on success', async ({
  page,
}) => {
  await observeMeasurementOwnership(page);
  await page.addInitScript(() => {
    const nativeText = File.prototype.text;
    let release: (() => void) | null = null;
    const gate = (window.measurementReadGate = {
      blocked: false,
      ready: false,
      counts: { calls: 0, active: 0, maximum: 0 },
      release() {
        const complete = release;
        release = null;
        this.ready = false;
        complete?.();
      },
    });
    File.prototype.text = async function () {
      gate.counts.calls++;
      gate.counts.active++;
      gate.counts.maximum = Math.max(gate.counts.maximum, gate.counts.active);
      try {
        const text = await nativeText.call(this);
        if (gate.blocked)
          await new Promise<void>((resolve) => {
            if (release) throw new Error('Unbounded native file-read gate');
            release = resolve;
            gate.ready = true;
          });
        return text;
      } finally {
        gate.counts.active--;
      }
    };
  });
  const source = Ecosystem.load(JSON.stringify(telemetryScenario('full-ring')));
  source.changeSettings({ nutrients: 1 });
  source.changeSettings({ nutrients: 0 });
  const fixture = source.save(),
    pick = async (world: WorldFile) =>
      page.locator('#file').setInputFiles({
        name: 'native-world.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(world)),
      });
  await page.goto('/');
  await pick(fixture);
  await expect(page.locator('#notice')).toContainText('World restored');
  const before = await downloadPausedWorld(page);
  expect(before).toEqual(Buffer.from(JSON.stringify(fixture)));
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  const sample = String(fixture.telemetry.samples[0].tick);
  await page.locator('#telemetry-sample').selectOption(sample);
  await page.locator('#telemetry-intervention').selectOption('1');
  await page.locator('#telemetry-intervention').focus();
  const invalid = structuredClone(fixture);
  invalid.interventions.entries.at(-1)!.sequence++;
  await pick(invalid);
  await expect(page.locator('#notice')).toContainText(/intervention/i);
  await expect(page.locator('#telemetry-sample')).toHaveValue(sample);
  await expect(page.locator('#telemetry-intervention')).toHaveValue('1');
  await expect(page.locator('#telemetry-intervention')).toBeFocused();
  expect(await downloadPausedWorld(page)).toEqual(before);
  await pick(fixture);
  await expect(page.locator('#notice')).toContainText('World restored');
  await expect(page.locator('#telemetry-sample')).toHaveValue('latest');
  await expect(page.locator('#telemetry-intervention')).toHaveValue('latest');
  const readsBefore = await page.evaluate(() => window.measurementReadGate.counts.calls);
  await page.evaluate(() => {
    window.measurementReadGate.blocked = true;
  });
  await pick(new Ecosystem({ ...DEFAULTS, seed: 123 }).save());
  await expect.poll(() => page.evaluate(() => window.measurementReadGate.ready)).toBe(true);
  await pick(new Ecosystem({ ...DEFAULTS, seed: 456 }).save());
  await expect(page.locator('#notice')).toContainText('World read still outstanding');
  expect(await page.evaluate(() => window.measurementReadGate.counts.calls)).toBe(readsBefore + 1);
  await page.locator('#file').dispatchEvent('cancel');
  await page.evaluate(() => {
    document.getElementById('reset')!.click();
    document.getElementById('confirm-reset')!.click();
    document.getElementById('confirm-reset')!.click();
  });
  await requestPause(page);
  const reset = await downloadPausedWorld(page);
  await page.evaluate(() => {
    window.measurementReadGate.blocked = false;
    window.measurementReadGate.release();
  });
  await expect.poll(() => page.evaluate(() => window.measurementReadGate.counts.active)).toBe(0);
  expect(await downloadPausedWorld(page)).toEqual(reset);
  const lifecycles = await page.evaluate(() => window.measurementGate.counts.L);
  await page.evaluate(() => {
    window.measurementGate.deliveryBlocked = true;
    window.measurementGate.holdLifecycle = true;
    document.getElementById('reset')!.click();
    document.getElementById('confirm-reset')!.click();
    document.getElementById('confirm-reset')!.click();
  });
  await expect
    .poll(() => page.evaluate(() => window.measurementGate.counts.completedL))
    .toBe(lifecycles + 1);
  await pick(fixture);
  await expect(page.locator('#notice')).toContainText('capacity busy');
  expect(await page.evaluate(() => window.measurementGate.counts.L)).toBe(lifecycles + 1);
  await page.evaluate(() => window.measurementGate.releaseResults());
  await expect.poll(() => page.evaluate(() => window.measurementGate.pending.size)).toBe(0);
  await requestPause(page);
  const saved = JSON.parse((await downloadPausedWorld(page)).toString()),
    reference = new Ecosystem(fixture.settings);
  advance(reference, saved.tick);
  expect(saved).toEqual(reference.save());
  const reads = await page.evaluate(() => window.measurementReadGate.counts);
  expect(reads).toMatchObject({ active: 0, maximum: 1 });
  await test.info().attach('native-world-file-ownership.json', {
    body: JSON.stringify({
      reads,
      lifecyclesBeforeBusyRead: lifecycles,
      lifecyclePostsAfterBusyRead: lifecycles + 1,
      limitation:
        'Forwards actual File.text bytes; delays promise-result delivery, not physical disk I/O. Cancellation uses a DOM cancel event, not an operating-system picker. Slider-capacity and disposal permutations additionally use the real-engine unit bridge.',
    }),
    contentType: 'application/json',
  });
});
for (const version of [2, 3, 4, 5, 6, 7, 8, 9] as const) {
  test(`measurement bytes preserve synthetic historical/current world${version} migration,180 samples and truthful manual windows`, async ({
    page,
  }) => {
    const world = Ecosystem.load(JSON.stringify(telemetryScenario('full-ring')));
    for (let entry = 0; entry < 130; entry++)
      world.changeSettings({ nutrients: entry % 2 ? 0 : 1 });
    world.changeSettings({ climate: -0 });
    if (version >= 7) {
      world.changeRefugeMode(true);
      world.paintRefuge({ rulesVersion: 1, tool: 'cool', radius: 1, units: -4 }, 0, 0);
      world.changeRefugeMode(false);
    }
    const current = world.save();
    (current.settings as any).retainedExtension = '=literal,"λ\r\n@formula';
    const {
      telemetry: _telemetry,
      lineageArchive: _lineageArchive,
      interventions: _interventions,
      terrain: _terrain,
      thermalRefuges: _thermalRefuges,
      ...ecology
    } = syntheticHistoricalWorld(current);
    const candidate =
      version === 2
        ? { ...ecology, version: 2 }
        : version === 3
          ? legacyV3(current)
          : version === 4
            ? legacyV4(current)
            : version === 5
              ? legacyV5(current)
              : version === 6
                ? legacyV6(current)
                : version === 7
                  ? legacyV7(current)
                  : version === 8
                    ? legacyV8(current)
                    : current;
    expect(candidate.version).toBe(version);
    expect('interventions' in candidate).toBe(version >= 5);
    expect('terrain' in candidate).toBe(version >= 6);
    expect('thermalRefuges' in candidate).toBe(version >= 7);
    expect('lineageArchive' in candidate).toBe(version >= 8);
    const text = JSON.stringify(candidate).replace(/"climate":0(?=[,}])/g, '"climate":-0'),
      reference = Ecosystem.load(text),
      expected = reference.save();
    await page.goto('/');
    await page.locator('#file').setInputFiles({
      name: `genuine-world${version}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
    await expect(page.locator('#notice')).toContainText('World restored');
    const before = await downloadPausedWorld(page);
    expect(before).toEqual(Buffer.from(JSON.stringify(expected)));
    await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
    const jsonBytes = await downloadMeasurements(page, 'json'),
      csvBytes = await downloadMeasurements(page, 'csv'),
      json = restoreMeasurementZeros(JSON.parse(jsonBytes.toString('utf8'))),
      csv = decodeDownloadedCsv(csvBytes);
    expect(csv).toEqual(json);
    expect(json.telemetry).toEqual(expected.telemetry);
    expect(json.interventions).toEqual(expected.interventions);
    expect(json.snapshot.completedTick).toBe(expected.tick);
    expect(Object.is(json.snapshot.settings.climate, -0)).toBe(true);
    expect(jsonBytes.toString()).not.toContain('retainedExtension');
    expect(json.windows.samples.retainedCount).toBe(version === 2 ? 0 : 180);
    expect(json.windows.manual).toMatchObject({
      retainedCount: version >= 5 ? 128 : 0,
      capacity: 128,
      originKind: version >= 5 ? 'fresh' : 'legacy-import',
      coverage: 'applied-portions-only',
    });
    expect(json.windows.settings.unknownEvictedPrefix).toBe(version >= 5);
    expect(json.version).toBe(3);
    expect(json.rules.version).toBe(2);
    expect(json.snapshot.thermalRefuges).toEqual(refugeSummary(reference.thermalRefuges));
    expect(json.snapshot.terrain).toEqual(DEFAULT_TERRAIN);
    for (const view of ['population', 'food', 'adaptation'])
      await page.locator('#telemetry-view').selectOption(view);
    if (version >= 5) {
      const sequence = String(expected.interventions.entries[0].sequence),
        sample = String(expected.telemetry.samples.at(-2)!.tick),
        layouts: object[] = [];
      await expect(page.locator('#telemetry-intervention option')).toHaveCount(129);
      await page.locator('#telemetry-intervention').selectOption(sequence);
      await page.locator('#telemetry-sample').selectOption(sample);
      for (const width of [360, 390, 640, 760, 780, 1024, 1280, 1600]) {
        await page.locator('#telemetry-intervention').focus();
        await page.setViewportSize({ width, height: 800 });
        await expect(page.locator('#telemetry-intervention')).toBeFocused();
        for (const view of ['population', 'food', 'adaptation']) {
          await page.locator('#telemetry-view').selectOption(view);
          await expect(page.locator('#telemetry-intervention')).toHaveValue(sequence);
          await expect(page.locator('#telemetry-sample')).toHaveValue(sample);
          const layout = await page.locator('#telemetry').evaluate((section) => ({
            nodes: section.querySelectorAll('*').length,
            fits: document.documentElement.scrollWidth <= innerWidth,
            stripHeights: [...section.querySelectorAll('.telemetry-manual-strip')].map(
              (strip) => strip.getBoundingClientRect().height,
            ),
            densities: [...section.querySelectorAll('.telemetry-manual-strip')].map((strip) =>
              [...strip.querySelectorAll('.telemetry-manual-density')].map((mark) =>
                Number(mark.getAttribute('data-count')),
              ),
            ),
          }));
          expect(layout.nodes).toBeLessThan(2000);
          expect(layout.fits).toBe(true);
          expect(layout.densities.length).toBeGreaterThan(0);
          expect(layout.stripHeights.every((height) => height === 48)).toBe(true);
          for (const density of layout.densities) expect(density).toEqual([128]);
          layouts.push({ width, view, ...layout });
        }
        if ([360, 390, 640, 1280].includes(width)) {
          await page.locator('#telemetry').scrollIntoViewIfNeeded();
          await test.info().attach(`dense180-128-${width}.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
        }
      }
      await test.info().attach('dense180-128-layouts.json', {
        body: JSON.stringify(layouts),
        contentType: 'application/json',
      });
    }
    await page.locator('#thermal').click();
    expect(await downloadPausedWorld(page)).toEqual(before);
    await expect(page.locator('#save')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.sensoryNative.activeUrls.size)).toBe(0);
    await test.info().attach('measurement-downloads.json', {
      contentType: 'application/json',
      body: JSON.stringify({
        version,
        tick: expected.tick,
        worldSHA256: createHash('sha256').update(before).digest('hex'),
        jsonSHA256: createHash('sha256').update(jsonBytes).digest('hex'),
        csvSHA256: createHash('sha256').update(csvBytes).digest('hex'),
        windows: json.windows,
        signedZeroPaths: json.negativeZeroPaths,
      }),
    });
  });
}
for (const speed of [1, 4, 12]) {
  test(`running ${speed}x native exports match independent real ecology at each authoritative FIFO position`, async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('#speed').selectOption(String(speed));
    await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
    for (const format of ['json', 'csv'] as const) {
      const bytes = await downloadMeasurements(page, format),
        envelope =
          format === 'json'
            ? restoreMeasurementZeros(JSON.parse(bytes.toString()))
            : decodeDownloadedCsv(bytes),
        reference = new Ecosystem();
      advance(reference, envelope.snapshot.completedTick);
      expect(envelope.snapshot.seed).toBe(reference.settings.seed);
      expect(envelope.telemetry).toEqual(reference.save().telemetry);
      expect(envelope.interventions).toEqual(reference.save().interventions);
    }
    await requestPause(page);
    const saved = JSON.parse((await downloadPausedWorld(page)).toString()),
      reference = new Ecosystem();
    advance(reference, saved.tick);
    expect(saved).toEqual(reference.save());
  });
}
for (const mode of ['processing', 'delivery'] as const) {
  test(`D9-A9 native ${mode} gate preserves36 ceiling through256 replacement workloads and exact FIFO drains`, async ({
    page,
  }, testInfo) => {
    await observeMeasurementOwnership(page);
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.goto('/');
    await requestPause(page);
    const before = await downloadPausedWorld(page),
      baseline = await page.evaluate(() => ({ ...window.measurementGate.counts }));
    await expect(page.locator('#save')).toBeEnabled();
    await page.evaluate((mode) => {
      const gate = window.measurementGate;
      gate.processingBlocked = mode === 'processing';
      gate.deliveryBlocked = mode === 'delivery';
      document.getElementById(mode === 'processing' ? 'measurements-json' : 'save')!.click();
      document.getElementById(mode === 'processing' ? 'save' : 'measurements-json')!.click();
      const canvas = document.getElementById('world')!,
        rect = canvas.getBoundingClientRect();
      document.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
      const pointer = (type: string) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            isPrimary: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
          }),
        );
      pointer('pointerdown');
      for (let point = 0; point < 31; point++) pointer('pointermove');
      pointer('pointerup');
      document.getElementById('reset')!.click();
      document.getElementById('confirm-reset')!.click();
      if (mode === 'processing')
        for (let attempt = 0; attempt < 256; attempt++) {
          document.getElementById('reset')!.click();
          document.getElementById('confirm-reset')!.click();
          for (const id of ['measurements-json', 'measurements-csv', 'save'])
            document.getElementById(id)!.click();
          pointer('pointerdown');
          pointer('pointerup');
        }
    }, mode);
    await expect.poll(() => page.evaluate(() => window.measurementGate.pending.size)).toBe(1);
    expect(await page.evaluate(() => window.measurementGate.counts.completedL)).toBe(
      baseline.completedL,
    );
    const held = await page.evaluate(() => ({ ...window.measurementGate.counts }));
    let predecessor: Buffer | null = null;
    if (mode === 'processing') await page.evaluate(() => window.measurementGate.releasePosts());
    else {
      await expect
        .poll(() => page.evaluate(() => window.measurementGate.counts.serializedS))
        .toBe(baseline.serializedS + 1);
      const download = page.waitForEvent('download');
      await page.evaluate(() => window.measurementGate.releaseResults());
      const stream = await (await download).createReadStream(),
        chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      predecessor = Buffer.concat(chunks);
      expect(predecessor).toEqual(before);
    }
    await page.evaluate(() => window.measurementGate.waitForDrain());
    await expect
      .poll(() => page.evaluate(() => window.measurementGate.counts.completedL))
      .toBe(baseline.completedL + 1);
    if (mode === 'delivery')
      await page.evaluate(async () => {
        const gate = window.measurementGate,
          input = document.getElementById('file') as HTMLInputElement;
        for (let replacement = 0; replacement < 256; replacement++) {
          const completion = gate.nextLifecycle();
          if (replacement % 2) {
            const files = new DataTransfer();
            files.items.add(new File(['{}'], 'invalid-world.json', { type: 'application/json' }));
            input.files = files.files;
            input.dispatchEvent(new Event('change'));
          } else {
            document.getElementById('reset')!.click();
            document.getElementById('confirm-reset')!.click();
            document.getElementById('confirm-reset')!.click();
          }
          await completion;
          await gate.waitForDrain();
          if (document.getElementById('run-state')!.textContent === 'LIVE')
            document.getElementById('pause')!.click();
          await gate.waitForDrain();
        }
      });
    await expect.poll(() => page.evaluate(() => window.measurementGate.pending.size)).toBe(0);
    const counts = await page.evaluate(() => ({ ...window.measurementGate.counts }));
    expect(counts.L - baseline.L).toBe(mode === 'processing' ? 1 : 257);
    expect(counts.serializedE - baseline.serializedE).toBe(mode === 'processing' ? 1 : 0);
    expect(counts.serializedS - baseline.serializedS).toBe(mode === 'processing' ? 0 : 1);
    expect(counts.maximum).toBe(1);
    expect(counts.maximum).toBeLessThanOrEqual(36);
    expect(counts.terminated).toBe(0);
    expect(downloads).toBe(mode === 'processing' ? 1 : 2);
    if ((await page.locator('#run-state').textContent()) === 'LIVE') await requestPause(page);
    await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
    const current = JSON.parse((await downloadMeasurements(page, 'json')).toString()),
      reference = new Ecosystem();
    advance(reference, current.snapshot.completedTick);
    expect(current.snapshot.settings).toEqual(reference.settings);
    expect(current.telemetry).toEqual(reference.save().telemetry);
    expect(current.interventions).toEqual(reference.save().interventions);
    const raw = await downloadPausedWorld(page),
      saved = JSON.parse(raw.toString());
    advance(reference, saved.tick - reference.tick);
    expect(saved).toEqual(reference.save());
    expect(raw).toEqual(Buffer.from(JSON.stringify(reference.save())));
    await testInfo.attach('native-ownership-counts.json', {
      contentType: 'application/json',
      body: JSON.stringify({
        mode,
        baseline,
        held,
        counts,
        downloads,
        beforeSHA256: createHash('sha256').update(before).digest('hex'),
        predecessorSHA256: predecessor && createHash('sha256').update(predecessor).digest('hex'),
        finalSHA256: createHash('sha256').update(raw).digest('hex'),
        limits:
          'Actual native Worker;36 ceiling preserved, one posted composed pipeline. Processing:256 blocked destructive intents. Delivery:256 actual alternating success/failure lifecycle completions after literal-byte posted Save drain. No OS picker, physical touch, heap/disk-duration or suspension drain guarantee.',
      }),
    });
  });
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

async function recordLineageDownload(
  testInfo: import('@playwright/test').TestInfo,
  label: string,
  bytes: Buffer,
) {
  const receipt = {
    label,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    worldVersion: JSON.parse(bytes.toString()).version,
    project: testInfo.project.name,
    limitation:
      'Native Worker/File/download APIs in desktop Chromium or iPhone13 Chromium mobile emulation, not a physical phone',
  };
  await testInfo.attach(`${label}.json`, { body: bytes, contentType: 'application/json' });
  await testInfo.attach(`${label}-receipt.json`, {
    body: JSON.stringify(receipt),
    contentType: 'application/json',
  });
}

test('lineage correction rejects provenance, FIFO order and omitted admissions without changing native complete saves', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const source = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
  source.spawn(admissionGenome(), 40, 40);
  advance(source, 31);
  const swapped = sameTickLineages().save();
  [swapped.lineageArchive.summaries[0], swapped.lineageArchive.summaries[1]] = [
    swapped.lineageArchive.summaries[1],
    swapped.lineageArchive.summaries[0],
  ];
  await page.goto('/');
  await requestPause(page);
  await importTelemetryWorld(page, source.save());
  await page.getByTitle('Inspect organism (I)').click();
  const at = await coordinate(page, 40, 40);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#inspector')).toContainText('Organism 1');
  const before = await downloadPausedWorld(page);
  advance(source, JSON.parse(before.toString()).tick - source.tick);
  expect(JSON.parse(before.toString())).toEqual(source.save());
  await recordLineageDownload(testInfo, 'lineage-correction-before', before);
  for (const [label, invalid] of [
    ['known-pruning', contradictoryPruning(false)],
    ['legacy-pruning', contradictoryPruning(true)],
    ['same-tick-order', swapped],
    ['omitted-newest-admission', omittedNewestAdmission()],
    ['impossible-readmission', impossibleReadmission()],
    ['false-pruning-claim', falsePruningClaim()],
    ['pruned-parent-order', reversedPrunedParent()],
    ['extinction-readmitted-parent-order', reversedReadmittedParent()],
    ['legacy-readmitted-parent-order', reversedReadmittedParent(true)],
    ['omitted-related-child', omittedRelatedChild()],
    ['missing-final-extinction', missingFinalExtinction()],
    ['extinction-occupancy', extinctionOccupancyContradiction()],
  ] as const) {
    const input = Buffer.from(JSON.stringify(invalid));
    await page
      .locator('#file')
      .setInputFiles({ name: `${label}.json`, mimeType: 'application/json', buffer: input });
    await expect(page.locator('#notice')).toHaveText('Invalid ecosystem lineage archive.');
    await expect(page.locator('#inspector')).toContainText('Organism 1');
    const after = await downloadPausedWorld(page);
    expect(after).toEqual(before);
    await recordLineageDownload(testInfo, `lineage-correction-${label}-input`, input);
    await recordLineageDownload(testInfo, `lineage-correction-${label}-recovery`, after);
  }
  await page.getByTitle('Advance one tick while paused').click();
  await expectPausedWorld(page, source.tick + 1);
  source.step();
  const continued = await downloadPausedWorld(page);
  expect(JSON.parse(continued.toString())).toEqual(source.save());
  await recordLineageDownload(testInfo, 'lineage-correction-rejection-continuation', continued);
  expect(errors).toEqual([]);
});

for (const parentOrder of [false, true])
  test(`lineage ${parentOrder ? 'pruned parent order' : 'round3 adjacent retained extinction'} survives native reload and the next FIFO admission`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await observeTelemetry(page);
    const reference = parentOrder ? prunedCreationOrder() : retainedAdjacentExtinction();
    const input = Buffer.from(JSON.stringify(reference.save()));
    expect(reference.lineageSnapshot().summaries[0]).toMatchObject({
      id: parentOrder ? 7 : 6,
      genomeStatus: 'retained',
      foundingGenome: admissionGenome(),
      extinctTick: 0,
    });
    await page.goto('/');
    await requestPause(page);
    await importTelemetryWorld(page, JSON.parse(input.toString()));
    const before = await downloadPausedWorld(page);
    advance(reference, JSON.parse(before.toString()).tick - reference.tick);
    expect(JSON.parse(before.toString())).toEqual(reference.save());
    await importTelemetryWorld(page, JSON.parse(before.toString()));
    advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
    await paintCell(page, 'plant', 80, 80);
    referenceManualPaint(reference, 'plant', 80, 80, 0, founder(0));
    await page.getByTitle('Advance one tick while paused').click();
    await expectPausedWorld(page, reference.tick + 1);
    reference.step();
    const continued = await downloadPausedWorld(page);
    expect(JSON.parse(continued.toString())).toEqual(reference.save());
    expect(reference.lineageSnapshot().summaries.map((row) => row.id)).toEqual(
      Array.from({ length: 256 }, (_, offset) => offset + (parentOrder ? 8 : 7)),
    );
    await importTelemetryWorld(page, JSON.parse(continued.toString()));
    advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
    await page.getByTitle('Advance one tick while paused').click();
    await expectPausedWorld(page, reference.tick + 1);
    reference.step();
    const reloaded = await downloadPausedWorld(page);
    expect(JSON.parse(reloaded.toString())).toEqual(reference.save());
    for (const [suffix, bytes] of [
      ['input', input],
      ['before', before],
      ['continued', continued],
      ['reload-step', reloaded],
    ] as const)
      await recordLineageDownload(
        testInfo,
        `lineage-${parentOrder ? 'pruned-parent' : 'r3-adjacent'}-${suffix}`,
        bytes,
      );
    expect(errors).toEqual([]);
  });

for (const legacy of [false, true])
  test(`lineage ${legacy ? 'legacy' : 'fresh'} parent readmission follows retained child through native FIFO continuation`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await observeTelemetry(page);
    const reference = readmittedParentOrder(legacy);
    const input = Buffer.from(JSON.stringify(reference.save()));
    expect(
      reference
        .lineageSnapshot()
        .summaries.slice(0, 2)
        .map((row) => row.id),
    ).toEqual([261, 5]);
    await page.goto('/');
    await requestPause(page);
    await importTelemetryWorld(page, JSON.parse(input.toString()));
    const before = await downloadPausedWorld(page);
    advance(reference, JSON.parse(before.toString()).tick - reference.tick);
    expect(JSON.parse(before.toString())).toEqual(reference.save());
    await importTelemetryWorld(page, JSON.parse(before.toString()));
    advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
    await paintCell(page, 'plant', 80, 80);
    referenceManualPaint(reference, 'plant', 80, 80, 0, founder(0));
    await page.getByTitle('Advance one tick while paused').click();
    await expectPausedWorld(page, reference.tick + 1);
    reference.step();
    const continued = await downloadPausedWorld(page);
    expect(JSON.parse(continued.toString())).toEqual(reference.save());
    expect(reference.lineageSnapshot().summaries.map((row) => row.id)).toEqual([
      5,
      ...Array.from({ length: 255 }, (_, offset) => offset + 262),
    ]);
    await importTelemetryWorld(page, JSON.parse(continued.toString()));
    advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
    await page.getByTitle('Advance one tick while paused').click();
    await expectPausedWorld(page, reference.tick + 1);
    reference.step();
    const reloaded = await downloadPausedWorld(page);
    expect(JSON.parse(reloaded.toString())).toEqual(reference.save());
    for (const [suffix, bytes] of [
      ['input', input],
      ['before', before],
      ['continued', continued],
      ['reload-step', reloaded],
    ] as const)
      await recordLineageDownload(
        testInfo,
        `lineage-${legacy ? 'legacy' : 'fresh'}-readmitted-parent-${suffix}`,
        bytes,
      );
    expect(errors).toEqual([]);
  });

test('lineage living-only child membership survives native reload and the next FIFO admission', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await observeTelemetry(page);
  const { world: reference } = relatedChildMembership(),
    input = Buffer.from(JSON.stringify(reference.save()));
  expect(
    reference
      .lineageSnapshot()
      .summaries.slice(0, 2)
      .map((row) => row.id),
  ).toEqual([260, 261]);
  await page.goto('/');
  await requestPause(page);
  await importTelemetryWorld(page, JSON.parse(input.toString()));
  const before = await downloadPausedWorld(page);
  advance(reference, JSON.parse(before.toString()).tick - reference.tick);
  expect(JSON.parse(before.toString())).toEqual(reference.save());
  await importTelemetryWorld(page, JSON.parse(before.toString()));
  advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
  await paintCell(page, 'plant', 80, 80);
  referenceManualPaint(reference, 'plant', 80, 80, 0, founder(0));
  await page.getByTitle('Advance one tick while paused').click();
  await expectPausedWorld(page, reference.tick + 1);
  reference.step();
  const continued = await downloadPausedWorld(page);
  expect(JSON.parse(continued.toString())).toEqual(reference.save());
  expect(reference.lineageSnapshot().summaries.map((row) => row.id)).toEqual([
    261,
    ...Array.from({ length: 255 }, (_, offset) => offset + 262),
  ]);
  await importTelemetryWorld(page, JSON.parse(continued.toString()));
  advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
  await page.getByTitle('Advance one tick while paused').click();
  await expectPausedWorld(page, reference.tick + 1);
  reference.step();
  const reloaded = await downloadPausedWorld(page);
  expect(JSON.parse(reloaded.toString())).toEqual(reference.save());
  for (const [suffix, bytes] of [
    ['input', input],
    ['before', before],
    ['continued', continued],
    ['reload-step', reloaded],
  ] as const)
    await recordLineageDownload(testInfo, `lineage-related-child-membership-${suffix}`, bytes);
  expect(errors).toEqual([]);
});

for (const legacy of [false, true])
  test(`lineage round2 ${legacy ? 'unknown legacy' : 'known overflow'} membership survives native reload and continuation`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await observeTelemetry(page);
    let reference = sameTickLineages();
    reference.spawn(admissionGenome(), 40, 40);
    if (legacy) {
      reference = Ecosystem.load(JSON.stringify(legacyV5(reference.save())));
      const unknown = reference.save();
      [unknown.lineageArchive.summaries[0], unknown.lineageArchive.summaries[1]] = [
        unknown.lineageArchive.summaries[1],
        unknown.lineageArchive.summaries[0],
      ];
      expect(unknown.lineageArchive.events).toEqual([]);
      reference = Ecosystem.load(JSON.stringify(unknown));
    }
    const initialIds = reference.lineageSnapshot().summaries.map((row) => row.id);
    expect(initialIds.slice(0, 2)).toEqual(legacy ? [7, 6] : [6, 7]);
    expect(initialIds.at(-1)).toBe(261);
    const input = Buffer.from(JSON.stringify(reference.save())),
      label = `lineage-r2-${legacy ? 'unknown' : 'known'}-membership`;
    await page.goto('/');
    await requestPause(page);
    await importTelemetryWorld(page, JSON.parse(input.toString()));
    const before = await downloadPausedWorld(page);
    advance(reference, JSON.parse(before.toString()).tick - reference.tick);
    expect(JSON.parse(before.toString())).toEqual(reference.save());
    await paintCell(page, 'plant', 80, 80);
    referenceManualPaint(reference, 'plant', 80, 80, 0, founder(0));
    await page.getByTitle('Advance one tick while paused').click();
    await expectPausedWorld(page, reference.tick + 1);
    reference.step();
    const continued = await downloadPausedWorld(page);
    expect(JSON.parse(continued.toString())).toEqual(reference.save());
    expect(reference.lineageSnapshot().summaries.map((row) => row.id)).toEqual([
      ...initialIds.slice(1),
      262,
    ]);
    await importTelemetryWorld(page, JSON.parse(continued.toString()));
    advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
    await page.getByTitle('Advance one tick while paused').click();
    await expectPausedWorld(page, reference.tick + 1);
    reference.step();
    const reloaded = await downloadPausedWorld(page);
    expect(JSON.parse(reloaded.toString())).toEqual(reference.save());
    for (const [suffix, bytes] of [
      ['input', input],
      ['before', before],
      ['continued', continued],
      ['reload-step', reloaded],
    ] as const)
      await recordLineageDownload(testInfo, `${label}-${suffix}`, bytes);
    expect(errors).toEqual([]);
  });

test('lineage correction preserves actual same-tick overflow and extinction readmission through native reload and continuation', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await observeTelemetry(page);
  const reference = sameTickLineages();
  reference.spawn(admissionGenome(), 40, 40);
  reference.kill(reference.organisms.get(1)!, 'manual');
  reference.kill(reference.organisms.get(2)!, 'manual');
  expect(
    reference
      .lineageSnapshot()
      .summaries.slice(-2)
      .map((row) => row.genomeStatus),
  ).toEqual(['pruned', 'pruned']);
  await page.goto('/');
  await requestPause(page);
  await importTelemetryWorld(page, reference.save());
  const before = await downloadPausedWorld(page);
  advance(reference, JSON.parse(before.toString()).tick - reference.tick);
  expect(JSON.parse(before.toString())).toEqual(reference.save());
  await importTelemetryWorld(page, JSON.parse(before.toString()));
  advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
  await paintCell(page, 'plant', 80, 80);
  referenceManualPaint(reference, 'plant', 80, 80, 0, founder(0));
  await expect(page.locator('#population')).toHaveText('256');
  await page.getByTitle('Advance one tick while paused').click();
  await expectPausedWorld(page, reference.tick + 1);
  reference.step();
  const continued = await downloadPausedWorld(page),
    state = JSON.parse(continued.toString()) as WorldFile;
  expect(state).toEqual(reference.save());
  expect(state.lineageArchive.summaries[0].id).toBe(9);
  await importTelemetryWorld(page, state);
  advance(reference, (await telemetryFrame(page)).stats.tick - reference.tick);
  await page.getByTitle('Advance one tick while paused').click();
  await expectPausedWorld(page, reference.tick + 1);
  reference.step();
  const reloaded = await downloadPausedWorld(page);
  expect(JSON.parse(reloaded.toString())).toEqual(reference.save());
  await recordLineageDownload(testInfo, 'lineage-correction-valid-overflow', before);
  await recordLineageDownload(testInfo, 'lineage-correction-valid-continuation', continued);
  await recordLineageDownload(testInfo, 'lineage-correction-valid-reload-step', reloaded);
  expect(errors).toEqual([]);
});

test('lineage v5 unknown history survives real extinction, native v6 reload and the next exact Step', async ({
  page,
}, testInfo) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('data:'))
      external.push(request.url());
  });
  await observeTelemetry(page);
  const source = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false);
  advance(source, 29);
  const organism = source.spawn(
    {
      behavior: { version: 1, mode: 'legacy' },
      cells: [{ x: 0, y: 0, type: 7 }],
      preference: 0.5,
      tolerance: 0.3,
      tempo: 2,
    },
    40,
    40,
  )!;
  organism.age = 975;
  const fixture = legacyV5(source.save()),
    input = Buffer.from(JSON.stringify(fixture));
  expect(fixture.version).toBe(5);
  expect(fixture).not.toHaveProperty('lineageArchive');
  const reference = Ecosystem.load(input.toString());
  reference.step();
  await page.goto('/');
  await importTelemetryWorld(page, fixture, true);
  await expectPausedWorld(page, 30);
  const terminalBytes = await downloadPausedWorld(page),
    terminal = JSON.parse(terminalBytes.toString()) as WorldFile;
  expect(terminal).toEqual(reference.save());
  expect(terminal.lineageArchive).toMatchObject({
    originKind: 'legacy-import',
    originTick: 29,
    living: [],
    events: [{ kind: 'extinct', id: organism.species, tick: 30 }],
  });
  expect(terminal.lineageArchive.summaries[0]).toMatchObject({
    origin: 'legacy-unknown',
    createdTick: null,
    parentId: null,
    foundingGenome: null,
    genomeStatus: 'legacy-unknown',
    peakKind: 'since-origin',
    extinctTick: 30,
  });
  await paintCell(page, 'plant', 80, 80);
  referenceManualPaint(reference, 'plant', 80, 80, 0, founder(0));
  await expect(page.locator('#population')).toHaveText('1');
  const placedBytes = await downloadPausedWorld(page),
    placed = JSON.parse(placedBytes.toString()) as WorldFile;
  expect(placed).toEqual(reference.save());
  expect(placed.lineageArchive.living[0]).toMatchObject({
    origin: 'manual',
    createdTick: 30,
    parentId: null,
  });
  await importTelemetryWorld(page, placed);
  const restoredBytes = await downloadPausedWorld(page),
    restored = JSON.parse(restoredBytes.toString()) as WorldFile;
  advance(reference, restored.tick - reference.tick);
  expect(restored).toEqual(reference.save());
  await stepTo(page, restored.tick + 1);
  reference.step();
  const steppedBytes = await downloadPausedWorld(page);
  expect(JSON.parse(steppedBytes.toString())).toEqual(reference.save());
  for (const [label, bytes] of [
    ['lineage-legacy-terminal', terminalBytes],
    ['lineage-manual-placement', placedBytes],
    ['lineage-current-reload', restoredBytes],
    ['lineage-exact-step', steppedBytes],
  ] as const)
    await recordLineageDownload(testInfo, label, bytes);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

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
  behavior: { version: 1 as const, mode: 'legacy' as const },
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
    'behavior',
    'cells',
    'preference',
    'tempo',
    'tolerance',
  ]);
  expect(inspector.file).toMatchObject({
    format: 'evolab-organism-blueprint',
    version: 2,
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
      notice: 'Unsupported blueprint version. Expected version 1 or 2.',
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
      version: 2,
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
      behavior: { version: 1 as const, mode: 'legacy' as const },
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
  await importTelemetryWorld(page, initial.save());
  const beforeBytes = await downloadPausedWorld(page),
    before = JSON.parse(beforeBytes.toString()) as WorldFile,
    reference = Ecosystem.load(beforeBytes.toString()),
    payload = {
      name: 'Telemetry-safe blueprint',
      description: 'Designer only',
      genome: sharedGenome(),
    };
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.getByLabel('Recorded sample', { exact: true }).selectOption('30');
  await expect(page.locator('#telemetry-details caption')).toHaveText('Selected sample at tick 30');
  const points = await page.evaluate(() => window.telemetryEvidence.points);
  expect(points).toHaveLength(2);
  await page.getByRole('tab', { name: 'Organism', exact: true }).click();
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
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await expect(page.getByLabel('Recorded sample', { exact: true })).toHaveValue('30');
  await page.getByLabel('Telemetry view', { exact: true }).selectOption('adaptation');
  await expect(page.locator('#telemetry-details caption')).toHaveText('Selected sample at tick 30');
  expect(
    await page
      .locator('[data-bin]')
      .evaluateAll((bars) => bars.map((bar) => Number(bar.getAttribute('data-count')))),
  ).toEqual(before.telemetry.samples[0].adaptation!.preferenceBins);
  await page.getByRole('tab', { name: 'Organism', exact: true }).click();
  expect((await downloadBlueprint(page)).file).toMatchObject(payload);
  expect(await downloadWorld(page)).toEqual(beforeBytes);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#plant-design').click();
  const target = await coordinate(page, 80, 80);
  await page.mouse.click(target.x, target.y);
  await expect(page.locator('#population')).toHaveText(String(before.organisms.length + 1));
  referenceManualPaint(reference, 'plant', 80, 80, 0, payload.genome);
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
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await expect(page.getByLabel('Telemetry view', { exact: true })).toHaveValue('adaptation');
  await expect(page.getByLabel('Recorded sample', { exact: true })).toHaveValue('30');
  await expect(page.locator('#telemetry-details caption')).toHaveText('Selected sample at tick 30');
  await page.getByRole('tab', { name: 'Organism', exact: true }).click();
  await importTelemetryWorld(page, continued);
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
test('blueprint designer preserves manual extinction and revives without resuming or rewriting telemetry', async ({
  page,
}, testInfo) => {
  await observeTelemetry(page);
  const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false),
    genome: Genome = {
      behavior: { version: 1 as const, mode: 'legacy' as const },
      cells: [{ x: 0, y: 0, type: 7 }],
      preference: 0.5,
      tolerance: 0.3,
      tempo: 2,
    },
    payload = { name: 'Paused revival', description: 'Extinction-safe designer', genome };
  reference.spawn(genome, 40, 40);
  for (let tick = 0; tick < 90; tick++) reference.step();
  reference.paint('erase', 40, 40, 0, genome);
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await importTelemetryWorld(page, reference.save());
  await expectPausedWorld(page, 90);
  const importDesign = async () => {
    await page.locator('#blueprint-file').setInputFiles({
      name: 'revival.json',
      mimeType: 'application/json',
      buffer: Buffer.from(serializeBlueprint(payload)),
    });
    await expect(page.locator('#notice')).toHaveText(
      'Blueprint loaded into the designer. Place it explicitly to add an organism.',
    );
    await expect(page.locator('#blueprint-file')).toHaveValue('');
  };
  await importDesign();
  await page.locator('#plant-design').click();
  const target = await coordinate(page, 80, 80);
  await page.mouse.click(target.x, target.y);
  referenceManualPaint(reference, 'plant', 80, 80, 0, genome);
  await expect(page.locator('#population')).toHaveText('1');
  await page.locator('#brush').evaluate((input: HTMLInputElement) => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await paintCell(page, 'erase', 80, 80);
  referenceManualPaint(reference, 'erase', 80, 80, 0, genome);
  await expect(page.locator('#population')).toHaveText('0');
  await expectPausedWorld(page, 90);
  await expect(page.locator('#extinction-summary')).toContainText('Last removal: manual erasure.');
  const extinct = await downloadPausedWorld(page);
  expect(JSON.parse(extinct.toString())).toEqual(reference.save());
  expect(reference.save().telemetry.samples.at(-1)).toMatchObject({ tick: 90, population: 1 });
  expect(reference.save().telemetry.pending.deaths.manual).toBe(2);
  await importDesign();
  await page.locator('#blueprint-file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.locator('#notice')).toHaveText(
    'Choose a standalone EvoLab organism blueprint.',
  );
  await expect(page.locator('#blueprint-file')).toHaveValue('');
  await page.locator('#blueprint-file').setInputFiles([]);
  await expect(page.locator('#blueprint-file')).toHaveValue('');
  expect(await downloadPausedWorld(page)).toEqual(extinct);
  await expect(page.locator('#extinction-summary')).toContainText('Last removal: manual erasure.');
  await page.locator('#plant-design').click();
  await page.mouse.click(target.x, target.y);
  referenceManualPaint(reference, 'plant', 80, 80, 0, genome);
  await expect(page.locator('#population')).toHaveText('1');
  await expect(page.locator('#extinction-summary')).toBeHidden();
  await expectPausedWorld(page, 90);
  expect((await telemetryFrame(page)).telemetry).toEqual(reference.save().telemetry);
  await stepTo(page, 120);
  for (let tick = 91; tick <= 120; tick++) reference.step();
  const continuedBytes = await downloadPausedWorld(page),
    continued = JSON.parse(continuedBytes.toString()) as WorldFile;
  expect(continued).toEqual(reference.save());
  const extinctWorld = JSON.parse(extinct.toString()) as WorldFile;
  const revived = continued.organisms[0];
  expect(extinctWorld.lineageArchive.living).toEqual([]);
  expect(continued.lineageArchive.living[0]).toMatchObject({
    id: revived.species,
    origin: 'manual',
    parentId: null,
    createdTick: 90,
  });
  expect(
    continued.lineageArchive.events
      .filter((event) => event.kind === 'created')
      .map((event) => event.id),
  ).toEqual([5, 6, 7]);
  expect(revived.species).toBe(7);
  expect(revived.ancestry).toEqual([]);
  expect(continued.births).toBe(0);
  await recordLineageDownload(testInfo, 'lineage-revival-extinct', extinct);
  await recordLineageDownload(testInfo, 'lineage-revival-continued', continuedBytes);
  expect(continued.telemetry.samples.at(-1)).toMatchObject({
    tick: 120,
    population: 1,
    births: 0,
    deaths: { manual: 2 },
  });
  await testInfo.attach('blueprint-extinction-integration.json', {
    contentType: 'application/json',
    body: JSON.stringify({ extinct: JSON.parse(extinct.toString()), continued }),
  });
  await page.screenshot({
    path: testInfo.outputPath('blueprint-extinction-revival.png'),
    fullPage: true,
  });
});

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
  world.interventions = history.save().interventions;
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
            genome: {
              cells: [{ x: 0, y: 0, type: 3 }],
              preference: 0.5,
              tolerance: 0.3,
              tempo: 2,
              behavior: { version: 1, mode: 'legacy' },
            },
          },
        ];
  return Ecosystem.load(JSON.stringify(legacyV5(world))).save();
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
  }, testInfo) => {
    await page.goto('/');
    await pause(page);
    const fixture = await extinctionFixture(page, 'living');
    await importWorld(page, fixture);
    await expect(page.locator('#notice')).toContainText('World restored');
    await pause(page);
    await paintCell(page, 'inspect', 120, 78);
    await expect(page.locator('#inspector')).toContainText(`Organism ${fixture.organisms[0].id}`);
    await page.locator('#pause-on-extinction').uncheck();
    const retainedBytes = await downloadPausedWorld(page),
      saved = JSON.parse(retainedBytes.toString()) as WorldFile;
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
    await page.locator('#pause-on-extinction').focus();
    const invalidArchive = structuredClone(saved);
    invalidArchive.lineageArchive.living[0].liveCount++;
    await importWorld(page, invalidArchive);
    await expect(page.locator('#notice')).toContainText('Invalid ecosystem lineage archive');
    await expectPausedWorld(page, saved.tick);
    await expect(page.locator('#pause-on-extinction')).not.toBeChecked();
    await expect(page.locator('#pause-on-extinction')).toBeFocused();
    await expect(page.locator('#inspector')).toContainText(`Organism ${fixture.organisms[0].id}`);
    const recoveredBytes = await downloadPausedWorld(page);
    expect(recoveredBytes).toEqual(retainedBytes);
    await recordLineageDownload(testInfo, 'lineage-recovery-before', retainedBytes);
    await recordLineageDownload(testInfo, 'lineage-recovery-after', recoveredBytes);
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
              delivery.nutrients = event.data.recovery.state.settings.nutrients;
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
    const populations = before.telemetry.samples.map((sample) => sample.population);
    await expectPopulationChart(page, populations);
    expect(before.telemetry.samples).toHaveLength(13);
    await importWorld(page, { ...fixture, version: 99 } as unknown as WorldFile);
    await expect.poll(() => page.evaluate('window.recoveryDelivery.nutrients')).toBe(0);
    await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
    await page.getByText('World settings', { exact: true }).click();
    await page.locator('#nutrients').fill('3');
    await page.locator('#mutation').fill('0.37');
    await page.locator('#climate').fill('0.25');
    await page.locator('#nutrients').fill('7');
    const reference = Ecosystem.load(JSON.stringify(before));
    reference.changeSettings({ nutrients: 7, mutation: 0.37, climate: 0.25 });
    const expected = reference.save();
    const pendingSave = readWorld(page);
    const recoveryNotice = await page.evaluate(
      '(() => { window.recoveryDelivery.release(); return document.getElementById("notice").textContent; })()',
    );
    expect(recoveryNotice).toContain('version 2, 3, 4, 5, 6, 7, 8 or 9');
    expect(await pendingSave).toEqual(expected);
    await expect(page.locator('#notice')).toContainText('World saved');
    await expect(page.locator('#nutrients')).toHaveValue('7');
    await expect(page.locator('#nutrients-value')).toHaveText('7%');
    await expect(page.locator('#mutation-value')).toHaveText('37%');
    await expect(page.locator('#climate-value')).toHaveText('25%');
    await expectPausedWorld(page, fixture.tick);
    await expect(page.locator('#extinction-summary')).toHaveText(summary!);
    await expectPopulationChart(page, populations);
    expect((await telemetryFrame(page)).telemetry).toEqual(before.telemetry);
    expect(await readWorld(page)).toEqual(expected);
    await page.waitForTimeout(200);
    expect(await readWorld(page)).toEqual(expected);
    await page.getByRole('button', { name: 'Reseed world' }).click();
    await page.locator('#confirm-reset').click();
    await pause(page);
    const reseeded = await readWorld(page);
    expect(reseeded.settings).toEqual(expected.settings);
    await expect(page.locator('#nutrients-value')).toHaveText('7%');
    await testInfo.attach('settings-recovery-evidence', {
      body: JSON.stringify({
        snapshotNutrients: 0,
        recoveryNotice,
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
    await page.locator('#confirm-reset').click();
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
          behavior: { version: 1 as const, mode: 'legacy' as const },
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
      const populations = terminal.telemetry.samples.map((sample) => sample.population);
      expect(populations).toHaveLength(3);
      await expectPopulationChart(page, populations);
      await importWorld(page, { ...terminal, version: 99 } as unknown as WorldFile);
      await expect(page.locator('#notice')).toContainText('version 2, 3, 4, 5, 6, 7, 8 or 9');
      expect(await readWorld(page)).toEqual(terminal);
      await expectPopulationChart(page, populations);
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
      behavior: { version: 1 as const, mode: 'legacy' as const },
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
    await expectPopulationChart(
      page,
      before.samples.map((sample) => sample.population),
    );
    const rendered = await page.evaluate(() => ({
      telemetry: window.telemetryEvidence.source!.telemetry,
      points: window.telemetryEvidence.points,
      width: (document.querySelector('#telemetry-plots svg') as SVGSVGElement).viewBox.baseVal
        .width,
      fits: document.documentElement.scrollWidth <= innerWidth,
      chartOutsideHabitat: (() => {
        const chart = document.querySelector('#telemetry')!.getBoundingClientRect(),
          world = document.querySelector('#world')!.getBoundingClientRect();
        return chart.left >= world.right || chart.top >= world.bottom;
      })(),
    }));
    expect(rendered.telemetry).toEqual(before);
    expect(rendered.points).toHaveLength(before.samples.length);
    const maximum = Math.max(1, ...before.samples.map((sample) => sample.population));
    expect(rendered.points).toEqual(
      before.samples.map((sample) => [
        50 +
          ((sample.tick - before.samples[0].tick) /
            (before.samples.at(-1)!.tick - before.samples[0].tick)) *
            (rendered.width - 64),
        144 - (sample.population / maximum) * 128,
      ]),
    );
    expect(rendered.fits).toBe(true);
    expect(rendered.chartOutsideHabitat).toBe(true);
    await test.info().attach(`restored-population-chart-${width}`, {
      body: await page.locator('#telemetry').screenshot(),
      contentType: 'image/png',
    });
  }
  frame = await telemetryFrame(page);
  expect(frame.telemetry).toEqual(before);
  const downloaded = JSON.parse((await downloadWorld(page)).toString());
  expect(downloaded.telemetry).toEqual(before);
  expect(downloaded.version).toBe(9);
  expect(downloaded.telemetry.version).toBe(2);
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
  await page.locator('#confirm-reset').click();
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
  expect(world.version).toBe(9);
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
  await page.locator('#confirm-reset').click();
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

async function refugeLoad(page: import('@playwright/test').Page, text: string): Promise<number> {
  const before = await page.evaluate(() => window.terrainNative.lifecycle.at(-1)?.requestId ?? 0);
  await page.locator('#file').setInputFiles({
    name: 'original-refuge-fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.lifecycle.at(-1)?.requestId ?? 0))
    .toBeGreaterThan(before);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#world').scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const native = window.terrainNative,
          latest = native.lifecycle.at(-1);
        return (
          native.frameRunId === latest?.runId &&
          (latest?.paused || !!latest?.pauseAcknowledgedSequence) &&
          native.playback?.paused
        );
      }),
    )
    .toBe(true);
  await test
    .info()
    .attach('original-input.json', { body: Buffer.from(text), contentType: 'application/json' });
  return page.evaluate(() => window.terrainNative.frame!.stats.tick);
}

async function refugeControls(page: import('@playwright/test').Page, radius = 0, intensity = 4) {
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  for (const [id, value] of [
    ['brush', radius],
    ['refuge-intensity', intensity],
  ] as const)
    await page.locator(`#${id}`).evaluate((input: HTMLInputElement, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input'));
    }, value);
}

async function refugeMode(page: import('@playwright/test').Page, enabled: boolean) {
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  if ((await page.locator('#refuge-enabled').isChecked()) !== enabled)
    await page.locator('#refuge-enabled').click();
  await expect(page.locator('#refuge-enabled')).toBeChecked({ checked: enabled });
  // A mobile sidebar action can hide the habitat; reveal it before requiring a new grid.
  await page.locator('#world').scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.frame?.thermalRefuges.enabled))
    .toBe(enabled);
}

async function refugePaint(
  page: import('@playwright/test').Page,
  tool: 'warm' | 'cool' | 'erase-temperature',
  x: number,
  y: number,
  zoom = 1,
) {
  const previous = await page.evaluate(() => window.terrainNative.manual?.commandId ?? 0);
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.locator(`button[data-tool="${tool}"]`).click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const anchor = await page.locator('#world').evaluate(
    (canvas: HTMLCanvasElement, point) => {
      const rect = canvas.getBoundingClientRect(),
        scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156) * point.zoom;
      return {
        x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (point.x + 0.5) * scale,
        y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (point.y + 0.5) * scale,
      };
    },
    { x, y, zoom },
  );
  await page.mouse.click(anchor.x, anchor.y);
  // The ordinary end-stroke receipt follows the paint result and any frame
  // on the same native FIFO channel, including rejected/no-op dabs.
  await expect
    .poll(() =>
      page.evaluate((previous) => {
        const terminal = window.terrainNative.manual;
        return terminal?.operation === 'end-stroke' && terminal.commandId > previous;
      }, previous),
    )
    .toBe(true);
}

async function refugeProtocol(page: import('@playwright/test').Page, receiptDriven = true) {
  const evidence = await page.evaluate(() => ({
    lifecycle: window.terrainNative.lifecycle,
    errors: window.terrainNative.errors,
    saved: window.terrainNative.saved,
    fifoPauses: window.terrainNative.fifoPauses,
  }));
  if (receiptDriven) expectReceiptDrivenTerrainPauses(evidence.lifecycle);
  else {
    expect(evidence.fifoPauses).toBeGreaterThan(0);
    for (const receipt of evidence.lifecycle) {
      expect(receipt.completedTick).toBe(0);
      if (receipt.paused) {
        expect(receipt.pausePostedSequence).toBeNull();
        continue;
      }
      expect(receipt.pausePostedSequence!).toBeGreaterThan(receipt.receivedSequence);
      expect(receipt.pauseAcknowledgedSequence).not.toBeNull();
      expect(receipt.pauseAcknowledgedSequence!).toBeGreaterThan(receipt.pausePostedSequence!);
    }
  }
  await test.info().attach('native-refuge-protocol.json', {
    body: JSON.stringify(evidence),
    contentType: 'application/json',
  });
}

test('B23-1 opt-in empty field retains the complete original climate trajectory through native Save/reload/Step', async ({
  page,
}) => {
  await observeTerrainNative(page, 'lifecycle-receipt');
  await page.goto('/');
  await terrainNativeFrame(page);
  await expect(page.locator('#refuge-enabled')).not.toBeChecked();
  const original = fixtureText('capture-attempt3/inputs/seed-42-porous-ridges.json'),
    reference = acceptedReference(original);
  const initialTick = (await terrainNativeFrame(page)).frame.stats.tick;
  while (reference.tick < initialTick) reference.step();
  await refugeMode(page, true);
  const first = await terrainSave(page, 'neutral-enabled.json');
  expect(first.thermalRefuges).toEqual({ version: 1, enabled: true, cells: [] });
  expect(first.interventions.entries).toEqual([
    {
      sequence: 1,
      origin: 'manual',
      kind: 'refuge-mode',
      firstTick: initialTick,
      lastTick: initialTick,
      detail: { rulesVersion: 1, before: false, after: true },
    },
  ]);
  const compare = (saved: WorldFile) => {
    while (reference.tick < saved.tick) reference.step();
    const { thermalRefuges: _field, lineageArchive: _archive, ...retained } = saved;
    expect({
      ...retained,
      organisms: restoreHistoricalWorld(saved).organisms,
      version: 6,
      interventions: reference.save().interventions,
    }).toEqual(reference.save());
  };
  compare(first);
  await refugeLoad(page, JSON.stringify(first));
  await page.locator('#step').click();
  const second = await terrainSave(page, 'neutral-reloaded-step.json');
  compare(second);
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await page.locator('#thermal').click();
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-out').click();
  await page.locator('#step').click();
  const third = await terrainSave(page, 'neutral-view-step.json');
  compare(third);
  expect(third.interventions).toEqual(first.interventions);
  await refugeProtocol(page);
});

function controlledRefuge(name: string, units: number) {
  const original = fixtureText(`capture-attempt3/inputs/${name}.json`),
    reference = acceptedReference(original),
    saved = JSON.parse(original);
  const current = {
    ...saved,
    version: 7,
    thermalRefuges: { version: 1, enabled: true, cells: [[index(120, 78), units]] },
    interventions: { ...saved.interventions, version: 3 },
  };
  const metabolic = JSON.parse(original);
  metabolic.eventOffset = units / 100;
  metabolic.eventUntil = 900;
  return { original, current, reference, metabolic: acceptedReference(JSON.stringify(metabolic)) };
}

test('B23-2 signed thermal arms pay actual energy for first-tick funded birth, not metric-only preference', async ({
  page,
}) => {
  await observeTerrainNative(page);
  await page.goto('/');
  await terrainNativeFrame(page);
  for (const units of [25, -25]) {
    const control = controlledRefuge('threshold-0.75-open', units);
    expect(await refugeLoad(page, JSON.stringify(control.current))).toBe(0);
    await page.locator('#step').click();
    control.metabolic.step();
    const saved = await terrainSave(page, `funded-${units}.json`),
      old = control.metabolic.save();
    expect(saved.births).toBe(units === 25 ? 1 : 0);
    expect(saved.organisms[0].children).toBe(units === 25 ? 1 : 0);
    expect(saved.telemetry.pending.energy.offspringGranted).toBe(units === 25 ? 10.5 : 0);
    expect(predecessor(saved)).toEqual({ ...old, eventOffset: 0, eventUntil: 0 });
  }
  await refugeProtocol(page, false);
});

test('B23-3 wrapped additive manual dabs share camera coordinates and never edit life, food or walls at command time', async ({
  page,
}) => {
  await observeTerrainNative(page, 'lifecycle-receipt');
  await page.goto('/');
  await terrainNativeFrame(page);
  const original = JSON.parse(fixtureText('capture-attempt3/inputs/threshold-0.75-open.json'));
  original.organisms[0].x = 239;
  original.organisms[0].y = 155;
  original.organisms[0].rotation = 1;
  original.food = [index(10, 10)];
  original.walls = [index(4, 4)];
  const reference = Ecosystem.load(JSON.stringify(original));
  advance(reference, await refugeLoad(page, JSON.stringify(original)));
  const before = await terrainSave(page, 'wrapped-before.json');
  expect(before).toEqual(reference.save());
  await refugeControls(page, 1, 25);
  await refugeMode(page, true);
  reference.changeRefugeMode(true);
  await page.locator('#zoom-out').click();
  for (const tool of ['warm', 'warm', 'cool', 'erase-temperature'] as const) {
    await refugePaint(page, tool, 0, 0, 1 / 1.4);
    reference.paintRefuge(
      { rulesVersion: 1, tool, units: tool === 'warm' ? 25 : tool === 'cool' ? -25 : 0, radius: 1 },
      0,
      0,
    );
    expect((await terrainNativeFrame(page)).frame).toEqual(terrainExpectedFrame(reference));
  }
  await refugePaint(page, 'warm', 0, 0, 1 / 1.4);
  reference.paintRefuge({ rulesVersion: 1, tool: 'warm', units: 25, radius: 1 }, 0, 0);
  expect(reference.thermalRefuges.units[index(-1, 0)]).toBe(25);
  await refugeMode(page, false);
  reference.changeRefugeMode(false);
  await expect(page.locator('#refuge-summary')).toContainText('Disabled · stored paint');
  await refugeMode(page, true);
  reference.changeRefugeMode(true);
  await page.locator('#clear-refuges').click();
  reference.clearRefuges();
  const after = await terrainSave(page, 'wrapped-after.json');
  expect(after).toEqual(reference.save());
  expect({
    ...after,
    thermalRefuges: before.thermalRefuges,
    interventions: before.interventions,
  }).toEqual(before);
  await refugeProtocol(page);
});

test('B23-4 capacity and late-load rejection preserve full state while stale manual owners drain across replacement', async ({
  page,
}) => {
  await observeMeasurementOwnership(page);
  await observeTerrainNative(page, 'lifecycle-receipt');
  await page.goto('/');
  await terrainNativeFrame(page);
  const original = JSON.parse(fixtureText('capture-attempt3/inputs/threshold-0.75-open.json'));
  const candidate = {
      ...original,
      version: 7,
      thermalRefuges: {
        version: 1,
        enabled: true,
        cells: Array.from({ length: 4096 }, (_, position) => [position, 32]),
      },
      interventions: { ...original.interventions, version: 3 },
    },
    text = JSON.stringify(candidate),
    reference = Ecosystem.load(text);
  advance(reference, await refugeLoad(page, text));
  await refugeSelected(page);
  const before = await terrainSave(page, 'capacity-before.json');
  expect(before).toEqual(reference.save());
  await refugeControls(page, 8, 4);
  await refugePaint(page, 'warm', 120, 78);
  await expect(page.locator('#notice')).toContainText('capacity');
  const bad = structuredClone(candidate);
  bad.thermalRefuges.cells[4095][1] = 33;
  await page.locator('#file').setInputFiles({
    name: 'late-malformed-field.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bad)),
  });
  await expect(page.locator('#notice')).toContainText('Invalid painted temperature cell');
  const recoveryRun = await page.evaluate(() => window.terrainNative.errors.at(-1).runId);
  const retained = await terrainSave(page, 'capacity-recovered.json');
  expect(retained).toEqual(before);
  await expect.poll(() => page.evaluate(() => window.terrainNative.selected?.id)).toBe(1);
  await page.locator('#step').click();
  reference.step();
  await expect(page.locator('#tick')).toHaveText(`TICK ${reference.tick.toLocaleString()}`);
  expect((await terrainNativeFrame(page, recoveryRun)).frame).toEqual(
    terrainExpectedFrame(reference),
  );
  await page.evaluate(() => {
    window.measurementGate.deliveryBlocked = true;
  });
  try {
    await refugeMode(page, false);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...window.measurementGate.pending.values()].filter(
              (owner: any) => owner.operation === 'refuge-mode',
            ).length,
        ),
      )
      .toBe(1);
    const replacement = Ecosystem.load(text);
    const loading = refugeLoad(page, text);
    await expect(page.locator('#save')).toBeDisabled();
    await page.evaluate(() => window.measurementGate.releaseResults());
    const tick = await loading;
    advance(replacement, tick);
    await expect(page.locator('#refuge-enabled')).toBeChecked();
    await page.locator('#step').click();
    replacement.step();
    const final = await terrainSave(page, 'capacity-new-run-step.json');
    expect(final).toEqual(replacement.save());
    expect(final.thermalRefuges.enabled).toBe(true);
    await expect.poll(() => page.evaluate(() => window.measurementGate.pending.size)).toBe(0);
  } finally {
    await page.evaluate(() => window.measurementGate.releaseResults());
  }
  const successful = await page.evaluate(() => window.terrainNative.lifecycle);
  expectReceiptDrivenTerrainPauses(successful);
  await test.info().attach('capacity-owner-recovery.json', {
    body: JSON.stringify({ successful, completeRetainedSave: true, capacity: 4096 }),
    contentType: 'application/json',
  });
});

test('B23-5 authoritative anchor temperature determines real survival, body food and extinction without rescue', async ({
  page,
}) => {
  await observeTerrainNative(page);
  await page.addInitScript(() => {
    window.refugePixels = null;
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      const result = Reflect.apply(put, this, args),
        pixels = args[0],
        frame = window.terrainNative?.frame;
      if (pixels.width === 240 && pixels.height === 156 && frame)
        window.refugePixels = {
          tick: frame.stats.tick,
          climate: frame.climate,
          offset: frame.offset,
          colors: [0, 78 * 240 + 120, 78 * 240 + 121, 37439].map((position) =>
            Array.from(pixels.data.slice(position * 4, position * 4 + 4)),
          ),
        };
      return result;
    };
  });
  await page.goto('/');
  await terrainNativeFrame(page);
  for (const units of [25, -25]) {
    const control = controlledRefuge('armor-survival', units);
    // The adjacent empty painted cell exposes the same thermal rule through
    // the real Canvas path while the occupied anchor retains its anatomy color.
    control.current.thermalRefuges.cells.push([index(121, 78), units]);
    expect(await refugeLoad(page, JSON.stringify(control.current))).toBe(0);
    await page.locator('#step').click();
    control.metabolic.step();
    const saved = await terrainSave(page, `survival-${units}.json`);
    expect(predecessor(saved)).toEqual({
      ...control.metabolic.save(),
      eventOffset: 0,
      eventUntil: 0,
    });
    expect(saved.organisms.length).toBe(units === 25 ? 1 : 0);
    expect(saved.deaths).toBe(units === 25 ? 0 : 1);
    expect(saved.telemetry.pending.deaths.energy).toBe(units === 25 ? 0 : 1);
    if (units === 25) {
      await page.getByRole('button', { name: 'Inspect', exact: true }).click();
      const anchor = await coordinate(page, 120, 78);
      await page.mouse.click(anchor.x, anchor.y);
      await expect(page.locator('#inspector')).toContainText('0.75');
      await expect(page.locator('#inspector')).toContainText('+0.25 (25 units)');
      const native = await terrainNativeFrame(page),
        expected = localTemperature(120, 78, saved.tick, saved.settings.climate, 0, {
          version: 1,
          enabled: true,
          units: Int8Array.from({ length: WIDTH * HEIGHT }, (_, position) =>
            position === index(120, 78) ? 25 : 0,
          ),
        });
      expect(expected).toBe(0.75);
      expect(native.selected.energy).toBe(0.05 - 0.012);
      await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
      // Add drift and a real heatwave at the paused command tick. This changes
      // the environment without retroactively spending energy or making samples.
      await terrainSettings(page);
      await page.locator('#climate').fill('1');
      await page.getByRole('button', { name: 'Heatwave', exact: true }).click();
      await page.locator('#world').scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          page.evaluate(() => [
            window.terrainNative.frame?.climate,
            window.terrainNative.frame?.offset,
          ]),
        )
        .toEqual([1, 0.32]);
      const common = (await terrainNativeFrame(page)).frame;
      expect(common.stats.tick).toBe(saved.tick);
      expect(common.telemetry).toEqual(saved.telemetry);
      const independentTemperature = (x: number, y: number, localUnits: number) => {
        const raw =
          0.5 +
          common.climate *
            (0.27 * Math.sin((x / WIDTH) * Math.PI * 2 - common.stats.tick / 1100) +
              0.13 * Math.cos((y / HEIGHT) * Math.PI * 2) +
              0.12 * Math.sin(common.stats.tick / 650)) +
          common.offset;
        return Math.max(0, Math.min(1, raw + localUnits / 100));
      };
      const anchorTemperature = independentTemperature(120, 78, units);
      await expect(
        page
          .locator('#inspector dt')
          .filter({ hasText: /^Normalized anchor temperature$/ })
          .locator('..')
          .locator('dd'),
      ).toHaveText(String(anchorTemperature));
      await page.locator('#thermal').click();
      await expect(page.locator('#thermal')).toHaveAttribute('aria-pressed', 'true');
      const expectedColors = [
        [0, 0, 0],
        [121, 78, units],
        [239, 155, 0],
      ].map(([x, y, localUnits]) => {
        const value = independentTemperature(x, y, localUnits);
        return [
          Math.round(9 + value * 37),
          Math.round(18 + (1 - Math.abs(value - 0.5) * 2) * 13),
          Math.round(20 + (1 - value) * 40),
          255,
        ];
      });
      await expect
        .poll(() => page.evaluate(() => window.refugePixels))
        .toEqual({
          tick: saved.tick,
          climate: 1,
          offset: 0.32,
          colors: [
            expectedColors[0],
            [0xa3, 0x8a, 0xe4, 255],
            expectedColors[1],
            expectedColors[2],
          ],
        });
      await test.info().attach('common-frame-thermal-authority.json', {
        body: JSON.stringify({
          tick: common.stats.tick,
          climate: common.climate,
          eventOffset: common.offset,
          units,
          anchorTemperature,
          pixels: await page.evaluate(() => window.refugePixels),
        }),
        contentType: 'application/json',
      });
    } else {
      expect(saved.food).toEqual([index(120, 78)]);
      await expect(page.locator('#extinction-summary')).toContainText('energy exhaustion');
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
      await page.locator('#pause-on-extinction').uncheck();
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
    }
  }
  await refugeProtocol(page, false);
});

function refugeGraph(value: any): object {
  const pending: any[] = [],
    nodes: object[] = [];
  function atom(item: any): object {
    if (item === null) return { kind: 'null' };
    if (typeof item !== 'object')
      return {
        kind: typeof item,
        value: typeof item === 'number' ? (Object.is(item, -0) ? '-0' : String(item)) : item,
      };
    const id = pending.length;
    pending.push(item);
    return { kind: 'reference', id };
  }
  const root = atom(value);
  for (let position = 0; position < pending.length; position++) {
    const item = pending[position];
    nodes.push({
      id: position,
      array: Array.isArray(item),
      prototype:
        Object.getPrototypeOf(item) === (Array.isArray(item) ? Array.prototype : Object.prototype)
          ? 'ordinary'
          : Object.getPrototypeOf(item) === null
            ? 'null'
            : 'other',
      entries: Object.getOwnPropertyNames(item).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        return {
          key,
          enumerable: descriptor.enumerable,
          writable: descriptor.writable,
          configurable: descriptor.configurable,
          value: atom(descriptor.value),
        };
      }),
    });
  }
  return { root, nodes };
}

// Invert the complete current genome/cell carriers before comparing the genuine
// predecessor graph. Raw organism properties stay on their original native path.
async function refugeSelected(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const anchor = await coordinate(page, 120, 78);
  await page.mouse.click(anchor.x, anchor.y);
  await expect.poll(() => page.evaluate(() => window.terrainNative.selected?.id)).toBe(1);
  return page.evaluate((encoder) => {
    const encode = Function(`return (${encoder})`)();
    return encode(window.terrainNative.selected);
  }, refugeGraph.toString());
}

async function refugeFullGenome(page: import('@playwright/test').Page) {
  const previous = await page.evaluate(() => window.terrainNative.fullDesign?.commandId ?? 0);
  if ((await page.locator('#specimen-details').getAttribute('open')) === null)
    await page.locator('#specimen-details > summary').click();
  await page.locator('#copy-organism').click();
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.fullDesign?.commandId ?? 0))
    .toBeGreaterThan(previous);
  return page.evaluate((encoder) => {
    const encode = Function(`return (${encoder})`)();
    const response = window.terrainNative.fullDesign;
    return {
      source: response.source,
      sourceId: response.sourceId,
      completedTick: response.completedTick,
      genome: encode(response.genome),
    };
  }, refugeGraph.toString());
}

test('B23-6 raw families retain full Saves and explicit full genomes while routine inspection stays a bounded observation', async ({
  page,
}) => {
  await observeTerrainNative(page, 'lifecycle-receipt');
  await page.goto('/');
  await terrainNativeFrame(page);
  const raw = fixtureText('native-depth-direct/inputs/desktop-combined-1087.json');
  const original = acceptedReference(raw);
  let expected = Ecosystem.load(raw);
  const tick = await refugeLoad(page, raw);
  advance(original, tick - original.tick);
  advance(expected, tick - expected.tick);
  expect(await refugeSelected(page)).toEqual(
    refugeGraph(observedOrganism(expected.save().organisms[0])),
  );
  const full = await refugeFullGenome(page);
  expect(full).toEqual({
    source: 'organism',
    sourceId: 1,
    completedTick: tick,
    genome: refugeGraph(expected.save().organisms[0].genome),
  });
  const first = await terrainSave(page, 'direct-deep-first.json');
  expect(first).toEqual(JSON.parse(JSON.stringify(expected.save())));
  const historicalOutput = JSON.parse(JSON.stringify(original.save()));
  historicalOutput.organisms.forEach((organism: any, position: number) => {
    organism.genome = original.save().organisms[position].genome;
  });
  expect(predecessor(first)).toEqual(historicalOutput);
  const normalized = acceptedReference(JSON.stringify(original.save()));
  expected = Ecosystem.load(JSON.stringify(first));
  const reloadedTick = await refugeLoad(page, JSON.stringify(first));
  advance(normalized, reloadedTick - normalized.tick);
  advance(original, reloadedTick - original.tick);
  advance(expected, reloadedTick - expected.tick);
  await refugeMode(page, true);
  expected.changeRefugeMode(true);
  expect(await refugeSelected(page)).toEqual(
    refugeGraph(observedOrganism(expected.save().organisms[0])),
  );
  expect((await refugeFullGenome(page)).genome).toEqual(
    refugeGraph(expected.save().organisms[0].genome),
  );
  const second = await terrainSave(page, 'direct-deep-reloaded.json');
  expect(second).toEqual(expected.save());
  await page.locator('#step').click();
  expected.step();
  normalized.step();
  original.step();
  original.step();
  const third = await terrainSave(page, 'direct-deep-step.json');
  expect(third).toEqual(expected.save());
  expect(restoreHistoricalWorld(third).organisms).toEqual(
    normalized.save().organisms.map((organism, position) => ({
      ...organism,
      genome: original.save().organisms[position].genome,
    })),
  );
  const cap = fixtureText('capture-direct/inputs/native-cap-v5.json');
  const capReference = acceptedReference(cap),
    capCurrent = Ecosystem.load(cap);
  const capTick = await refugeLoad(page, cap);
  advance(capReference, capTick - capReference.tick);
  advance(capCurrent, capTick - capCurrent.tick);
  const selected = await refugeSelected(page);
  expect(selected).toEqual(refugeGraph(observedOrganism(capCurrent.save().organisms[0])));
  let downloads = 0;
  const record = () => downloads++;
  page.on('download', record);
  const before = await page.evaluate(() => ({
    saved: window.terrainNative.saved,
    tick: window.terrainNative.frame!.stats.tick,
    playback: window.terrainNative.playback,
  }));
  await page.locator('#save').click();
  await expect(page.locator('#notice')).toContainText('World file exceeds 2.5 MB');
  expect(downloads).toBe(0);
  expect(await page.evaluate(() => window.terrainNative.saved)).toBe(before.saved);
  expect(await refugeSelected(page)).toEqual(selected);
  expect(await page.evaluate(() => window.terrainNative.frame!.stats.tick)).toBe(before.tick);
  expect(await page.evaluate(() => window.terrainNative.errors.at(-1)?.fatal)).toBeUndefined();
  await page.locator('#step').click();
  capReference.step();
  capCurrent.step();
  await expect(page.locator('#tick')).toHaveText(`TICK ${capCurrent.tick.toLocaleString()}`);
  expect(await refugeSelected(page)).toEqual(
    refugeGraph(observedOrganism(capCurrent.save().organisms[0])),
  );
  page.off('download', record);
  await refugeProtocol(page);
  await test.info().attach('raw-depth-cap-boundaries.json', {
    body: JSON.stringify({
      depth: 1087,
      explicitFullGenotype: full,
      routineObservationIsProjection: true,
      completeFirstSaveMatchedPredecessor: true,
      capInputBytes: Buffer.byteLength(cap),
      acceptedReferenceOutputBytes: Buffer.byteLength(JSON.stringify(capReference.save())),
      nativeOutputBytes: null,
      downloads,
      before,
    }),
    contentType: 'application/json',
  });
  const adjacentRaw = fixtureText('native-depth-direct/inputs/desktop-combined-1088.json');
  const adjacent = Ecosystem.load(adjacentRaw);
  const adjacentTick = await refugeLoad(page, adjacentRaw);
  advance(adjacent, adjacentTick - adjacent.tick);
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const adjacentFirst = await terrainSave(page, 'original-adjacent-supported-first.json');
  expect(adjacentFirst).toEqual(JSON.parse(JSON.stringify(adjacent.save())));
  await page.locator('#step').click();
  adjacent.step();
  const adjacentStepped = await terrainSave(page, 'original-adjacent-supported-step.json');
  expect(adjacentStepped).toEqual(JSON.parse(JSON.stringify(adjacent.save())));
  expect(await refugeSelected(page)).toEqual(
    refugeGraph(observedOrganism(adjacent.save().organisms[0])),
  );
  await test.info().attach('original-adjacent-native-continuation.json', {
    body: JSON.stringify({
      inputBytes: Buffer.byteLength(adjacentRaw),
      tick: adjacentTick,
      stepTick: adjacentStepped.tick,
      routineObservationIsProjection: true,
      completeSavesCompared: true,
    }),
    contentType: 'application/json',
  });
});

test('B23-7 manual disclosure, keyboard controls and responsive views preserve the whole paused world', async ({
  page,
}) => {
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      external.push(request.url());
  });
  await observeTerrainNative(page, 'lifecycle-receipt');
  await page.goto('/');
  await terrainNativeFrame(page);
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  await expect(page.locator('.refuge-section')).toContainText('Manual environment change.');
  await expect(page.locator('.refuge-section')).toContainText('Walls do not insulate temperature.');
  await page.locator('#refuge-enabled').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#refuge-enabled')).toBeChecked();
  await refugeControls(page, 0, 4);
  await page.locator('#refuge-intensity').focus();
  await page.keyboard.press('End');
  await expect(page.locator('#refuge-intensity')).toHaveValue('32');
  await page.getByRole('button', { name: 'Erase temperature', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#refuge-intensity')).toBeDisabled();
  await page.getByRole('button', { name: 'Warm', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#refuge-intensity')).toBeEnabled();
  await refugeMode(page, false);
  const before = await downloadPausedWorld(page),
    layouts: object[] = [];
  for (const width of [320, 390, 760, 780, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.locator('#refuge-enabled').focus();
    await expect(page.locator('#refuge-enabled')).toBeFocused();
    const layout = await page.locator('.refuge-section').evaluate((section) => ({
      width: innerWidth,
      fits: document.documentElement.scrollWidth <= innerWidth,
      text: section.textContent,
      contrast: [...section.querySelectorAll('h3,p,label,button:not(:disabled)')].map((node) => {
        const luminance = (color: string) =>
          color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .reduce((sum, channel, position) => {
              const value = channel / 255;
              return (
                sum +
                (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
                  [0.2126, 0.7152, 0.0722][position]
              );
            }, 0);
        let surface: Element | null = node;
        while (
          surface &&
          ['transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(surface).backgroundColor)
        )
          surface = surface.parentElement;
        if (!surface) throw new Error('No painted refuge-control background');
        const light = [
          luminance(getComputedStyle(node).color),
          luminance(getComputedStyle(surface).backgroundColor),
        ];
        return (Math.max(...light) + 0.05) / (Math.min(...light) + 0.05);
      }),
      controls: [...section.querySelectorAll('button,input')].map((control) => ({
        tag: control.tagName,
        width: control.getBoundingClientRect().width,
        height: control.getBoundingClientRect().height,
      })),
    }));
    expect(layout.width).toBe(width);
    expect(layout.fits).toBe(true);
    expect(layout.contrast.every((ratio) => ratio >= 4.5)).toBe(true);
    expect(layout.controls.every((control) => control.width > 0)).toBe(true);
    layouts.push(layout);
  }
  await page.locator('#thermal').click();
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-out').click();
  await page.locator('#clear-refuges').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#notice')).toContainText('unchanged');
  await terrainSettings(page);
  await page.locator('#reset').click();
  await expect(page.locator('#reset-dialog')).toContainText(
    'Painted temperature will be cleared and disabled.',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('#reset-dialog')).not.toBeVisible();
  expect(await downloadPausedWorld(page)).toEqual(before);
  await test.info().attach('refuge-layouts.json', {
    body: JSON.stringify(layouts),
    contentType: 'application/json',
  });
  await test.info().attach('refuge-responsive.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await refugeProtocol(page);
});

test.describe('retained lineage explorer', () => {
  test('paused accessible navigation highlights real membership and preserves complete saves', async ({
    page,
  }, info) => {
    await page.addInitScript(() => {
      const evidence = ((window as any).lineageExplorerEvidence = {
        commands: [] as string[],
        outlines: 0,
      });
      Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
        apply(post, worker, args) {
          if (!['flow-ack', 'display-view'].includes(args[0].type))
            evidence.commands.push(args[0].type);
          return Reflect.apply(post, worker, args);
        },
      });
      CanvasRenderingContext2D.prototype.fillRect = new Proxy(
        CanvasRenderingContext2D.prototype.fillRect,
        {
          apply(fill, context, args) {
            if (context.canvas.id === 'world') evidence.outlines = 0;
            return Reflect.apply(fill, context, args);
          },
        },
      );
      CanvasRenderingContext2D.prototype.strokeRect = new Proxy(
        CanvasRenderingContext2D.prototype.strokeRect,
        {
          apply(stroke, context, args) {
            if (context.canvas.id === 'world' && context.strokeStyle === '#ffffff')
              evidence.outlines++;
            return Reflect.apply(stroke, context, args);
          },
        },
      );
    });
    await page.goto('/');
    await pause(page);
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
    const parent = world.spawn(admissionGenome(), 120, 78)!;
    world.spawn(admissionGenome(), 122, 78, parent.species, parent);
    const childBody = admissionGenome();
    childBody.preference = 0.65;
    const child = world.spawn(childBody, 124, 78, undefined, parent)!;
    world.kill(child, 'manual');
    // Opaque compatibility remains part of complete world Save, not display projection.
    parent.genome.legacyExtensions = [
      ['extra', encodeLegacyValue({ text: '<literal>', nested: [1, { preserved: true }] })],
    ];
    await importTelemetryWorld(page, world.save());
    await page.locator('#ecosystem-tab').click();
    const before = await downloadWorld(page);
    await page.locator('#lineage-heading').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#lineage-explorer')).toHaveJSProperty('open', true);
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    await expect(page.locator('#lineage-retention')).toContainText('Bounded evidence');
    const commands = await page.evaluate(
      () => (window as any).lineageExplorerEvidence.commands.length,
    );
    const search = page.getByLabel('Search lineage ID, anatomy or status');
    await search.fill(String(parent.species));
    const row = page.locator('#lineage-rows button');
    await expect(row).toHaveCount(1);
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#lineage-detail')).toBeFocused();
    await expect(page.locator('#lineage-detail')).toContainText('Peak: 2 lifetime');
    await expect(page.locator('#lineage-detail')).toContainText('Anatomy category: Rootling');
    await expect(page.locator('.lineage-event-chart')).toHaveAttribute('role', 'img');
    await expect(
      page.getByRole('list', { name: `Retained timeline for lineage #${parent.species}` }),
    ).toContainText(`Parent #${parent.species} → child #${child.species}`);
    await page.locator('#world').scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => (window as any).lineageExplorerEvidence.outlines))
      .toBe(2);
    await page.locator(`#lineage-detail [data-lineage-id="${child.species}"]`).click();
    await expect(page.locator('#lineage-detail')).toContainText(
      `Lineage #${child.species} · Extinct`,
    );
    await expect(page.locator('#lineage-detail')).toContainText(
      'Generation: unknown (not archived)',
    );
    await expect(page.locator('#lineage-detail')).toContainText(
      `Extinction of lineage #${child.species}`,
    );
    await page.locator('#world').scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => (window as any).lineageExplorerEvidence.outlines))
      .toBe(0);
    expect(await page.evaluate(() => (window as any).lineageExplorerEvidence.commands.length)).toBe(
      commands,
    );
    expect(await downloadWorld(page)).toEqual(before);
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    await page.locator('#lineage-clear').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#lineage-clear')).toBeDisabled();
    await expect(search).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    expect(await downloadWorld(page)).toEqual(before);
    await expect(page.locator('#lineage-detail')).toContainText('Select a lineage');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    // Import a fresh world with the same lineage IDs: extinct selection must not attach.
    await search.fill(String(child.species));
    await page.locator('#lineage-rows button').click();
    const replacement = new Ecosystem(DEFAULTS, false);
    replacement.spawn(admissionGenome(), 10, 10);
    replacement.spawn(admissionGenome(), 12, 10);
    await page.locator('#lineage-detail button').focus();
    // Keep native focus recovery observable: the ordinary import helper clicks Pause/Save.
    await page.locator('#file').setInputFiles({
      name: 'replacement-lineages.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(replacement.save())),
    });
    await expect(page.locator('#notice')).toContainText('World restored');
    await expect(search).toBeFocused();
    await page.locator('#pause').evaluate((button: HTMLButtonElement) => {
      if (button.textContent === 'Ⅱ Pause') button.click();
    });
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    await expect(page.getByTitle('Advance one tick while paused')).toBeEnabled();
    await expect(search).toBeFocused();
    const replacementTick = Number((await page.locator('#tick').textContent())!.replace(/\D/g, ''));
    expect(replacementTick).toBeGreaterThanOrEqual(replacement.tick);
    advance(replacement, replacementTick - replacement.tick);
    await page.keyboard.press('Space');
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    expect(await downloadWorld(page)).toEqual(Buffer.from(JSON.stringify(replacement.save())));
    await expect(page.locator('#lineage-detail')).toContainText('Select a lineage');
    await expect(page.locator('#lineage-rows [aria-pressed="true"]')).toHaveCount(0);
    const screenshot = await page.locator('#lineage-explorer').screenshot();
    await info.attach('lineage-explorer', { body: screenshot, contentType: 'image/png' });
  });

  test('held native pagination cannot cross an asynchronous world replacement', async ({
    page,
  }, info) => {
    await observeTerrainNative(page);
    await page.goto('/');
    await terrainNativeFrame(page);
    const world = sameTickLineages();
    await importTelemetryWorld(page, world.save());
    await page.locator('#ecosystem-tab').click();
    await page.locator('#lineage-heading').click();
    const target = page.getByRole('button', { name: 'Next lineages' });
    await target.scrollIntoViewIfNeeded();
    await target.focus();
    const box = (await target.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const session =
      info.project.name === 'mobile' ? await page.context().newCDPSession(page) : null;
    if (session)
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    else {
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
    }
    const replacement = Ecosystem.load(JSON.stringify(world.save()));
    replacement.step();
    await page.locator('#file').setInputFiles({
      name: 'held-pager-replacement.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(replacement.save())),
    });
    await expect(page.locator('#notice')).toContainText('World restored');
    await expect(page.locator('#lineage-observed')).toHaveText(
      `Observed at tick ${replacement.tick}.`,
    );
    await expect(target).toBeEnabled();
    expect(await target.boundingBox()).toEqual(box);
    expect(
      await target.evaluate(
        (button, at) => document.elementFromPoint(at.x, at.y)?.closest('button') === button,
        point,
      ),
    ).toBe(true);
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else await page.mouse.up();
    await expect(page.locator('#lineage-results')).toContainText('showing 1–40');
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    expect(await terrainSave(page, 'held-pager-replacement-after.json')).toEqual(
      replacement.save(),
    );
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#lineage-results')).toContainText('showing 41–80');
    expect(await terrainSave(page, 'fresh-pager-after.json')).toEqual(replacement.save());
  });

  test('live observations preserve a held navigation target and timeline scroll', async ({
    page,
  }, info) => {
    await page.goto('/');
    await pause(page);
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
    const parent = world.spawn(admissionGenome(), 120, 78)!;
    const children = Array.from({ length: 24 }, (_, i) =>
      world.spawn(admissionGenome(), 10 + i * 2, 20, undefined, parent)!,
    );
    await importTelemetryWorld(page, world.save());
    await page.locator('#ecosystem-tab').click();
    await page.locator('#lineage-heading').click();
    await expect(page.locator('#lineage-retention')).toContainText('Bounded evidence');
    await page.locator('#lineage-search').fill(String(parent.species));
    await page.locator('#lineage-rows button').click();
    const before = JSON.parse((await downloadWorld(page)).toString()) as WorldFile;
    const timeline = page.locator('.lineage-timeline');
    const scroll = await timeline.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(scroll).toBeGreaterThan(0);
    const target = page.locator(`#lineage-detail button[data-lineage-id="${children[0].species}"]`);
    await target.scrollIntoViewIfNeeded();
    await page.evaluate((id) => {
      (window as any).lineageHeld = {
        row: document.querySelector('#lineage-rows button'),
        timeline: document.querySelector('.lineage-timeline'),
        target: document.querySelector(`#lineage-detail button[data-lineage-id="${id}"]`),
      };
    }, children[0].species);
    const observedTick = () =>
      page
        .locator('#lineage-observed')
        .evaluate((element) => Number(element.textContent!.replace(/\D/g, '')));
    const tick = await observedTick();
    await page.locator('#pause').click();
    await expect(page.locator('#run-state')).toHaveText('LIVE');
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const session =
      info.project.name === 'mobile' ? await page.context().newCDPSession(page) : null;
    if (session)
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    else {
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
    }
    const pressedTick = await observedTick();
    await expect.poll(observedTick).toBeGreaterThan(Math.max(tick, pressedTick) + 1);
    expect(
      await page.evaluate(() => {
        const held = (window as any).lineageHeld;
        return {
          row: held.row === document.querySelector('#lineage-rows button'),
          timeline: held.timeline === document.querySelector('.lineage-timeline'),
          target: held.target.isConnected,
          scroll: held.timeline.scrollTop,
        };
      }),
    ).toEqual({ row: true, timeline: true, target: true, scroll });
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else await page.mouse.up();
    await expect(page.locator('#lineage-detail')).toContainText(
      `Lineage #${children[0].species} · Living`,
    );
    await requestPause(page);
    await expect(page.locator('#save')).toBeEnabled();
    const after = JSON.parse((await downloadPausedWorld(page)).toString()) as WorldFile;
    const reference = Ecosystem.load(JSON.stringify(before));
    while (reference.tick < after.tick) reference.step();
    expect(after).toEqual(reference.save());
  });

  test('native relationship focus survives a sibling extinction observation', async ({ page }) => {
    await observeTerrainNative(page);
    await page.goto('/');
    await terrainNativeFrame(page);
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
    const parent = world.spawn(admissionGenome(), 120, 78)!;
    const first = world.spawn(admissionGenome(), 122, 78, undefined, parent)!;
    const second = world.spawn(admissionGenome(), 124, 78, undefined, parent)!;
    first.energy = 0.001;
    await importTelemetryWorld(page, world.save());
    await page.locator('#ecosystem-tab').click();
    await page.locator('#lineage-heading').click();
    await page.locator('#lineage-search').fill(String(parent.species));
    await page.locator('#lineage-rows button').click();
    const before = await terrainSave(page, 'focused-extinction-before.json');
    expect(before.organisms.map((organism) => organism.id)).toContain(first.id);
    const reference = Ecosystem.load(JSON.stringify(before));
    const target = page.locator(`#lineage-detail button[data-lineage-id="${second.species}"]`);
    await target.focus();
    await page.evaluate(() => {
      (window as any).focusedRelation = document.activeElement;
      // Activate the real Step control without moving focus off the relationship.
      document.getElementById('step')!.click();
    });
    reference.step();
    expect(reference.organisms.has(first.id)).toBe(false);
    await expect(page.locator('#lineage-observed')).toHaveText(
      `Observed at tick ${reference.tick}.`,
    );
    await expect(target).toBeFocused();
    expect(await target.evaluate((element) => element === (window as any).focusedRelation)).toBe(
      true,
    );
    expect(
      await page
        .locator('[data-lineage-key="children"] button')
        .evaluateAll((buttons) =>
          buttons.map((button) => Number((button as HTMLElement).dataset.lineageId)),
        ),
    ).toEqual([first.species, second.species]);
    await page.keyboard.press('Enter');
    await expect(page.locator('#lineage-detail')).toContainText(
      `Lineage #${second.species} · Living`,
    );
    await expect(page.locator('#run-state')).toHaveText('PAUSED');
    expect(await terrainSave(page, 'focused-extinction-after.json')).toEqual(reference.save());
  });

  for (const selectedEvidence of ['retained', 'expiring'] as const) {
    test(`native relationship ownership across real archive eviction / ${selectedEvidence}`, async ({
      page,
    }, info) => {
      await observeTerrainNative(page);
      await page.goto('/');
      await terrainNativeFrame(page);
      const { world, parent, extinct, retained } = relationshipEviction();
      await importTelemetryWorld(page, world.save());
      await page.locator('#ecosystem-tab').click();
      await page.locator('#lineage-heading').click();
      const selected = selectedEvidence === 'retained' ? parent.species : extinct.species;
      await page.locator('#lineage-search').fill(String(selected));
      await page.locator('#lineage-rows button').click();
      const before = await terrainSave(page, `eviction-${selectedEvidence}-before.json`);
      const reference = Ecosystem.load(JSON.stringify(before));
      const id = selectedEvidence === 'retained' ? retained.species : parent.species;
      const target = page.locator(`#lineage-detail button[data-lineage-id="${id}"]`);
      await target.scrollIntoViewIfNeeded();
      await target.focus();
      await target.evaluate((element) => {
        (window as any).evictionTarget = element;
      });
      const box = (await target.boundingBox())!;
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const session =
        selectedEvidence === 'retained' && info.project.name === 'mobile'
          ? await page.context().newCDPSession(page)
          : null;
      if (selectedEvidence === 'retained') {
        if (session)
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [point],
          });
        else {
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
        }
      }
      await page.evaluate(() => document.getElementById('step')!.click());
      reference.step();
      expect(reference.lineageSnapshot().events.some((event) => event.id === extinct.species)).toBe(
        false,
      );
      await expect(page.locator('#lineage-observed')).toHaveText(
        `Observed at tick ${reference.tick}.`,
      );
      if (selectedEvidence === 'retained') {
        expect(await target.evaluate((element) => element === (window as any).evictionTarget)).toBe(
          true,
        );
        await expect(target).toBeFocused();
        expect(await target.boundingBox()).toEqual(box);
        // Release at the original coordinates: no move may compensate for reflow.
        if (session) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await session.detach();
        } else await page.mouse.up();
        await expect(page.locator('#lineage-detail')).toContainText(
          `Lineage #${retained.species} · Living`,
        );
      } else {
        await expect(page.locator('#lineage-detail')).toContainText('evidence was pruned');
        await expect(page.locator('#lineage-search')).toBeFocused();
        await page.keyboard.press('Space');
      }
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
      expect(await terrainSave(page, `eviction-${selectedEvidence}-after.json`)).toEqual(
        reference.save(),
      );
    });
  }

  for (const pager of ['previous', 'next'] as const) {
    test(`native focused ${pager} pagination recovers safely across real archive eviction`, async ({
      page,
    }) => {
      await observeTerrainNative(page);
      await page.goto('/');
      await terrainNativeFrame(page);
      const world = paginationEviction();
      await importTelemetryWorld(page, world.save());
      await page.locator('#ecosystem-tab').click();
      await page.locator('#lineage-heading').click();
      await page.locator('#lineage-search').fill('extinct');
      await expect(page.locator('#lineage-results')).toContainText('41 matching');
      if (pager === 'previous') await page.getByRole('button', { name: 'Next lineages' }).click();
      const reference = Ecosystem.load(
        JSON.stringify(await terrainSave(page, `pager-${pager}-before.json`)),
      );
      const target = page.getByRole('button', {
        name: pager === 'previous' ? 'Previous lineages' : 'Next lineages',
      });
      await expect(target).toBeEnabled();
      await target.focus();
      await expect(target).toBeFocused();
      await page.evaluate(() => document.getElementById('step')!.click());
      reference.step();
      await expect(page.locator('#lineage-observed')).toHaveText(
        `Observed at tick ${reference.tick}.`,
      );
      await expect(page.locator('#lineage-results')).toContainText('40 matching');
      await expect(page.locator('#lineage-results')).toContainText('showing 1–40');
      await expect(target).toBeDisabled();
      await expect(page.locator('#lineage-search')).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
      expect(await terrainSave(page, `pager-${pager}-after.json`)).toEqual(reference.save());
    });
  }

  test('empty and overflowing archives expose pruned ancestry with bounded phone-safe navigation', async ({
    page,
  }) => {
    await page.goto('/');
    await pause(page);
    const empty = new Ecosystem(DEFAULTS, false);
    await importTelemetryWorld(page, empty.save(), true);
    await page.locator('#ecosystem-tab').click();
    await page.locator('#lineage-heading').click();
    await expect(page.locator('#lineage-retention')).toContainText('Bounded evidence');
    await expect(page.locator('#lineage-results')).toContainText('No retained lineages');
    await expect(page.locator('#lineage-rows li')).toHaveCount(0);
    const world = new Ecosystem({ ...DEFAULTS, climate: 0, mutation: 0, nutrients: 0 }, false);
    const parent = world.spawn(admissionGenome(), 120, 78)!;
    const changed = admissionGenome();
    changed.preference = 0.7;
    const child = world.spawn(changed, 122, 78, undefined, parent)!;
    world.kill(parent, 'manual');
    for (let i = 0; i < 270; i++) world.kill(world.spawn(admissionGenome(), 10, 10)!, 'manual');
    // Child stays living with metadata even after its own summary/event is evicted.
    await importTelemetryWorld(page, world.save());
    await expect(page.locator('#lineage-retention')).toContainText(
      '256/256 summaries; 512/512 events',
    );
    await expect(page.locator('#lineage-retention')).toContainText('Older summaries pruned');
    await expect(page.locator('#lineage-retention')).toContainText(
      'Events pruned through tick 0; that tick may be partial',
    );
    await expect(page.locator('#lineage-rows li')).toHaveCount(40);
    await page.getByRole('button', { name: 'Next lineages', exact: true }).click();
    await expect(page.locator('#lineage-results')).toContainText('showing 41–80');
    await page.getByLabel('Search lineage ID, anatomy or status').fill(`#${child.species}`);
    await page.locator('#lineage-rows button').click();
    await expect(page.locator('#lineage-detail')).toContainText(
      'Current living representative; founding anatomy unknown / pruned',
    );
    await expect(page.locator('#lineage-detail')).toContainText('unknown / pruned ancestor');
    await page.locator(`#lineage-detail [data-lineage-id="${parent.species}"]`).click();
    await expect(page.locator('#lineage-detail')).toContainText('Unknown / pruned');
    await expect(page.locator('#lineage-detail')).toContainText('Live: unknown');
    await expect(page.locator('#lineage-detail')).toContainText('Creation tick unknown / pruned');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});

async function checkpointBytes(
  page: import('@playwright/test').Page,
  slot: number,
  value?: string,
) {
  return page.evaluate(
    async ({ slot, value }) => {
      const request = indexedDB.open('evolab-world-checkpoints', 1);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<string | undefined>((resolve, reject) => {
          const tx = db.transaction('entries', value === undefined ? 'readonly' : 'readwrite');
          const store = tx.objectStore('entries');
          let result: string | undefined;
          if (value === undefined) {
            const read = store.get(slot);
            read.onsuccess = () => {
              result = read.result;
            };
          } else store.put(value, slot);
          tx.oncomplete = () => resolve(result);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { slot, value },
  );
}
async function openCheckpoints(page: import('@playwright/test').Page) {
  await page.locator('#local-checkpoints').evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  await page.locator('#checkpoint-refresh').click();
  await expect(page.locator('#checkpoint-status')).toContainText('refreshed');
}
async function confirmCheckpoint(
  page: import('@playwright/test').Page,
  action: 'restore' | 'delete',
) {
  await page.locator('#checkpoint-' + action).click();
  await expect(page.locator('#checkpoint-dialog')).toBeVisible();
  await page.locator('#checkpoint-confirm').click();
}
test('local complete checkpoints survive reload, require confirmations, and continue identically to downloaded worlds', async ({
  page,
}, info) => {
  await observeTerrainNative(page);
  await page.goto('/');
  await terrainNativeFrame(page);
  const candidate = new Ecosystem({ ...DEFAULTS, seed: 19019 });
  for (let tick = 0; tick < 95; tick++) candidate.step();
  candidate.shock('heat');
  candidate.changeRefugeMode(true);
  candidate.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 1, units: 7 }, 120, 78);
  Object.defineProperty(candidate.settings, '__proto__', {
    value: { opaque: 'own data' },
    enumerable: true,
  });
  for (const organism of candidate.organisms.values()) {
    (organism as any).opaque = { identity: organism.id };
    organism.genome.legacyExtensions = [
      ['retained', encodeLegacyValue({ values: [Infinity, -0, 'literal'] })],
    ];
    organism.genome.cells[0].legacyExtensions = [
      ['cell', encodeLegacyValue({ nested: ['retained'] })],
    ];
  }
  const initialRun = await page.evaluate(() => window.terrainNative.lifecycle.at(-1)!.runId);
  await importWorld(page, candidate.save());
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.lifecycle.at(-1)!.runId))
    .toBeGreaterThan(initialRun);
  await terrainNativeFrame(page);
  await openCheckpoints(page);
  await page.locator('#checkpoint-name').fill('Literal <checkpoint> 🌿');
  const baseline = await downloadPausedWorld(page);
  await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#checkpoint-save').click();
  await expect(page.locator('#checkpoint-status')).toContainText('Complete checkpoint saved.');
  const stored = await checkpointBytes(page, 1);
  expect(JSON.parse(stored!).world).toBe(baseline.toString());
  await expect(page.locator('#checkpoint-slot')).toContainText('Literal <checkpoint> 🌿');
  expect(
    await page
      .locator('#local-checkpoints')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(page.locator('#checkpoint-usage')).toContainText('1 / 5');
  await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#checkpoint-save').click();
  await expect(page.locator('#checkpoint-confirm-description')).toContainText('Overwrite');
  await page.locator('#checkpoint-cancel').click();
  expect(await checkpointBytes(page, 1)).toBe(stored);
  await page.reload();
  await terrainNativeFrame(page);
  await openCheckpoints(page);
  expect(await checkpointBytes(page, 1)).toBe(stored);
  const beforeRestoreRun = await page.evaluate(() => window.terrainNative.lifecycle.at(-1)!.runId);
  await confirmCheckpoint(page, 'restore');
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.lifecycle.at(-1)!.runId))
    .toBeGreaterThan(beforeRestoreRun);
  await terrainNativeFrame(page);
  const restored = await downloadPausedWorld(page);
  const expected = Ecosystem.load(baseline.toString());
  const loaded = JSON.parse(restored.toString()) as WorldFile;
  expect(loaded.tick).toBeGreaterThanOrEqual(expected.tick);
  while (expected.tick < loaded.tick) expected.step();
  expect(loaded).toEqual(expected.save());
  await page.locator('#step').click();
  await expect(page.locator('#tick')).toHaveText(`TICK ${(loaded.tick + 1).toLocaleString()}`);
  expected.step();
  const localContinuation = await downloadPausedWorld(page);
  expect(JSON.parse(localContinuation.toString())).toEqual(expected.save());
  // Load the exact downloaded source through the independent file UI, then compare every native field at the same completed tick.
  const beforeFileRun = await page.evaluate(() => window.terrainNative.lifecycle.at(-1)!.runId);
  await page
    .locator('#file')
    .setInputFiles({ name: 'download.json', mimeType: 'application/json', buffer: baseline });
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.lifecycle.at(-1)!.runId))
    .toBeGreaterThan(beforeFileRun);
  await terrainNativeFrame(page);
  const downloaded = JSON.parse((await downloadPausedWorld(page)).toString()) as WorldFile;
  const fileExpected = Ecosystem.load(baseline.toString());
  while (fileExpected.tick < downloaded.tick) fileExpected.step();
  expect(downloaded).toEqual(fileExpected.save());
  await page.locator('#step').click();
  await expect(page.locator('#tick')).toHaveText(`TICK ${(downloaded.tick + 1).toLocaleString()}`);
  fileExpected.step();
  expect(JSON.parse((await downloadPausedWorld(page)).toString())).toEqual(fileExpected.save());
  await openCheckpoints(page);
  for (let slot = 2; slot <= 5; slot++) {
    await page.locator('#checkpoint-slot').selectOption(String(slot));
    await expect(page.locator('#save')).toBeEnabled();
    await page.locator('#checkpoint-save').click();
    await expect(page.locator('#checkpoint-status')).toContainText('Complete checkpoint saved.');
  }
  await expect(page.locator('#checkpoint-usage')).toContainText('5 / 5');
  await confirmCheckpoint(page, 'delete');
  await expect(page.locator('#checkpoint-status')).toContainText('Checkpoint deleted.');
  expect(await checkpointBytes(page, 5)).toBeUndefined();
  await info.attach('complete-checkpoint-continuation.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      sourceTick: JSON.parse(baseline.toString()).tick,
      localTick: loaded.tick + 1,
      fileTick: downloaded.tick + 1,
      sourceSHA256: createHash('sha256').update(baseline).digest('hex'),
      localSHA256: createHash('sha256').update(localContinuation).digest('hex'),
      comparison:
        'complete native worlds including RNG, order, counters, lineage, telemetry, interventions and opaque data; receipt-driven Pause, then exact Step',
    }),
  });
});

test('corrupt local checkpoints, failed complete validation, CAS conflicts and quota preserve the active world and original stored bytes', async ({
  page,
}, info) => {
  await observeTerrainNative(page);
  await page.goto('/');
  await terrainNativeFrame(page);
  await openCheckpoints(page);
  await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#checkpoint-save').click();
  await expect(page.locator('#checkpoint-status')).toContainText('Complete checkpoint saved.');
  const original = await checkpointBytes(page, 1),
    before = await downloadPausedWorld(page);
  await page.locator('#checkpoint-restore').click();
  const changed = JSON.stringify({ ...JSON.parse(original!), name: 'Another tab revision' });
  await checkpointBytes(page, 1, changed);
  await page.locator('#checkpoint-confirm').click();
  await expect(page.locator('#checkpoint-status')).toContainText('changed or disappeared');
  expect(await downloadPausedWorld(page)).toEqual(before);
  const invalid = JSON.parse(before.toString());
  invalid.organisms[0].genome.cells = [];
  await checkpointBytes(
    page,
    1,
    JSON.stringify({ ...JSON.parse(original!), world: JSON.stringify(invalid) }),
  );
  await page.locator('#checkpoint-refresh').click();
  await expect(page.locator('#checkpoint-status')).toContainText('refreshed');
  await confirmCheckpoint(page, 'restore');
  await expect
    .poll(() => page.evaluate(() => window.terrainNative.errors.at(-1)?.code))
    .toBe('load-failed');
  const failedRun = await page.evaluate(() => window.terrainNative.errors.at(-1).runId);
  await terrainNativeFrame(page, failedRun);
  expect(await downloadPausedWorld(page)).toEqual(before);
  await checkpointBytes(page, 1, '{corrupt');
  await page.locator('#checkpoint-refresh').click();
  await expect(page.locator('#checkpoint-slot')).toContainText('Corrupt checkpoint');
  await page.locator('#checkpoint-restore').click();
  await expect(page.locator('#checkpoint-status')).toContainText('no restorable');
  await confirmCheckpoint(page, 'delete');
  await expect(page.locator('#checkpoint-status')).toContainText('deleted');
  await checkpointBytes(page, 1, original!);
  await page.locator('#checkpoint-refresh').click();
  await expect(page.locator('#checkpoint-status')).toContainText('refreshed');
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('Test storage quota exhausted', 'QuotaExceededError');
    };
  });
  await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#checkpoint-save').click();
  await page.locator('#checkpoint-confirm').click();
  await expect(page.locator('#checkpoint-status')).toContainText('storage is full');
  expect(await checkpointBytes(page, 1)).toBe(original);
  expect(await downloadPausedWorld(page)).toEqual(before);
  await page.locator('#step').click();
  await expect(page.locator('#tick')).toHaveText(
    `TICK ${(JSON.parse(before.toString()).tick + 1).toLocaleString()}`,
  );
  await info.attach('checkpoint-faults.json', {
    contentType: 'application/json',
    body: JSON.stringify({
      conflict: 'exact bytes checked after confirmation',
      corruption: 'explicit deletion',
      invalidWorld: 'real worker load-failed with exact active-world recovery',
      quota: 'native IndexedDB put throws; original bytes unchanged; exact Step remains available',
    }),
  });
});

test('native undefined checkpoint records remain occupied and cannot replace an observed empty slot', async ({
  page,
}) => {
  await observeTerrainNative(page);
  await page.goto('/');
  await terrainNativeFrame(page);
  const baseline = await downloadPausedWorld(page);
  await openCheckpoints(page);
  await page.locator('#checkpoint-name').fill('preserve unknown records');
  const undefinedRecord = async (slot: number, write = false) =>
    page.evaluate(
      async ({ slot, write }) => {
        const request = indexedDB.open('evolab-world-checkpoints', 1);
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise<{ present: boolean; isUndefined: boolean }>(
            (resolve, reject) => {
              const tx = db.transaction('entries', write ? 'readwrite' : 'readonly');
              const store = tx.objectStore('entries');
              if (write) store.put(undefined, slot);
              const cursor = store.openCursor(slot);
              let result = { present: false, isUndefined: false };
              cursor.onsuccess = () => {
                result = {
                  present: cursor.result !== null,
                  isUndefined: cursor.result?.value === undefined,
                };
              };
              tx.oncomplete = () => resolve(result);
              tx.onabort = () => reject(tx.error);
            },
          );
        } finally {
          db.close();
        }
      },
      { slot, write },
    );
  expect(await undefinedRecord(1, true)).toEqual({ present: true, isUndefined: true });
  await page.locator('#checkpoint-refresh').click();
  await expect(page.locator('#checkpoint-slot')).toContainText('Uninspectable stored value');
  await expect(page.locator('#checkpoint-usage')).toContainText('1 / 5');
  for (const action of ['save', 'restore', 'delete']) {
    await page.locator('#checkpoint-' + action).click();
    await expect(page.locator('#checkpoint-status')).toContainText(
      'Unsupported storage is read-only',
    );
    await expect(page.locator('#checkpoint-dialog')).not.toBeVisible();
  }
  await page.locator('#checkpoint-slot').selectOption('2');
  expect(await undefinedRecord(2, true)).toEqual({ present: true, isUndefined: true });
  await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#checkpoint-save').click();
  await expect(page.locator('#checkpoint-status')).toContainText('changed or disappeared');
  await expect(page.locator('#checkpoint-dialog')).not.toBeVisible();
  expect(await undefinedRecord(1)).toEqual({ present: true, isUndefined: true });
  expect(await undefinedRecord(2)).toEqual({ present: true, isUndefined: true });
  expect((await downloadPausedWorld(page)).toString()).toBe(baseline.toString());
});

test('unavailable checkpoint storage leaves explicit download and exact Step available', async ({
  page,
}) => {
  await observeTerrainNative(page);
  await page.addInitScript(() => {
    IDBFactory.prototype.open = function () {
      throw new DOMException('Test denied storage', 'SecurityError');
    };
  });
  await page.goto('/');
  await terrainNativeFrame(page);
  await page.locator('#local-checkpoints').evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  await page.locator('#checkpoint-refresh').click();
  await expect(page.locator('#checkpoint-status')).toContainText('unavailable');
  const before = JSON.parse((await downloadPausedWorld(page)).toString());
  await page.locator('#step').click();
  await expect(page.locator('#tick')).toHaveText(`TICK ${(before.tick + 1).toLocaleString()}`);
});
