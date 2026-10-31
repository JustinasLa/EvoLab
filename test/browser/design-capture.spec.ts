import { test, expect, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type Genome, type WorldFile } from '../../src/model';
import { parseBlueprint, serializeBlueprint } from '../../src/blueprint';
import { LIBRARY_DATABASE } from '../../src/library';
import { nativeDownload, nativeSummary, registerNativeEvidence } from './sensory-evidence';

registerNativeEvidence();
test.afterEach(async ({ page }) => {
  const native = await nativeSummary(page);
  expect(native.pending).toEqual([]);
  expect(native.activeUrls).toEqual([]);
  expect(native.overflow).toBe(false);
});

declare global {
  interface Window {
    designCaptureEvidence: {
      hold: boolean;
      release: (() => void) | null;
      last: any;
      state: any;
      captures: number;
      maximumStateBytes: number;
      delayPost: boolean;
      releasePost: (() => void) | null;
      error: any;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const evidence = (window.designCaptureEvidence = {
      hold: false,
      release: null,
      last: null,
      state: null,
      captures: 0,
      maximumStateBytes: 0,
      delayPost: false,
      releasePost: null,
      error: null,
    });
    window.Worker = new Proxy(window.Worker, {
      construct(target, args: ConstructorParameters<typeof Worker>, newTarget) {
        const worker: Worker = Reflect.construct(target, args, newTarget);
        const nativePost = worker.postMessage;
        worker.postMessage = function (...messages: Parameters<typeof nativePost>) {
          if (evidence.delayPost && messages[0].type === 'capture-design') {
            evidence.delayPost = false;
            evidence.releasePost = () => {
              evidence.releasePost = null;
              Reflect.apply(nativePost, worker, messages);
            };
            return;
          }
          return Reflect.apply(nativePost, worker, messages);
        };
        worker.addEventListener('message', ({ data }) => {
          if (data.state) {
            evidence.state = data.state;
            evidence.maximumStateBytes = Math.max(
              evidence.maximumStateBytes,
              new TextEncoder().encode(JSON.stringify(data.state)).byteLength,
            );
          }
          if (data.type === 'error' && data.operation === 'capture-design') evidence.error = data;
          if (data.type === 'design-captured') {
            evidence.last = data;
            evidence.captures++;
          }
        });
        const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage')!;
        let handler: ((event: MessageEvent) => void) | null = null;
        Object.defineProperty(worker, 'onmessage', {
          get: () => handler,
          set(next: ((event: MessageEvent) => void) | null) {
            handler = next;
            descriptor.set!.call(worker, (event: MessageEvent) => {
              const deliver = () => {
                next?.(event);
                if (event.data.type === 'loaded' && !event.data.state.playback.paused)
                  document.getElementById('pause')!.click();
              };
              if (evidence.hold && event.data.type === 'design-captured') {
                evidence.hold = false;
                evidence.release = () => {
                  evidence.release = null;
                  deliver();
                };
              } else deliver();
            });
          },
        });
        return worker;
      },
    });
  });
});

function fixture(large = false): WorldFile {
  const genome: Genome = {
    ...founder(2),
    behavior: {
      version: 1,
      mode: 'evolved',
      reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
    },
    legacyExtensions: [['memo', [['string', large ? 'x'.repeat(20000) : 'complete native memo']]]],
  };
  genome.cells[0].legacyExtensions = [['cellMemo', [['number', '-0']]]];
  const world = new Ecosystem({ ...DEFAULTS, seed: 73, climate: 0, nutrients: 0 }, false, {
    terrain: { version: 1, preset: 'open-field', seed: null },
  });
  world.spawn(genome, 120, 78);
  return world.save();
}

async function loadAndInspect(page: Page, world: WorldFile) {
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#file').setInputFiles({
    name: 'complete-capture-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(world)),
  });
  await expect(page.locator('#world-label')).toHaveText('WORLD 0073');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const box = await page.locator('#world').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2 + 0.1, box!.y + box!.height / 2 + 0.1);
  await expect(page.locator('#inspector')).toContainText('Organism 1');
}

async function revealSelected(page: Page, selector: string) {
  if (
    ['#copy-organism', '#capture-selected', '#export-organism-blueprint'].includes(selector) &&
    (await page.locator('#specimen-details').getAttribute('open')) === null
  )
    await page.locator('#specimen-details > summary').click();
}
async function download(page: Page, selector: string) {
  await revealSelected(page, selector);
  return nativeDownload(page, selector);
}

