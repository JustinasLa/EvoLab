import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, type WorldFile } from '../../src/model';
import type { ComparisonResult } from '../../src/experiment-model';

declare global {
  interface Window {
    comparisonNative: {
      source: string;
      result: ComparisonResult | null;
      progress: number;
      created: number;
      terminated: number;
      liveSaves: number;
      types: string[];
      holdCompletion: boolean;
      releaseCompletion: (() => void) | null;
    };
    comparisonRead: { started: boolean; release: () => void };
  }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const records = (window.comparisonNative = {
      source: '',
      result: null as ComparisonResult | null,
      progress: 0,
      created: 0,
      terminated: 0,
      liveSaves: 0,
      types: [] as string[],
      holdCompletion: false,
      releaseCompletion: null as (() => void) | null,
    });
    const Native = Worker;
    window.Worker = class extends Native {
      comparison: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.comparison = String(url).includes('comparison-worker');
        if (this.comparison) records.created++;
        this.addEventListener('message', (event) => {
          const { data } = event;
          if (this.comparison && data.type === 'progress') records.progress++;
          if (this.comparison && data.type === 'complete') {
            records.result = data.result;
            if (records.holdCompletion) {
              const handler = this.onmessage;
              records.releaseCompletion = () => handler?.call(this, event);
              event.stopImmediatePropagation();
            }
          }
          if (!this.comparison && data.type === 'saved') records.liveSaves++;
        });
      }
      override postMessage(data: any, options?: any) {
        if (this.comparison && data.type === 'start') records.source = data.text;
        if (!this.comparison && data.type !== 'flow-ack') {
          if (records.types.length >= 200) throw new Error('Comparison evidence command bound');
          records.types.push(data.type);
        }
        super.postMessage(data, options);
      }
      override terminate() {
        if (this.comparison) records.terminated++;
        super.terminate();
      }
    };
  });
  await page.goto('/');
  await expect(page.locator('#tick')).toContainText('TICK');
  await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#comparisons').evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
});
async function download(page: Page, selector: string) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const file = await pending;
  const text = (await readFile((await file.path())!)).toString();
  if (selector === '#save') await expect(page.locator('#save')).toBeEnabled();
  return text;
}
async function run(
  page: Page,
  intervention: 'none' | 'heat' | 'cold',
  duration: number,
  delay: number,
) {
  await page.locator('#comparison-intervention').selectOption(intervention);
  await page.locator('#comparison-duration').fill(String(duration));
  await page.locator('#comparison-delay').fill(String(delay));
  await page.locator('#comparison-start').click();
  await expect(page.locator('#comparison-status')).toContainText('Complete:');
  return page.evaluate(() => window.comparisonNative.result!);
}
function expected(source: string, horizon: number, intervention?: 'heat' | 'cold', boundary = 0) {
  const world = Ecosystem.load(source);
  while (world.tick < horizon) {
    if (world.tick === boundary && intervention) {
      const before = { offset: world.eventOffset, until: world.eventUntil };
      world.shock(intervention);
      world.appendIntervention({
        kind: 'shock',
        detail: {
          kind: intervention,
          before,
          after: { offset: world.eventOffset, until: world.eventUntil },
        },
      });
    }
    world.step();
  }
  return world.save();
}

test('native checkpoint forks repeat identical full control states and bounded samples without changing the sandbox', async ({
  page,
}, info) => {
  const sandbox = await download(page, '#save');
  const before = await page.evaluate(() => window.comparisonNative.types.length);
  const first = await run(page, 'none', 120, 0);
  const source = await page.evaluate(() => window.comparisonNative.source);
  expect(source).toBe(sandbox);
  expect(first.control).toEqual(first.treatment);
  expect(JSON.parse(first.control.state)).toEqual(expected(source, first.plan.horizonTick));
  expect(first.control.samples.map((sample) => sample.tick)).toEqual(
    [0, 30, 60, 90, 120].map((offset) => first.sourceTick + offset),
  );
  expect(await download(page, '#comparison-control')).toBe(first.control.state);
  expect(await download(page, '#comparison-treatment')).toBe(first.treatment.state);
  const second = await run(page, 'none', 120, 0);
  expect(second).toEqual(first);
  const audit = await page.evaluate(() => window.comparisonNative);
  expect(audit.types.slice(before)).toEqual(['save', 'save']);
  expect(audit.created).toBe(2);
  expect(audit.terminated).toBe(2);
  expect(audit.progress).toBeGreaterThan(0);
  expect(await download(page, '#save')).toBe(sandbox);
  await test.info().attach('native-comparison-control-control.json', {
    contentType: 'application/json',
    body: JSON.stringify({ project: info.project.name, source, result: first, audit }),
  });
});

