import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

interface Receipt {
  index: number;
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
  startedMs: number;
  completedMs: number;
  path: string;
}
interface Evidence {
  started: number;
  streams: Map<Download, Promise<Buffer>>;
  receipts: Receipt[];
  errors: string[];
  streamReads: { download: number; startedMs: number; returnedMs?: number; endedMs?: number }[];
}
const evidence = new WeakMap<Page, Evidence>();

declare global {
  interface Window {
    sensoryNative: {
      posts: any[];
      responses: any[];
      urls: { operation: string; url: string; bytes?: number; timeMs: number }[];
      activeUrls: Map<string, number>;
      pending: Map<string, object>;
      firstFrames: Record<string, { tick: number; selected: number | null }>;
      hashTasks: Promise<void>[];
      terminated: number;
      overflow: boolean;
    };
  }
}

export function registerNativeEvidence(): void {
  test.beforeEach(async ({ page }) => {
    const state: Evidence = {
      started: performance.now(),
      streams: new Map(),
      receipts: [],
      errors: [],
      streamReads: [],
    };
    evidence.set(page, state);
    page.on('pageerror', (error) => state.errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') state.errors.push(message.text());
    });
    page.on('download', (download) => {
      const index = state.streams.size + 1,
        startedMs = performance.now() - state.started,
        info = test.info(),
        originalRead = download.createReadStream.bind(download);
      download.createReadStream = async () => {
        const record = {
          download: index,
          startedMs: performance.now() - state.started,
        } as Evidence['streamReads'][number];
        state.streamReads.push(record);
        const stream = await originalRead();
        record.returnedMs = performance.now() - state.started;
        stream.once('end', () => {
          record.endedMs = performance.now() - state.started;
        });
        return stream;
      };
      const stream = (async () => {
        const chunks: Buffer[] = [],
          native = await download.createReadStream();
        for await (const chunk of native) chunks.push(chunk);
        const bytes = Buffer.concat(chunks),
          filename = download.suggestedFilename();
        const path = info.outputPath(`native-${index}-${filename.replace(/[^\w.-]/g, '_')}`);
        await writeFile(path, bytes);
        state.receipts.push({
          index,
          filename,
          url: download.url(),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          startedMs,
          completedMs: performance.now() - state.started,
          path,
        });
        await info.attach(`native-${index}-${filename}`, {
          path,
          contentType: filename.endsWith('.csv') ? 'text/csv' : 'application/json',
        });
        return bytes;
      })();
      state.streams.set(download, stream);
      void stream.catch((error) => state.errors.push(`Native download ${index}: ${String(error)}`));
    });
    await page.addInitScript(() => {
      const state = (window.sensoryNative = {
        posts: [] as any[],
        responses: [] as any[],
        urls: [] as any[],
        activeUrls: new Map<string, number>(),
        pending: new Map<string, object>(),
        firstFrames: {} as Record<string, { tick: number; selected: number | null }>,
        hashTasks: [] as Promise<void>[],
        terminated: 0,
        overflow: false,
      });
      const bounded = (records: any[], record: any) => {
        if (records.length < 40000) records.push(record);
        else state.overflow = true;
      };
      const create = URL.createObjectURL.bind(URL),
        revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob),
          timeMs = performance.now(),
          bytes = blob instanceof Blob ? blob.size : undefined;
        state.activeUrls.set(url, timeMs);
        bounded(state.urls, { operation: 'create', url, bytes, timeMs });
        return url;
      };
      URL.revokeObjectURL = (url) => {
        bounded(state.urls, { operation: 'revoke', url, timeMs: performance.now() });
        state.activeUrls.delete(url);
        revoke(url);
      };
      window.Worker = new Proxy(window.Worker, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget) as Worker;
          worker.postMessage = new Proxy(worker.postMessage, {
            apply(post, receiver, args) {
              const data = args[0],
                id = data.requestId ?? data.commandId;
              const record: any = {
                ordinal: state.posts.length + 1,
                type: data.type,
                runId: data.runId,
                requestId: data.commandId,
                commandId: data.commandId,
                timeMs: performance.now(),
                speed: data.value,
              };
              if (id !== undefined) state.pending.set(`${data.runId}:${id}`, record);
              const bytes = new TextEncoder().encode(JSON.stringify(data));
              record.payloadJSONBytes = bytes.length;
              record.transferredBufferLengths = Object.values(data)
                .filter((value) => value instanceof ArrayBuffer)
                .map((value) => (value as ArrayBuffer).byteLength);
              state.hashTasks.push(
                crypto.subtle.digest('SHA-256', bytes).then((digest) => {
                  record.payloadJSONSHA256 = Array.from(new Uint8Array(digest), (byte) =>
                    byte.toString(16).padStart(2, '0'),
                  ).join('');
                }),
              );
              bounded(state.posts, record);
              return Reflect.apply(post, receiver, args);
            },
          });
          worker.addEventListener('message', ({ data }) => {
            const id = data.requestId ?? data.commandId;
            if (id !== undefined) state.pending.delete(`${data.runId}:${id}`);
            bounded(state.responses, {
              ordinal: state.responses.length + 1,
              type: data.type,
              operation: data.operation,
              runId: data.runId,
              requestId: data.commandId,
              commandId: data.commandId,
              completedTick: data.completedTick,
              tick: data.state?.world.stats.tick ?? data.recovery?.state.world.stats.tick,
              selected: data.state?.selected?.id ?? data.recovery?.state.selected?.id ?? null,
              paused: data.state?.playback.paused ?? data.recovery?.state.playback.paused,
              recovery: data.recovery
                ? {
                    selected: data.recovery.state.selected?.id ?? null,
                    paused: data.recovery.state.playback.paused,
                    tick: data.recovery.state.world.stats.tick,
                    settings: data.recovery.state.settings,
                  }
                : undefined,
              byteLength: data.byteLength,
              message: data.message,
              fatal: data.fatal,
              timeMs: performance.now(),
            });
            if (data.type === 'frame' && !state.firstFrames[data.runId])
              state.firstFrames[data.runId] = {
                tick: data.frame.stats.tick,
                selected: data.state.selected?.id ?? null,
              };
          });
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => {
            state.terminated++;
            terminate();
          };
          return worker;
        },
      });
    });
  });
  test.afterEach(async ({ page }, info) => {
    const state = evidence.get(page)!;
    const settlements = await Promise.allSettled([...state.streams.values()]);
    let native: unknown = null;
    if (!page.isClosed()) {
      native = await page
        .evaluate(async () => {
          const state = window.sensoryNative;
          if (!state) return null;
          await Promise.all(state.hashTasks);
          return {
            posts: state.posts,
            responses: state.responses,
            urls: state.urls,
            activeUrls: [...state.activeUrls],
            pending: [...state.pending],
            firstFrames: state.firstFrames,
            terminated: state.terminated,
            overflow: state.overflow,
          };
        })
        .catch((error) => ({ unavailable: String(error) }));
    }
    const path = info.outputPath('native-resource-ledger.json');
    await writeFile(
      path,
      JSON.stringify(
        {
          title: info.title,
          project: info.project.name,
          status: info.status,
          durationMs: performance.now() - state.started,
          downloads: state.receipts,
          nativeStreamReads: state.streamReads.length,
          streamReads: state.streamReads,
          streams: settlements.map((settlement) => settlement.status),
          errors: state.errors,
          native,
        },
        null,
        2,
      ),
    );
    await info.attach('native-resource-ledger.json', { path, contentType: 'application/json' });
  });
}

