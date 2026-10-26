import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { parse } from '@babel/parser';
import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Ecosystem } from '../../src/ecosystem';
import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  founder,
  positions,
  type Genome,
  type ControlState,
  type WorldFile,
} from '../../src/model';
import { serializeBlueprint } from '../../src/blueprint';

type Counters = {
  steps: number;
  gridBuilds: number;
  transfers: number;
  gridBytes: number;
  maxScheduled: number;
  maxDisplay: number;
  maxProgress: number;
  largestStepMs: number;
  largestBatchMs: number;
};
type Receipt = {
  commandId: number;
  type: string;
  postedAt: number;
  receivedAt: number;
  state: ControlState;
};
declare global {
  interface Window {
    longRun: {
      state: ControlState | null;
      receipt: Receipt | null;
      counters: Counters | null;
      frames: number;
      metadataBytes: number;
      telemetryJSONBytes: number;
      saveTextBytes: number;
      draws: number;
      drawnAt: number;
      frameAt: number;
      savedText: string | null;
      holdFrame?: boolean;
      holdTerminal?: boolean;
      holdControl?: boolean;
      releaseFrame?: (() => void) | null;
      releaseTerminal?: (() => void) | null;
      releaseControl?: (() => void) | null;
    };
  }
}

function instrumentWorker(source: string): string {
  const parsed = parse(source, { sourceType: 'module' });
  const insertions: { position: number; text: string }[] = [];
  const methods: string[] = [];
  function visit(node: any): void {
    if (node.type === 'ClassMethod' && node.body && ['step', 'display'].includes(node.key.name)) {
      const name = node.key.name;
      methods.push(name);
      insertions.push({
        position: node.body.start + 1,
        text: name === 'step' ? 'const __began=performance.now(),__before=this.tick;try{' : 'try{',
      });
      insertions.push({
        position: node.body.end - 1,
        text:
          name === 'step'
            ? '}finally{if(this.tick===__before+1)__evidence.steps++;__evidence.largestStepMs=Math.max(__evidence.largestStepMs,performance.now()-__began)}'
            : '}finally{__evidence.gridBuilds++}',
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object') visit(child);
      } else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parsed);
  expect(methods.sort()).toEqual(['display', 'step']);
  let instrumented = source;
  for (const insertion of insertions.sort((left, right) => right.position - left.position))
    instrumented =
      instrumented.slice(0, insertion.position) +
      insertion.text +
      instrumented.slice(insertion.position);
  return `const __evidence={steps:0,gridBuilds:0,transfers:0,gridBytes:0,maxScheduled:0,maxDisplay:0,maxProgress:0,largestStepMs:0,largestBatchMs:0};
const __timeout=globalThis.setTimeout.bind(globalThis),__post=globalThis.postMessage.bind(globalThis);let __scheduled=0;
const __owners={display:null,progress:null},__counts={display:0,progress:0};
globalThis.addEventListener('message',({data})=>{const channel=data?.channel,owner=__owners[channel];if(data?.type==='flow-ack'&&owner&&owner.runId===data.runId&&owner.sequence===data.sequence){__counts[channel]--;__owners[channel]=null}});
globalThis.setTimeout=(callback,delay,...args)=>{__scheduled++;__evidence.maxScheduled=Math.max(__evidence.maxScheduled,__scheduled);return __timeout(()=>{__scheduled--;const began=performance.now();try{callback(...args)}finally{__evidence.largestBatchMs=Math.max(__evidence.largestBatchMs,performance.now()-began)}},delay)};
globalThis.postMessage=(data,transfer)=>{if(data.type==='frame'||data.type==='progress'){const channel=data.type==='frame'?'display':'progress';__counts[channel]++;__owners[channel]={runId:data.runId,sequence:data.sequence};const key=channel==='display'?'maxDisplay':'maxProgress';__evidence[key]=Math.max(__evidence[key],__counts[channel])}if(data.type==='frame'){__evidence.transfers++;__evidence.gridBytes+=data.frame.cells.byteLength+data.frame.ids.byteLength}return __post({...data,measurement:{...__evidence}},transfer)};
${instrumented}`;
}

async function observe(page: Page, instrument = true): Promise<void> {
  if (instrument)
    await page.route('**/worker-*.js', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: instrumentWorker(await response.text()) });
    });
  await page.addInitScript(() => {
    window.longRun = {
      state: null,
      receipt: null,
      counters: null,
      frames: 0,
      metadataBytes: 0,
      telemetryJSONBytes: 0,
      saveTextBytes: 0,
      draws: 0,
      drawnAt: 0,
      frameAt: 0,
      savedText: null,
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: Parameters<typeof draw>) {
      const result = Reflect.apply(draw, this, args);
      if (this.canvas.id === 'world') {
        window.longRun.draws++;
        window.longRun.drawnAt = performance.now();
      }
      return result;
    };
    window.Worker = new Proxy(window.Worker, {
      construct(target, args: ConstructorParameters<typeof Worker>, newTarget) {
        const worker: Worker = Reflect.construct(target, args, newTarget);
        let posted: { commandId: number; type: string; postedAt: number } | null = null;
        const nativePost = worker.postMessage;
        worker.postMessage = function (...messages: Parameters<typeof nativePost>) {
          const command = messages[0];
          if (command.type !== 'flow-ack')
            posted = {
              commandId: command.commandId,
              type: command.type,
              postedAt: performance.now(),
            };
          return Reflect.apply(nativePost, worker, messages);
        };
        worker.addEventListener('message', ({ data }) => {
          const evidence = window.longRun;
          if (data.measurement) evidence.counters = data.measurement;
          if (data.state) evidence.state = data.state;
          if (data.type === 'frame') {
            evidence.frames++;
            evidence.frameAt = performance.now();
          } else
            evidence.metadataBytes += new TextEncoder().encode(JSON.stringify(data)).byteLength;
          if (data.type === 'progress' || data.type === 'telemetry')
            evidence.telemetryJSONBytes += new TextEncoder().encode(
              JSON.stringify(data),
            ).byteLength;
          if (data.type === 'saved') {
            evidence.savedText = data.text;
            evidence.saveTextBytes += new TextEncoder().encode(data.text).byteLength;
          }
          if (posted && data.commandId === posted.commandId) {
            evidence.receipt = {
              ...posted,
              receivedAt: performance.now(),
              state: data.state ?? data.recovery?.state,
            };
            posted = null;
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
              const evidence = window.longRun;
              if (evidence.holdFrame && event.data.type === 'frame') {
                evidence.holdFrame = false;
                evidence.releaseFrame = () => {
                  evidence.releaseFrame = null;
                  deliver();
                };
              } else if (
                evidence.holdTerminal &&
                (event.data.type === 'loaded' ||
                  (event.data.type === 'error' && event.data.recovery))
              ) {
                evidence.holdTerminal = false;
                evidence.releaseTerminal = () => {
                  evidence.releaseTerminal = null;
                  deliver();
                };
              } else if (evidence.holdControl && event.data.type === 'control') {
                evidence.holdControl = false;
                evidence.releaseControl = () => {
                  evidence.releaseControl = null;
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
}

function fixture(population: number): WorldFile {
  const world = new Ecosystem({ ...DEFAULTS, seed: 14027, climate: 0, mutation: 0 }, false);
  for (let tick = 0; tick < 5400; tick++) world.step();
  for (let organism = 0; organism < population; organism++) {
    const genome =
      population === 1600
        ? { cells: [{ x: 0, y: 0, type: 4 as const }], preference: 0.5, tolerance: 0.3, tempo: 2 }
        : founder(0);
    const spawned = world.spawn(
      genome,
      population === 1600 ? organism % WIDTH : 5 + (organism % 8) * 28,
      population === 1600 ? Math.floor(organism / WIDTH) : 5 + Math.floor(organism / 8) * 18,
    )!;
    expect(spawned).toBeDefined();
  }
  return world.save();
}

async function settle(page: Page): Promise<WorldFile> {
  const download = page.waitForEvent('download');
  await page.locator('#save').click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function load(page: Page, file: WorldFile, render: boolean, speed: number): Promise<void> {
  await page.waitForFunction(() => window.longRun.state !== null);
  if (!(await page.evaluate(() => window.longRun.state!.playback.paused)))
    await control(page, 'pause');
  await page.locator('#file').setInputFiles({
    name: 'bounded-long-run.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  expect(await settle(page)).toEqual(file);
  await page.evaluate(
    ({ render, speed }) => {
      const checkbox = document.querySelector<HTMLInputElement>('#render-habitat')!;
      if (checkbox.checked !== render) {
        checkbox.checked = render;
        checkbox.dispatchEvent(new Event('change'));
      }
      const select = document.querySelector<HTMLSelectElement>('#speed')!;
      select.value = String(speed);
      select.dispatchEvent(new Event('change'));
    },
    { render, speed },
  );
  await settle(page);
  await page.locator('#world').scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.longRun.state?.display.visible)).toBe(true);
}

function runtime() {
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    base: '21b3abe2f2ffca909ce09833b4cee3d5aa7742aa',
    node: process.version,
    cpu: cpus()[0]?.model,
    platform: platform(),
    kernel: release(),
    logicalCpus: cpus().length,
  };
}

async function attachEvidence(testInfo: TestInfo, name: string, evidence: unknown): Promise<void> {
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(evidence, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

async function control(
  page: Page,
  kind: string,
): Promise<{ inputAt: number; receipt: Receipt; renderedAt: number; drawnAt: number }> {
  const before = await page.evaluate(() => window.longRun.receipt!.commandId);
  const inputAt = await page.evaluate((kind) => {
    const began = performance.now();
    if (kind === 'speed') {
      const select = document.querySelector<HTMLSelectElement>('#speed')!;
      select.value = select.value === '1' ? '4' : '1';
      select.dispatchEvent(new Event('change'));
    } else if (kind === 'reveal') {
      document.getElementById('render-habitat')!.click();
    } else document.getElementById(kind)!.click();
    return began;
  }, kind);
  await page.waitForFunction((id) => (window.longRun.receipt?.commandId ?? 0) > id, before);
  if (kind === 'reveal')
    await page.waitForFunction((time) => window.longRun.drawnAt >= time, inputAt);
  return page.evaluate(async (inputAt) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const evidence = window.longRun;
    if (
      document.getElementById('tick')!.textContent !==
      `TICK ${evidence.state!.world.stats.tick.toLocaleString()}`
    )
      throw new Error('Progress not rendered at its accepted tick.');
    return {
      inputAt,
      receipt: evidence.receipt!,
      renderedAt: performance.now(),
      drawnAt: evidence.drawnAt,
    };
  }, inputAt);
}

test('real admitted plant retains its complete anatomy through a later designer import', async ({
  page,
}, testInfo) => {
  await observe(page);
  await page.goto('/');
  const file = fixture(0);
  await load(page, file, true, 4);
  const genome: Genome = {
    cells: [
      { x: 0, y: 0, type: 3 },
      { x: 1, y: 0, type: 4 },
      { x: 0, y: 1, type: 7 },
    ],
    preference: 0.725,
    tolerance: 0.42,
    tempo: 5,
  };
  const replacement = { ...founder(0), preference: 0.15 };
  await page.locator('#blueprint-file').setInputFiles({
    name: 'plant-a.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeBlueprint({ name: 'Ordered A', description: '', genome })),
  });
  await expect(page.locator('#notice')).toContainText('loaded into the designer');
  await page.locator('#world').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => window.longRun.state?.display.visible);
  await settle(page);
  await page.evaluate(() => {
    window.longRun.holdControl = true;
  });
  await page.locator('#speed').selectOption('1');
  await page.waitForFunction(() => !!window.longRun.releaseControl);
  await page.locator('#plant-design').click();
  const walls = new Set(file.walls);
  let location: { x: number; y: number } | null = null;
  for (let row = 5; row < HEIGHT - 5 && !location; row++)
    for (let column = 5; column < WIDTH - 5 && !location; column++)
      if (positions({ genome, x: column, y: row, rotation: 0 }).every((cell) => !walls.has(cell)))
        location = { x: column, y: row };
  expect(location).not.toBeNull();
  await page.locator('#world').scrollIntoViewIfNeeded();
  const pointer = await page.locator('#world').evaluate((canvas: HTMLCanvasElement, location) => {
    const rect = canvas.getBoundingClientRect(),
      scale = Math.min(canvas.clientWidth / 240, canvas.clientHeight / 156);
    return {
      x: rect.left + (canvas.clientWidth - 240 * scale) / 2 + (location!.x + 0.5) * scale,
      y: rect.top + (canvas.clientHeight - 156 * scale) / 2 + (location!.y + 0.5) * scale,
    };
  }, location);
  await page.mouse.click(pointer.x, pointer.y);
  await page.locator('#blueprint-file').setInputFiles({
    name: 'designer-b.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      serializeBlueprint({ name: 'Later B', description: '', genome: replacement }),
    ),
  });
  await expect(page.locator('#blueprint-name')).toHaveValue('Later B');
  await page.evaluate(() => window.longRun.releaseControl!());
  const saved = await settle(page);
  const reference = Ecosystem.load(JSON.stringify(file));
  reference.paint('plant', location!.x, location!.y, 2, genome);
  expect(saved).toEqual(reference.save());
  expect(saved.organisms).toHaveLength(1);
  expect(saved.organisms[0].genome).toEqual(genome);
  await page.locator('#step').click();
  reference.step();
  expect(await settle(page)).toEqual(reference.save());
  await attachEvidence(testInfo, 'real-admitted-plant-evidence', {
    ...runtime(),
    project: testInfo.project.name,
    genome,
    replacement,
    location,
    savedTick: saved.tick,
    saveSHA256: createHash('sha256').update(JSON.stringify(saved)).digest('hex'),
  });
});

for (const population of [64, 1600]) {
  test(`forty real control barriers population=${population}`, async ({
    page,
    browser,
  }, testInfo) => {
    await observe(page);
    await page.goto('/');
    const file = fixture(population);
    await load(page, file, true, 12);
    const records: object[] = [],
      inputLatencies: number[] = [],
      settlingLatencies: number[] = [],
      revealLatencies: number[] = [];
    for (let interaction = -2; interaction < 40; interaction++) {
      await page.locator('#world').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => window.longRun.state?.display.visible);
      const kind = ['cancel-target', 'pause', 'reveal', 'speed'][(interaction + 4) % 4];
      if (kind === 'cancel-target' || kind === 'pause') {
        await page.evaluate(() => {
          document.querySelector<HTMLInputElement>('#target-tick')!.value = String(
            window.longRun.state!.world.stats.tick + 1000000,
          );
          document.getElementById('run-to-tick')!.click();
        });
        await page.waitForFunction(() => window.longRun.state?.target?.status === 'running');
      } else if (kind === 'reveal') {
        await page.evaluate(() => document.getElementById('render-habitat')!.click());
        await settle(page);
        await page.locator('#world').scrollIntoViewIfNeeded();
        await page.waitForFunction(() => window.longRun.state?.display.visible);
      }
      const record = await control(page, kind);
      const saved = await settle(page);
      const savedAt = await page.evaluate(() => performance.now());
      if (kind !== 'speed') expect(saved.tick).toBe(record.receipt.state.world.stats.tick);
      if (interaction >= 0) {
        const inputAck = record.receipt.receivedAt - record.inputAt;
        inputLatencies.push(inputAck);
        if (kind === 'cancel-target' || kind === 'pause')
          settlingLatencies.push(savedAt - record.inputAt);
        if (kind === 'reveal') revealLatencies.push(record.drawnAt - record.inputAt);
        records.push({
          interaction,
          kind,
          ...record,
          inputAck,
          renderedProgressMs: record.renderedAt - record.inputAt,
          savedAt,
          savedTick: saved.tick,
          savedSHA256: createHash('sha256').update(JSON.stringify(saved)).digest('hex'),
        });
      }
      if (kind === 'pause') {
        await page.evaluate(() => document.getElementById('cancel-target')!.click());
        await settle(page);
      }
    }
    const distribution = (values: number[]) => {
      const ordered = [...values].sort((left, right) => left - right);
      return {
        median: ordered[Math.floor(ordered.length / 2)],
        p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
        max: ordered.at(-1),
      };
    };
    const measured = {
      inputAckMs: distribution(inputLatencies),
      savedSettleMs: distribution(settlingLatencies),
      freshRevealMs: distribution(revealLatencies),
    };
    const counters = await page.evaluate(() => window.longRun.counters);
    await attachEvidence(testInfo, 'forty-control-evidence', {
      ...runtime(),
      browser: browser.version(),
      population,
      project: testInfo.project.name,
      measured,
      counters,
      records,
      limitations:
        'Actual native controls receive programmatic DOM events with canvas in view; timings are not a human reaction or physical-device measurement. Saves are real native downloads. Separate existing browser tests exercise actual pointer/keyboard coordinates. Saturated latency has no foreground guarantee.',
    });
    expect(records).toHaveLength(40);
    expect(counters!.maxScheduled).toBe(1);
    if (population === 64) {
      expect(measured.inputAckMs.p95).toBeLessThan(150);
      expect(measured.savedSettleMs.p95).toBeLessThan(250);
      expect(measured.freshRevealMs.p95).toBeLessThan(250);
    }
  });
}

test('native long-run controls fit narrow layouts, extreme ticks and zoom-equivalent width', async ({
  page,
  browser,
}, testInfo) => {
  await observe(page);
  await page.goto('/');
  const { telemetry: discarded, ...legacy } = new Ecosystem(DEFAULTS, false).save();
  expect(discarded.samples).toHaveLength(0);
  await page.locator('#file').setInputFiles({
    name: 'maximum-tick-v2.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...legacy, version: 2, tick: 1000000000 })),
  });
  await expect(page.locator('#tick')).toHaveText('TICK 1,000,000,000');
  await page.locator('#target-tick').fill('1000000000');
  const layouts: object[] = [];
  for (const width of [360, 390, 640, 760, 780, 1024, 1280, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect().toJSON();
      const targets = [
        '#run-to-tick',
        '#cancel-target',
        '#refresh-habitat',
        '#target-tick',
        'label[for="render-habitat"]',
      ].map((selector) => ({ selector, ...rect(selector) }));
      document.getElementById('target-tick')!.focus();
      const focus = getComputedStyle(document.getElementById('target-tick')!);
      const contrast = [
        '#target-help',
        '#tick-rate',
        '#habitat-freshness',
        'label[for="render-habitat"]',
        'label[for="target-tick"]',
      ].map((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const foreground = getComputedStyle(element).color;
        let ancestor: Element | null = element;
        let background = 'rgba(0, 0, 0, 0)';
        while (ancestor && background === 'rgba(0, 0, 0, 0)') {
          background = getComputedStyle(ancestor).backgroundColor;
          ancestor = ancestor.parentElement;
        }
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
          return channels.reduce((total, channel, index) => {
            const normalized = channel / 255;
            const linear =
              normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            return total + linear * [0.2126, 0.7152, 0.0722][index];
          }, 0);
        };
        const light = luminance(foreground),
          dark = luminance(background);
        return {
          selector,
          foreground,
          background,
          ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
        };
      });
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        habitat: rect('#world'),
        sidebar: rect('.sidebar'),
        tick: rect('#tick'),
        target: rect('#target-tick'),
        targets,
        contrast,
        focus: { width: focus.outlineWidth, style: focus.outlineStyle, color: focus.outlineColor },
      };
    });
    layouts.push(layout);
    expect(layout.scrollWidth).toBeLessThanOrEqual(width);
    expect(layout.habitat.width).toBeGreaterThan(0);
    for (const target of layout.targets)
      expect(target.height).toBeGreaterThanOrEqual(width <= 780 ? 44 : 36);
    expect(parseFloat(layout.focus.width)).toBeGreaterThanOrEqual(2);
    for (const color of layout.contrast) expect(color.ratio).toBeGreaterThanOrEqual(4.5);
    if (width === 360 || width === 1280) {
      const path = testInfo.outputPath(`layout-${width}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`layout-${width}`, { path, contentType: 'image/png' });
    }
  }
  await attachEvidence(testInfo, 'long-run-layout-evidence', {
    ...runtime(),
    browser: browser.version(),
    project: testInfo.project.name,
    layouts,
    zoomEquivalent:
      '640 CSS pixels represents a 1280px viewport at 200% layout zoom; not an OS magnifier or physical browser zoom claim.',
  });
});

test('ordinary paced render-off throughput remains measured rather than inferred from speed', async ({
  page,
  browser,
}, testInfo) => {
  await observe(page, false);
  await page.goto('/');
  const file = fixture(64),
    results: object[] = [];
  for (const render of [true, false]) {
    await load(page, file, render, 4);
    const began = await page.evaluate(() => {
      const time = performance.now();
      document.getElementById('pause')!.click();
      return time;
    });
    await page.waitForTimeout(5100);
    await page.evaluate(() => document.getElementById('pause')!.click());
    const saved = await settle(page),
      end = await page.evaluate(() => ({
        time: performance.now(),
        state: window.longRun.state,
        frames: window.longRun.frames,
      }));
    results.push({
      render,
      began,
      end,
      actualTicksPerSecond: ((saved.tick - file.tick) * 1000) / (end.time - began),
    });
  }
  await attachEvidence(testInfo, 'ordinary-paced-evidence', {
    ...runtime(),
    browser: browser.version(),
    results,
    limitations:
      'No worker wrappers. Page counters and actual Save downloads remain. A 40ms scheduler is timer-limited; no rendering-off speedup is promised.',
  });
});

test('requested Chromium lifecycle transition records actual visibility and complete ecology', async ({
  page,
  browser,
}, testInfo) => {
  await observe(page);
  await page.goto('/');
  const file = fixture(64);
  await load(page, file, true, 4);
  await page.evaluate(() => {
    document.addEventListener('visibilitychange', (event) => {
      document.documentElement.dataset.lifecycleVisibility = JSON.stringify({
        state: document.visibilityState,
        trusted: event.isTrusted,
        at: performance.now(),
      });
    });
    document.getElementById('pause')!.click();
  });
  await page.waitForFunction(() => window.longRun.state?.rate.status === 'measured');
  const before = await page.evaluate(() => ({
    time: performance.now(),
    state: window.longRun.state,
  }));
  const session = await page.context().newCDPSession(page);
  await session.send('Page.setWebLifecycleState', { state: 'frozen' });
  const suspended = await session.send('Runtime.evaluate', {
    expression:
      'JSON.stringify({visibility:document.visibilityState,event:document.documentElement.dataset.lifecycleVisibility})',
    returnByValue: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 2300));
  await session.send('Page.setWebLifecycleState', { state: 'active' });
  await session.send('Page.bringToFront');
  await page.locator('#world').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => window.longRun.state?.display.visible);
  const resumed = await page.evaluate(() => ({
    time: performance.now(),
    visibility: document.visibilityState,
    event: document.documentElement.dataset.lifecycleVisibility,
    state: window.longRun.state,
  }));
  await control(page, 'pause');
  const saved = await settle(page);
  const reference = Ecosystem.load(JSON.stringify(file));
  for (let tick = reference.tick; tick < saved.tick; tick++) reference.step();
  expect(saved).toEqual(reference.save());
  expect(resumed.time - before.time).toBeGreaterThanOrEqual(2300);
  expect(resumed.visibility).toBe('visible');
  await attachEvidence(testInfo, 'actual-lifecycle-evidence', {
    ...runtime(),
    browser: browser.version(),
    project: testInfo.project.name,
    before,
    suspended: JSON.parse(suspended.result.value),
    resumed,
    savedTick: saved.tick,
    completeSaveSHA256: createHash('sha256').update(JSON.stringify(saved)).digest('hex'),
    limitations:
      'Chromium CDP frozen/active requests, not synthetic visibility dispatch. Inspect observed visibility/event fields: this headless browser may remain visible and keep its worker running despite the request. Missing events mean no trusted visibility transition was observed. This does not prove physical hidden-tab throttling, suspension, discard or OS sleep; complete elapsed wall time is retained.',
  });
  await session.detach();
});

test('native exact targets, suspended cancellation and render-off editing preserve complete saves', async ({
  page,
}, testInfo) => {
  await observe(page);
  await page.goto('/');
  const file = fixture(64);
  const records: object[] = [];
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  };
  for (const speed of [1, 4, 12])
    for (const render of [true, false]) {
      await load(page, file, render, speed);
      await page.locator('#target-tick').fill(String(file.tick + 31));
      await page.locator('#target-tick').press('Enter');
      await page.waitForFunction(() => window.longRun.state?.target?.status === 'reached');
      const saved = await settle(page);
      const reference = Ecosystem.load(JSON.stringify(file));
      for (let tick = 0; tick < 31; tick++) reference.step();
      expect(saved).toEqual(reference.save());
      expect(saved.tick).toBe(file.tick + 31);
      records.push({
        speed,
        render,
        tick: saved.tick,
        saveSHA256: createHash('sha256').update(JSON.stringify(saved)).digest('hex'),
      });
      await page.locator('#target-tick').focus();
      await capture(`target-reached-speed-${speed}-render-${render}`);
    }
  await load(page, file, false, 1);
  await page.locator('#target-tick').fill(String(file.tick + 1000000));
  await page.locator('#run-to-tick').click();
  await page.waitForFunction(() => window.longRun.state?.target?.status === 'running');
  await capture('render-off-target-running');
  await page.locator('#pause').click();
  await page.waitForFunction(() => window.longRun.state?.target?.status === 'suspended');
  const suspended = await settle(page);
  await capture('target-suspended');
  await page.locator('#cancel-target').focus();
  await page.locator('#cancel-target').press('Enter');
  await page.waitForFunction(() => window.longRun.state?.target?.status === 'cancelled');
  expect(await settle(page)).toEqual(suspended);
  await capture('target-cancelled');
  await page.locator('#step').click();
  const stepped = await settle(page);
  const reference = Ecosystem.load(JSON.stringify(file));
  for (let tick = reference.tick; tick < stepped.tick; tick++) reference.step();
  expect(stepped.tick).toBe(suspended.tick + 1);
  expect(stepped).toEqual(reference.save());
  await capture('render-off-paused-step');
  await page.locator('#render-habitat').check();
  await page.locator('#world').scrollIntoViewIfNeeded();
  await expect(page.locator('#habitat-freshness')).toContainText(
    `Habitat current at tick ${stepped.tick}`,
  );
  expect(await settle(page)).toEqual(stepped);
  await capture('render-reenabled-current');
  await page.locator('#file').setInputFiles({
    name: 'invalid-world.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...stepped, version: 99 })),
  });
  await expect(page.locator('#notice')).toContainText('version 2, 3 or 4');
  expect(await settle(page)).toEqual(stepped);
  await capture('retained-world-failed-import');
  await attachEvidence(testInfo, 'native-target-evidence', {
    ...runtime(),
    project: testInfo.project.name,
    records,
    suspendedTick: suspended.tick,
    steppedTick: stepped.tick,
  });
});

for (const replacement of ['invalid', 'empty'])
  for (const frameFirst of [false, true])
    test(`real held-frame ${replacement} replacement frameFirst=${frameFirst}`, async ({
      page,
    }, testInfo) => {
      await observe(page);
      await page.goto('/');
      const file = fixture(64);
      await load(page, file, true, 4);
      await page.waitForFunction(() => window.longRun.frameAt > 0 && window.longRun.draws > 0);
      await page.evaluate(() => {
        window.longRun.holdFrame = true;
        document.getElementById('refresh-habitat')!.click();
      });
      await page.waitForFunction(() => !!window.longRun.releaseFrame);
      const before = await page.evaluate(() => ({
        counters: window.longRun.counters!,
        draws: window.longRun.draws,
      }));
      const empty = new Ecosystem(file.settings, false);
      for (let tick = 0; tick < file.tick; tick++) empty.step();
      const candidate = replacement === 'invalid' ? { ...file, version: 99 } : empty.save();
      await page.evaluate(() => {
        window.longRun.holdTerminal = true;
      });
      await page.locator('#file').setInputFiles({
        name: 'held-replacement.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(candidate)),
      });
      await page.waitForFunction(() => !!window.longRun.releaseTerminal);
      await page.locator('#world').scrollIntoViewIfNeeded();
      await page.evaluate((frameFirst) => {
        if (frameFirst) {
          window.longRun.releaseFrame!();
          window.longRun.releaseTerminal!();
        } else {
          window.longRun.releaseTerminal!();
          window.longRun.releaseFrame!();
        }
      }, frameFirst);
      await page.waitForFunction((draws) => window.longRun.draws > draws, before.draws);
      const expected = replacement === 'invalid' ? file : empty.save();
      await expect(page.locator('#habitat-freshness')).toContainText(
        `Habitat current at tick ${expected.tick}`,
      );
      const after = await page.evaluate(() => ({
        counters: window.longRun.counters!,
        draws: window.longRun.draws,
      }));
      expect(after.counters.gridBuilds - before.counters.gridBuilds).toBe(1);
      expect(after.counters.gridBytes - before.counters.gridBytes).toBe(187200);
      expect(after.draws - before.draws).toBe(1);
      expect(after.counters.maxDisplay).toBe(1);
      expect(await settle(page)).toEqual(expected);
      await attachEvidence(testInfo, 'real-held-frame-evidence', {
        ...runtime(),
        project: testInfo.project.name,
        replacement,
        frameFirst,
        before,
        after,
        saveSHA256: createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
      });
    });

test('render-off progresses and records history before any habitat is drawn', async ({
  page,
}, testInfo) => {
  await observe(page);
  await page.addInitScript(() => {
    window.longRun.holdFrame = true;
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.longRun.releaseFrame);
  await control(page, 'pause');
  await page.locator('#render-habitat').uncheck();
  const before = await settle(page);
  const counters = await page.evaluate(() => window.longRun.counters!);
  await page.locator('#target-tick').fill(String(before.tick + 61));
  await page.locator('#run-to-tick').click();
  await page.waitForFunction(() => window.longRun.state?.target?.status === 'reached');
  const saved = await settle(page);
  const reference = Ecosystem.load(JSON.stringify(before));
  for (let tick = 0; tick < 61; tick++) reference.step();
  expect(saved).toEqual(reference.save());
  const after = await page.evaluate(() => ({
    draws: window.longRun.draws,
    counters: window.longRun.counters!,
    state: window.longRun.state,
  }));
  expect(after.draws).toBe(0);
  expect(after.counters.gridBuilds).toBe(counters.gridBuilds);
  expect(after.counters.gridBytes).toBe(counters.gridBytes);
  await expect(page.locator('#habitat-freshness')).toContainText('habitat tick not received');
  const path = testInfo.outputPath('no-habitat-render-off.png');
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach('no-habitat-render-off', { path, contentType: 'image/png' });
  await attachEvidence(testInfo, 'no-habitat-evidence', {
    ...runtime(),
    project: testInfo.project.name,
    beforeTick: before.tick,
    after,
    savedTick: saved.tick,
    recordedSamples: saved.telemetry.samples.length,
    limitations:
      'The default-on startup frame is held before page consumption and is counted separately; after disabling rendering no additional grids are built or transferred. This is not a claim that default-on startup built no grid.',
  });
  await page.evaluate(() => window.longRun.releaseFrame!());
  expect(await settle(page)).toEqual(saved);
  expect(await page.evaluate(() => window.longRun.draws)).toBe(0);
});

for (const population of [64, 1600]) {
  for (const speed of [1, 4, 12])
    for (const repetition of [0, 1, 2]) {
      test(`paired advancing transport population=${population} speed=${speed} repetition=${repetition}`, async ({
        page,
        browser,
      }, testInfo) => {
        await observe(page);
        await page.goto('/');
        const file = fixture(population),
          raw: object[] = [];
        for (const render of repetition % 2 ? [false, true] : [true, false]) {
          await load(page, file, render, speed);
          const start = await page.evaluate(() => {
            const input = document.querySelector<HTMLInputElement>('#target-tick')!;
            input.value = String(window.longRun.state!.world.stats.tick + 1000000);
            const result = {
              time: performance.now(),
              tick: window.longRun.state!.world.stats.tick,
              counters: window.longRun.counters!,
              frames: window.longRun.frames,
              metadataBytes: window.longRun.metadataBytes,
              telemetryJSONBytes: window.longRun.telemetryJSONBytes,
              saveTextBytes: window.longRun.saveTextBytes,
            };
            document.documentElement.dataset.measureStart = String(result.time);
            document.getElementById('run-to-tick')!.click();
            return result;
          });
          await page.waitForFunction(
            () =>
              ['reached', 'extinct', 'cancelled'].includes(
                window.longRun.state?.target?.status ?? '',
              ) ||
              performance.now() - Number(document.documentElement.dataset.measureStart) >= 5100,
            undefined,
            { polling: 100 },
          );
          const stopped = await page.evaluate(() => {
            const state = window.longRun.state!;
            if (state.target?.status === 'running')
              document.getElementById('cancel-target')!.click();
            return { time: performance.now(), state };
          });
          const saved = await settle(page),
            end = await page.evaluate(() => ({
              counters: window.longRun.counters!,
              frames: window.longRun.frames,
              metadataBytes: window.longRun.metadataBytes,
              telemetryJSONBytes: window.longRun.telemetryJSONBytes,
              saveTextBytes: window.longRun.saveTextBytes,
            }));
          const reference = Ecosystem.load(JSON.stringify(file));
          for (let tick = reference.tick; tick < saved.tick; tick++) reference.step();
          expect(saved).toEqual(reference.save());
          expect(end.counters.maxScheduled).toBe(1);
          expect(end.counters.maxDisplay).toBeLessThanOrEqual(1);
          expect(end.counters.maxProgress).toBeLessThanOrEqual(1);
          const grids = end.counters.gridBuilds - start.counters.gridBuilds;
          const transferred = end.counters.gridBytes - start.counters.gridBytes;
          expect(transferred).toBe(grids * 187200);
          if (!render) {
            expect(grids).toBe(0);
            expect(transferred).toBe(0);
          }
          raw.push({
            render,
            speed,
            repetition,
            start,
            stopped,
            end,
            stoppedTick: saved.tick,
            advancedTicks: saved.tick - file.tick,
            elapsedMs: stopped.time - start.time,
            actualTicksPerSecond: ((saved.tick - file.tick) * 1000) / (stopped.time - start.time),
            grids,
            transferred,
            completeSaveSHA256: createHash('sha256').update(JSON.stringify(saved)).digest('hex'),
          });
        }
        await attachEvidence(testInfo, 'paired-advancing-evidence', {
          ...runtime(),
          browser: browser.version(),
          project: testInfo.project.name,
          population,
          seed: file.settings.seed,
          initialSaveSHA256: createHash('sha256').update(JSON.stringify(file)).digest('hex'),
          raw,
          limitations:
            'Instrumented worker wraps actual completed steps, actual display helper and scheduled callbacks without changing engine behavior. Timings include observation wrappers. Metadata/telemetry JSON byte counts estimate serialization, not structured-clone wire size; raw grid buffers and saved UTF8 text bytes are exact. Programmatic native DOM events keep the canvas visible. Full saves are independently recomputed at actual completed ticks. This is local Chromium emulation, not physical-device or hidden-tab certification.',
        });
      });
    }
}
