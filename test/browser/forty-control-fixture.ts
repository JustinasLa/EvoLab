// Opt-in instrumentation and ownership for the four forty-control cases only.
import {
  test,
  expect,
  type Browser,
  type Page,
  type TestInfo,
  type Download,
} from '@playwright/test';
import { writeFile, rename } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import type { Readable } from 'node:stream';
import type { ControlState, WorldFile, WorkerCommand } from '../../src/model';

const TOTAL_MS = 120000;
const WINDOW_MS = 30000;
const MAX_BYTES = 2500000;
const MAX_COMMANDS = 512;

type FrameworkTiming = {
  startedAt: number;
  bodyStartedAt?: number;
  bodyEndedAt?: number;
  acceptanceElapsedMs?: number;
  invalidate?: (error: unknown) => void;
  body?: Promise<void>;
};
export const fortyTest = test.extend<{ fortyFramework: FrameworkTiming; fortyOwnership: void }>({
  fortyFramework: [
    async ({}, use, testInfo) => {
      // Automatic fixtures without page dependencies start before page/context setup.
      const timing: FrameworkTiming = { startedAt: performance.now() };
      await use(timing);
      const endedAt = performance.now();
      const path = testInfo.outputPath('forty-framework-timing.json');
      await writeFile(
        path,
        JSON.stringify(
          {
            frameworkBeforeBodyMs:
              timing.bodyStartedAt === undefined ? null : timing.bodyStartedAt - timing.startedAt,
            frameworkAfterBodyMs:
              timing.bodyEndedAt === undefined ? null : endedAt - timing.bodyEndedAt,
            fixtureTotalMs: endedAt - timing.startedAt,
            acceptanceElapsedMs: timing.acceptanceElapsedMs ?? null,
            note: 'Framework page/context setup and after-hooks/teardown are outside acceptance and supply no workload allowance. Shared beforeAll bundle preparation is reported in the case evidence.',
          },
          null,
          2,
        ),
      );
      await testInfo.attach('forty-framework-timing', { path, contentType: 'application/json' });
    },
    { auto: true },
  ],
  fortyOwnership: [
    async ({ page, fortyFramework }, use, testInfo) => {
      try {
        await use();
      } finally {
        // This fixture depends on page, so teardown runs BEFORE page/context
        // teardown. Playwright may have raced the body on a timeout: invalidate
        // immediately, terminate owned resources, then settle that exact body.
        if (fortyFramework.invalidate && fortyFramework.bodyEndedAt === undefined) {
          fortyFramework.invalidate(
            testInfo.errors[0] ?? new Error('Framework interrupted the acceptance body.'),
          );
          await page.close({ runBeforeUnload: false }).catch(() => {});
        }
        await fortyFramework.body?.catch(() => {});
      }
    },
    { auto: true },
  ],
});

type Command = {
  sequence: number;
  workerId: string;
  operationId: string | null;
  type: string;
  commandId: number;
  runId: number;
  postedAt: number;
  terminal?: {
    type: string;
    operation: string;
    runId: number;
    commandId: number;
    receivedAt: number;
    state: ControlState;
    text?: string;
  };
};
type Identity = {
  documentId: string;
  workerId: string;
  workers: number;
  runId: number | null;
  replacementId: number | null;
};
type BrowserFixture = {
  epoch: string;
  active: boolean;
  deadline: number;
  windowDeadline: number;
  documentId: string;
  workerIds: string[];
  commands: Command[];
  phase: string | null;
  expected: { runId: number; replacementId: number } | null;
  runId: number | null;
  replacementId: number | null;
  violation: string | null;
  samples: Record<string, { offeredAt: number; readyObservedAt?: number; dispatchAt?: number }>;
  check: (epoch: string) => void;
  identity: () => Identity;
};
declare global {
  interface Window {
    fortyFixture: BrowserFixture;
  }
}

function sourceProvenance() {
  const checkoutHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      if (statSync(eventPath).size <= 1024 * 1024) {
        const event = JSON.parse(readFileSync(eventPath, 'utf8'));
        const head = event.pull_request?.head?.sha,
          base = event.pull_request?.base?.sha;
        if (
          typeof head === 'string' &&
          typeof base === 'string' &&
          /^[0-9a-f]{40}$/.test(head) &&
          /^[0-9a-f]{40}$/.test(base)
        )
          return {
            head,
            base,
            checkoutHead,
            provenance:
              'GitHub pull_request event head/base; hashes are from the actual checkout tree, which may be a shallow merge checkout. The parent gate must reconcile current remote head/base.',
          };
      }
    } catch {
      /* Unavailable event metadata is not a fabricated base attestation. */
    }
  }
  try {
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return {
      head: checkoutHead,
      base,
      checkoutHead,
      provenance:
        'Local merge-base HEAD origin/main; current remote base is reconciled separately.',
    };
  } catch {
    return {
      head: checkoutHead,
      base: null,
      checkoutHead,
      provenance:
        'Base unavailable in this checkout; no event base or local origin/main ancestry proof. This is not a current-base attestation.',
    };
  }
}