test('native treatment boundaries reproduce real heat/cold engine continuations with no statistical claim', async ({
  page,
}) => {
  for (const intervention of ['heat', 'cold'] as const) {
    const first = await run(page, intervention, 61, 12);
    const source = await page.evaluate(() => window.comparisonNative.source);
    expect(JSON.parse(first.control.state)).toEqual(expected(source, first.plan.horizonTick));
    expect(JSON.parse(first.treatment.state)).toEqual(
      expected(source, first.plan.horizonTick, intervention, first.plan.treatmentTick),
    );
    const changed = JSON.parse(first.treatment.state) as WorldFile;
    expect(changed.interventions.entries.at(-1)?.firstTick).toBe(first.sourceTick + 12);
    expect(first.control.samples.map((sample) => sample.tick)).toEqual(
      first.treatment.samples.map((sample) => sample.tick),
    );
    expect(await run(page, intervention, 61, 12)).toEqual(first);
    expect(await page.locator('#comparison-status').textContent()).toContain(
      `after completed tick ${first.sourceTick + 12}`,
    );
  }
});

test('native cancel/reset/import fences late captures and releases active worker/results', async ({
  page,
}) => {
  const baseline = await download(page, '#save');
  await page.evaluate(() => {
    document.getElementById('comparison-start')!.click();
    document.getElementById('comparison-cancel')!.click();
  });
  await expect(page.locator('#save')).toBeEnabled();
  expect(await page.evaluate(() => window.comparisonNative.created)).toBe(0);
  await expect(page.locator('#comparison-status')).toContainText('cancelled');
  await run(page, 'none', 31, 0);
  await page.locator('#load').click();
  await expect(page.locator('#comparison-results')).toBeEmpty();
  await page
    .locator('#file')
    .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.locator('#notice')).toContainText('valid EvoLab');
  expect(await download(page, '#save')).toBe(baseline);
  await page.locator('#comparison-duration').fill('3600');
  await page.locator('#comparison-delay').fill('0');
  await page.locator('#comparison-start').click();
  await expect(page.locator('#comparison-status')).toContainText('Comparison tick');
  await page.locator('#comparison-cancel').click();
  await expect(page.locator('#comparison-results')).toBeEmpty();
  const counts = await page.evaluate(() => window.comparisonNative);
  expect(counts.created).toBe(counts.terminated);
  await page.evaluate(() => {
    document.getElementById('comparison-start')!.click();
    document.getElementById('reset')!.click();
    document.getElementById('confirm-reset')!.click();
  });
  await expect(page.locator('#comparison-status')).toContainText('lifecycle changed');
  await expect(page.locator('#comparison-results')).toBeEmpty();
  await expect(page.locator('#comparison-start')).toBeEnabled();
});