async function records(page: Page): Promise<string[]> {
  return page.evaluate(
    (name) =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('entries');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('entries', 'readonly');
          const read = tx.objectStore('entries').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(read.result);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    LIBRARY_DATABASE,
  );
}

async function nextCapture(page: Page, selector: string) {
  const before = await page.evaluate(() => window.designCaptureEvidence.captures);
  await revealSelected(page, selector);
  await page.locator(selector).click();
  await expect
    .poll(() => page.evaluate(() => window.designCaptureEvidence.captures))
    .toBe(before + 1);
  return page.evaluate(() => window.designCaptureEvidence.last);
}

test('complete evolved and opaque genotype survives selected/common copy, direct export and native library capture/load without world changes', async ({
  page,
}, info) => {
  const file = fixture(),
    genome = file.organisms[0].genome;
  await loadAndInspect(page, file);
  const before = await download(page, '#save');
  const copied = await nextCapture(page, '#copy-organism');
  expect(copied.genome).toEqual(genome);
  expect(copied).toMatchObject({
    source: 'organism',
    sourceId: 1,
    completedTick: JSON.parse(before.toString()).tick,
    seed: 73,
  });
  expect(parseBlueprint((await download(page, '#export-blueprint')).toString()).genome).toEqual(
    genome,
  );
  expect(
    parseBlueprint((await download(page, '#export-organism-blueprint')).toString()).genome,
  ).toEqual(genome);
  const captured = await nextCapture(page, '#capture-selected');
  await expect(page.locator('#library-rows button')).toHaveCount(1);
  const stored = JSON.parse((await records(page))[0]);
  expect(parseBlueprint(stored.blueprint).genome).toEqual(genome);
  expect(stored.provenance).toEqual({ captureTick: captured.completedTick, seed: 73 });
  await page.locator('#blueprint-name').fill('newer designer draft');
  await page.locator('#library-load').click();
  await expect(page.locator('#library-dialog')).toBeVisible();
  await page.locator('#library-confirm').click();
  await expect(page.locator('#blueprint-name')).not.toHaveValue('newer designer draft');
  expect(parseBlueprint((await download(page, '#export-blueprint')).toString()).genome).toEqual(
    genome,
  );
  await page.getByRole('tab', { name: 'Ecosystem', exact: true }).click();
  const common = await nextCapture(page, '#lineages button');
  expect(common.source).toBe('lineage');
  expect(common.sourceId).toBe(file.organisms[0].species);
  expect(common.genome).toEqual(genome);
  expect(parseBlueprint((await download(page, '#export-blueprint')).toString()).genome).toEqual(
    genome,
  );
  expect((await download(page, '#save')).equals(before)).toBe(true);
  const state = await page.evaluate(() => window.designCaptureEvidence.state);
  expect(state.selected.genome.behavior).toEqual(genome.behavior);
  expect(JSON.stringify(state)).not.toContain('complete native memo');
  expect(await page.evaluate(() => window.designCaptureEvidence.maximumStateBytes)).toBeLessThan(
    32768,
  );
  await info.attach('complete-capture-neutral-world.json', {
    body: before,
    contentType: 'application/json',
  });
  // Deliberate placement of the captured full design allocates fresh identity.
  const reference = Ecosystem.load(before.toString());
  await page.locator('#plant-design').click();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const point = await page.locator('#world').evaluate((canvas: HTMLCanvasElement) => {
    const box = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: box.left + (canvas.clientWidth - 240 * scale) / 2 + 40.5 * scale,
      y: box.top + (canvas.clientHeight - 156 * scale) / 2 + 40.5 * scale,
    };
  });
  await page.mouse.click(point.x, point.y);
  const outcome = reference.paint('plant', 40, 40, 0, genome);
  expect(outcome.placement).toBeDefined();
  reference.appendIntervention({ kind: 'placement', detail: outcome.placement! });
  await expect(page.locator('#population')).toHaveText('2');
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  const placed = JSON.parse((await download(page, '#save')).toString());
  expect(placed).toEqual(reference.save());
  expect(placed.organisms[1].genome).toEqual(genome);
  expect(placed.organisms[1].id).not.toBe(file.organisms[0].id);
  expect(placed.births).toBe(file.births);
});