// Runs in the same init script, after the existing observer. It wraps real
// Worker objects without changing commands, terminal messages or engine code.
function installBrowserFixture(epoch: string): void {
  const state: BrowserFixture = (window.fortyFixture = {
    epoch,
    active: true,
    deadline: Infinity,
    windowDeadline: Infinity,
    documentId: crypto.randomUUID(),
    workerIds: [],
    commands: [],
    phase: null,
    expected: null,
    runId: null,
    replacementId: null,
    violation: null,
    samples: {},
    check(captured) {
      if (
        captured !== state.epoch ||
        !state.active ||
        performance.now() >= Math.min(state.deadline, state.windowDeadline)
      ) {
        state.active = false;
        throw new Error('Forty-control browser epoch/deadline expired.');
      }
      if (state.violation) throw new Error(state.violation);
    },
    identity() {
      return {
        documentId: state.documentId,
        workerId: state.workerIds[0],
        workers: state.workerIds.length,
        runId: state.runId,
        replacementId: state.replacementId,
      };
    },
  });
  const NativeWorker = window.Worker;
  for (const type of ['click', 'change', 'input'])
    window.addEventListener(
      type,
      (event) => {
        const element = event.target as HTMLElement | null;
        if (
          !element?.closest(
            '#file, #save, #pause, #speed, #render-habitat, #run-to-tick, #cancel-target',
          )
        )
          return;
        try {
          state.check(epoch);
        } catch {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  window.Worker = new Proxy(NativeWorker, {
    construct(target, args: ConstructorParameters<typeof Worker>, newTarget) {
      state.check(epoch);
      const worker: Worker = Reflect.construct(target, args, newTarget);
      const workerId = crypto.randomUUID();
      state.workerIds.push(workerId);
      if (state.workerIds.length !== 1) state.violation = 'Unexpected extra application Worker.';
      const nativePost = worker.postMessage;
      worker.postMessage = function (
        ...messages: [message: unknown, options?: Transferable[] | StructuredSerializeOptions]
      ) {
        const data = messages[0] as WorkerCommand;
        if (data.type !== 'flow-ack') {
          // This check is at the actual transport dispatch, including automatic
          // view/load/Pause continuations outside a runner evaluate closure.
          state.check(epoch);
          if (state.commands.length >= 512) throw new Error('Bounded command ledger exhausted.');
          if (
            state.expected &&
            (data.runId !== state.expected.runId || data.type === 'start' || data.type === 'load')
          )
            throw new Error('Unexpected world replacement/command run.');
          state.commands.push({
            sequence: state.commands.length,
            workerId,
            operationId: state.phase,
            type: data.type,
            commandId: data.commandId,
            runId: data.runId,
            postedAt: performance.now(),
          });
        }
        return Reflect.apply(nativePost, worker, messages);
      };
      worker.addEventListener('message', ({ data }) => {
        // Expired native work may finish cleanup, but supplies no late evidence.
        if (!state.active || performance.now() >= Math.min(state.deadline, state.windowDeadline)) {
          state.active = false;
          return;
        }
        if (data.state) {
          state.runId = data.runId;
          state.replacementId = data.state.replacementId;
          if (
            state.expected &&
            (data.runId !== state.expected.runId ||
              data.state.replacementId !== state.expected.replacementId)
          )
            state.violation = 'Unexpected observed world identity.';
        }
        if (data.commandId === undefined) return;
        const command = state.commands.find(
          (entry) =>
            entry.workerId === workerId &&
            entry.commandId === data.commandId &&
            entry.runId === data.runId,
        );
        if (!command || command.terminal) {
          state.violation = 'Missing or duplicate exact command terminal association.';
          return;
        }
        if (data.operation !== command.type)
          state.violation = 'Terminal operation differs from posted command.';
        command.terminal = {
          type: data.type,
          operation: data.operation,
          runId: data.runId,
          commandId: data.commandId,
          receivedAt: performance.now(),
          state: data.state ?? data.recovery?.state,
          ...(data.type === 'saved' ? { text: data.text } : {}),
        };
        if (data.type === 'error')
          state.violation = `Command ${command.type}/${command.commandId} failed: ${data.message}`;
      });
      return worker;
    },
  });
}

class Fence {
  readonly epoch = randomUUID();
  readonly startedAt = performance.now();
  readonly deadline = this.startedAt + TOTAL_MS;
  readonly abort = new AbortController();
  readonly owned = new Set<Promise<unknown>>();
  readonly streams = new Set<Readable>();
  active = true;
  windowDeadline = Infinity;
  reason: unknown;
  private timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly page: Page,
    readonly interrupted: () => unknown = () => undefined,
  ) {
    this.timer = setTimeout(
      () => this.invalidate(new Error('Measured overall acceptance deadline exceeded.')),
      TOTAL_MS,
    );
  }
  remaining(): number {
    this.check();
    return Math.max(
      1,
      Math.floor(Math.min(this.deadline, this.windowDeadline) - performance.now()),
    );
  }
  check(): void {
    const interruption = this.interrupted();
    if (this.active && interruption) this.invalidate(interruption);
    if (this.active && performance.now() >= Math.min(this.deadline, this.windowDeadline))
      this.invalidate(new Error('Measured acceptance/window deadline exceeded.'));
    if (!this.active) throw this.reason;
  }
  invalidate(error: unknown): void {
    if (!this.active) return;
    this.active = false;
    this.reason = error;
    clearTimeout(this.timer);
    this.abort.abort(error);
    // Abort owns the original error. A stream may not yet have its reader's
    // error listener, so terminal cleanup must not emit a second error event.
    for (const stream of this.streams) stream.destroy();
  }
  own<T>(promise: Promise<T>): Promise<T> {
    this.owned.add(promise);
    void promise.then(
      () => this.owned.delete(promise),
      () => this.owned.delete(promise),
    );
    return promise;
  }
  async wait<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    // Every race owns its source, abort listener and timer. Invalidation aborts
    // cancellable waits/streams; page closure cancels Playwright sources before
    // the outer failure path awaits all callback/source settlement.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.reason);
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => this.invalidate(new Error('Bounded fixture await expired.')),
        this.remaining(),
      );
    });
    const source = this.own(
      Promise.resolve().then(() => {
        this.check();
        return action();
      }),
    );
    try {
      const result = await Promise.race([source, expired]);
      this.check();
      return result;
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', onAbort);
    }
  }
  async closeFailure(): Promise<number> {
    const began = performance.now();
    // No new browser observations. Closing cancels outstanding protocol calls,
    // actionability waits, downloads, and page-side RAF/poll continuations.
    await this.page.close({ runBeforeUnload: false }).catch(() => {});
    await Promise.allSettled([...this.owned]);
    return performance.now() - began;
  }
  finish(): void {
    this.check();
    clearTimeout(this.timer);
    this.active = false;
  }
}