for (const phase of ['active', 'complete'] as const) {
  for (const outcome of ['valid', 'invalid', 'read-error'] as const) {
    test(`native delayed ${outcome} import clears a newer ${phase} comparison`, async ({
      page,
    }) => {
      const baseline = await download(page, '#save');
      const replacement = new Ecosystem(DEFAULTS, false);
      replacement.step();
      await page.evaluate(
        ({ readError, holdCompletion }) => {
          const text = File.prototype.text;
          window.comparisonNative.holdCompletion = holdCompletion;
          window.comparisonRead = {
            started: false,
            release: () => {
              throw new Error('Read not started');
            },
          };
          File.prototype.text = function () {
            const file = this;
            window.comparisonRead.started = true;
            return new Promise<string>((resolve, reject) => {
              window.comparisonRead.release = () => {
                File.prototype.text = text;
                if (readError) reject(new Error('Unreadable selected world.'));
                else text.call(file).then(resolve, reject);
              };
            });
          };
        },
        { readError: outcome === 'read-error', holdCompletion: phase === 'active' },
      );
      await page.locator('#file').setInputFiles({
        name: 'delayed-comparison-world.json',
        mimeType: 'application/json',
        buffer: Buffer.from(outcome === 'valid' ? JSON.stringify(replacement.save()) : '{}'),
      });
      await expect.poll(() => page.evaluate(() => window.comparisonRead.started)).toBe(true);
      await page.locator('#comparison-intervention').selectOption('none');
      await page.locator('#comparison-duration').fill('31');
      await page.locator('#comparison-delay').fill('0');
      await page.locator('#comparison-start').click();
      await expect
        .poll(() => page.evaluate(() => window.comparisonNative.result !== null))
        .toBe(true);
      const native = await page.evaluate(() => window.comparisonNative);
      expect(JSON.parse(native.result!.control.state)).toEqual(
        expected(native.source, native.result!.plan.horizonTick),
      );
      if (phase === 'active') {
        await expect(page.locator('#comparison-start')).toBeDisabled();
        expect(native.created - native.terminated).toBe(1);
        expect(await page.evaluate(() => window.comparisonNative.releaseCompletion !== null)).toBe(
          true,
        );
      } else {
        await expect(page.locator('#comparison-status')).toContainText('Complete:');
        await expect(page.locator('#comparison-control')).toBeEnabled();
      }
      await page.evaluate(() => window.comparisonRead.release());
      await expect(page.locator('#notice')).toContainText(
        outcome === 'valid'
          ? 'World restored'
          : outcome === 'invalid'
            ? 'valid EvoLab'
            : 'Unreadable selected world',
      );
      await expect(page.locator('#comparison-status')).toContainText('lifecycle changed');
      await expect(page.locator('#comparison-results')).toBeEmpty();
      await expect(page.locator('#comparison-start')).toBeEnabled();
      await expect(page.locator('#comparison-cancel')).toBeDisabled();
      await expect(page.locator('#comparison-control')).toBeDisabled();
      await expect(page.locator('#comparison-treatment')).toBeDisabled();
      expect(
        await page.evaluate(() => {
          const value = window.comparisonNative;
          value.releaseCompletion?.();
          return value.created === value.terminated;
        }),
      ).toBe(true);
      await expect(page.locator('#comparison-results')).toBeEmpty();
      await expect(page.locator('#run-state')).toHaveText('PAUSED');
      expect(JSON.parse(await download(page, '#save'))).toEqual(
        outcome === 'valid' ? replacement.save() : JSON.parse(baseline),
      );
    });
  }
}

test('native empty checkpoints retain honest extinction and the maximum bounded sample horizon', async ({
  page,
}) => {
  const empty = JSON.stringify(new Ecosystem(DEFAULTS, false).save());
  await page.locator('#file').setInputFiles({
    name: 'empty.json',
    mimeType: 'application/json',
    buffer: Buffer.from(empty),
  });
  await expect(page.locator('#extinction-summary')).toContainText('imported empty world');
  const result = await run(page, 'none', 3600, 0);
  expect(result.control.extinction).toEqual({ tick: null, cause: 'initially empty checkpoint' });
  expect(result.control.samples).toHaveLength(121);
  expect(result.control).toEqual(result.treatment);
  expect(JSON.parse(result.control.state).tick).toBe(3600);
  await expect(page.locator('#comparison-results tbody tr')).toHaveCount(121);
  await expect(page.locator('#comparison-status')).toContainText('historical tick unknown');
});