test('a genuine held native full response cannot replace a newer designer edit and releases its one owned command', async ({
  page,
}) => {
  const file = fixture();
  await loadAndInspect(page, file);
  const before = await download(page, '#save');
  await page.evaluate(() => {
    window.designCaptureEvidence.hold = true;
  });
  await nextCapture(page, '#copy-organism');
  await expect.poll(() => page.evaluate(() => !!window.designCaptureEvidence.release)).toBe(true);
  await page.locator('#blueprint-name').fill('newer retained design');
  await page.locator('#copy-organism').click();
  await expect(page.locator('#notice')).toContainText('capture busy');
  expect(await page.evaluate(() => window.designCaptureEvidence.captures)).toBe(1);
  await page.evaluate(() => window.designCaptureEvidence.release!());
  await expect(page.locator('#notice')).toContainText('cancelled');
  await expect(page.locator('#blueprint-name')).toHaveValue('newer retained design');
  expect((await download(page, '#save')).equals(before)).toBe(true);
});

test('complete source limits fail without truncation, download, designer replacement or loss of a newer library candidate', async ({
  page,
}) => {
  const file = fixture(true);
  await loadAndInspect(page, file);
  await page.locator('#blueprint-name').fill('retained design');
  const anatomy = await page.locator('#editor').innerHTML();
  const before = await download(page, '#save');
  let downloads = 0;
  page.on('download', () => downloads++);
  await nextCapture(page, '#copy-organism');
  await expect(page.locator('#notice')).toContainText('16 KiB');
  await nextCapture(page, '#export-organism-blueprint');
  await expect(page.locator('#notice')).toContainText('16 KiB');
  expect(downloads).toBe(0);
  await nextCapture(page, '#capture-selected');
  await expect(page.locator('#library-status')).toContainText('failed');
  expect(await records(page)).toEqual([]);
  await expect(page.locator('#library-candidate')).toBeHidden();
  await page.evaluate(() => {
    window.designCaptureEvidence.hold = true;
  });
  await nextCapture(page, '#capture-selected');
  await expect.poll(() => page.evaluate(() => !!window.designCaptureEvidence.release)).toBe(true);
  await page.locator('#library-file').setInputFiles({
    name: 'candidate.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      serializeBlueprint({ name: 'Keep this candidate', description: '', genome: founder(0) }),
    ),
  });
  await expect(page.locator('#library-candidate-name')).toHaveText('Keep this candidate');
  await page.evaluate(() => window.designCaptureEvidence.release!());
  await expect(page.locator('#library-status')).toContainText('Existing candidate preserved');
  await expect(page.locator('#library-candidate-name')).toHaveText('Keep this candidate');
  await expect(page.locator('#blueprint-name')).toHaveValue('retained design');
  expect(await page.locator('#editor').innerHTML()).toBe(anatomy);
  expect(await records(page)).toEqual([]);
  expect((await download(page, '#save')).equals(before)).toBe(true);
});

test('a source that genuinely dies before the delayed native read fails without replacement and keeps exact empty Step and complete Save', async ({
  page,
}) => {
  const world = new Ecosystem({ ...DEFAULTS, seed: 73, climate: 0, nutrients: 0 }, false, {
    terrain: { version: 1, preset: 'open-field', seed: null },
  });
  const genome: Genome = { ...founder(0), cells: [{ x: 0, y: 0, type: 3 }] };
  const organism = world.spawn(genome, 120, 78)!;
  organism.energy = 1;
  const file = world.save();
  await loadAndInspect(page, file);
  await page.locator('#blueprint-name').fill('retained after genuine source death');
  await page.evaluate(() => {
    window.designCaptureEvidence.delayPost = true;
    (document.getElementById('target-tick') as HTMLInputElement).value = '1000000';
    document.getElementById('run-to-tick')!.click();
    document.getElementById('copy-organism')!.click();
  });
  await expect
    .poll(() => page.evaluate(() => !!window.designCaptureEvidence.releasePost))
    .toBe(true);
  await expect(page.locator('#extinction-summary')).toContainText('energy exhaustion');
  const deathTick = await page.evaluate(() => window.designCaptureEvidence.state.world.stats.tick);
  expect(deathTick).toBeGreaterThan(1);
  await page.evaluate(() => window.designCaptureEvidence.releasePost!());
  await expect(page.locator('#notice')).toContainText('no longer alive');
  const error = await page.evaluate(() => window.designCaptureEvidence.error);
  expect(error).toMatchObject({
    operation: 'capture-design',
    source: 'organism',
    sourceId: 1,
    code: 'invalid-command',
  });
  expect(error.fatal).toBeUndefined();
  await expect(page.locator('#blueprint-name')).toHaveValue('retained after genuine source death');
  await page.locator('#step').click();
  await expect(page.locator('#tick')).toHaveText(`TICK ${deathTick + 1}`);
  const reference = Ecosystem.load(JSON.stringify(file));
  while (reference.tick < deathTick + 1) reference.step();
  expect(JSON.parse((await download(page, '#save')).toString())).toEqual(reference.save());
});