type Operation = {
  sequence: number;
  id: string;
  role: string;
  interaction: number | null;
  window: number | null;
  expectedType: string;
  status: string;
  runnerStartedMs: number;
  runnerCompletedMs?: number;
  offeredAt?: number;
  readyObservedAt?: number;
  dispatchAt?: number;
  identity?: Identity;
  command?: Command;
  rawPath?: string;
  rawBytes?: number;
  rawSHA256?: string;
  nativeBytesComplete?: boolean;
  savedAt?: number;
  savedTick?: number;
  equalities: string[];
  error?: string;
};
type WindowEvidence = {
  index: number;
  startedMs: number;
  elapsedMs?: number;
  status: string;
  saves: number;
  identity?: Identity;
};

export async function runFortyControls(options: {
  page: Page;
  browser: Browser;
  testInfo: TestInfo;
  framework: FrameworkTiming;
  bundlePreparationMs: number;
  population: number;
  makeFixture: () => WorldFile;
  observe: (init: string, within: <T>(action: () => Promise<T>) => Promise<T>) => Promise<void>;
  exactReference: (file: WorldFile, tick: number) => Promise<string>;
}): Promise<void> {
  const { page, browser, testInfo, framework, population } = options;
  const fence = new Fence(page, () =>
    testInfo.status === 'timedOut' || testInfo.status === 'interrupted'
      ? (testInfo.errors[0] ?? new Error('Framework interrupted the acceptance body.'))
      : undefined,
  ); // Acceptance starts before any fixture work.
  framework.bodyStartedAt = fence.startedAt;
  framework.invalidate = (error) => fence.invalidate(error);
  testInfo.setTimeout(TOTAL_MS);
  const context = page.context(),
    mainFrame = page.mainFrame();
  const operations: Operation[] = [],
    windows: WindowEvidence[] = [],
    records: object[] = [];
  const inputLatencies: number[] = [],
    settlingLatencies: number[] = [],
    revealLatencies: number[] = [];
  const inputAdmission: number[] = [],
    readyDispatch: number[] = [],
    offeredCompletion: number[] = [];
  const navigation: string[] = [];
  let documentId: string | undefined, workerId: string | undefined;
  let loadedIdentity: Identity | undefined,
    commands: Omit<Command, 'terminal'>[] = [];
  let activeOperation: Operation | undefined;
  let status = 'incomplete',
    originalError: string | undefined,
    cleanupMs = 0;
  let counters: unknown, measured: unknown, acceptedElapsedMs: number | undefined;
  const provenance = sourceProvenance();
  const { head, base, checkoutHead } = provenance;
  const sourceHashes = Object.fromEntries(
    ['test/browser/long-run.spec.ts', 'test/browser/forty-control-fixture.ts'].map((path) => [
      path,
      createHash('sha256')
        .update(execFileSync('git', ['show', `${checkoutHead}:${path}`]))
        .digest('hex'),
    ]),
  );
  const evidencePath = testInfo.outputPath('forty-control-evidence.json');
  const onNavigation = (frame: ReturnType<Page['mainFrame']>) => {
    if (frame === mainFrame) {
      navigation.push(frame.url());
      if (navigation.length > 1)
        fence.invalidate(new Error('Unexpected main-frame navigation/reload.'));
    }
  };
  const onClose = () => {
    if (fence.active) fence.invalidate(new Error('Fixture page closed unexpectedly.'));
  };
  page.on('framenavigated', onNavigation);
  page.on('close', onClose);
  const evidence = () => ({
    schema: 1,
    status,
    originalError,
    head,
    base,
    sourceProvenance: provenance,
    sourceHashes,
    population,
    project: testInfo.project.name,
    browser: browser.version(),
    node: process.version,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    platform: platform(),
    kernel: release(),
    budget: {
      acceptanceMs: TOTAL_MS,
      windowMs: WINDOW_MS,
      acceptanceElapsedMs: acceptedElapsedMs ?? performance.now() - fence.startedAt,
      finalMeasuredEndpoint:
        'forty-framework-timing.json acceptanceElapsedMs includes the final evidence write, attachment, browser fence invalidation and assertions',
      windows: windows.map((observation) => ({
        ...observation,
        nativeSaves: operations.filter(
          (op) => op.window === observation.index && op.nativeBytesComplete,
        ).length,
        incompleteOperations: operations
          .filter((op) => op.window === observation.index && op.status !== 'checked')
          .map((op) => op.id),
      })),
    },
    framework: {
      sharedBeforeAllBundleMs: options.bundlePreparationMs,
      beforeBodyMs: fence.startedAt - framework.startedAt,
      cleanupMs,
    },
    identity: {
      contextAndPageRetained: page.context() === context && page.mainFrame() === mainFrame,
      documentId,
      workerId,
      loadedIdentity,
      navigation,
    },
    counts: {
      operations: operations.length,
      nativeSaves: operations.filter((op) => op.nativeBytesComplete).length,
      rawArtifacts: operations.filter((op) => op.rawPath).length,
      checkedSaves: operations.filter((op) => op.expectedType === 'save' && op.status === 'checked')
        .length,
      retainedRecords: records.length,
      inputAck: inputLatencies.length,
      savedSettle: settlingLatencies.length,
      reveal: revealLatencies.length,
    },
    measured,
    counters,
    operations,
    commands,
    records,
    limitations:
      'Owner-amended offered cadence: four <=30s windows inside <=120s, not original 30s acceptance. Programmatic DOM activation on desktop/Chromium mobile emulation, not human pointer or physical-device evidence. Readiness is polling observation (RAF polling); timestamps share browser performance.now. savedAt is sampled in the browser AFTER completed native stream bytes and includes post-completion sampling/transport overhead; never uses the earlier saved terminal. Runner/evidence/framework times use a separate monotonic clock. Saturated latency has no foreground guarantee. Pause-cleanup full/literal equality is a new strengthening. Historical cancelled CI40454560729/original 30s failures and 188 selected diagnostics remain separate.',
  });
  const checkpoint = async () => {
    fence.check();
    await snapshotCommands();
    const text = JSON.stringify(evidence(), null, 2);
    await fence.wait(() => writeFile(`${evidencePath}.tmp`, text, { signal: fence.abort.signal }));
    await fence.wait(() => rename(`${evidencePath}.tmp`, evidencePath));
  };
  const identity = async () => {
    const result = await fence.wait(() =>
      page.evaluate((epoch) => {
        const f = window.fortyFixture;
        f.check(epoch);
        return f.identity();
      }, fence.epoch),
    );
    fence.check();
    expect(page.context()).toBe(context);
    expect(page.mainFrame()).toBe(mainFrame);
    expect(navigation).toHaveLength(1);
    expect(result.workers).toBe(1);
    if (documentId !== undefined) expect(result.documentId).toBe(documentId);
    if (workerId !== undefined) expect(result.workerId).toBe(workerId);
    documentId = result.documentId;
    workerId = result.workerId;
    if (loadedIdentity) expect(result).toEqual(loadedIdentity);
    return result;
  };
  const installDeadline = async () => {
    // Browser sample precedes the remaining-duration sample. Installation and
    // transport delays therefore consume allowance rather than extend it.
    const sampledAt = await fence.wait(() =>
      page.evaluate((epoch) => {
        window.fortyFixture.check(epoch);
        return performance.now();
      }, fence.epoch),
    );
    const remaining = fence.remaining();
    const totalRemaining = Math.max(1, Math.floor(fence.deadline - performance.now()));
    await fence.wait(() =>
      page.evaluate(
        ({ epoch, sampledAt, remaining, totalRemaining }) => {
          const f = window.fortyFixture;
          f.check(epoch);
          f.deadline = Math.min(f.deadline, sampledAt + totalRemaining);
          f.windowDeadline = sampledAt + remaining;
          f.check(epoch);
        },
        { epoch: fence.epoch, sampledAt, remaining, totalRemaining },
      ),
    );
  };
  const poll = async (predicate: () => boolean) => {
    // Predicate is fixture-owned code; browser checks wrap every RAF polling pass.
    const handle = await fence.wait(() =>
      page.waitForFunction(
        ({ epoch, predicate }) => {
          window.fortyFixture.check(epoch);
          return (0, eval)(`(${predicate})`)();
        },
        { epoch: fence.epoch, predicate: predicate.toString() },
        { timeout: fence.remaining() },
      ),
    );
    await fence.wait(() => handle.dispose());
  };
  const begin = async (role: string, interaction: number | null, expectedType: string) => {
    fence.check();
    if (operations.length >= 180) throw new Error('Bounded operation ledger exhausted.');
    const op: Operation = {
      sequence: operations.length,
      id: `${operations.length}-${role}-${interaction ?? 'setup'}`,
      role,
      interaction,
      window: windows.at(-1)?.status === 'running' ? windows.at(-1)!.index : null,
      expectedType,
      status: 'pending',
      runnerStartedMs: performance.now() - fence.startedAt,
      equalities: [],
    };
    operations.push(op);
    activeOperation = op;
    await checkpoint();
    op.offeredAt = await fence.wait(() =>
      page.evaluate(
        ({ epoch, id }) => {
          const f = window.fortyFixture;
          f.check(epoch);
          f.phase = id;
          const time = performance.now();
          f.samples[id] = { offeredAt: time };
          return time;
        },
        { epoch: fence.epoch, id: op.id },
      ),
    );
    return op;
  };
  const ready = async (op: Operation, selector = '#save') => {
    const handle = await fence.wait(() =>
      page.waitForFunction(
        ({ epoch, id, selector }) => {
          const f = window.fortyFixture;
          f.check(epoch);
          const enabled = !document.querySelector<HTMLButtonElement>(selector)!.disabled;
          if (enabled && f.samples[id].readyObservedAt === undefined)
            f.samples[id].readyObservedAt = performance.now();
          return enabled;
        },
        { epoch: fence.epoch, id: op.id, selector },
        { timeout: fence.remaining() },
      ),
    );
    await fence.wait(() => handle.dispose());
  };
  const dispatch = async (op: Operation, kind: string) => {
    await fence.wait(() =>
      page.evaluate(
        ({ epoch, id, kind }) => {
          const f = window.fortyFixture;
          f.check(epoch);
          if (!f.samples[id] || f.samples[id].dispatchAt !== undefined)
            throw new Error('Missing or duplicate operation dispatch ownership.');
          // An offered control can own admission before its target preparation.
          // Reclaim its exact pending ID without restarting any timestamp.
          f.phase = id;
          f.samples[id].dispatchAt = performance.now();
          if (kind === 'speed') {
            const select = document.querySelector<HTMLSelectElement>('#speed')!;
            select.value = select.value === '1' ? '4' : '1';
            f.check(epoch);
            select.dispatchEvent(new Event('change'));
          } else if (kind === 'configure') {
            const checkbox = document.querySelector<HTMLInputElement>('#render-habitat')!;
            if (!checkbox.checked) {
              checkbox.checked = true;
              f.check(epoch);
              checkbox.dispatchEvent(new Event('change'));
            }
            const select = document.querySelector<HTMLSelectElement>('#speed')!;
            select.value = '12';
            f.check(epoch);
            select.dispatchEvent(new Event('change'));
          } else {
            const button = document.getElementById(
              kind === 'reveal' || kind === 'hide' ? 'render-habitat' : kind,
            ) as HTMLButtonElement;
            if (button.disabled) throw new Error(`Disabled native control ${kind}.`);
            if (kind === 'run-to-tick')
              document.querySelector<HTMLInputElement>('#target-tick')!.value = String(
                window.longRun.state!.world.stats.tick + 1000000,
              );
            f.check(epoch);
            button.click();
          }
        },
        { epoch: fence.epoch, id: op.id, kind },
      ),
    );
  };
  const terminal = async (op: Operation, includeText = false) => {
    const handle = await fence.wait(() =>
      page.waitForFunction(
        ({ epoch, id, type }) => {
          const f = window.fortyFixture;
          f.check(epoch);
          const candidates = f.commands.filter((c) => c.operationId === id && c.type === type);
          if (candidates.length > 1) throw new Error('Ambiguous operation command linkage.');
          return candidates.length === 1 && !!candidates[0].terminal;
        },
        { epoch: fence.epoch, id: op.id, type: op.expectedType },
        { timeout: fence.remaining() },
      ),
    );
    await fence.wait(() => handle.dispose());
    const result = await fence.wait(() =>
      page.evaluate(
        ({ epoch, id, type, includeText }) => {
          const f = window.fortyFixture;
          f.check(epoch);
          const c = f.commands.filter((c) => c.operationId === id && c.type === type);
          if (c.length !== 1 || !c[0].terminal) throw new Error('Missing exact terminal.');
          const { text, ...receipt } = c[0].terminal;
          return {
            command: { ...c[0], terminal: { ...receipt, ...(includeText ? { text } : {}) } },
            ...f.samples[id],
            identity: f.identity(),
          };
        },
        { epoch: fence.epoch, id: op.id, type: op.expectedType, includeText },
      ),
    );
    const c = result.command;
    expect(c.workerId).toBe(workerId);
    expect(c.terminal!.commandId).toBe(c.commandId);
    expect(c.terminal!.runId).toBe(c.runId);
    expect(c.terminal!.operation).toBe(c.type);
    expect(c.terminal!.type).toBe(
      op.expectedType === 'save' ? 'saved' : op.expectedType === 'load' ? 'loaded' : 'control',
    );
    if (loadedIdentity) {
      expect(c.runId).toBe(loadedIdentity.runId);
      expect(c.terminal!.state.replacementId).toBe(loadedIdentity.replacementId);
      expect(result.identity).toEqual(loadedIdentity);
    }
    op.command = { ...c, terminal: { ...c.terminal!, text: undefined } };
    op.identity = result.identity;
    op.readyObservedAt = result.readyObservedAt;
    op.dispatchAt = result.dispatchAt;
    return result;
  };
  const checked = async (op: Operation) => {
    fence.check();
    op.status = 'checked';
    op.runnerCompletedMs = performance.now() - fence.startedAt;
    if (op.window !== null && op.expectedType === 'save')
      windows[op.window].saves = operations.filter(
        (entry) =>
          entry.window === op.window && entry.expectedType === 'save' && entry.status === 'checked',
      ).length;
    await checkpoint();
  };
  const action = async (
    role: string,
    interaction: number | null,
    kind: string,
    expectedType: string,
    admission = false,
    offered?: Operation,
  ) => {
    const op = offered ?? (await begin(role, interaction, expectedType));
    activeOperation = op;
    if (admission) await ready(op);
    await dispatch(op, kind);
    const receipt = await terminal(op);
    await identity();
    await checked(op);
    return { op, receipt };
  };
  const save = async (role: string, interaction: number | null) => {
    const op = await begin(role, interaction, 'save');
    await ready(op);
    let removeListener: () => void = () => {};
    const native = fence.own(
      new Promise<Download>((resolve, reject) => {
        const onDownload = (download: Download) => {
          removeListener();
          resolve(download);
        };
        const onAbort = () => {
          removeListener();
          reject(fence.reason);
        };
        removeListener = () => {
          page.off('download', onDownload);
          fence.abort.signal.removeEventListener('abort', onAbort);
        };
        page.on('download', onDownload);
        fence.abort.signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
    const chunks: Buffer[] = [];
    let stream: Readable | null = null;
    try {
      await dispatch(op, 'save');
      const download = await fence.wait(() => native);
      stream = await fence.wait(() => download.createReadStream());
      if (!stream) throw new Error('Native Save has no stream.');
      fence.streams.add(stream);
      let bytes = 0;
      const read = async () => {
        for await (const chunk of stream!) {
          fence.check();
          const buffer = Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_BYTES) throw new Error('Native Save exceeds existing byte cap.');
          chunks.push(buffer);
        }
      };
      await fence.wait(read);
      fence.streams.delete(stream);
      op.nativeBytesComplete = true;
      const raw = Buffer.concat(chunks);
      // This endpoint follows completion of native bytes. Sampling transport is
      // deliberately included in saved-settle; no earlier saved receipt replaces it.
      op.savedAt = await fence.wait(() =>
        page.evaluate((epoch) => {
          window.fortyFixture.check(epoch);
          return performance.now();
        }, fence.epoch),
      );
      op.rawPath = testInfo.outputPath(`save-${op.id}.json`);
      op.rawBytes = raw.byteLength;
      op.rawSHA256 = createHash('sha256').update(raw).digest('hex');
      await fence.wait(() => writeFile(op.rawPath!, raw, { signal: fence.abort.signal }));
      await fence.wait(() =>
        testInfo.attach(`save-${op.id}`, { path: op.rawPath, contentType: 'application/json' }),
      );
      fence.check();
      op.status = 'raw-complete';
      await checkpoint(); // Raw bytes are durable before JSON or semantic checks.
      const result = await terminal(op, true);
      expect(raw.equals(Buffer.from(result.command.terminal!.text!))).toBe(true);
      op.equalities.push('native bytes equal exact save-command terminal text');
      const world: WorldFile = JSON.parse(raw.toString());
      fence.check();
      op.status = 'parsed';
      op.savedTick = world.tick;
      await fence.wait(() =>
        page.evaluate(
          ({ epoch, id }) => {
            const f = window.fortyFixture;
            f.check(epoch);
            for (const c of f.commands)
              if (c.operationId === id && c.terminal) delete c.terminal.text;
          },
          { epoch: fence.epoch, id: op.id },
        ),
      );
      await identity();
      await checkpoint();
      return { op, world, raw, command: result.command };
    } catch (error) {
      // Retained chunks may be serialized only by the outer failure path, after
      // invalidation. Never finish an interrupted stream as acceptance evidence.
      if (chunks.length && op.status !== 'raw-complete' && op.status !== 'parsed') {
        op.rawBytes = chunks.reduce((n, c) => n + c.length, 0);
        partialBuffers.set(op.id, Buffer.concat(chunks));
      }
      throw error;
    } finally {
      removeListener();
      if (stream) {
        fence.streams.delete(stream);
        if (!stream.readableEnded) stream.destroy();
      }
    }
  };
  const partialBuffers = new Map<string, Buffer>();
  const snapshotCommands = async () => {
    commands = await fence.wait(() =>
      page.evaluate((epoch) => {
        const f = window.fortyFixture;
        f.check(epoch);
        return f.commands.map(({ terminal, ...c }) => ({
          ...c,
          terminal: terminal
            ? {
                type: terminal.type,
                operation: terminal.operation,
                runId: terminal.runId,
                commandId: terminal.commandId,
                receivedAt: terminal.receivedAt,
                replacementId: terminal.state.replacementId,
                tick: terminal.state.world.stats.tick,
              }
            : undefined,
        }));
      }, fence.epoch),
    );
    expect(commands.length).toBeLessThanOrEqual(MAX_COMMANDS);
  };
  const canvas = async () => {
    await fence.wait(() =>
      page.locator('#world').scrollIntoViewIfNeeded({ timeout: fence.remaining() }),
    );
    await poll(() => !!window.longRun.state?.display.visible);
  };
  const distribution = (values: number[]) => {
    const ordered = [...values].sort((a, b) => a - b);
    return {
      count: values.length,
      median: ordered[Math.floor(ordered.length / 2)],
      p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
      max: ordered.at(-1),
    };
  };
  try {
    await fence.wait(() =>
      options.observe(
        `(${installBrowserFixture.toString()})(${JSON.stringify(fence.epoch)});`,
        (action) => fence.wait(action),
      ),
    );
    await fence.wait(() => page.goto('/', { timeout: fence.remaining() }));
    await installDeadline();
    await poll(() => window.longRun.state !== null);
    await identity();
    const file = options.makeFixture();
    fence.check();
    if (!(await fence.wait(() => page.evaluate(() => window.longRun.state!.playback.paused))))
      await action('setup-pause', null, 'pause', 'pause');
    await poll(() => window.longRun.state!.playback.paused);
    const op = await begin('setup-load', null, 'load');
    await fence.wait(() =>
      page.locator('#file').setInputFiles(
        {
          name: 'bounded-long-run.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(file)),
        },
        { timeout: fence.remaining() },
      ),
    );
    const loaded = await terminal(op);
    await poll(() => !!window.longRun.loadedReceipt && window.longRun.state!.playback.paused);
    const paused = await fence.wait(() => page.evaluate(() => window.longRun.state!));
    expect(await fence.wait(() => page.locator('#run-state').textContent())).toBe('PAUSED');
    const original = await fence.wait(() => options.exactReference(file, file.tick));
    const presentation = await fence.wait(() =>
      page.evaluate(async (text) => {
        const path = '/__reference/engine.js';
        const { Ecosystem } = await import(path);
        return Ecosystem.load(text).presentation();
      }, original),
    );
    expect(loaded.command.terminal!.state.world).toEqual(presentation);
    expect(loaded.command.terminal!.state.world.stats.tick).toBe(file.tick);
    expect(paused.replacementId).toBe(loaded.command.commandId);
    loadedIdentity = await identity();
    expect(loadedIdentity.runId).toBe(loaded.command.runId);
    expect(loadedIdentity.replacementId).toBe(loaded.command.commandId);
    await fence.wait(() =>
      page.evaluate(
        ({ epoch, runId, replacementId }) => {
          const f = window.fortyFixture;
          f.check(epoch);
          f.expected = { runId, replacementId };
        },
        {
          epoch: fence.epoch,
          runId: loadedIdentity!.runId!,
          replacementId: loadedIdentity!.replacementId!,
        },
      ),
    );
    await checked(op);
    const first = await save('setup-loaded', null);
    expect(first.world.tick).toBe(paused.world.stats.tick);
    expect(first.world.tick).toBeGreaterThanOrEqual(file.tick);
    expect(first.command.terminal!.state.replacementId).toBe(loaded.command.commandId);
    const reference = await fence.wait(() => options.exactReference(file, first.world.tick));
    expect(first.world).toEqual(JSON.parse(reference));
    expect(first.raw.equals(Buffer.from(reference))).toBe(true);
    first.op.equalities.push(
      'complete independent same-browser real-engine reference',
      'literal independent reference serialization',
    );
    await checked(first.op);
    await action('setup-configure', null, 'configure', 'speed');
    const configured = await save('setup-configured', null);
    expect(configured.world).toEqual(first.world);
    expect(configured.raw.equals(first.raw)).toBe(true);
    configured.op.equalities.push('complete setup-loaded world', 'literal setup-loaded bytes');
    await checked(configured.op);
    await canvas();
    for (let index = 0; index < 4; index++) {
      fence.check();
      const began = performance.now();
      fence.windowDeadline = Math.min(fence.deadline, began + WINDOW_MS);
      const observation: WindowEvidence = {
        index,
        startedMs: began - fence.startedAt,
        status: 'running',
        saves: 0,
      };
      windows.push(observation);
      let callback: Promise<void> | undefined;
      try {
        await fortyTest.step(
          `observation window ${index + 1}/4`,
          () => {
            callback = fence.own(
              (async () => {
                try {
                  await installDeadline();
                  observation.identity = await identity();
                  await checkpoint();
                  for (
                    let interaction = index === 0 ? -2 : index * 10;
                    interaction < (index + 1) * 10;
                    interaction++
                  ) {
                    fence.check();
                    await canvas();
                    const kind = ['cancel-target', 'pause', 'reveal', 'speed'][
                      (interaction + 4) % 4
                    ];
                    let offered: Operation | undefined;
                    if (kind === 'cancel-target' || kind === 'pause') {
                      // Prior-Save admission belongs before starting the next
                      // target. Waiting with a live target would add a lease's
                      // worth of ecology to every preparation. Preserve both
                      // offered/readiness endpoints through preparation.
                      offered = await begin('primary-control', interaction, kind);
                      await ready(offered);
                      await action('run-to-preparation', interaction, 'run-to-tick', 'run-to');
                      await poll(() => window.longRun.state?.target?.status === 'running');
                    } else if (kind === 'reveal') {
                      await action('hide-preparation', interaction, 'hide', 'display-view');
                      const preparation = await save('reveal-preparation', interaction);
                      await checked(preparation.op);
                      await canvas();
                    }
                    const { op: control, receipt } = await action(
                      'primary-control',
                      interaction,
                      kind,
                      kind === 'reveal' ? 'display-view' : kind,
                      !offered,
                      offered,
                    );
                    const inputAt = receipt.dispatchAt!;
                    if (kind === 'reveal')
                      await poll(
                        () =>
                          window.longRun.drawnAt >=
                          window.fortyFixture.samples[window.fortyFixture.phase!].dispatchAt!,
                      );
                    const rendered = await fence.wait(() =>
                      page.evaluate(
                        async ({ epoch, inputAt }) => {
                          const f = window.fortyFixture;
                          f.check(epoch);
                          await new Promise<void>((resolve) =>
                            requestAnimationFrame(() => resolve()),
                          );
                          f.check(epoch);
                          if (
                            document.getElementById('tick')!.textContent !==
                            `TICK ${window.longRun.state!.world.stats.tick.toLocaleString()}`
                          )
                            throw new Error('Progress not rendered at its accepted tick.');
                          return {
                            inputAt,
                            renderedAt: performance.now(),
                            drawnAt: window.longRun.drawnAt,
                          };
                        },
                        { epoch: fence.epoch, inputAt },
                      ),
                    );
                    const primary = await save('primary', interaction);
                    const savedAt = primary.op.savedAt!;
                    if (kind !== 'speed') {
                      expect(primary.world.tick).toBe(
                        receipt.command.terminal!.state.world.stats.tick,
                      );
                      primary.op.equalities.push('primary tick equals exact control terminal tick');
                    }
                    await checked(primary.op);
                    if (interaction >= 0) {
                      fence.check();
                      const receivedAt = receipt.command.terminal!.receivedAt;
                      const inputAck = receivedAt - inputAt;
                      inputLatencies.push(inputAck);
                      inputAdmission.push(receipt.readyObservedAt! - receipt.offeredAt);
                      readyDispatch.push(inputAt - receipt.readyObservedAt!);
                      offeredCompletion.push(savedAt - receipt.offeredAt);
                      if (kind === 'cancel-target' || kind === 'pause')
                        settlingLatencies.push(savedAt - inputAt);
                      if (kind === 'reveal') revealLatencies.push(rendered.drawnAt - inputAt);
                      records.push({
                        interaction,
                        kind,
                        operationId: control.id,
                        saveOperationId: primary.op.id,
                        ...rendered,
                        offeredAt: receipt.offeredAt,
                        readyObservedAt: receipt.readyObservedAt,
                        dispatchAt: inputAt,
                        postedAt: receipt.command.postedAt,
                        receivedAt,
                        savedAt,
                        command: receipt.command,
                        identity: receipt.identity,
                        admissionWaitMs: receipt.readyObservedAt! - receipt.offeredAt,
                        readyToDispatchMs: inputAt - receipt.readyObservedAt!,
                        commandPostDelayMs: receipt.command.postedAt - inputAt,
                        commandServiceMs: receivedAt - receipt.command.postedAt,
                        inputAck,
                        savedSettleMs: savedAt - inputAt,
                        offeredToCompletionMs: savedAt - receipt.offeredAt,
                        renderedProgressMs: rendered.renderedAt - inputAt,
                        savedTick: primary.world.tick,
                        savedSHA256: primary.op.rawSHA256,
                        rawSaveBytes: primary.raw.byteLength,
                      });
                      await checkpoint();
                    }
                    if (kind === 'pause') {
                      await action(
                        'pause-cleanup-cancel',
                        interaction,
                        'cancel-target',
                        'cancel-target',
                      );
                      const cleanup = await save('pause-cleanup', interaction);
                      // New strengthening; the old fixture discarded this output.
                      expect(cleanup.world).toEqual(primary.world);
                      expect(cleanup.raw.equals(primary.raw)).toBe(true);
                      cleanup.op.equalities.push(
                        'complete previous primary world (new strengthening)',
                        'literal previous primary bytes (new strengthening)',
                      );
                      await checked(cleanup.op);
                    }
                  }
                  await snapshotCommands();
                  await identity();
                  observation.saves = operations.filter(
                    (op) =>
                      op.window === index && op.expectedType === 'save' && op.status === 'checked',
                  ).length;
                  expect(observation.saves).toBe(index === 0 ? 18 : 15);
                  fence.check();
                  observation.elapsedMs = performance.now() - began;
                  expect(observation.elapsedMs).toBeLessThanOrEqual(WINDOW_MS);
                  observation.status = 'complete';
                  await checkpoint();
                  fence.check();
                  observation.elapsedMs = performance.now() - began;
                  expect(observation.elapsedMs).toBeLessThanOrEqual(WINDOW_MS);
                } catch (error) {
                  fence.invalidate(error);
                  throw error;
                }
              })(),
            );
            return callback;
          },
          { timeout: WINDOW_MS },
        );
        fence.check();
      } catch (error) {
        fence.invalidate(error);
        observation.status = 'incomplete';
        observation.elapsedMs = performance.now() - began;
        throw error;
      }
      fence.windowDeadline = Infinity;
      // Browser window fence is advanced only after timely callback settlement.
      await fence.wait(() =>
        page.evaluate((epoch) => {
          const f = window.fortyFixture;
          f.check(epoch);
          f.windowDeadline = f.deadline;
        }, fence.epoch),
      );
    }
    measured = {
      inputAckMs: distribution(inputLatencies),
      savedSettleMs: distribution(settlingLatencies),
      freshRevealMs: distribution(revealLatencies),
      admissionWaitMs: distribution(inputAdmission),
      readyToDispatchMs: distribution(readyDispatch),
      offeredToCompletionMs: distribution(offeredCompletion),
    };
    counters = await fence.wait(() =>
      page.evaluate((epoch) => {
        window.fortyFixture.check(epoch);
        return window.longRun.counters;
      }, fence.epoch),
    );
    await snapshotCommands();
    await identity();
    expect(records).toHaveLength(40);
    expect(inputLatencies).toHaveLength(40);
    expect(settlingLatencies).toHaveLength(20);
    expect(revealLatencies).toHaveLength(10);
    const saves = operations.filter((op) => op.expectedType === 'save');
    expect(saves).toHaveLength(65);
    expect(saves.every((op) => op.status === 'checked')).toBe(true);
    expect(saves.filter((op) => op.window === null).map((op) => op.role)).toEqual([
      'setup-loaded',
      'setup-configured',
    ]);
    expect(saves.filter((op) => op.role === 'primary').map((op) => op.interaction)).toEqual(
      Array.from({ length: 42 }, (_, i) => i - 2),
    );
    expect(
      saves.filter((op) => op.role === 'reveal-preparation').map((op) => op.interaction),
    ).toEqual(Array.from({ length: 11 }, (_, i) => i * 4 - 2));
    expect(saves.filter((op) => op.role === 'pause-cleanup').map((op) => op.interaction)).toEqual(
      Array.from({ length: 10 }, (_, i) => i * 4 + 1),
    );
    expect(new Set(saves.map((op) => `${op.command!.runId}/${op.command!.commandId}`)).size).toBe(
      65,
    );
    expect(commands.every((c) => 'terminal' in c && c.terminal)).toBe(true);
    expect((counters as { maxScheduled: number }).maxScheduled).toBe(1);
    if (population === 64) {
      expect(distribution(inputLatencies).p95).toBeLessThan(150);
      expect(distribution(settlingLatencies).p95).toBeLessThan(250);
      expect(distribution(revealLatencies).p95).toBeLessThan(250);
    }
    await checkpoint();
    fence.check();
    acceptedElapsedMs = performance.now() - fence.startedAt;
    expect(acceptedElapsedMs).toBeLessThanOrEqual(TOTAL_MS);
    status = 'complete';
    await checkpoint();
    await fence.wait(() =>
      testInfo.attach('forty-control-evidence', {
        path: evidencePath,
        contentType: 'application/json',
      }),
    );
    await fence.wait(() =>
      page.evaluate((epoch) => {
        const f = window.fortyFixture;
        f.check(epoch);
        f.active = false;
      }, fence.epoch),
    );
    fence.check();
    acceptedElapsedMs = performance.now() - fence.startedAt;
    expect(acceptedElapsedMs).toBeLessThanOrEqual(TOTAL_MS);
    framework.acceptanceElapsedMs = acceptedElapsedMs;
    // No async acceptance work follows the measured final assertion.
    fence.finish();
  } catch (error) {
    fence.invalidate(error); // Synchronous before any cleanup await.
    status = 'incomplete';
    originalError =
      error instanceof Error
        ? (error.stack ?? error.message)
        : typeof error === 'object' && error !== null
          ? JSON.stringify(error)
          : String(error);
    if (activeOperation && activeOperation.status !== 'checked') {
      activeOperation.status = 'failed/interrupted';
      activeOperation.error = originalError;
    }
    cleanupMs = await fence.closeFailure();
    for (const [id, bytes] of partialBuffers) {
      const op = operations.find((op) => op.id === id)!;
      op.rawPath = testInfo.outputPath(`partial-${id}.bin`);
      op.rawSHA256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(op.rawPath, bytes);
    }
    // Failure-only serialization uses retained data and elapsed cleanup. It
    // never reads the browser, completes a download or publishes success.
    await writeFile(
      testInfo.outputPath('forty-control-failure.json'),
      JSON.stringify(evidence(), null, 2),
    ).catch(() => {});
    throw error;
  } finally {
    page.off('framenavigated', onNavigation);
    page.off('close', onClose);
    framework.bodyEndedAt = performance.now();
  }
}