export async function nativeDownload(page: Page, selector = '#save'): Promise<Buffer> {
  await expect.poll(() => page.evaluate(() => window.sensoryNative.activeUrls.size)).toBe(0);
  await expect(page.locator(selector)).toBeEnabled();
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const download = await pending,
    bytes = await evidence.get(page)!.streams.get(download)!;
  if (selector === '#save')
    expect(download.suggestedFilename()).toMatch(/^evolab-world-\d+\.json$/);
  else expect(download.suggestedFilename()).toBe('evolab-blueprint.json');
  expect(await download.failure()).toBeNull();
  await expect.poll(() => page.evaluate(() => window.sensoryNative.activeUrls.size)).toBe(0);
  if (selector === '#save') {
    await expect(page.locator('#save')).toBeEnabled();
    const terminal = await page.evaluate(() =>
      window.sensoryNative.responses.filter((response) => response.type === 'saved').at(-1),
    );
    expect(terminal.byteLength).toBe(bytes.length);
    expect(terminal.completedTick).toBe(JSON.parse(bytes.toString('utf8')).tick);
  }
  return bytes;
}

export async function nativeSummary(page: Page): Promise<any> {
  return page.evaluate(() => {
    const state = window.sensoryNative;
    return {
      posts: state.posts,
      responses: state.responses,
      pending: [...state.pending],
      activeUrls: [...state.activeUrls],
      firstFrames: state.firstFrames,
      overflow: state.overflow,
    };
  });
}

export function assertNativeStreams(page: Page, downloads: number): void {
  const state = evidence.get(page)!;
  expect(state.streams.size).toBe(downloads);
  expect(state.receipts).toHaveLength(downloads);
  expect(state.errors).toEqual([]);
}

export async function attachWorld(info: TestInfo, label: string, world: unknown): Promise<void> {
  const path = info.outputPath(label);
  await writeFile(path, JSON.stringify(world));
  await info.attach(label, { path, contentType: 'application/json' });
}
