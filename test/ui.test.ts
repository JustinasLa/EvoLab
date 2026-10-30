import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/main';
import { draw, genomeSvg, organismHtml, point, viewport } from '../src/view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULT_TERRAIN } from '../src/terrain';
import { DEFAULTS, founder, type Frame, type PlaybackState, type WorldFile } from '../src/model';
import { parseBlueprint, serializeBlueprint, BLUEPRINT_MAX_BYTES } from '../src/blueprint';
import { startWorker, type Scope } from '../src/worker';
import { emptyRefuges, refugeSummary } from '../src/refuges';
import { libraryHarness } from './fixtures/library';
import { classifyRecord, encodeRecord, libraryCandidate } from '../src/library';
class WorkerStub extends EventTarget {
  playback: PlaybackState = { paused: false, pauseOnExtinction: true, extinction: null };
  postMessage = vi.fn((data: any) => {
    if (data.type === 'start')
      this.emit({
        type: 'started',
        operation: 'start',
        requestId: data.requestId,
        completedTick: 0,
        seed: data.settings.seed,
        settings: data.settings,
        terrain: data.terrain,
      });
    if (['begin-stroke', 'end-stroke', 'paint', 'settings', 'shock'].includes(data.type))
      this.emit({
        type: 'manual-result',
        operation: data.type,
        commandId: data.commandId,
        ...(data.strokeId ? { strokeId: data.strokeId } : {}),
        status: 'no-op',
        completedTick: 0,
        rowSequence: null,
      });
    if (data.type === 'pause' || data.type === 'resume')
      this.emit({
        type: 'playback',
        playback: { ...this.playback, paused: data.type === 'pause' },
      });
  });
  terminate = vi.fn();
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  emit(data: any, runId?: number): void {
    if (['loaded', 'saved'].includes(data.type)) {
      const operation = data.type === 'loaded' ? 'load' : 'save',
        request = this.postMessage.mock.calls
          .map((call) => call[0])
          .filter((request) => request.type === operation)
          .at(-1),
        saved = data.text ? JSON.parse(data.text) : null;
      data = {
        operation,
        requestId: request?.requestId,
        completedTick: saved?.tick ?? 0,
        seed: saved?.settings.seed ?? data.settings?.seed,
        ...(saved ? { byteLength: new TextEncoder().encode(data.text).byteLength } : {}),
        ...data,
      };
    }
    if (data.playback) this.playback = data.playback;
    this.onmessage?.({
      data: {
        terrain: { ...DEFAULT_TERRAIN },
        thermalRefuges: refugeSummary(emptyRefuges()),
        playback: this.playback,
        runId:
          runId ??
          this.postMessage.mock.calls
            .filter((c) => ['start', 'load'].includes(c[0].type))
            .at(-1)?.[0].runId,
        ...data,
      },
    } as MessageEvent);
  }
}
let root: HTMLDivElement, worker: WorkerStub, dispose: () => void, paint: FrameRequestCallback;
const world = new Ecosystem(),
  sample = world.frame(),
  organism = [...world.organisms.values()][0];
const get = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`)!;
const click = (id: string) => {
  get(id).click();
  if (id === 'reset' && get<HTMLDialogElement>('reset-dialog').open) get('confirm-reset').click();
};
const set = (id: string, value: string, event = 'input') => {
  get<HTMLInputElement>(id).value = value;
  get(id).dispatchEvent(new Event(event));
};
const pointer = (type: string, x = 150, y = 150) =>
  get('world').dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
function emit(frame: Frame = sample, selected: any = null): void {
  worker.emit({ type: 'frame', frame, selected });
}
function upload(file?: { size: number; text: () => Promise<string> }): void {
  Object.defineProperty(get('file'), 'files', { configurable: true, value: file ? [file] : [] });
  get('file').dispatchEvent(new Event('change'));
}
async function loadText(text: string): Promise<void> {
  upload({ size: text.length, text: async () => text });
  await Promise.resolve();
}
function realWorker() {
  const tasks: (() => void)[] = [],
    outbox: any[] = [];
  let currentWorld: Ecosystem;
  const originalFrame = Ecosystem.prototype.frame;
  vi.spyOn(Ecosystem.prototype, 'frame').mockImplementation(function (this: Ecosystem) {
    currentWorld = this;
    return originalFrame.call(this);
  });
  const scope: Scope = {
    onmessage: null,
    postMessage: (data, transfer = []) => outbox.push(structuredClone(data, { transfer })),
  };
  startWorker(scope, (callback) => tasks.push(callback));
  const command = (data: any) => scope.onmessage!({ data } as MessageEvent);
  const initial = worker.postMessage.mock.calls[0][0];
  worker.postMessage.mockImplementation(command);
  command(initial);
  const deliver = () => {
    for (const data of outbox.splice(0)) worker.onmessage!({ data } as MessageEvent);
  };
  const save = (): WorldFile => {
    return currentWorld.save();
  };
  return { tasks, outbox, command, deliver, save, advance: () => tasks.shift()!() };
}
function ownershipBridge(mountFunction = mount, beforePublish: (data: any) => void = () => {}) {
  dispose();
  type Record = { command: any; terminal?: any };
  const records = new Map<number, Record>(),
    processing = new Set<number>(),
    callbacks: (() => void)[] = [],
    counts = { E: 0, S: 0, M: 0, C: 0, L: 0, maximum: 0, delivered: 0, terminated: 0 };
  let processingBlocked = false,
    framesBlocked = false,
    hold: (data: any) => boolean = () => false,
    latestFrame: any;
  const classify = (type: string): 'E' | 'S' | 'M' | 'C' | 'L' =>
    type === 'export-measurements'
      ? 'E'
      : type === 'save'
        ? 'S'
        : type === 'end-stroke'
          ? 'C'
          : ['start', 'load'].includes(type)
            ? 'L'
            : 'M';
  const key = (data: any): number => data.requestId ?? data.commandId;
  const scope: Scope = {
    onmessage: null,
    postMessage(data, transfer = []) {
      beforePublish(data);
      if (data.type === 'frame' && framesBlocked) {
        latestFrame = data;
        return;
      }
      data = structuredClone(data, { transfer });
      if (data.type === 'frame') latestFrame = data;
      const record = records.get(key(data));
      if (record && data.operation) {
        expect(record.terminal).toBeUndefined();
        record.terminal = data;
        if (hold(data)) return;
        records.delete(key(data));
        counts.delivered++;
      }
      endpoint.onmessage?.({ data } as MessageEvent);
    },
  };
  const endpoint = Object.assign(new EventTarget(), {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as (() => void) | null,
    postMessage: (data: any) => {
      if (key(data)) {
        counts[classify(data.type)]++;
        expect(records.has(key(data))).toBe(false);
        records.set(key(data), { command: structuredClone(data) });
        expect(records.size).toBeLessThanOrEqual(36);
        counts.maximum = Math.max(counts.maximum, records.size);
        if (processingBlocked) {
          processing.add(key(data));
          return;
        }
      }
      scope.onmessage!({ data: structuredClone(data) } as MessageEvent);
    },
    terminate: () => {
      counts.terminated++;
      processing.clear();
      records.clear();
      callbacks.length = 0;
    },
  });
  startWorker(scope, (callback) => {
    expect(callbacks.length).toBeLessThan(1);
    callbacks.push(callback);
  });
  dispose = mountFunction(root, endpoint as unknown as Worker);
  click('pause');
  return {
    endpoint,
    records,
    counts,
    get latestFrame() {
      return latestFrame;
    },
    get callbackCount() {
      return callbacks.length;
    },
    advance() {
      callbacks.shift()!();
    },
    blockProcessing() {
      processingBlocked = true;
    },
    holdFrames() {
      framesBlocked = true;
    },
    holdTerminals(predicate: (data: any) => boolean = () => true) {
      hold = predicate;
    },
    processAll() {
      processingBlocked = false;
      for (const id of processing) {
        processing.delete(id);
        scope.onmessage!({ data: records.get(id)!.command } as MessageEvent);
      }
    },
    deliver(id: number) {
      const record = records.get(id)!;
      expect(record?.terminal).toBeDefined();
      records.delete(id);
      counts.delivered++;
      endpoint.onmessage?.({ data: record.terminal } as MessageEvent);
      return record.terminal;
    },
    deliverAll() {
      for (const id of records.keys()) this.deliver(id);
    },
    emit(data: any) {
      endpoint.onmessage?.({ data } as MessageEvent);
    },
  };
}
describe('post-success publication failures with real ecology and independent physical owners', () => {
  it.each([
    'start',
    'load',
    'settings',
    'paint',
    'shock',
    'refuge-mode',
    'paint-refuge',
    'clear-refuges',
  ])(
    'shows an independent stopped failure after one successful %s and recovers the applied world explicitly',
    async (operation) => {
      let armed = false,
        targetId = 0,
        terminals = 0,
        failures = 0,
        currentWorld!: Ecosystem;
      const originalFrame = Ecosystem.prototype.frame;
      vi.spyOn(Ecosystem.prototype, 'frame').mockImplementation(function (this: Ecosystem) {
        currentWorld = this;
        return originalFrame.call(this);
      });
      const bridge = ownershipBridge(mount, (data) => {
        if (targetId && (data.requestId ?? data.commandId) === targetId) {
          terminals++;
          expect(data.type).not.toBe('error');
          armed = true;
        }
        if (data.type === 'frame' && armed) {
          armed = false;
          throw new Error('injected frame publication after successful terminal');
        }
        if (data.type === 'error' && data.fatal && !data.operation) failures++;
      });
      bridge.advance();
      expect(bridge.callbackCount).toBe(0);
      if (operation === 'paint-refuge' || operation === 'clear-refuges') {
        click('refuge-enabled');
        if (operation === 'clear-refuges') {
          root.querySelector<HTMLButtonElement>('[data-tool="warm"]')!.click();
          pointer('pointerdown', 50, 50);
          pointer('pointerup');
        }
      }
      bridge.holdTerminals();
      click('measurements-json');
      click('save');
      set('mutation', '0.2');
      if (operation === 'paint' || operation === 'paint-refuge') {
        root
          .querySelector<HTMLButtonElement>(
            `[data-tool="${operation === 'paint' ? 'food' : 'warm'}"]`,
          )!
          .click();
        pointer('pointerdown', 50, 50);
      } else {
        root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
        pointer('pointerdown', 50, 50);
        pointer('pointerup');
      }
      const held = new Map(bridge.records),
        post = bridge.endpoint.postMessage,
        candidate = new Ecosystem({ ...DEFAULTS, seed: 73, nutrients: 0 }, false);
      let command: any;
      vi.spyOn(bridge.endpoint, 'postMessage').mockImplementation((data: any) => {
        if (!targetId && terminals === 0 && data.type === operation) {
          targetId = data.requestId ?? data.commandId;
          command = structuredClone(data);
        }
        post(data);
      });
      bridge.holdTerminals(
        (data) => held.has(data.requestId ?? data.commandId) || data.operation === 'end-stroke',
      );
      let reference = Ecosystem.load(JSON.stringify(currentWorld.save()));
      if (operation === 'start') click('reset');
      else if (operation === 'load') await loadText(JSON.stringify(candidate.save()));
      else if (operation === 'settings') set('nutrients', '7');
      else if (operation === 'refuge-mode') click('refuge-enabled');
      else if (operation === 'clear-refuges') click('clear-refuges');
      else if (operation === 'shock')
        root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
      else {
        pointer('pointermove', 80, 50);
        pointer('pointerup');
      }
      expect(targetId).toBeGreaterThan(0);
      expect(terminals).toBe(1);
      expect(failures).toBe(1);
      expect(get('run-state').textContent).toBe('STOPPED');
      expect(get('notice').textContent).toContain('The action completed');
      expect(get('notice').textContent).toContain('World preserved');
      expect(get<HTMLButtonElement>('step').disabled).toBe(true);
      expect(bridge.callbackCount).toBe(0);
      expect(bridge.counts.terminated).toBe(0);
      for (const [id, record] of held) expect(bridge.records.get(id)).toBe(record);
      if (operation === 'start') reference = new Ecosystem(command.settings);
      else if (operation === 'load') reference = candidate;
      else if (operation === 'settings') reference.changeSettings(command.settings);
      else if (operation === 'refuge-mode') reference.changeRefugeMode(command.enabled);
      else if (operation === 'clear-refuges') reference.clearRefuges();
      else if (operation === 'paint-refuge')
        reference.paintRefuge(
          command,
          command.x,
          command.y,
          reference.save().interventions.entries.at(-1)!.sequence,
        );
      else if (operation === 'shock') {
        const before = { offset: reference.eventOffset, until: reference.eventUntil };
        reference.shock(command.kind);
        reference.appendIntervention({
          kind: 'shock',
          detail: {
            kind: command.kind,
            before,
            after: { offset: reference.eventOffset, until: reference.eventUntil },
          },
        });
      } else {
        const outcome = reference.paint(
            command.tool,
            command.x,
            command.y,
            command.radius,
            command.genome,
          ),
          sequence = reference.interventions.entries.at(-1)!.sequence;
        reference.recordPaint(
          outcome,
          command.tool,
          command.radius,
          command.x,
          command.y,
          sequence,
        );
      }
      expect(currentWorld.save()).toEqual(reference.save());
      targetId = 0;
      await loadText('{}');
      expect(get('run-state').textContent).toBe('PAUSED');
      expect(get('notice').textContent).toContain('Not a valid');
      expect(bridge.callbackCount).toBe(0);
      expect(get<HTMLButtonElement>('measurements-json').disabled).toBe(true);
      expect(get<HTMLButtonElement>('save').disabled).toBe(true);
      expect(currentWorld.save()).toEqual(reference.save());
      for (const [id, record] of held) expect(bridge.records.get(id)).toBe(record);
      bridge.deliverAll();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(bridge.records.size).toBe(0);
      expect(get<HTMLButtonElement>('measurements-json').disabled).toBe(false);
      expect(get<HTMLButtonElement>('save').disabled).toBe(false);
      if (!reference.organisms.size) {
        get<HTMLInputElement>('pause-on-extinction').checked = false;
        get('pause-on-extinction').dispatchEvent(new Event('change'));
        expect(get('run-state').textContent).toBe('PAUSED');
      }
      click('pause');
      expect(get('run-state').textContent).toBe('LIVE');
      expect(bridge.callbackCount).toBe(1);
      bridge.advance();
      for (let tick = 0; tick < 4; tick++) reference.step();
      expect(currentWorld.save()).toEqual(reference.save());
      expect(bridge.callbackCount).toBe(1);
    },
  );
});
describe('D9 lifetime ownership with real processing and independently gated terminal delivery', () => {
  it.each(['start', 'load'])(
    'D9-A10 proven nonposted %s preserves the current run and applicable serialized downloads',
    async (operation) => {
      const bridge = ownershipBridge();
      bridge.holdTerminals();
      click('measurements-json');
      click('save');
      const post = bridge.endpoint.postMessage;
      vi.spyOn(bridge.endpoint, 'postMessage').mockImplementation((data: any) => {
        if (data.type === operation)
          throw new DOMException('injected nonposting', 'DataCloneError');
        post(data);
      });
      if (operation === 'start') click('reset');
      else await loadText('{}');
      const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      bridge.deliverAll();
      expect(anchor).toHaveBeenCalledTimes(2);
      expect(bridge.counts.L).toBe(1);
      expect(bridge.records.size).toBe(0);
    },
  );
  it('D9-A10 rejects a real sequence-limit settings edit without an optimistic UI value or log/RNG change', async () => {
    const bridge = ownershipBridge(),
      world = new Ecosystem({ ...DEFAULTS, nutrients: 0 }, false);
    for (let entry = 0; entry < 128; entry++)
      world.changeSettings({ nutrients: entry % 2 ? 0 : 1 });
    const saved = world.save(),
      offset = Number.MAX_SAFE_INTEGER - 128;
    saved.interventions.totalEntries = Number.MAX_SAFE_INTEGER;
    saved.interventions.evictedThroughTick = 0;
    for (const entry of saved.interventions.entries) entry.sequence += offset;
    expect(Ecosystem.load(JSON.stringify(saved)).save()).toEqual(saved);
    await loadText(JSON.stringify(saved));
    set('nutrients', '7');
    expect(get<HTMLInputElement>('nutrients').value).toBe('0');
    expect(get('nutrients-value').textContent).toBe('0%');
    expect(get('notice').textContent).toContain('sequence limit');
    expect(bridge.records.size).toBe(0);
    expect(bridge.latestFrame.frame.interventions).toEqual(saved.interventions);
    set('nutrients', '0');
    expect(bridge.records.size).toBe(0);
  });
  it('D9-A7 ignores callbacks from a disposed incarnation with reused request numbers on a remount', () => {
    const old = ownershipBridge();
    old.holdTerminals();
    click('measurements-json');
    const receipt = [...old.records.values()][0].terminal,
      callback = old.endpoint.onmessage!;
    const current = ownershipBridge();
    current.holdTerminals();
    click('measurements-json');
    expect([...current.records.keys()][0]).toBe(receipt.requestId);
    callback({ data: receipt } as MessageEvent);
    old.endpoint.onerror?.();
    expect(current.records.size).toBe(1);
    expect(get<HTMLButtonElement>('measurements-json').disabled).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(old.counts.terminated).toBe(1);
  });
  it.each(['DataCloneError', 'Error'])(
    'D9-A6 proves nonposting or actual termination on injected %s',
    (kind) => {
      const bridge = ownershipBridge();
      vi.spyOn(bridge.endpoint, 'postMessage').mockImplementationOnce(() => {
        if (kind === 'DataCloneError') throw new DOMException('injected clone failure', kind);
        throw new Error('injected port failure');
      });
      click('measurements-json');
      expect(bridge.records.size).toBe(0);
      expect(bridge.counts.terminated).toBe(kind === 'Error' ? 1 : 0);
      expect(get('notice').textContent).toContain('No automatic retry');
      if (kind === 'Error') root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
    },
  );
  it.each(['begin-stroke', 'end-stroke'])(
    'D9-A6 keeps the reserved close honest on injected nonposting %s',
    (operation) => {
      const bridge = ownershipBridge(),
        original = bridge.endpoint.postMessage;
      vi.spyOn(bridge.endpoint, 'postMessage').mockImplementation((data: any) => {
        if (data.type === operation) throw new DOMException('injected failure', 'DataCloneError');
        original(data);
      });
      root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
      pointer('pointerdown');
      pointer('pointerup');
      expect(bridge.counts.terminated).toBe(operation === 'end-stroke' ? 1 : 0);
      expect(bridge.records.size).toBe(0);
    },
  );
  it.each([
    'payload',
    'error',
    'fatal',
    'lifecycle',
    'manual',
    'rejected',
    'Blob',
    'URL',
    'anchor',
    'click',
    'nonError',
  ])('D9-A6 retires exact owners through injected %s bookkeeping failures', (failure) => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    if (failure === 'lifecycle') click('reset');
    else if (failure === 'manual' || failure === 'rejected') set('nutrients', '7');
    else click('measurements-json');
    const [id, record] = [...bridge.records][0];
    if (failure === 'payload') record.terminal.byteLength++;
    if (failure === 'lifecycle') record.terminal.seed = -1;
    if (failure === 'manual') record.terminal.status = 'invalid';
    if (failure === 'rejected') record.terminal.status = 'rejected';
    if (failure === 'error' || failure === 'fatal')
      record.terminal = {
        ...record.terminal,
        type: 'error',
        message: failure === 'error' ? 'x'.repeat(513) : 'injected fatal terminal',
        fatal: failure === 'fatal',
      };
    if (failure === 'Blob')
      vi.stubGlobal(
        'Blob',
        class {
          constructor() {
            throw new Error('injected Blob failure');
          }
        },
      );
    if (failure === 'URL' || failure === 'nonError')
      vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
        throw failure === 'URL' ? new Error('injected URL failure') : 'injected non-Error';
      });
    if (failure === 'anchor') {
      const create = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((name: string) => {
        if (name === 'a') throw new Error('injected anchor failure');
        return create(name);
      });
    }
    if (failure === 'click')
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
        throw new Error('injected click failure');
      });
    bridge.deliver(id);
    expect(bridge.records.size).toBe(0);
    expect(get('notice').textContent).not.toContain('Download requested');
    if (failure === 'click') expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('D9-A5 fault-injects a four-command UI ceiling; the real4096 ceiling is separately verified in worker and native browser cases', async () => {
    vi.resetModules();
    vi.doMock('../src/model', async (original) => ({
      ...(await original<object>()),
      STROKE_COMMAND_CAPACITY: 4,
    }));
    const { mount: boundedMount } = await import('../src/main');
    vi.doUnmock('../src/model');
    const bridge = ownershipBridge(boundedMount);
    bridge.holdFrames();
    root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
    get('world').dispatchEvent(new MouseEvent('pointerdown', { button: 2 }));
    expect(bridge.counts.M).toBe(0);
    pointer('pointerdown');
    pointer('pointerdown');
    for (let command = 1; command < 4; command++) pointer('pointermove');
    pointer('pointermove');
    pointer('pointerup');
    expect(bridge.counts).toMatchObject({ M: 5, C: 1 });
    expect(bridge.records.size).toBe(0);
    expect(bridge.latestFrame.frame.interventions.entries[0].detail.successfulCommands).toBe(1);
    expect(get('notice').textContent).toContain('4096');
  });
  it('rejects an invalid edited blueprint at an already selected placement tool without a manual success', () => {
    root.querySelector<HTMLButtonElement>('[data-tool="plant"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!.click();
    pointer('pointerdown');
    pointer('pointerup');
    expect(get('notice').textContent).toContain('connected cells before painting');
  });
  it('D9-A10 guards the physical File.text slot until settlement and ignores cancelled and disposed reads', async () => {
    const bridge = ownershipBridge();
    let resolve!: (value: string) => void;
    upload({
      size: 2,
      text: () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    });
    get('file').dispatchEvent(new Event('cancel'));
    const second = vi.fn(async () => '{}');
    upload({ size: 2, text: second });
    expect(second).not.toHaveBeenCalled();
    expect(get('notice').textContent).toContain('still outstanding');
    resolve('{}');
    await Promise.resolve();
    expect(bridge.counts.L).toBe(1);
    upload({
      size: 2,
      text: () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    });
    dispose();
    resolve('{}');
    await Promise.resolve();
    expect(bridge.counts.L).toBe(1);
    expect(bridge.counts.terminated).toBe(1);
  });
  it('D9-A4 explicitly fault-injects a small safe-ID ceiling without wrapping/reusing a posting identity', () => {
    const nativeNumber = Number;
    function boundedNumber(value: unknown) {
      return nativeNumber(value);
    }
    Object.setPrototypeOf(boundedNumber, nativeNumber);
    Object.defineProperty(boundedNumber, 'MAX_SAFE_INTEGER', { value: 1 });
    vi.stubGlobal('Number', boundedNumber);
    click('reset');
    expect(get('notice').textContent).toContain('transport unavailable');
    expect(worker.postMessage.mock.calls.filter(([data]) => data.type === 'start')).toHaveLength(1);
  });
  function saturate() {
    click('measurements-json');
    click('save');
    root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
    pointer('pointerdown');
    for (let point = 0; point < 30; point++) pointer('pointermove', 151 + point, 150);
    pointer('pointermove', 190, 150);
    pointer('pointerup');
  }
  it('D9-A1 reserves C before begin, stalls all36 physical owners and rejects256 replacement intents', async () => {
    const bridge = ownershipBridge();
    bridge.blockProcessing();
    saturate();
    expect(bridge.counts).toMatchObject({ E: 1, S: 1, M: 32, C: 1, L: 1 });
    click('reset');
    expect(bridge.records.size).toBe(36);
    const admitted = { ...bridge.counts };
    for (let attempt = 0; attempt < 256; attempt++) {
      click('reset');
      await loadText('{"invalid":true}');
      click('measurements-csv');
      click('save');
      pointer('pointerdown');
      pointer('pointerup');
    }
    expect(bridge.counts).toEqual(admitted);
    expect(bridge.records.size).toBe(36);
    bridge.processAll();
    expect(bridge.records.size).toBe(0);
    expect(bridge.latestFrame.frame.stats.tick).toBe(0);
    expect(bridge.latestFrame.frame.interventions.entries).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(get<HTMLButtonElement>('save').disabled).toBe(false);
    expect(bridge.counts.maximum).toBe(36);
  });
  it('D9-A2 holds serialized results through256 successful and failed run replacements without refilling any class', async () => {
    const bridge = ownershipBridge(),
      captures = vi.spyOn(Ecosystem.prototype, 'measurements'),
      saves = vi.spyOn(Ecosystem.prototype, 'save');
    bridge.holdTerminals((data) => !['start', 'load'].includes(data.operation));
    saturate();
    expect(bridge.records.size).toBe(35);
    for (let replacement = 0; replacement < 256; replacement++) {
      if (replacement % 2) await loadText('{"invalid":true}');
      else click('reset');
      click('measurements-json');
      click('measurements-csv');
      click('save');
      pointer('pointerdown');
      pointer('pointerup');
      set('nutrients', '11');
      expect(bridge.records.size).toBe(35);
    }
    expect(bridge.counts).toMatchObject({ E: 1, S: 1, M: 32, C: 1, L: 257, maximum: 36 });
    expect(captures).toHaveBeenCalledTimes(1);
    expect(saves).toHaveBeenCalledTimes(1);
    const currentNotice = get('notice').textContent;
    bridge.deliverAll();
    expect(bridge.records.size).toBe(0);
    expect(get('notice').textContent).toBe(currentNotice);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(get<HTMLButtonElement>('measurements-json').disabled).toBe(false);
    expect(get<HTMLButtonElement>('save').disabled).toBe(false);
    bridge.holdTerminals(() => false);
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    click('measurements-csv');
    click('save');
    expect(anchor).toHaveBeenCalledTimes(2);
  });
  it.each(
    ['reset', 'valid-load', 'invalid-last-log', 'same-tick-failure'].flatMap((replacement) =>
      ['old-first', 'lifecycle-first'].map((order) => ({ replacement, order })),
    ),
  )(
    'D9-A3/A8 retires stale E/S/M/C with %j without stale effects or a scheduler wake',
    async ({ replacement, order }) => {
      const bridge = ownershipBridge();
      bridge.holdTerminals();
      click('measurements-json');
      click('save');
      root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
      pointer('pointerdown');
      pointer('pointerup');
      set('nutrients', '7');
      root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
      root.querySelector<HTMLButtonElement>('[data-tool="plant"]')!.click();
      pointer('pointerdown', 50, 50);
      pointer('pointerup');
      const oldIds = [...bridge.records.keys()];
      const retained = bridge.latestFrame.frame.interventions;
      if (replacement === 'reset') click('reset');
      else {
        const candidate = new Ecosystem().save();
        if (replacement === 'invalid-last-log') {
          const invalid = new Ecosystem();
          invalid.changeSettings({ nutrients: 7 });
          const file = invalid.save();
          file.interventions.entries[0].sequence = 2;
          await loadText(JSON.stringify(file));
        } else await loadText(replacement === 'valid-load' ? JSON.stringify(candidate) : '{}');
      }
      const lifecycle = [...bridge.records].find(([, record]) =>
        ['start', 'load'].includes(record.command.type),
      )![0];
      if (order === 'lifecycle-first') bridge.deliver(lifecycle);
      const notice = get('notice').textContent;
      for (const id of oldIds) bridge.deliver(id);
      expect(get('notice').textContent).toBe(notice);
      if (order === 'old-first') bridge.deliver(lifecycle);
      expect(bridge.records.size).toBe(0);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(bridge.latestFrame.frame.interventions.entries).toEqual(
        replacement === 'reset' || replacement === 'valid-load' ? [] : retained.entries,
      );
      expect(get<HTMLButtonElement>('save').disabled).toBe(false);
    },
  );
  it('D9-A10 preserves both pins and focus on failed complete import and resets only after successful equal-tick replacement', async () => {
    ownershipBridge();
    const world = new Ecosystem(DEFAULTS, false);
    for (let tick = 0; tick < 60; tick++) world.step();
    world.changeSettings({ nutrients: 7 });
    await loadText(JSON.stringify(world.save()));
    click('ecosystem-tab');
    paint(0);
    set('telemetry-sample', '30', 'change');
    set('telemetry-intervention', '1', 'change');
    get('telemetry-intervention').focus();
    const corrupt = world.save() as any;
    delete corrupt.interventions;
    await loadText(JSON.stringify(corrupt));
    paint(0);
    expect(get<HTMLSelectElement>('telemetry-sample').value).toBe('30');
    expect(get<HTMLSelectElement>('telemetry-intervention').value).toBe('1');
    expect(document.activeElement).toBe(get('telemetry-intervention'));
    await loadText(JSON.stringify(world.save()));
    paint(0);
    expect(get<HTMLSelectElement>('telemetry-sample').value).toBe('latest');
    expect(get<HTMLSelectElement>('telemetry-intervention').value).toBe('latest');
  });
  it('D9-A4 rejects duplicate and wrong tuple receipts without retiring a newer export owner', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    click('measurements-json');
    const first = [...bridge.records.keys()][0],
      old = bridge.records.get(first)!.terminal;
    click('reset');
    bridge.deliver([...bridge.records].find(([, record]) => record.command.type === 'start')![0]);
    bridge.deliver(first);
    click('measurements-csv');
    const current = [...bridge.records.keys()][0],
      receipt = bridge.records.get(current)!.terminal;
    for (const wrong of [
      old,
      { ...old, type: 'error', message: 'obsolete error' },
      { ...receipt, operation: 'save' },
      { ...receipt, format: 'json' },
      { ...receipt, runId: receipt.runId - 1 },
      { ...receipt, requestId: current + 100 },
      { ...receipt, strokeId: 1 },
      { type: 'frame', runId: receipt.runId - 1 },
      null,
    ])
      bridge.emit(wrong);
    expect(get<HTMLButtonElement>('measurements-json').disabled).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    bridge.deliver(current);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    bridge.emit(receipt);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
  it.each([
    'export-measurements',
    'save',
    'begin-stroke',
    'paint',
    'placement',
    'settings',
    'shock',
    'end-stroke',
    'start',
    'load',
  ])(
    'D9-A4 preserves newer %s ownership against every wrong header, duplicate and unrelated receipt',
    async (target) => {
      const bridge = ownershipBridge(),
        operation = target === 'placement' ? 'paint' : target,
        manual = ['begin-stroke', 'paint', 'placement', 'settings', 'shock'].includes(target),
        category =
          target === 'export-measurements'
            ? 'E'
            : target === 'save'
              ? 'S'
              : target === 'end-stroke'
                ? 'C'
                : ['start', 'load'].includes(target)
                  ? 'L'
                  : 'M';
      bridge.holdTerminals((data) => data.operation === operation);
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      async function action() {
        if (target === 'export-measurements') click('measurements-json');
        else if (target === 'save') click('save');
        else if (target === 'start') click('reset');
        else if (target === 'load') await loadText(JSON.stringify(new Ecosystem().save()));
        else if (target === 'settings') set('nutrients', '7');
        else if (target === 'shock')
          root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
        else {
          root
            .querySelector<HTMLButtonElement>(
              `[data-tool="${target === 'placement' ? 'plant' : 'food'}"]`,
            )!
            .click();
          pointer('pointerdown', 50, 50);
          pointer('pointerup');
        }
      }
      await action();
      const firstId = [...bridge.records.keys()][0],
        old = bridge.records.get(firstId)!.terminal;
      if (!['start', 'load'].includes(target)) click('reset');
      bridge.deliver(firstId);
      await action();
      const id = [...bridge.records.keys()][0],
        receipt = bridge.records.get(id)!.terminal;
      if (manual) {
        bridge.holdTerminals((data) =>
          ['begin-stroke', 'paint', 'settings', 'shock'].includes(data.operation),
        );
        for (let entry = 0; entry < 31; entry++) set('nutrients', entry % 2 ? '1' : '2');
        expect(bridge.records.size).toBe(32);
      }
      for (const wrong of [
        old,
        { ...old, type: 'error', message: 'duplicate error' },
        { ...receipt, operation: operation === 'save' ? 'export-measurements' : 'save' },
        { ...receipt, runId: receipt.runId - 1 },
        { ...receipt, format: 'csv' },
        { ...receipt, strokeId: 999 },
        { ...receipt, requestId: undefined, commandId: undefined },
        {
          ...receipt,
          ...(manual || target === 'end-stroke' ? { requestId: id } : { commandId: id }),
        },
        { ...receipt, requestId: id + 1000, commandId: id + 1000 },
        ...['snapshot', 'progress', 'flow-ack'].map((type) => ({
          type,
          runId: receipt.runId,
          requestId: id,
          commandId: id,
        })),
      ])
        bridge.emit(wrong);
      const count = bridge.counts[category];
      if (manual) set('nutrients', '3');
      else await action();
      expect(bridge.counts[category]).toBe(count);
      bridge.deliverAll();
      expect(bridge.records.size).toBe(0);
    },
  );
  it.each(['end-first', 'paint-first'])(
    'D9-A5 retires paint and C separately in %s order',
    (order) => {
      const bridge = ownershipBridge();
      bridge.holdTerminals();
      root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
      pointer('pointerdown');
      pointer('pointerup');
      const find = (type: string) =>
          [...bridge.records].find(([, record]) => record.command.type === type)![0],
        begin = find('begin-stroke'),
        paintId = find('paint'),
        end = find('end-stroke');
      bridge.deliver(begin);
      bridge.deliver(order === 'end-first' ? end : paintId);
      pointer('pointerdown', 170, 150);
      pointer('pointerup');
      expect(bridge.counts.C).toBe(order === 'end-first' ? 2 : 1);
      expect(bridge.counts.M).toBe(order === 'end-first' ? 4 : 2);
      bridge.deliver(order === 'end-first' ? paintId : end);
      bridge.deliverAll();
      expect(bridge.records.size).toBe(0);
      expect(bridge.latestFrame.frame.interventions.entries.length).toBe(
        order === 'end-first' ? 2 : 1,
      );
    },
  );
  it('D9-A6/A7 keeps fatal-flagged native work charged until exact results or actual endpoint termination', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    saturate();
    bridge.emit({ type: 'error', runId: 1, fatal: true, message: 'injected tick failure' });
    expect(bridge.records.size).toBe(35);
    click('reset');
    expect(bridge.records.size).toBe(36);
    dispose();
    expect(bridge.counts.terminated).toBe(1);
    expect(bridge.records.size).toBe(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('D9-A6 handles messageerror through EventTarget before abandoning physical ownership', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    saturate();
    bridge.endpoint.dispatchEvent(new MessageEvent('messageerror'));
    expect(bridge.counts.terminated).toBe(1);
    expect(bridge.records.size).toBe(0);
    expect(get('run-state').textContent).toBe('STOPPED');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
function nearDeath(): WorldFile {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0 }, false);
  const organism = world.spawn(
    { cells: [{ x: 0, y: 0, type: 3 }], preference: 0.5, tolerance: 0.3, tempo: 2 },
    40,
    40,
  )!;
  organism.energy = 10;
  for (let tick = 0; tick < 71; tick++) world.step();
  organism.age = 975;
  organism.energy = 5;
  world.food[5] = 1;
  world.walls[6] = 1;
  return world.save();
}
function chartRecorder() {
  const paths: number[][][] = [];
  const replaced = vi.spyOn(get('telemetry-plots'), 'replaceChildren');
  let renders = 0;
  const read = () =>
    [...root.querySelectorAll('[data-series="Population"] [data-tick]')].map((mark) => [
      Number(mark.getAttribute('data-tick')),
      Number(mark.getAttribute('data-value')),
    ]);
  return {
    get paths() {
      paint(0);
      if (renders !== replaced.mock.calls.length) {
        paths.push(read());
        renders = replaced.mock.calls.length;
      }
      return paths;
    },
    expected(populations: number[]) {
      const first = read()[0]?.[0] ?? 30;
      return populations.map((population, position) => [first + position * 30, population]);
    },
  };
}
beforeEach(() => {
  const NativeReader = FileReader;
  vi.stubGlobal(
    'FileReader',
    class extends NativeReader {
      private fake = false;
      private ended = false;
      private value: string | null = null;
      override get result() {
        return this.fake ? this.value : super.result;
      }
      override readAsText(file: Blob) {
        const input = file as unknown as { text?: () => Promise<string> };
        if (file instanceof Blob || !input.text) {
          super.readAsText(file);
          return;
        }
        this.fake = true;
        input.text().then(
          (value) => {
            if (this.ended) return;
            this.value = value;
            this.dispatchEvent(new ProgressEvent('load'));
            this.dispatchEvent(new ProgressEvent('loadend'));
          },
          () => {
            if (this.ended) return;
            this.dispatchEvent(new ProgressEvent('error'));
            this.dispatchEvent(new ProgressEvent('loadend'));
          },
        );
      }
      override abort() {
        if (!this.fake) {
          super.abort();
          return;
        }
        if (this.ended) return;
        this.ended = true;
        this.dispatchEvent(new ProgressEvent('abort'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 250,
    height: 180,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 180,
    right: 250,
    toJSON: () => ({}),
  });
  const ctx = new Proxy(
    { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) },
    {
      get: (o, p) => (p in o ? o[p as keyof typeof o] : vi.fn()),
      set: (o, p, v) => {
        Reflect.set(o, p, v);
        return true;
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      paint = cb;
      return 1;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:world');
      static revokeObjectURL = vi.fn();
    },
  );
  root = document.createElement('div');
  document.body.append(root);
  worker = new WorkerStub();
  dispose = mount(root, worker as unknown as Worker);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('explicit bounded local library', () => {
  let storage: ReturnType<typeof libraryHarness>;
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const third = '00000000-0000-4000-8000-000000000003';
  const draft = (name = '<literal> name', tick?: number) =>
    libraryCandidate(
      founder(2),
      name,
      'description',
      tick === undefined ? undefined : { captureTick: tick, seed: 42 },
    );
  const flush = async () => {
    for (let phase = 0; phase < 35; phase++) await Promise.resolve();
  };
  const open = async () => {
    get<HTMLDetailsElement>('local-library').open = true;
    get('local-library').dispatchEvent(new Event('toggle'));
    await flush();
  };
  const select = (id = first) =>
    root.querySelector<HTMLButtonElement>(`[data-library-id="${id}"]`)!.click();
  const uploadLocal = async (value: string, designer = false) => {
    const input = get<HTMLInputElement>(designer ? 'blueprint-file' : 'library-file');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ size: value.length, text: async () => value }],
    });
    input.dispatchEvent(new Event('change'));
    await flush();
  };
  beforeEach(() => {
    dispose();
    storage = libraryHarness();
    vi.stubGlobal('indexedDB', storage.factory);
    dispose = mount(root, worker as unknown as Worker);
    emit(sample, organism);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it('preserves current world and manual interventions through library design replacement with the real worker', async () => {
    const harness = realWorker();
    harness.deliver();
    click('pause');
    harness.deliver();
    root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
    harness.deliver();
    const before = harness.save();
    expect(before.version).toBe(7);
    expect(before.telemetry.version).toBe(2);
    expect(before.interventions.version).toBe(3);
    expect(before.thermalRefuges).toEqual({ version: 1, enabled: false, cells: [] });
    expect(before.interventions.entries).toHaveLength(1);
    storage.values.set(first, encodeRecord(draft('composed design'), 1));
    await open();
    click('library-load');
    await flush();
    click('library-confirm');
    await flush();
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('composed design');
    click('library-delete');
    click('library-confirm');
    await flush();
    expect(storage.values.size).toBe(0);
    expect(harness.save()).toEqual(before);
    expect(get('run-state').textContent).toBe('PAUSED');
    expect(worker.postMessage.mock.calls.filter(([data]) => data.type === 'shock')).toHaveLength(1);
  });

  it('round-trips literal names, stable keyed focus, duplicate IDs, rename, replace and delete', async () => {
    storage.values.set(first, encodeRecord(draft(), 1));
    storage.values.set(second, encodeRecord(draft('neighbor'), 1));
    await open();
    expect(get('library-count').textContent).toContain('2 / 100');
    select();
    const button = root.querySelector<HTMLButtonElement>(`[data-library-id="${first}"]`)!;
    button.focus();
    storage.values.set(first, encodeRecord(draft('renamed elsewhere'), 2));
    click('library-refresh');
    await flush();
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toContain('renamed elsewhere');
    click('library-rename');
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(true);
    expect(document.activeElement).toBe(get('library-cancel'));
    set('library-rename-name', '  <b> 🌿  ');
    click('library-confirm');
    await flush();
    expect(classifyRecord(first, storage.values.get(first))).toMatchObject({
      revision: 3,
      blueprint: { name: '  <b> 🌿  ' },
    });
    expect(root.querySelector('#library-rows b')).toBeNull();
    click('library-duplicate');
    await flush();
    expect(storage.values.size).toBe(3);
    const copies = [...storage.values].map(([id, token]) => classifyRecord(id, token));
    expect(
      copies.filter((row) => row.kind === 'valid' && row.blueprint.name === '  <b> 🌿  '),
    ).toHaveLength(2);
    click('library-export');
    click('library-export');
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    await uploadLocal(serializeBlueprint(draft('incoming').blueprint));
    expect(get('library-candidate').hidden).toBe(false);
    click('library-export-candidate');
    select();
    click('library-replace');
    expect(get('library-dialog-description').textContent).toContain(first);
    click('library-confirm');
    await flush();
    expect(classifyRecord(first, storage.values.get(first))).toMatchObject({
      revision: 4,
      blueprint: { name: 'incoming' },
    });
    click('library-delete');
    click('library-confirm');
    await flush();
    expect(storage.values.has(first)).toBe(false);
    expect(document.activeElement?.getAttribute('data-library-id')).toBe(second);
    select(second);
    click('library-delete');
    click('library-cancel');
    expect(storage.values.has(second)).toBe(true);
    vi.useFakeTimers();
    click('library-export');
    vi.advanceTimersByTime(1000);
  });

  it('loads only a fresh confirmed revision and shares intent ownership with designer files', async () => {
    storage.values.set(first, encodeRecord(draft('library design'), 1));
    await open();
    click('library-load');
    await flush();
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(true);
    await uploadLocal(serializeBlueprint(draft('new designer intent').blueprint), true);
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
    click('library-confirm');
    await flush();
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('new designer intent');
    click('library-load');
    await flush();
    click('library-confirm');
    await flush();
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('library design');
    expect(worker.postMessage.mock.calls.some(([message]) => message.type === 'plant')).toBe(false);
    click('library-load');
    await flush();
    storage.values.set(first, encodeRecord(draft('cross-tab revision'), 2));
    click('library-confirm');
    await flush();
    expect(get('library-status').textContent).toContain('changed or disappeared');
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('library design');
    click('library-load');
    await flush();
    expect(get('library-status').textContent).toContain('changed or disappeared');
    click('library-refresh');
    await flush();
    click('library-load');
    await flush();
    set('blueprint-name', 'synchronous edit');
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
    click('library-load');
    await flush();
    get('library-dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
  });

  it.each(['initial', 'final'])(
    'cancels a library load on Organism departure during the %s read without releasing its native owner early',
    async (phase) => {
      storage.values.set(first, encodeRecord(draft('must not publish'), 1));
      await open();
      set('blueprint-name', 'retained designer');
      set('blueprint-description', 'retained description');
      root.querySelector<HTMLButtonElement>('button[data-tool="inspect"]')!.click();
      const design = get('editor').innerHTML;
      if (phase === 'final') {
        click('library-load');
        await flush();
        expect(get<HTMLDialogElement>('library-dialog').open).toBe(true);
      }
      storage.faults.txStall = true;
      storage.faults.abortThrow = true;
      click(phase === 'initial' ? 'library-load' : 'library-confirm');
      await flush();
      const owner = storage.current;
      const transactions = storage.connection.transaction.mock.calls.length;
      const ecosystem = root.querySelector<HTMLButtonElement>('[data-tab="ecosystem"]')!;
      ecosystem.focus();
      ecosystem.click();
      expect(get('library-status').textContent).toContain('Load into designer cancelled');
      expect(get('library-status').textContent).toContain('no longer visible');
      const cancelled = get('library-status').textContent;
      expect(owner.native.abort).toHaveBeenCalledOnce();
      expect(owner.native.oncomplete).toBeTypeOf('function');
      click('library-refresh');
      await flush();
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
      delete storage.faults.txStall;
      delete storage.faults.abortThrow;
      owner.complete();
      await flush();
      expect(owner.native.oncomplete).toBeNull();
      expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
      expect(get<HTMLInputElement>('blueprint-name').value).toBe('retained designer');
      expect(get<HTMLInputElement>('blueprint-description').value).toBe('retained description');
      expect(get('editor').innerHTML).toBe(design);
      expect(get('ecosystem-panel').hidden).toBe(false);
      expect(get('organism-panel').hidden).toBe(true);
      expect(root.querySelector('button[data-tool="inspect"]')!.getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(document.activeElement).toBe(ecosystem);
      expect(get('library-status').textContent).toBe(cancelled);
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
    },
  );

  it.each(['initial', 'final'])(
    'cancels the %s completed library read across connection invalidation until terminal delivery',
    async (phase) => {
      vi.useFakeTimers();
      storage.values.set(first, encodeRecord(draft('must not publish'), 1));
      await open();
      set('blueprint-name', 'retained designer');
      set('blueprint-description', 'retained description');
      root.querySelector<HTMLButtonElement>('button[data-tool="inspect"]')!.click();
      const design = get('editor').innerHTML;
      if (phase === 'final') {
        click('library-load');
        await flush();
        expect(get<HTMLDialogElement>('library-dialog').open).toBe(true);
      }
      storage.faults.completionStall = 'readonly';
      click(phase === 'initial' ? 'library-load' : 'library-confirm');
      await flush();
      const owner = storage.current;
      const transactions = storage.connection.transaction.mock.calls.length;
      get('blueprint-description').focus();
      storage.connection.onversionchange();
      await flush();
      expect(get('library-status').textContent).toContain('Another tab changed');
      const status = get('library-status').textContent;
      expect(owner.native.abort).toHaveBeenCalled();
      expect(owner.native.oncomplete).toBeTypeOf('function');
      click('library-refresh');
      await flush();
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      const captureEffectsAcrossDeadline = vi.spyOn(get('capture-selected'), 'setAttribute');
      await vi.advanceTimersByTimeAsync(10001);
      await flush();
      expect(get('library-status').textContent).toBe(status);
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      expect(captureEffectsAcrossDeadline).not.toHaveBeenCalled();
      delete storage.faults.completionStall;
      owner.releaseCompletion();
      await flush();
      expect(owner.native.oncomplete).toBeNull();
      expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
      expect(get<HTMLInputElement>('blueprint-name').value).toBe('retained designer');
      expect(get<HTMLInputElement>('blueprint-description').value).toBe('retained description');
      expect(get('editor').innerHTML).toBe(design);
      expect(get('organism-panel').hidden).toBe(false);
      expect(get('ecosystem-panel').hidden).toBe(true);
      expect(root.querySelector('button[data-tool="inspect"]')!.getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(document.activeElement).toBe(get('blueprint-description'));
      expect(get('library-status').textContent).toBe(status);
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      expect(captureEffectsAcrossDeadline).not.toHaveBeenCalled();
      click('library-refresh');
      await flush();
      expect(get('library-status').textContent).toContain('Library refreshed');
      click('library-load');
      await flush();
      expect(get<HTMLDialogElement>('library-dialog').open).toBe(true);
      click('library-confirm');
      await flush();
      expect(get<HTMLInputElement>('blueprint-name').value).toBe('must not publish');
    },
  );

  it('captures genuine observed ticks without mutating the world and preserves focus across frames', async () => {
    const capture = get<HTMLButtonElement>('capture-selected');
    get<HTMLDetailsElement>('specimen-details').open = true;
    capture.focus();
    emit({ ...sample, stats: { ...sample.stats, tick: 123 } }, organism);
    expect(document.activeElement).toBe(capture);
    capture.click();
    await flush();
    expect(storage.values.size).toBe(1);
    const [id, value] = [...storage.values][0];
    expect(classifyRecord(id, value)).toMatchObject({ provenance: { captureTick: 123 } });
    expect(
      worker.postMessage.mock.calls.some(([message]) =>
        ['pause', 'resume', 'plant'].includes(message.type),
      ),
    ).toBe(false);
    expect(get('library-selection').textContent).toContain('Observed at tick 123');
    capture.focus();
    emit(sample, null);
    expect(capture.disabled).toBe(true);
    expect(document.activeElement).toBe(get('specimen-details').querySelector('summary'));
    emit(sample, organism);
    capture.focus();
    click('ecosystem-tab');
    emit(sample, null);
    expect(document.activeElement).toBe(get('organism-tab'));
    emit(sample, organism);
    click('reset');
    expect(capture.disabled).toBe(true);
    worker.emit({ type: 'loaded', settings: DEFAULTS });
    expect(capture.disabled).toBe(true);
    worker.emit({ type: 'saved', text: JSON.stringify(world.save()) });
    expect(capture.disabled).toBe(true);
    emit(sample, organism);
    expect(capture.disabled).toBe(false);
  });

  it('keeps malformed/future rows read-only and rechecks repair CAS after confirmation', async () => {
    const bad = JSON.stringify({
      recordVersion: 1,
      revision: 0,
      blueprint: serializeBlueprint(draft().blueprint),
    });
    storage.values.set(first, bad);
    storage.values.set(second, JSON.stringify({ recordVersion: 2, extra: true }));
    storage.values.set('uninspectable', { payload: true });
    await open();
    expect(get('library-count').textContent).toContain('3 / 100');
    expect(root.querySelector<HTMLButtonElement>(`[data-repair-id="${first}"]`)).not.toBeNull();
    root.querySelector<HTMLButtonElement>(`[data-repair-id="${first}"]`)!.click();
    storage.values.set(first, encodeRecord(draft('repaired elsewhere'), 1));
    click('library-confirm');
    await flush();
    expect(storage.values.has(first)).toBe(true);
    storage.values.set(first, bad);
    click('library-refresh');
    await flush();
    root.querySelector<HTMLButtonElement>(`[data-repair-id="${first}"]`)!.click();
    click('library-confirm');
    await flush();
    expect(storage.values.has(first)).toBe(false);
    expect(storage.values.size).toBe(2);
    for (const button of root.querySelectorAll<HTMLButtonElement>('#library-rows button'))
      expect(button.disabled).toBe(true);
  });

  it.each(['insertion', 'removal', 'sole damaged row'])(
    'repairs the stable full UUID after %s before an unchanged damaged row',
    async (change) => {
      const third = '00000000-0000-4000-8000-000000000003';
      const valid = encodeRecord(draft('valid neighbor'), 1);
      const damaged = encodeRecord(draft('damaged target'), 1).replace(
        '"revision":1',
        '"revision":0',
      );
      const neighbor = encodeRecord(draft('damaged neighbor'), 1).replace(
        '"revision":1',
        '"revision":-1',
      );
      storage.values.set(second, damaged);
      if (change !== 'sole damaged row') storage.values.set(third, neighbor);
      if (change !== 'insertion') storage.values.set(first, valid);
      await open();
      const button = root.querySelector<HTMLButtonElement>(`[data-repair-id="${second}"]`)!;
      if (change === 'insertion') storage.values.set(first, valid);
      else storage.values.delete(first);
      click('library-refresh');
      await flush();
      expect(root.querySelector(`[data-repair-id="${second}"]`)).toBe(button);
      const survivors = [...storage.values].filter(([id]) => id !== second);
      button.click();
      expect(get('library-dialog-description').textContent).toContain(`Local ID ${second}.`);
      expect(get('library-dialog-description').textContent).not.toContain(third);
      click('library-confirm');
      await flush();
      expect([...storage.values]).toEqual(survivors);
    },
  );

  it('retains an unsaved candidate on quota/full/error and distinguishes committed refresh failure', async () => {
    await open();
    storage.faults.requestError = 'QuotaExceededError';
    click('library-save');
    await flush();
    expect(get('library-status').textContent).toContain('storage is full');
    expect(get('library-candidate').hidden).toBe(false);
    click('library-save');
    expect(get('library-status').textContent).toContain('Busy');
    click('capture-selected');
    expect(get('library-status').textContent).toContain('unavailable or busy');
    click('library-import');
    expect(get('library-status').textContent).toContain('Busy');
    delete storage.faults.requestError;
    click('library-add');
    await flush();
    expect(get('library-candidate').hidden).toBe(true);
    storage.faults.txStall = true;
    click('library-duplicate');
    await flush();
    click('library-refresh');
    click('library-add');
    window.dispatchEvent(new Event('focus'));
    storage.faults.requestError = 'UnknownError';
    storage.faults.txStall = false;
    storage.current.complete();
    await flush();
    expect(get('library-status').textContent).toContain(
      'committed outcome is unchanged; refresh failed',
    );
    delete storage.faults.requestError;
    click('library-refresh');
    await flush();
    await uploadLocal(serializeBlueprint(draft('discard me').blueprint));
    click('library-discard');
    expect(get('library-candidate').hidden).toBe(true);
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
      throw new Error('download');
    });
    click('library-export');
    expect(get('library-status').textContent).toContain('Could not download');
  });

  it('bounds dialogs, picker ownership, read deadlines and coalesced refresh requests', async () => {
    vi.useFakeTimers();
    storage.values.set(first, encodeRecord(draft(), 1));
    await open();
    click('library-rename');
    vi.advanceTimersByTime(60000);
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
    click('library-delete');
    get<HTMLDetailsElement>('local-library').open = false;
    get('local-library').dispatchEvent(new Event('toggle'));
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
    await open();
    click('library-load');
    await flush();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    click('library-import');
    click('library-import');
    get('blueprint-file').dispatchEvent(new Event('cancel'));
    vi.advanceTimersByTime(60000);
    expect(get('library-status').textContent).toContain('picker expired');
    await uploadLocal(serializeBlueprint(draft().blueprint));
    expect(get('library-candidate').hidden).toBe(true);
    click('library-import');
    get('library-file').dispatchEvent(new Event('cancel'));
    const input = get<HTMLInputElement>('library-file');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ size: 1, text: () => new Promise(() => {}) }],
    });
    input.dispatchEvent(new Event('change'));
    click('library-refresh');
    click('library-import');
    vi.advanceTimersByTime(10000);
    await flush();
    expect(get('library-status').textContent).not.toContain('Reading local');
    await uploadLocal('invalid');
    expect(get('library-status').textContent).toContain('JSON');
    click('import-blueprint');
    get('library-file').dispatchEvent(new Event('change'));
    get('blueprint-file').dispatchEvent(new Event('cancel'));
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ size: 20000, text: async () => '' }],
    });
    input.dispatchEvent(new Event('change'));
    expect(get('library-status').textContent).toContain('16 KiB');
  });

  it('does not publish stale reads, commits or focus after disposal', async () => {
    storage.values.set(first, encodeRecord(draft(), 1));
    await open();
    storage.faults.txStall = true;
    click('library-load');
    await flush();
    click('library-refresh');
    click('import-blueprint');
    get('blueprint-file').dispatchEvent(new Event('cancel'));
    await flush();
    storage.faults.txStall = false;
    await uploadLocal('invalid', true);
    expect(get<HTMLInputElement>('blueprint-name').value).not.toBe('<literal> name');
    click('library-load');
    await flush();
    dispose();
    const before = root.innerHTML,
      focus = document.activeElement;
    storage.connection.onclose?.();
    await flush();
    expect(root.innerHTML).toBe(before);
    expect(document.activeElement).toBe(focus);
  });

  it.each(
    (['delete', 'repair'] as const).flatMap((action) =>
      (['clear', 'remount', 'supersede'] as const).map((boundary) => ({ action, boundary })),
    ),
  )(
    'suppresses old $action followups across postcommit refresh $boundary',
    async ({ action, boundary }) => {
      const original = encodeRecord(draft('target'), 1);
      const neighbor = encodeRecord(draft('neighbor'), 1);
      storage.values.set(
        first,
        action === 'repair' ? JSON.stringify({ ...JSON.parse(original), revision: 0 }) : original,
      );
      storage.values.set(second, neighbor);
      await open();
      if (action === 'repair')
        root.querySelector<HTMLButtonElement>(`[data-repair-id="${first}"]`)!.click();
      else click('library-delete');
      storage.faults.completionStall = 'readonly';
      click('library-confirm');
      await flush();
      expect([...storage.values]).toEqual([[second, neighbor]]);
      expect(get('library-status').textContent).toContain('Write committed');
      const owner = storage.current;
      const oldCapture = get('capture-selected');
      if (boundary === 'supersede') click('library-refresh');
      else {
        dispose();
        root.replaceChildren();
        if (boundary === 'remount') {
          worker = new WorkerStub();
          dispose = mount(root, worker as unknown as Worker);
        }
      }
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      expect(document.activeElement).toBe(document.body);
      const before = root.innerHTML;
      const queries = vi.spyOn(root, 'querySelector');
      const captureEffects = vi.spyOn(oldCapture, 'setAttribute');
      delete storage.faults.completionStall;
      owner.releaseCompletion();
      await flush();
      expect([...storage.values]).toEqual([[second, neighbor]]);
      expect(document.activeElement).toBe(document.body);
      if (boundary !== 'supersede') {
        expect(root.innerHTML).toBe(before);
        expect(queries).not.toHaveBeenCalled();
        expect(captureEffects).not.toHaveBeenCalled();
      } else {
        expect(get('library-status').textContent).toContain('Library refreshed');
        expect(root.querySelector(`[data-library-id="${second}"]`)).not.toBeNull();
      }
    },
  );

  it.each(
    ['create', 'replace'].flatMap((action) =>
      [false, true].flatMap((expired) =>
        ['onversionchange', 'onclose'].flatMap((invalidation) =>
          ['complete', 'abort'].map((terminal) => ({ action, expired, invalidation, terminal })),
        ),
      ),
    ),
  )(
    'reconciles $action certainty after expired=$expired $invalidation $terminal without stale UI',
    async ({ action, expired, invalidation, terminal }) => {
      vi.useFakeTimers();
      const original = encodeRecord(draft('original'), 1);
      const neighbor = encodeRecord(draft('neighbor'), 1);
      storage.values.set(first, original);
      storage.values.set(second, neighbor);
      await open();
      if (action === 'replace') {
        await uploadLocal(serializeBlueprint(draft('replacement').blueprint));
        click('library-replace');
      }
      storage.faults.abortThrow = true;
      if (terminal === 'complete') storage.faults.completionStall = 'readwrite';
      else storage.faults.txStall = true;
      click(action === 'create' ? 'library-save' : 'library-confirm');
      await flush();
      const owner = storage.current;
      const transactions = storage.connection.transaction.mock.calls.length;
      const opens = storage.factory.open.mock.calls.length;
      select(second);
      const focused = root.querySelector<HTMLButtonElement>(`[data-library-id="${second}"]`)!;
      focused.focus();
      const rows = get('library-rows').innerHTML;
      storage.connection[invalidation]();
      await flush();
      const complete = owner.native.oncomplete;
      const abort = owner.native.onabort;
      click('library-refresh');
      click('library-add');
      await flush();
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      expect(storage.factory.open).toHaveBeenCalledTimes(opens);
      expect(get('library-candidate').hidden).toBe(false);
      if (expired) await vi.advanceTimersByTimeAsync(10001);
      if (terminal === 'complete') owner.releaseCompletion();
      else abort();
      await flush();
      expect(get('library-status').textContent).toContain(
        terminal === 'complete' ? 'Native write committed' : 'no write from it committed',
      );
      expect(get('library-candidate').hidden).toBe(terminal === 'complete');
      expect(get('library-rows').innerHTML).toBe(rows);
      expect(get('library-selection').textContent).toContain(second);
      expect(document.activeElement).toBe(focused);
      expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
      expect(storage.factory.open).toHaveBeenCalledTimes(opens);
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      if (terminal === 'abort')
        expect([...storage.values]).toEqual([
          [first, original],
          [second, neighbor],
        ]);
      else if (action === 'create') expect(storage.values.size).toBe(3);
      else
        expect(classifyRecord(first, storage.values.get(first))).toMatchObject({
          revision: 2,
          blueprint: { name: 'replacement' },
        });
      const status = get('library-status').textContent;
      complete();
      abort();
      await flush();
      expect(get('library-status').textContent).toBe(status);
      expect(get('library-rows').innerHTML).toBe(rows);
      delete storage.faults.completionStall;
      delete storage.faults.abortThrow;
      delete storage.faults.txStall;
      click('library-refresh');
      await flush();
      expect(get('library-status').textContent).toContain('Library refreshed');
      expect(get('library-selection').textContent).toContain(second);
      expect(document.activeElement).toBe(focused);
    },
  );

  it.each(['refresh', 'delete', 'repair'] as const)(
    'revokes %s refresh publication and followups across connection invalidation without releasing native ownership',
    async (action) => {
      vi.useFakeTimers();
      const original = encodeRecord(draft('target'), 1);
      const neighbor = encodeRecord(draft('neighbor'), 1);
      storage.values.set(
        first,
        action === 'repair' ? JSON.stringify({ ...JSON.parse(original), revision: 0 }) : original,
      );
      storage.values.set(second, neighbor);
      await open();
      if (action === 'refresh')
        storage.values.set(third, encodeRecord(draft('not yet displayed'), 1));
      else if (action === 'repair')
        root.querySelector<HTMLButtonElement>(`[data-repair-id="${first}"]`)!.click();
      else click('library-delete');
      storage.faults.completionStall = 'readonly';
      click(action === 'refresh' ? 'library-refresh' : 'library-confirm');
      await flush();
      const committed = [...storage.values];
      if (action !== 'refresh') {
        expect(committed).toEqual([[second, neighbor]]);
        expect(get('library-status').textContent).toContain('Write committed');
      }
      const owner = storage.current;
      const transactions = storage.connection.transaction.mock.calls.length;
      const rows = get('library-rows').innerHTML;
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      storage.faults.abortThrow = true;
      storage.connection.onversionchange();
      await flush();
      expect(get('library-status').textContent).toContain('Another tab changed');
      const status = get('library-status').textContent;
      expect(owner.native.abort).toHaveBeenCalledOnce();
      expect(owner.native.oncomplete).toBeTypeOf('function');
      click('library-refresh');
      await flush();
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      const captureEffects = vi.spyOn(get('capture-selected'), 'setAttribute');
      const captureEffectsAcrossDeadline = vi.spyOn(get('capture-selected'), 'setAttribute');
      await vi.advanceTimersByTimeAsync(10001);
      await flush();
      expect(get('library-status').textContent).toBe(status);
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      expect(captureEffectsAcrossDeadline).not.toHaveBeenCalled();
      delete storage.faults.completionStall;
      delete storage.faults.abortThrow;
      owner.releaseCompletion();
      await flush();
      expect(owner.native.oncomplete).toBeNull();
      expect(get('library-status').textContent).toBe(status);
      if (action !== 'refresh') expect(status).toContain('Write committed');
      expect(get('library-rows').innerHTML).toBe(rows);
      expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
      expect(document.activeElement).toBe(document.body);
      expect(captureEffects).not.toHaveBeenCalled();
      expect([...storage.values]).toEqual(committed);
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions);
      click('library-refresh');
      await flush();
      expect(storage.connection.transaction).toHaveBeenCalledTimes(transactions + 1);
      expect(get('library-status').textContent).toContain('Library refreshed');
      expect(get('library-rows').children).toHaveLength(committed.length);
      expect([...storage.values]).toEqual(committed);
    },
  );

  it.each([
    'sole delete',
    'disappeared',
    'vanished next',
    'vanished previous',
    'vanished preferred',
  ])('preserves deliberate no selection through repeated refresh after %s', async (scenario) => {
    const a = encodeRecord(draft('A'), 1);
    const b = encodeRecord(draft('B'), 1);
    const c = encodeRecord(draft('C'), 1);
    const unseen =
      scenario === 'vanished preferred' ? '00000000-0000-4000-8000-000000000004' : third;
    const expected =
      scenario === 'vanished preferred'
        ? [
            [first, a],
            [unseen, c],
          ]
        : [[unseen, c]];
    storage.values.set(first, a);
    if (scenario.startsWith('vanished')) storage.values.set(second, b);
    if (scenario === 'vanished preferred') storage.values.set(third, c);
    await open();
    if (scenario === 'vanished previous' || scenario === 'vanished preferred') select(second);
    // Simulate an unseen same-origin tab update without refreshing this snapshot.
    storage.values.set(unseen, c);
    if (scenario === 'disappeared') {
      storage.values.delete(first);
      click('library-refresh');
    } else {
      if (scenario === 'vanished preferred') storage.values.delete(third);
      if (scenario === 'vanished next') storage.values.delete(second);
      if (scenario === 'vanished previous') storage.values.delete(first);
      click('library-delete');
      click('library-confirm');
    }
    await flush();
    expect([...storage.values]).toEqual(expected);
    const assertNone = () => {
      expect(get('library-selection').textContent).toBe('No selected entry.');
      expect(root.querySelector('[data-library-id][aria-pressed="true"]')).toBeNull();
      for (const action of ['load', 'rename', 'duplicate', 'export', 'delete'])
        expect(get<HTMLButtonElement>(`library-${action}`).disabled).toBe(true);
    };
    assertNone();
    if (scenario !== 'disappeared') expect(document.activeElement).toBe(get('library-heading'));
    get('library-refresh').focus();
    for (let repeat = 0; repeat < 2; repeat++) {
      click('library-refresh');
      await flush();
      assertNone();
      expect(document.activeElement).toBe(get('library-refresh'));
    }
    select(unseen);
    get('library-load').focus();
    click('library-refresh');
    await flush();
    expect(get('library-selection').textContent).toContain(unseen);
    expect(get<HTMLButtonElement>('library-load').disabled).toBe(false);
    expect(document.activeElement).toBe(get('library-load'));
  });

  it('keeps timed-out native ownership, refuses busy replacement, and reports terminal connection state', async () => {
    vi.useFakeTimers();
    storage.values.set(first, encodeRecord(draft(), 1));
    await open();
    click('library-rename');
    (document.activeElement as HTMLElement).blur();
    click('library-confirm');
    await flush();
    expect(document.activeElement).toBe(get('library-heading'));
    click('library-delete');
    get<HTMLButtonElement>('library-delete').disabled = true;
    storage.connection.onversionchange();
    await flush();
    expect(document.activeElement).toBe(get('library-heading'));
    expect(get('library-status').textContent).toContain('Another tab');
    await open();
    storage.faults.txStall = true;
    storage.faults.abortThrow = true;
    click('library-load');
    await flush();
    click('library-load');
    expect(get('library-status').textContent).toContain('replacement not started');
    await vi.advanceTimersByTimeAsync(10000);
    await flush();
    expect(get('library-status').textContent).toContain('uncertain');
    delete storage.faults.abortThrow;
    delete storage.faults.txStall;
    storage.current.complete();
    await flush();
    click('library-refresh');
    await flush();
    await uploadLocal(serializeBlueprint(draft('candidate').blueprint));
    click('library-load');
    expect(get('library-status').textContent).toContain('replacement not started');
    storage.faults.txStall = true;
    click('library-add');
    await flush();
    click('library-add');
    expect(get('library-status').textContent).toContain('Action not started');
    await vi.advanceTimersByTimeAsync(10000);
    await flush();
    delete storage.faults.txStall;
  });

  it('uses a stable fallback for a removed invoker and ignores an already-resolved open after disposal', async () => {
    storage.values.set(first, encodeRecord(draft(), 1));
    await open();
    get('library-rename').focus();
    click('library-rename');
    get('library-rename').remove();
    click('library-cancel');
    expect(document.activeElement).toBe(get('library-heading'));
    click('library-save');
    dispose();
    const before = root.innerHTML;
    await flush();
    expect(root.innerHTML).toBe(before);
    expect(storage.values.size).toBe(1);
  });

  it('retains focused keyed rows when an earlier key disappears and never steals a newer control focus', async () => {
    storage.values.set(first, encodeRecord(draft(), 1));
    storage.values.set(second, encodeRecord(draft('focused'), 1));
    await open();
    select(second);
    const button = root.querySelector<HTMLButtonElement>(`[data-library-id="${second}"]`)!;
    button.focus();
    storage.values.delete(first);
    click('library-refresh');
    await flush();
    expect(document.activeElement).toBe(button);
    storage.faults.txStall = true;
    click('library-delete');
    click('library-confirm');
    await flush();
    get('blueprint-name').focus();
    delete storage.faults.txStall;
    storage.current.complete();
    await flush();
    expect(document.activeElement).toBe(get('blueprint-name'));
    storage.values.set(first, encodeRecord(draft(), 1));
    click('library-refresh');
    await flush();
    const remaining = root.querySelector<HTMLButtonElement>(`[data-library-id="${first}"]`)!;
    remaining.focus();
    storage.values.clear();
    click('library-refresh');
    await flush();
    expect(document.activeElement).toBe(get('library-heading'));
  });

  it.each(
    (['create', 'duplicate', 'rename', 'replace', 'delete', 'repair'] as const).flatMap((action) =>
      (['write', 'refresh'] as const).map((phase) => ({ action, phase })),
    ),
  )(
    'preserves newer explicit selection during $action $phase completion',
    async ({ action, phase }) => {
      const source = draft('target', 42);
      const original = encodeRecord(source, 1);
      const expected = new Map([
        [
          first,
          action === 'repair' ? JSON.stringify({ ...JSON.parse(original), revision: 0 }) : original,
        ],
        [second, encodeRecord(draft('neighbor'), 1)],
        [third, encodeRecord(draft('newer explicit selection'), 1)],
      ]);
      for (const [id, value] of expected) storage.values.set(id, value);
      await open();
      if (action === 'create')
        await uploadLocal(serializeBlueprint(draft('created').blueprint), true);
      else if (action === 'replace')
        await uploadLocal(serializeBlueprint(draft('replacement').blueprint));
      if (action === 'repair')
        root.querySelector<HTMLButtonElement>(`[data-repair-id="${first}"]`)!.click();
      else if (action === 'rename' || action === 'replace' || action === 'delete') {
        click(`library-${action}`);
        if (action === 'rename') set('library-rename-name', 'renamed');
      }
      storage.faults.completionStall = phase === 'write' ? 'readwrite' : 'readonly';
      click(
        action === 'create'
          ? 'library-save'
          : action === 'duplicate'
            ? 'library-duplicate'
            : 'library-confirm',
      );
      await flush();
      const owner = storage.current;
      if (action === 'create' || action === 'duplicate') {
        const id = [...storage.values.keys()].find((id) => !expected.has(String(id)));
        expect(id).toBeTypeOf('string');
        expected.set(
          String(id),
          encodeRecord(
            action === 'duplicate' ? source : { blueprint: draft('created').blueprint },
            1,
          ),
        );
      } else if (action === 'delete' || action === 'repair') expected.delete(first);
      else
        expected.set(
          first,
          encodeRecord(
            action === 'rename'
              ? { ...source, blueprint: { ...source.blueprint, name: 'renamed' } }
              : { blueprint: draft('replacement').blueprint },
            2,
          ),
        );
      expect([...storage.values]).toEqual([...expected]);
      select(third);
      expect(get('library-selection').textContent).toContain('newer explicit selection');
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      delete storage.faults.completionStall;
      owner.releaseCompletion();
      await flush();
      expect([...storage.values]).toEqual([...expected]);
      expect(get('library-selection').textContent).toContain('newer explicit selection');
      expect(root.querySelector(`[data-library-id="${third}"]`)!.getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(document.activeElement).toBe(document.body);
      expect(get('library-count').textContent).toContain(`${expected.size} / 100`);
      expect(get('library-status').textContent).toContain('Write committed');
    },
  );

  it('retains an aborting native reader without queuing a rejected replacement or another deadline', async () => {
    vi.useFakeTimers();
    storage.values.set(first, encodeRecord(draft(), 1));
    await open();
    let finish!: (value: string) => void;
    const input = get<HTMLInputElement>('blueprint-file');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [
        {
          size: 1,
          text: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      ],
    });
    input.dispatchEvent(new Event('change'));
    const abort = vi.spyOn(FileReader.prototype, 'abort').mockImplementationOnce(() => {});
    click('library-load');
    expect(get('library-status').textContent).toContain('native owner has not settled');
    expect(abort).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(abort).toHaveBeenCalledTimes(1);
    finish(serializeBlueprint(draft('old reader').blueprint));
    await flush();
    expect(get<HTMLInputElement>('blueprint-name').value).not.toBe('old reader');
    click('library-load');
    await flush();
    expect(get<HTMLDialogElement>('library-dialog').open).toBe(true);
  });

  it.each([false, true])(
    'revokes timed-out file publication for designer=%s while retaining and releasing only its own native reader',
    async (designer) => {
      vi.useFakeTimers();
      const original = encodeRecord(draft('stored'), 1);
      storage.values.set(first, original);
      await open();
      set('blueprint-name', 'retained designer');
      const design = get('editor').innerHTML;
      const commands = worker.postMessage.mock.calls.length;
      const readers: FileReader[] = [];
      const reads = vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (
        this: FileReader,
      ) {
        readers.push(this);
      });
      const abort = vi.spyOn(FileReader.prototype, 'abort').mockImplementation(() => {});
      const expired = serializeBlueprint(draft('expired candidate').blueprint);
      const input = get<HTMLInputElement>(designer ? 'blueprint-file' : 'library-file');
      await uploadLocal(expired, designer);
      expect(reads).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10000);
      const statusId = designer ? 'designer-file-status' : 'library-status';
      const timeout = get(statusId).textContent;
      expect(timeout).toContain('timed out');
      expect(abort).toHaveBeenCalledOnce();
      const reader = readers[0];
      const oldTerminal = reader.onloadend!;
      Object.defineProperty(reader, 'result', { value: expired });
      reader.dispatchEvent(new ProgressEvent('load'));
      await flush();
      expect(get(statusId).textContent).toBe(timeout);
      expect(get('library-candidate').hidden).toBe(true);
      reader.dispatchEvent(new ProgressEvent('abort'));
      reader.dispatchEvent(new ProgressEvent('error'));
      await flush();
      expect(get(statusId).textContent).toBe(timeout);
      expect(get('library-candidate').hidden).toBe(true);
      expect(get<HTMLInputElement>('blueprint-name').value).toBe('retained designer');
      expect(get('editor').innerHTML).toBe(design);
      expect([...storage.values]).toEqual([[first, original]]);
      await uploadLocal(expired, !designer);
      expect(reads).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      reader.dispatchEvent(new ProgressEvent('loadend'));
      await flush();
      expect(reader.onload).toBeNull();
      const retry = serializeBlueprint(draft('explicit retry').blueprint);
      await uploadLocal(retry, designer);
      expect(reads).toHaveBeenCalledTimes(2);
      const clearInput = vi.spyOn(input, 'value', 'set');
      const timers = vi.getTimerCount();
      oldTerminal.call(reader, new ProgressEvent('loadend'));
      expect(clearInput).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timers);
      await uploadLocal(expired, !designer);
      expect(reads).toHaveBeenCalledTimes(2);
      Object.defineProperty(readers[1], 'result', { value: retry });
      readers[1].dispatchEvent(new ProgressEvent('load'));
      readers[1].dispatchEvent(new ProgressEvent('loadend'));
      await flush();
      expect(input.value).toBe('');
      expect(get<HTMLInputElement>('blueprint-name').value).toBe(
        designer ? 'explicit retry' : 'retained designer',
      );
      expect(get('library-candidate').hidden).toBe(designer);
      if (!designer) {
        expect(get('library-candidate-name').textContent).toBe('explicit retry');
        expect(get('library-status').textContent).toContain('Imported an unsaved blueprint');
      } else expect(get(statusId).textContent).toContain('loaded into designer');
      expect([...storage.values]).toEqual([[first, original]]);
      expect(worker.postMessage).toHaveBeenCalledTimes(commands);
    },
  );

  it('cancels captures before native transaction admission and never relabels their tick', async () => {
    storage.faults.openStall = true;
    click('capture-selected');
    click('reset');
    storage.deliverOpen();
    await flush();
    expect(storage.values.size).toBe(0);
    expect(get('library-candidate').hidden).toBe(true);
    expect(get('library-status').textContent).toContain('before storage admission');
    emit(sample, organism);
    storage.faults.requestError = 'QuotaExceededError';
    click('capture-selected');
    await flush();
    expect(get('library-candidate').hidden).toBe(false);
    click('reset');
    expect(get('library-candidate').hidden).toBe(true);
    emit(sample, organism);
    delete storage.faults.requestError;
    dispose();
    storage.faults.openStall = true;
    dispose = mount(root, worker as unknown as Worker);
    emit(sample, organism);
    click('capture-selected');
    dispose();
    const before = root.innerHTML;
    storage.deliverOpen();
    await flush();
    expect(root.innerHTML).toBe(before);
  });

  it('fails invalid candidates and bounds synchronous reader errors and designer deadlines', async () => {
    await open();
    set('blueprint-name', 'x'.repeat(81));
    click('library-save');
    expect(get('library-status').textContent).toContain('unchanged');
    emit(sample, { ...organism, genome: { ...organism.genome, cells: [] } });
    click('capture-selected');
    expect(storage.values.size).toBe(0);
    vi.useFakeTimers();
    const input = get<HTMLInputElement>('blueprint-file');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ size: 1, text: () => new Promise(() => {}) }],
    });
    input.dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(10000);
    await flush();
    expect(get('designer-file-status').textContent).toContain('timed out');
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementationOnce(() => {
      throw new Error('reader');
    });
    input.dispatchEvent(new Event('change'));
    expect(get('designer-file-status').textContent).toContain('Could not read');
    click('import-blueprint');
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    input.dispatchEvent(new Event('change'));
    expect(get('designer-file-status').textContent).toContain('cancelled');
  });
});

describe('ecosystem desk', () => {
  it('confirms every user reset with a frozen payload, cancellation focus and no ecological command on cancellation', () => {
    click('ecosystem-tab');
    root.querySelector<HTMLDetailsElement>('.world-settings')!.open = true;
    const before = worker.postMessage.mock.calls.length;
    get('reset').click();
    expect(get<HTMLDialogElement>('reset-dialog').open).toBe(true);
    expect(document.activeElement).toBe(get('cancel-reset'));
    expect(worker.postMessage.mock.calls).toHaveLength(before);
    get('reset-dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(get<HTMLDialogElement>('reset-dialog').open).toBe(false);
    expect(document.activeElement).toBe(get('reset'));
    expect(worker.postMessage.mock.calls).toHaveLength(before);
    get('reset').click();
    set('seed', '99');
    set('terrain-preset', 'open-field', 'change');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    expect(worker.postMessage.mock.calls).toHaveLength(before);
    get('confirm-reset').click();
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'start', settings: DEFAULTS, terrain: DEFAULT_TERRAIN }),
    );
    expect(get<HTMLSelectElement>('terrain-preset').value).toBe('open-field');
    expect(get('terrain-draft-status').textContent).toContain('Unapplied');
    expect(get('terrain-committed').textContent).toContain('Porous ridges');
  });
  it('validates draft seed bounds without posting, and invalidates reset confirmation on load and disposal', () => {
    get<HTMLInputElement>('terrain-follow').checked = false;
    get('terrain-follow').dispatchEvent(new Event('change'));
    expect(get('terrain-seed-label').hidden).toBe(false);
    for (const seed of ['-1', '4294967296', '0.5', '']) {
      set('terrain-seed', seed);
      const before = worker.postMessage.mock.calls.length;
      click('regenerate-walls');
      get('reset').click();
      expect(get('notice').textContent).toContain('valid wall recipe');
      expect(worker.postMessage.mock.calls).toHaveLength(before);
      expect(get('terrain-preview-caption').textContent).toContain('unavailable');
    }
    set('terrain-seed', '4294967295');
    get('reset').click();
    expect(get('reset-payload').textContent).toContain('4294967295');
    click('load');
    expect(get<HTMLDialogElement>('reset-dialog').open).toBe(false);
    get('confirm-reset').click();
    expect(worker.postMessage.mock.calls).toHaveLength(1);
    get('reset').click();
    dispose();
    get('reset').click();
    expect(get<HTMLDialogElement>('reset-dialog').open).toBe(false);
    set('terrain-seed', '0');
    expect(worker.postMessage.mock.calls).toHaveLength(1);
  });
  it('separates immutable wall owners from newer drafts and preserves paused selected real ecology through clear/no-op/regenerate', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    click('clear-walls');
    const first = [...bridge.records.values()].find(
      (record) => record.command.type === 'clear-walls',
    )!;
    expect(first.command).toMatchObject({ action: 'clear', runId: 1 });
    bridge.emit({ ...first.terminal, action: 'regenerate' });
    expect(get('notice').textContent).not.toContain('Wall action applied');
    bridge.deliver(first.command.commandId);
    expect(get('notice').textContent).toContain('Wall action applied');
    set('terrain-preset', 'chambered-refuges', 'change');
    get<HTMLInputElement>('terrain-follow').checked = false;
    get('terrain-follow').dispatchEvent(new Event('change'));
    set('terrain-seed', '0');
    click('regenerate-walls');
    const pending = [...bridge.records.values()].find(
      (record) => record.command.type === 'regenerate-walls',
    )!;
    for (const extra of [
      { action: 'clear' },
      { resolvedSeed: 1 },
      { recipe: { ...pending.command.recipe, seed: 1 } },
      { recipe: null },
      { requestId: pending.command.commandId },
    ])
      bridge.emit({ ...pending.terminal, ...extra });
    expect(get('terrain-committed').textContent).toContain('Porous ridges');
    set('terrain-preset', 'open-field', 'change');
    bridge.deliver(pending.command.commandId);
    expect(get('terrain-committed').textContent).toContain('Chambered refuges');
    expect(get<HTMLSelectElement>('terrain-preset').value).toBe('open-field');
    expect(get('run-state').textContent).toBe('PAUSED');
    click('clear-walls');
    bridge.deliverAll();
    click('clear-walls');
    bridge.deliverAll();
    expect(get('notice').textContent).toContain('unchanged');
    click('regenerate-walls');
    bridge.deliverAll();
    expect(get('terrain-committed').textContent).toContain('Open field');
    expect(get('terrain-draft-status').textContent).toContain('matches');
  });
  it('requires exact current wall metadata and echoes even for correlated errors, without consuming other native owners', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    set('terrain-preset', 'open-field', 'change');
    click('regenerate-walls');
    const pending = [...bridge.records.values()][0];
    bridge.emit({ ...pending.terminal, terrain: null });
    expect(get('notice').textContent).toContain('Invalid completed wall recipe');
    bridge.deliver(pending.command.commandId);
    click('regenerate-walls');
    const next = [...bridge.records.values()][0];
    bridge.emit({ ...next.terminal, terrain: { ...DEFAULT_TERRAIN } });
    expect(get('notice').textContent).toContain('differs');
    bridge.deliver(next.command.commandId);
    click('clear-walls');
    const rejected = [...bridge.records.values()][0];
    bridge.emit({
      type: 'error',
      operation: 'clear-walls',
      runId: 1,
      commandId: rejected.command.commandId,
      action: 'regenerate',
      message: 'wrong echo',
    });
    bridge.deliver(rejected.command.commandId);
    expect(get('notice').textContent).toContain('unchanged');
    click('clear-walls');
    const error = [...bridge.records.values()][0];
    bridge.emit({
      type: 'error',
      operation: 'clear-walls',
      runId: 1,
      commandId: error.command.commandId,
      action: 'clear',
      message: 'matching wall error',
    });
    expect(get('notice').textContent).toBe('matching wall error');
    bridge.deliver(error.command.commandId);
  });
  it('keeps newer terrain drafts through rejected real imports and revokes old wall results across reset', async () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    click('clear-walls');
    const old = [...bridge.records.values()][0];
    await loadText('{}');
    set('terrain-preset', 'open-field', 'change');
    const load = [...bridge.records.values()].find((record) => record.command.type === 'load')!;
    bridge.deliver(load.command.requestId);
    expect(get('terrain-committed').textContent).toContain('Porous ridges');
    expect(get<HTMLSelectElement>('terrain-preset').value).toBe('open-field');
    bridge.deliver(old.command.commandId);
    expect(get<HTMLSelectElement>('terrain-preset').value).toBe('open-field');
    get('reset').click();
    get('cancel-reset').click();
    expect(bridge.records.size).toBe(0);
  });
  it('reuses mounted output nodes and changes text only when the displayed value changes', () => {
    const population = get('population'),
      observer = new MutationObserver(() => {}),
      query = vi.spyOn(root, 'querySelector');
    observer.observe(population, { childList: true, characterData: true, subtree: true });
    emit();
    expect(population.textContent).toBe(String(sample.stats.population));
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    emit();
    expect(observer.takeRecords()).toEqual([]);
    const changed = structuredClone(sample);
    changed.stats.population++;
    emit(changed);
    expect(population.textContent).toBe(String(changed.stats.population));
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(query).not.toHaveBeenCalled();
    observer.disconnect();
  });
  it('starts with Pan and Organism selected without changing the world when dragged', () => {
    expect(get('world').dataset.tool).toBe('pan');
    expect(root.querySelector('button[data-tool="pan"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(root.querySelector('button[data-tool="inspect"]')!.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(get('tool-hint').textContent).toBe('Drag to move the world. Scroll to zoom.');
    expect(get('brush-control').hidden).toBe(true);
    expect(get('organism-tab').getAttribute('aria-selected')).toBe('true');
    expect(get('ecosystem-tab').getAttribute('aria-selected')).toBe('false');
    expect(get('organism-panel').hidden).toBe(false);
    expect(get('ecosystem-panel').hidden).toBe(true);
    pointer('pointerdown');
    pointer('pointermove', 170, 180);
    window.dispatchEvent(new Event('pointerup'));
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(get<HTMLDetailsElement>('specimen-details').open).toBe(false);
  });
  it('keeps the habitat clear and consolidates the interface in the sidebar', () => {
    const sidebar = root.querySelector('.sidebar')!,
      stage = root.querySelector('.world-stage')!;
    expect(stage.children).toHaveLength(1);
    expect(stage.firstElementChild).toBe(get('world').parentElement);
    for (const id of [
      'pause',
      'step',
      'speed',
      'zoom-in',
      'zoom-out',
      'fit',
      'brush',
      'world-label',
      'run-state',
      'tick',
      'world-count',
      'ecosystem-panel',
      'organism-panel',
      'save',
      'load',
      'help',
      'notice',
    ])
      expect(sidebar.contains(get(id))).toBe(true);
    expect(sidebar.contains(root.querySelector('.tool-dock'))).toBe(true);
    expect(sidebar.contains(root.querySelector('.cell-legend'))).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('.legend')!.open).toBe(false);
  });
  it('starts immediately, pauses, single-steps, changes settings live and reseeds', () => {
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'start',
      settings: DEFAULTS,
      terrain: DEFAULT_TERRAIN,
      runId: 1,
      requestId: 1,
    });
    paint(0);
    window.dispatchEvent(new Event('resize'));
    click('step');
    expect(get<HTMLButtonElement>('step').disabled).toBe(true);
    click('pause');
    expect(get<HTMLButtonElement>('step').disabled).toBe(false);
    click('step');
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'step' });
    click('pause');
    set('speed', '12', 'change');
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'speed', value: 12 });
    set('mutation', '.2');
    set('nutrients', '8');
    set('climate', '.5');
    set('brush', '5');
    expect(get('nutrients-value').textContent).toBe('8%');
    expect(get('brush-value').textContent).toBe('5 cells');
    root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'shock',
      kind: 'heat',
      runId: 1,
      commandId: 5,
    });
    set('seed', '-1');
    click('reset');
    expect(get('notice').textContent).toContain('whole-number');
    set('seed', '99');
    click('reset');
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'start',
        runId: 2,
        settings: { ...DEFAULTS, seed: 99, mutation: 0.2, nutrients: 8, climate: 0.5 },
      }),
    );
  });
  it('renders real population, lineages, weather and a selected organism', () => {
    emit();
    expect(Number(get('population').textContent)).toBe(sample.stats.population);
    paint(1);
    paint(2);
    window.dispatchEvent(new Event('resize'));
    expect(root.querySelectorAll('.lineage')).toHaveLength(1);
    expect(get('species-count').textContent).toBe('1 lineage');
    expect(get('world-count').textContent).toBe('1 organism · 1 lineage');
    const populated = Ecosystem.load(JSON.stringify(world.save()));
    populated.spawn(founder(1), 2, 10, 2);
    populated.spawn(founder(2), 2, 25, 3);
    for (let update = 0; update < 12; update++) emit(populated.frame());
    expect(root.querySelectorAll('.lineage')).toHaveLength(3);
    expect(get('species-count').textContent).toBe('3 lineages');
    expect(get('world-count').textContent).toBe('3 organisms · 3 lineages');
    root.querySelector<HTMLButtonElement>('.lineage')!.click();
    expect(get('organism-panel').hidden).toBe(false);
    expect(get<HTMLDetailsElement>('specimen-details').open).toBe(false);
    emit(sample, organism);
    expect(get('inspector').textContent).toContain(`Organism ${organism.id}`);
    click('copy-organism');
    expect(get('notice').textContent).toContain('Anatomy copied');
    for (let i = 0; i < 14; i++) emit(sample, organism);
    click('pause');
    emit(sample, null);
    expect(get('inspector').textContent).toContain('Click any organism');
    const quiet = new Ecosystem(DEFAULTS, false).frame();
    for (let i = 0; i < 12; i++) emit(quiet);
    expect(get('lineages').textContent).toContain('quiet');
    worker.emit({ type: 'unknown' });
    const before = get('tick').textContent;
    worker.emit({ type: 'frame', frame: sample, selected: null }, 0);
    expect(get('tick').textContent).toBe(before);
    dispose();
    emit();
    expect(get('tick').textContent).toBe(before);
  });
  it('projects only accepted worker history through repeated frames, resize, load, errors and reset', () => {
    const points = (action: () => void) => {
      action();
      paint(0);
      return [...root.querySelectorAll('[data-series="Population"] [data-tick]')].map((mark) => [
        Number(mark.getAttribute('data-tick')),
        Number(mark.getAttribute('data-value')),
      ]);
    };
    const observed = new Ecosystem();
    expect(points(() => emit(observed.frame()))).toEqual([]);
    for (let tick = 0; tick < 30; tick++) observed.step();
    const one = points(() => emit(observed.frame()));
    expect(one).toHaveLength(1);
    observed.paint('plant', 40, 40, 0, founder(0));
    const edited = observed.frame();
    expect(edited.stats.population).toBe(2);
    for (let inspection = 0; inspection < 20; inspection++)
      expect(points(() => emit(edited, [...observed.organisms.values()][0]))).toEqual(one);
    expect(get('population').textContent).toBe('2');
    expect(points(() => window.dispatchEvent(new Event('resize')))).toEqual(one);
    for (let tick = 0; tick < 30; tick++) observed.step();
    const two = points(() => emit(observed.frame()));
    expect(two).toHaveLength(2);
    expect(points(() => worker.emit({ type: 'frame', frame: sample }, 0))).toEqual(two);
    expect(points(() => window.dispatchEvent(new Event('resize')))).toEqual(two);
    worker.emit({ type: 'error', message: 'Invalid ecosystem telemetry.' });
    expect(points(() => window.dispatchEvent(new Event('resize')))).toEqual(two);
    worker.emit({ type: 'loaded', settings: DEFAULTS });
    expect(points(() => emit(observed.frame()))).toEqual(two);
    const ring = new Ecosystem(DEFAULTS, false);
    for (let tick = 0; tick < 5430; tick++) ring.step();
    expect(points(() => emit(ring.frame()))).toHaveLength(180);
    expect(points(() => window.dispatchEvent(new Event('resize')))).toHaveLength(180);
    worker.emit({ type: 'loaded', settings: DEFAULTS });
    expect(points(() => emit(sample))).toEqual([]);
    click('reset');
    expect(points(() => emit(sample))).toEqual([]);
  });
  it('paints, inspects, pans and zooms without confusing coordinate systems', () => {
    emit();
    root.querySelector<HTMLButtonElement>('[data-tool="inspect"]')!.click();
    pointer('pointermove');
    pointer('pointerdown', -500, -500);
    window.dispatchEvent(new Event('pointerup'));
    pointer('pointerdown');
    expect(get<HTMLDetailsElement>('specimen-details').open).toBe(true);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'inspect' }),
    );
    pointer('pointermove', 155, 155);
    window.dispatchEvent(new Event('pointerup'));
    root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
    pointer('pointerdown');
    pointer('pointermove', 160, 150);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'paint', tool: 'food' }),
    );
    window.dispatchEvent(new Event('pointercancel'));
    root.querySelector<HTMLButtonElement>('[data-tool="pan"]')!.click();
    pointer('pointerdown');
    pointer('pointermove', 170, 180);
    window.dispatchEvent(new Event('pointerup'));
    click('zoom-in');
    click('zoom-out');
    get('world').dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, clientX: 150, clientY: 150, cancelable: true }),
    );
    paint(0);
    click('fit');
    get('world').dispatchEvent(new Event('dblclick'));
    click('thermal');
    expect(get('thermal').getAttribute('aria-pressed')).toBe('true');
    paint(1);
    click('thermal');
    paint(2);
  });
  it('designs connected bodies and rejects disconnected planting', () => {
    root.querySelector<HTMLButtonElement>('[data-tab="organism"]')!.click();
    get('editor').click();
    get<HTMLButtonElement>('editor')
      .querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!
      .click();
    click('plant-design');
    expect(get('notice').textContent).toContain('connected');
    get('editor').querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!.click();
    expect(get('design-note').textContent).toContain('Ready');
    get('editor').querySelector<HTMLButtonElement>('[data-x="0"][data-y="0"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-cell="6"]')!.click();
    get('editor').querySelector<HTMLButtonElement>('[data-x="0"][data-y="0"]')!.click();
    set('preference', '.75');
    expect(get('preference-value').textContent).toBe('30°');
    click('plant-design');
    expect(get('world').dataset.tool).toBe('plant');
    expect(get('world').scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    pointer('pointerdown');
    pointer('pointermove');
    window.dispatchEvent(new Event('pointerup'));
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'paint', tool: 'plant' }),
    );
    click('clear-design');
    expect(root.querySelectorAll('#editor button')).toHaveLength(81);
  });
  it('handles keyboard shortcuts, help, errors, and disposal', () => {
    const key = (key: string, code = key) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, code, cancelable: true }));
    key(' ', 'Space');
    expect(get('run-state').textContent).toBe('PAUSED');
    key('f');
    expect(get('world').dataset.tool).toBe('food');
    key('q');
    get('seed').dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
    expect(get('world').dataset.tool).toBe('food');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));
    expect(get('world').dataset.tool).toBe('food');
    click('help');
    expect(get<HTMLDialogElement>('help-dialog').open).toBe(true);
    expect(get('help-dialog').textContent).toContain('An original cellular simulation');
    expect(get('help-dialog').querySelector('a')).toBeNull();
    key('w');
    click('close-help');
    key('w');
    expect(get('world').dataset.tool).toBe('wall');
    worker.emit({ type: 'error', message: 'Bad import' });
    expect(get('notice').textContent).toBe('Bad import');
    worker.emit({ type: 'error', message: 'Failed tick', fatal: true });
    expect(get('run-state').textContent).toBe('STOPPED');
    worker.onerror?.();
    expect(get('notice').textContent).toContain('worker stopped');
    dispose();
    expect(worker.terminate).toHaveBeenCalled();
  });
  it('exports complete worlds and restores settings from successful imports', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    click('save');
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'save', runId: 1, requestId: 2 });
    worker.emit({ type: 'saved', text: JSON.stringify(world.save()) });
    expect(URL.createObjectURL).toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    vi.useRealTimers();
    const fileClick = vi.spyOn(get('file'), 'click');
    click('load');
    expect(fileClick).toHaveBeenCalled();
    upload();
    upload({ size: 100, text: async () => 'world' });
    await vi.waitFor(() =>
      expect(worker.postMessage).toHaveBeenLastCalledWith({
        type: 'load',
        text: 'world',
        runId: 2,
        requestId: 3,
      }),
    );
    worker.emit({
      type: 'loaded',
      settings: { seed: 88, mutation: 0.3, nutrients: 8, climate: 0.4 },
    });
    expect(get('notice').textContent).toContain('World restored');
    expect(get<HTMLInputElement>('seed').value).toBe('88');
    expect(get('nutrients-value').textContent).toBe('8%');
    upload({ size: 2500001, text: async () => '' });
    await vi.waitFor(() => expect(get('notice').textContent).toContain('2.5 MB'));
    upload({
      size: 10,
      text: async () => {
        throw new Error('Unreadable');
      },
    });
    await vi.waitFor(() => expect(get('notice').textContent).toBe('Unreadable'));
    upload({
      size: 10,
      text: async () => {
        throw 'unknown';
      },
    });
    await vi.waitFor(() => expect(get('notice').textContent).toContain('Could not read'));
  });
  it('ignores a file read that finishes after the view is disposed', async () => {
    let finish: (text: string) => void = () => {};
    upload({
      size: 1,
      text: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    dispose();
    finish('world');
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });
  it('boots the app entry point', async () => {
    root.id = 'app';
    const constructor = vi.fn(function () {
      return worker;
    });
    vi.stubGlobal('Worker', constructor);
    vi.resetModules();
    await import('../src/main');
    expect(constructor).toHaveBeenCalled();
  });
});
describe('standalone blueprint files', () => {
  const input = () => get<HTMLInputElement>('blueprint-file');
  const fixture = (name = '  <img onerror=alert(1)> 🌿  ') => ({
    name,
    description: '<script>literal only</script>\nSecond line',
    genome: {
      ...founder(2),
      preference: 0.1234567890123456,
      tolerance: 0.4567890123456789,
      tempo: 11,
    },
  });
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const uploadBlueprint = (file?: { size: number; text: () => Promise<string> }) => {
    Object.defineProperty(input(), 'files', { configurable: true, value: file ? [file] : [] });
    input().dispatchEvent(new Event('change'));
  };
  const importDraft = async (text = serializeBlueprint(fixture())) => {
    uploadBlueprint({ size: new TextEncoder().encode(text).length, text: async () => text });
    await flush();
  };
  const blobText = (blob: Blob): Promise<string> =>
    new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob);
    });
  const exported = async (id = 'export-blueprint') => {
    click(id);
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
    expect(blob.type).toBe('application/json');
    return parseBlueprint(await blobText(blob));
  };
  const draftState = () => ({
    name: get<HTMLInputElement>('blueprint-name').value,
    description: get<HTMLTextAreaElement>('blueprint-description').value,
    editor: get('editor').innerHTML,
    preference: get<HTMLInputElement>('preference').value,
    tool: get('world').dataset.tool,
    paused: get('run-state').textContent,
  });
  beforeEach(() => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it.each([false, true])(
    'imports only into the designer, preserving exact traits and world commands (paused=%s)',
    async (paused) => {
      emit(sample, organism);
      if (paused) click('pause');
      click('plant-design');
      click('ecosystem-tab');
      const commands = worker.postMessage.mock.calls.length;
      vi.mocked(get('world').scrollIntoView).mockClear();
      await importDraft();
      expect(worker.postMessage).toHaveBeenCalledTimes(commands);
      expect(get('world').scrollIntoView).not.toHaveBeenCalled();
      expect(get('world').dataset.tool).toBe('pan');
      expect(get('organism-panel').hidden).toBe(false);
      expect(get<HTMLDetailsElement>('specimen-details').open).toBe(false);
      expect(get('notice').textContent).toBe(
        'Blueprint loaded into the designer. Place it explicitly to add an organism.',
      );
      expect(get('run-state').textContent).toBe(paused ? 'PAUSED' : 'LIVE');
      expect(await exported()).toMatchObject(fixture());
      expect(root.querySelector('img, script, [onerror]')).toBeNull();
      pointer('pointerdown');
      window.dispatchEvent(new Event('pointerup'));
      expect(worker.postMessage).toHaveBeenCalledTimes(commands);
      click('plant-design');
      pointer('pointerdown');
      const message = worker.postMessage.mock.calls.at(-1)![0];
      expect(message).toMatchObject({ type: 'paint', tool: 'plant', genome: fixture().genome });
      expect(Object.keys(message)).toEqual([
        'type',
        'tool',
        'x',
        'y',
        'radius',
        'genome',
        'runId',
        'commandId',
      ]);
    },
  );

  it('isolates inspector exports from the draft and resets metadata deliberately on copies', async () => {
    await importDraft();
    const draft = draftState();
    emit(sample, organism);
    expect(await exported('export-organism-blueprint')).toEqual({
      format: 'evolab-organism-blueprint',
      version: 1,
      name: 'Bloom',
      description: '',
      genome: organism.genome,
    });
    expect(draftState()).toEqual(draft);
    emit(sample, null);
    expect(root.querySelector('#export-organism-blueprint')).toBeNull();
    const missing = document.createElement('button');
    missing.id = 'export-organism-blueprint';
    root.append(missing);
    const count = vi.mocked(URL.createObjectURL).mock.calls.length;
    missing.click();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(count);
    missing.remove();
    emit(sample, organism);
    click('copy-organism');
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('Bloom');
    expect(get<HTMLTextAreaElement>('blueprint-description').value).toBe('');
    await importDraft();
    root.querySelector<HTMLButtonElement>('.lineage')!.click();
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('Bloom');
    expect(get<HTMLTextAreaElement>('blueprint-description').value).toBe('');
    await importDraft();
    set('preference', '0.75');
    get('editor').querySelector<HTMLButtonElement>('[data-x="0"][data-y="0"]')!.click();
    expect(get<HTMLInputElement>('blueprint-name').value).toBe(fixture().name);
    expect(get<HTMLTextAreaElement>('blueprint-description').value).toBe(fixture().description);
    click('clear-design');
    expect(await exported()).toMatchObject({
      name: 'Untitled organism',
      description: '',
      genome: founder(0),
    });
  });

  it('rejects invalid metadata and anatomy on export without creating a URL', async () => {
    for (const [id, value] of [
      ['blueprint-name', ' '],
      ['blueprint-name', 'n'.repeat(81)],
      ['blueprint-description', 'd'.repeat(1001)],
    ]) {
      await importDraft();
      set(id, value);
      click('export-blueprint');
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(get('notice').textContent).toContain(id === 'blueprint-name' ? 'name' : 'description');
    }
    await importDraft();
    get('editor').querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!.click();
    click('export-blueprint');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(get('notice').textContent).toContain('connected');
  });

  it('uses fixed safe downloads and cleans anchors and URLs on success and failure', () => {
    vi.useFakeTimers();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('evolab-blueprint.json');
      expect(this.href).toBe('blob:world');
      expect(this.isConnected).toBe(true);
    });
    click('export-blueprint');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:world');
    anchorClick.mockImplementation(() => {
      throw new Error('Download unavailable');
    });
    click('export-blueprint');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(get('notice').textContent).toBe(
      'Could not download this blueprint. Try exporting again.',
    );
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    anchorClick.mockImplementation(() => {
      throw 'failed';
    });
    click('export-blueprint');
    expect(get('notice').textContent).toContain('Could not download');
    vi.runAllTimers();
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
      throw new Error('No URL');
    });
    click('export-blueprint');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('preserves the entire draft, tool and world on invalid files and read failures', async () => {
    await importDraft();
    click('pause');
    click('plant-design');
    const before = draftState();
    const commands = worker.postMessage.mock.calls.length;
    const invalid = [
      '{',
      '{}',
      'null',
      JSON.stringify({ ...JSON.parse(serializeBlueprint(fixture())), version: 2 }),
      JSON.stringify({
        ...JSON.parse(serializeBlueprint(fixture())),
        genome: {
          ...fixture().genome,
          cells: [
            { x: 0, y: 0, type: 3 },
            { x: 2, y: 0, type: 4 },
          ],
        },
      }),
      JSON.stringify({
        ...JSON.parse(serializeBlueprint(fixture())),
        genome: { ...fixture().genome, tempo: 0 },
      }),
      JSON.stringify({ ...JSON.parse(serializeBlueprint(fixture())), id: 3 }),
      '🌿'.repeat(4500),
    ];
    for (const text of invalid) {
      uploadBlueprint({ size: 1, text: async () => text });
      await flush();
      expect(draftState()).toEqual(before);
      expect(get('notice').textContent).not.toContain('loaded');
    }
    const read = vi.fn(async () => '');
    uploadBlueprint({ size: BLUEPRINT_MAX_BYTES + 1, text: read });
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(get('notice').textContent).toContain('16 KiB');
    for (const failure of [new Error('secret'.repeat(1000)), 'secret']) {
      uploadBlueprint({
        size: 1,
        text: async () => {
          throw failure;
        },
      });
      await flush();
      expect(get('notice').textContent).toBe(
        'Could not read this blueprint. Choose a readable JSON file.',
      );
      expect(draftState()).toEqual(before);
    }
    expect(worker.postMessage).toHaveBeenCalledTimes(commands);
    expect(input().value).toBe('');
  });

  it('cancels pickers silently and permits repeated same-file imports', async () => {
    await importDraft();
    const before = draftState(),
      notice = get('notice').textContent;
    uploadBlueprint();
    Object.defineProperty(input(), 'files', { configurable: true, value: null });
    input().dispatchEvent(new Event('change'));
    input().dispatchEvent(new Event('cancel'));
    const fileClick = vi.spyOn(input(), 'click');
    click('import-blueprint');
    expect(fileClick).toHaveBeenCalledOnce();
    expect(input().value).toBe('');
    expect(draftState()).toEqual(before);
    expect(get('notice').textContent).toBe(notice);
    for (let repeat = 0; repeat < 2; repeat++) {
      await importDraft();
      expect(input().value).toBe('');
      expect(draftState()).toEqual(before);
    }
  });

  it('rejects out-of-order reads and prevents old finally handlers clearing a newer selection', async () => {
    let finishOld!: (value: string) => void, finishNew!: (value: string) => void;
    uploadBlueprint({
      size: 1,
      text: () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    });
    uploadBlueprint({
      size: 1,
      text: () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    });
    let value = 'new selection';
    Object.defineProperty(input(), 'value', {
      configurable: true,
      get: () => value,
      set: (next) => {
        value = next;
      },
    });
    finishOld(serializeBlueprint(fixture('old')));
    await flush();
    expect(value).toBe('new selection');
    finishNew(serializeBlueprint(fixture('new')));
    await flush();
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('new');
    expect(value).toBe('');
    let rejectOld!: (reason: unknown) => void;
    uploadBlueprint({
      size: 1,
      text: () =>
        new Promise((_, reject) => {
          rejectOld = reject;
        }),
    });
    await importDraft(serializeBlueprint(fixture('newest')));
    const notice = get('notice').textContent;
    rejectOld('stale error');
    await flush();
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('newest');
    expect(get('notice').textContent).toBe(notice);
  });

  it('keeps the newest successful import when an older success resolves last', async () => {
    let finish!: (value: string) => void;
    uploadBlueprint({
      size: 1,
      text: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await importDraft(serializeBlueprint(fixture('newest success')));
    const before = draftState(),
      notice = get('notice').textContent;
    finish(serializeBlueprint(fixture('old success')));
    await flush();
    expect(draftState()).toEqual(before);
    expect(get('notice').textContent).toBe(notice);
  });

  it.each([
    'cell',
    'preference',
    'name',
    'description',
    'reset-design',
    'copy',
    'common',
    'reseed',
    'world-load',
    'picker',
    'cancel',
    'dispose',
  ])('ignores a delayed result and error after %s', async (action) => {
    emit(sample, organism);
    let finish!: (value: string) => void, reject!: (reason: unknown) => void;
    const change = async () => {
      if (action === 'cell')
        get('editor').querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!.click();
      if (action === 'preference') set('preference', '0.75');
      if (action === 'name') set('blueprint-name', 'edited');
      if (action === 'description') set('blueprint-description', 'edited');
      if (action === 'reset-design') click('clear-design');
      if (action === 'copy') click('copy-organism');
      if (action === 'common') root.querySelector<HTMLButtonElement>('.lineage')!.click();
      if (action === 'reseed') click('reset');
      if (action === 'world-load') {
        upload({ size: 1, text: async () => 'world' });
        await flush();
        worker.emit({ type: 'loaded', settings: DEFAULTS });
      }
      if (action === 'picker') click('import-blueprint');
      if (action === 'cancel') input().dispatchEvent(new Event('cancel'));
      if (action === 'dispose') dispose();
    };
    uploadBlueprint({
      size: 1,
      text: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await change();
    const before = draftState(),
      notice = get('notice').textContent;
    finish(serializeBlueprint(fixture('late result')));
    await flush();
    expect(draftState()).toEqual(before);
    expect(get('notice').textContent).toBe(notice);
    if (action === 'dispose') {
      const rejectedRead = vi.fn();
      uploadBlueprint({ size: 1, text: rejectedRead });
      expect(rejectedRead).not.toHaveBeenCalled();
      dispose = mount(root, worker as unknown as Worker);
      emit(sample, organism);
    }
    uploadBlueprint({
      size: 1,
      text: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    });
    await change();
    const errorState = draftState(),
      errorNotice = get('notice').textContent;
    reject(new Error('late error'));
    await flush();
    expect(draftState()).toEqual(errorState);
    expect(get('notice').textContent).toBe(errorNotice);
  });

  it('labels bounded fields and keeps typing and textarea shortcuts out of the world', () => {
    for (const [id, limit] of [
      ['blueprint-name', 80],
      ['blueprint-description', 1000],
    ] as const) {
      expect(root.querySelector(`label[for="${id}"]`)).not.toBeNull();
      expect(get<HTMLInputElement>(id).maxLength).toBe(limit);
      get(id).dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, code: 'Space', key: ' ' }),
      );
      get(id).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'p' }));
    }
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(get('world').dataset.tool).toBe('pan');
  });

  it('keeps complete paused real-worker saves identical until explicit planting and exact Step', async () => {
    const bridge = realWorker(),
      deferred = bridge.tasks;
    bridge.deliver();
    click('pause');
    deferred.shift()!();
    bridge.deliver();
    const save = () => JSON.stringify(bridge.save());
    const before = save();
    await importDraft();
    await exported();
    expect(save()).toBe(before);
    expect(deferred).toHaveLength(0);
    const population = JSON.parse(before).organisms.length;
    click('plant-design');
    pointer('pointerdown');
    window.dispatchEvent(new Event('pointerup'));
    bridge.deliver();
    expect(JSON.parse(save()).organisms).toHaveLength(population + 1);
    expect(get('run-state').textContent).toBe('PAUSED');
    click('step');
    bridge.deliver();
    expect(JSON.parse(save()).tick).toBe(JSON.parse(before).tick + 1);
    expect(get('run-state').textContent).toBe('PAUSED');
    expect(deferred).toHaveLength(0);
  });
});

describe('authoritative playback presentation', () => {
  it('starts checked, sends a session-only boolean command, and waits for authoritative control acknowledgements', () => {
    expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(true);
    expect(get('extinction-summary').hidden).toBe(true);
    expect(get('extinction-help').textContent).toBe('On by default; applies to this tab.');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.postMessage.mockImplementation(() => {});
    click('pause');
    expect(get('run-state').textContent).toBe('LIVE');
    worker.emit({
      type: 'playback',
      playback: { paused: true, pauseOnExtinction: true, extinction: null },
    });
    expect(get('run-state').textContent).toBe('PAUSED');
    click('pause-on-extinction');
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'pause-on-extinction',
      runId: 1,
      value: false,
    });
    worker.emit({
      type: 'playback',
      playback: { paused: true, pauseOnExtinction: false, extinction: null },
    });
    expect(get<HTMLButtonElement>('step').disabled).toBe(false);
    expect(get('run-state').textContent).toBe('PAUSED');
    click('pause');
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'resume' });
    expect(get('run-state').textContent).toBe('PAUSED');
    worker.emit({
      type: 'playback',
      playback: { paused: false, pauseOnExtinction: false, extinction: null },
    });
    expect(get('run-state').textContent).toBe('LIVE');
  });

  it.each(['energy', 'age', 'manual', 'empty-import'] as const)(
    'renders honest %s summary separately from notices and preserves paused tools',
    (cause) => {
      emit(sample, organism);
      const empty = new Ecosystem(DEFAULTS, false);
      empty.tick = 99;
      const playback = { paused: true, pauseOnExtinction: true, extinction: { tick: 71, cause } };
      worker.emit({ type: 'frame', frame: empty.frame(), selected: null, playback });
      expect(get('population').textContent).toBe('0');
      expect(get('tick').textContent).toBe('TICK 99');
      expect(get('run-state').textContent).toBe('PAUSED');
      expect(get('pause').textContent).toContain('Resume');
      expect(get<HTMLButtonElement>('step').disabled).toBe(false);
      expect(root.classList.contains('paused')).toBe(true);
      expect(get('extinction-summary').textContent).toContain('tick 71');
      expect(get('extinction-summary').getAttribute('aria-live')).toBe('polite');
      expect(get('extinction-summary').textContent).toContain(
        {
          energy: 'energy exhaustion',
          age: 'age limit',
          manual: 'manual erasure',
          'empty-import': 'Original extinction cause unavailable',
        }[cause],
      );
      expect(get('inspector').textContent).toContain('Click any organism');
      expect(get('lineages').textContent).toContain('quiet');
      const summary = get('extinction-summary').textContent;
      worker.postMessage.mockImplementation(() => {});
      click('pause');
      expect(get('notice').textContent).toContain(
        'Place an organism, or turn off Pause on extinction and press Resume.',
      );
      expect(get('run-state').textContent).toBe('PAUSED');
      worker.emit({ type: 'playback', playback });
      worker.emit({ type: 'error', message: 'Rejected file' });
      expect(get('notice').textContent).toBe('Rejected file');
      expect(get('extinction-summary').textContent).toBe(summary);
      click('save');
      click('help');
      expect(get('help-dialog').textContent).toContain('reloading restores ON');
      click('close-help');
      for (const tool of ['inspect', 'food', 'wall', 'erase', 'plant']) {
        root.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`)!.click();
        expect(get('world').dataset.tool).toBe(tool);
      }
      set('speed', '12', 'change');
      click('thermal');
      expect(get('extinction-summary').textContent).toBe(summary);
      worker.emit({
        type: 'frame',
        frame: sample,
        selected: null,
        playback: { ...playback, extinction: null },
      });
      expect(get('extinction-summary').hidden).toBe(true);
      expect(get('lineages').querySelector('.lineage')).not.toBeNull();
      expect(get('run-state').textContent).toBe('PAUSED');
    },
  );

  it('renders empty successful loads as paused before the ecological frame and shows intentional running accurately', async () => {
    const playback = {
      paused: true,
      pauseOnExtinction: true,
      extinction: { tick: 71, cause: 'empty-import' },
    };
    await loadText('{}');
    worker.emit({ type: 'loaded', settings: DEFAULTS, playback });
    expect(get('run-state').textContent).toBe('PAUSED');
    expect(get<HTMLButtonElement>('step').disabled).toBe(false);
    expect(get('extinction-summary').textContent).toContain('imported empty world at tick 71');
    worker.emit({
      type: 'playback',
      playback: { ...playback, paused: false, pauseOnExtinction: false },
    });
    expect(get('extinction-summary').textContent).toContain('Empty world running');
    expect(get('extinction-summary').textContent).toContain('Pause on extinction is off.');
  });

  it.each([true, false])(
    'retains chosen %s through real reseed and loads, not a new mount',
    async (preference) => {
      const harness = realWorker();
      harness.deliver();
      if (!preference) click('pause-on-extinction');
      harness.deliver();
      set('seed', '123');
      click('reset');
      harness.deliver();
      expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(preference);
      const empty = nearDeath();
      empty.organisms = [];
      await loadText(JSON.stringify(empty));
      harness.deliver();
      expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(preference);
      expect(get('run-state').textContent).toBe(preference ? 'PAUSED' : 'LIVE');
      await loadText('{}');
      harness.deliver();
      expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(preference);
      await loadText(JSON.stringify(nearDeath()));
      harness.deliver();
      expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(preference);
      expect(get('extinction-summary').hidden).toBe(true);
      dispose();
      worker = new WorkerStub();
      dispose = mount(root, worker as unknown as Worker);
      expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(true);
    },
  );
});

describe('display-only retained-world races', () => {
  for (const cadence of [4, 12]) {
    it.each([false, true])(
      `preserves post-snapshot settings edits (multiple: %s) on delayed recovery at update ${cadence}`,
      async (multiple) => {
        const chart = chartRecorder();
        const harness = realWorker();
        harness.deliver();
        await loadText(JSON.stringify(nearDeath()));
        harness.deliver();
        harness.advance();
        harness.deliver();
        for (let update = 2; update < cadence; update++) {
          harness.command({ type: 'snapshot' });
          harness.deliver();
        }
        const history = harness.save().telemetry.samples.map((sample) => sample.population);
        expect(chart.paths.at(-1)).toEqual(chart.expected(history));
        const before = harness.save();
        const summary = get('extinction-summary').textContent;
        const steps = vi.spyOn(Ecosystem.prototype, 'step');
        await loadText('{}');
        expect(harness.outbox).toHaveLength(1);
        expect(harness.outbox[0]).toMatchObject({
          type: 'error',
          runId: 3,
          recovery: { settings: { nutrients: 0 } },
        });
        const paths = chart.paths.length;
        if (multiple) {
          set('nutrients', '3');
          set('mutation', '0.37');
          set('climate', '0.25');
        }
        set('nutrients', '7');
        click('ecosystem-tab');
        const commands = worker.postMessage.mock.calls.length;
        set('telemetry-view', 'population', 'change');
        set('telemetry-sample', '30', 'change');
        get('telemetry-sample').focus();
        expect(document.activeElement).toBe(get('telemetry-sample'));
        get('telemetry-sample').dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
        );
        get('telemetry-view').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', bubbles: true }),
        );
        paint(0);
        expect(worker.postMessage.mock.calls).toHaveLength(commands);
        const reference = Ecosystem.load(JSON.stringify(before));
        if (multiple) {
          reference.changeSettings({ nutrients: 3 });
          reference.changeSettings({ mutation: 0.37 });
          reference.changeSettings({ climate: 0.25 });
        }
        reference.changeSettings({ nutrients: 7 });
        const expected = reference.save();
        expect(harness.save()).toEqual(expected);
        harness.deliver();
        expect(get<HTMLInputElement>('nutrients').value).toBe('7');
        expect(get('nutrients-value').textContent).toBe('7%');
        expect(get<HTMLInputElement>('mutation').value).toBe(String(expected.settings.mutation));
        expect(get('mutation-value').textContent).toBe(
          `${Math.round(expected.settings.mutation * 100)}%`,
        );
        expect(get<HTMLInputElement>('climate').value).toBe(String(expected.settings.climate));
        expect(get('climate-value').textContent).toBe(
          `${Math.round(expected.settings.climate * 100)}%`,
        );
        expect(get('notice').textContent).toContain('Not a valid EvoLab ecosystem');
        expect(get('extinction-summary').textContent).toBe(summary);
        expect(get('run-state').textContent).toBe('PAUSED');
        expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(true);
        expect(get<HTMLButtonElement>('step').disabled).toBe(false);
        expect(get('population').textContent).toBe('0');
        expect(get('tick').textContent).toBe(`TICK ${before.tick}`);
        expect(get('inspector').textContent).toContain('Click any organism');
        expect(get('lineages').textContent).toContain('quiet');
        expect(harness.save()).toEqual(expected);
        expect(harness.tasks).toHaveLength(0);
        expect(steps).not.toHaveBeenCalled();
        expect(get<HTMLSelectElement>('telemetry-sample').value).toBe('30');
        expect(document.activeElement).toBe(get('telemetry-sample'));
        expect(chart.paths).toHaveLength(paths + 1);
        window.dispatchEvent(new Event('resize'));
        expect(chart.paths.at(-1)).toEqual(chart.expected(history));
        harness.command({ type: 'snapshot' });
        harness.deliver();
        expect(chart.paths.at(-1)).toEqual(chart.expected(history));
        click('reset');
        const started = worker.postMessage.mock.calls.at(-1)![0];
        expect(started).toMatchObject({ type: 'start', settings: expected.settings, runId: 4 });
        expect(harness.save()).toEqual(new Ecosystem(expected.settings).save());
        expect(harness.tasks).toHaveLength(1);
        harness.deliver();
        expect(get('nutrients-value').textContent).toBe('7%');
        expect(get('extinction-summary').hidden).toBe(true);
        expect(steps).not.toHaveBeenCalled();
      },
    );
  }

  it('uses successful-load settings as the base beneath newer edits and clears patches for later loads', async () => {
    const harness = realWorker();
    harness.deliver();
    set('mutation', '0.31');
    const imported = nearDeath();
    imported.settings.seed = 123;
    imported.interventions.originSettings.seed = 123;
    imported.interventions.prefixSettings.seed = 123;
    await loadText(JSON.stringify(imported));
    set('nutrients', '3');
    set('nutrients', '7');
    set('climate', '0.25');
    harness.deliver();
    const expected = { ...imported.settings, nutrients: 7, climate: 0.25 };
    expect(get<HTMLInputElement>('seed').value).toBe('123');
    expect(get('world-label').textContent).toBe('WORLD 0123');
    expect(get<HTMLInputElement>('mutation').value).toBe(String(imported.settings.mutation));
    expect(get('nutrients-value').textContent).toBe('7%');
    expect(get('climate-value').textContent).toBe('25%');
    const reference = Ecosystem.load(JSON.stringify(imported));
    reference.changeSettings({ nutrients: 3 });
    reference.changeSettings({ nutrients: 7 });
    reference.changeSettings({ climate: 0.25 });
    expect(harness.save()).toEqual(reference.save());
    click('reset');
    expect(worker.postMessage.mock.calls.at(-1)![0]).toMatchObject({ settings: expected });
    harness.deliver();
    await loadText(JSON.stringify(imported));
    harness.deliver();
    expect(get('nutrients-value').textContent).toBe('0%');
    expect(get('climate-value').textContent).toBe('0%');
    expect(harness.save()).toEqual(imported);
  });

  it.each(['reset', 'load', 'dispose'])(
    'rejects delayed recovery with newer settings after %s without leaking pending edits',
    async (boundary) => {
      const harness = realWorker();
      harness.deliver();
      await loadText('{}');
      const recovery = harness.outbox.splice(0)[0];
      set('nutrients', '7');
      if (boundary !== 'dispose') {
        if (boundary === 'reset') click('reset');
        else await loadText(JSON.stringify(nearDeath()));
        expect(get('notice').textContent).toContain('capacity busy');
        worker.onmessage!({ data: recovery } as MessageEvent);
      }
      if (boundary === 'reset') click('reset');
      else if (boundary === 'load') await loadText(JSON.stringify(nearDeath()));
      else dispose();
      harness.deliver();
      const before = root.innerHTML;
      worker.onmessage!({ data: recovery } as MessageEvent);
      expect(root.innerHTML).toBe(before);
      if (boundary === 'dispose') return;
      const expected = boundary === 'reset' ? 7 : 0;
      expect(get('nutrients-value').textContent).toBe(`${expected}%`);
      expect(harness.save().settings.nutrients).toBe(expected);
      await loadText('{}');
      harness.deliver();
      expect(get('nutrients-value').textContent).toBe(`${expected}%`);
      expect(harness.save().settings.nutrients).toBe(expected);
    },
  );

  for (const cadence of [4, 12]) {
    it.each(['terminal', 'selected-pause', 'off-paused', 'enable-empty', 'off-running'])(
      `resyncs delayed %s at update ${cadence} without sampling or cadence changes`,
      async (scenario) => {
        const chart = chartRecorder();
        const harness = realWorker();
        harness.deliver();
        await loadText(JSON.stringify(nearDeath()));
        harness.deliver();
        harness.command({ type: 'inspect', x: 40, y: 40 });
        harness.deliver();
        for (let update = 2; update < cadence; update++) {
          harness.command({ type: 'snapshot' });
          harness.deliver();
        }
        const history = harness.save().telemetry.samples.map((sample) => sample.population);
        expect(chart.paths.at(-1)).toEqual(chart.expected(history));
        expect(get('inspector').textContent).toContain('Organism 1');
        if (scenario === 'selected-pause') {
          click('pause');
          harness.command({ type: 'pause-on-extinction', runId: 2, value: false });
        } else {
          if (scenario === 'enable-empty' || scenario === 'off-running')
            harness.command({ type: 'pause-on-extinction', runId: 2, value: false });
          harness.advance();
          if (scenario === 'off-paused')
            harness.command({ type: 'pause-on-extinction', runId: 2, value: false });
          if (scenario === 'enable-empty')
            harness.command({ type: 'pause-on-extinction', runId: 2, value: true });
        }
        const before = harness.save();
        const pending = harness.tasks.length;
        const held = harness.outbox.splice(0);
        const paths = chart.paths.length;
        await loadText('{}');
        expect(get<HTMLButtonElement>('capture-selected').disabled).toBe(true);
        const beforeDisplay = root.innerHTML;
        for (const data of held) worker.onmessage!({ data } as MessageEvent);
        expect(root.innerHTML).toBe(beforeDisplay);
        expect(chart.paths).toHaveLength(paths);
        expect(harness.outbox).toHaveLength(1);
        const recovery = harness.outbox[0];
        expect(recovery).toMatchObject({ type: 'error', runId: 3 });
        harness.deliver();
        expect(get('notice').textContent).toContain('Not a valid EvoLab ecosystem');
        expect(get('population').textContent).toBe(String(before.organisms.length));
        expect(get('tick').textContent).toBe(`TICK ${before.tick}`);
        expect(get<HTMLInputElement>('seed').value).toBe(String(before.settings.seed));
        expect(get('nutrients-value').textContent).toBe(`${before.settings.nutrients}%`);
        const playback = recovery.recovery.playback;
        expect(get('run-state').textContent).toBe(playback.paused ? 'PAUSED' : 'LIVE');
        expect(get('pause').textContent).toContain(playback.paused ? 'Resume' : 'Pause');
        expect(root.classList.contains('paused')).toBe(playback.paused);
        expect(get<HTMLButtonElement>('step').disabled).toBe(!playback.paused);
        expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(
          playback.pauseOnExtinction,
        );
        if (scenario === 'selected-pause') {
          expect(get('inspector').textContent).toContain('Organism 1');
          expect(get('extinction-summary').hidden).toBe(true);
        } else {
          expect(get('inspector').textContent).toContain('Click any organism');
          expect(get('lineages').textContent).toContain('quiet');
          expect(get('extinction-summary').textContent).toContain('tick 72');
          expect(get('extinction-summary').textContent).toContain('age limit');
        }
        expect(harness.save()).toEqual(before);
        expect(harness.tasks).toHaveLength(pending);
        expect(chart.paths).toHaveLength(paths + 1);
        window.dispatchEvent(new Event('resize'));
        expect(chart.paths.at(-1)).toEqual(chart.expected(history));
        harness.command({ type: 'snapshot' });
        harness.deliver();
        expect(chart.paths.at(-1)).toEqual(chart.expected(history));
        expect(get('notice').textContent).toContain('Not a valid EvoLab ecosystem');
      },
    );
  }

  it('does not prune, clear or fabricate bounded chart history on display recovery', () => {
    const chart = chartRecorder();
    const recorded = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0 }, false);
    const genome = { ...founder(0), cells: [{ x: 0, y: 0, type: 7 as const }] };
    for (let interval = 0; interval < 181; interval++) {
      recorded.paint('plant', 40, 40, 0, genome);
      for (let tick = 0; tick < 30; tick++) recorded.step();
      recorded.paint('erase', 40, 40, 0, genome);
    }
    const empty = recorded.frame();
    for (let update = 0; update < 720; update++) emit(empty);
    expect(chart.paths.at(-1)).toEqual(chart.expected(Array(180).fill(1)));
    const error = {
      type: 'error',
      message: 'Invalid terrain',
      recovery: {
        frame: empty,
        selected: null,
        settings: DEFAULTS,
        playback: {
          paused: true,
          pauseOnExtinction: true,
          extinction: { tick: 0, cause: 'empty-import' },
        },
      },
    };
    worker.emit(error);
    window.dispatchEvent(new Event('resize'));
    expect(chart.paths.at(-1)).toEqual(chart.expected(Array(180).fill(1)));
    emit(empty);
    expect(chart.paths.at(-1)).toEqual(chart.expected(Array(180).fill(1)));
    for (let tick = 0; tick < 30; tick++) recorded.step();
    emit(recorded.frame());
    expect(chart.paths.at(-1)).toEqual(chart.expected([...Array(179).fill(1), 0]));
  });

  it.each(['reset', 'load'])(
    'rejects old loaded/control/recovery/frame messages after %s and disposed recovery before every display side effect',
    async (replacement) => {
      const harness = realWorker();
      harness.deliver();
      await loadText('{}');
      const recovery = harness.outbox.splice(0)[0];
      worker.onmessage!({ data: recovery } as MessageEvent);
      if (replacement === 'reset') {
        set('seed', '99');
        click('reset');
      } else await loadText(JSON.stringify(nearDeath()));
      harness.deliver();
      const before = root.innerHTML;
      for (const data of [
        recovery,
        { type: 'loaded', runId: 2, settings: DEFAULTS, playback: recovery.recovery.playback },
        { type: 'playback', runId: 2, playback: recovery.recovery.playback },
        { type: 'frame', runId: 2, ...recovery.recovery },
      ])
        worker.onmessage!({ data } as MessageEvent);
      expect(root.innerHTML).toBe(before);
      dispose();
      worker.onmessage!({ data: { ...recovery, runId: 3 } } as MessageEvent);
      worker.onerror?.();
      expect(root.innerHTML).toBe(before);
    },
  );

  it('does not advance the response ID for local size/read failures', async () => {
    emit();
    const count = worker.postMessage.mock.calls.length;
    upload({ size: 2500001, text: async () => '{}' });
    await Promise.resolve();
    expect(get('notice').textContent).toContain('2.5 MB');
    upload({
      size: 1,
      text: async () => {
        throw new Error('File read failed');
      },
    });
    await Promise.resolve();
    expect(get('notice').textContent).toBe('File read failed');
    expect(worker.postMessage).toHaveBeenCalledTimes(count);
    const next = world.frame();
    next.stats.tick = 123;
    worker.emit({ type: 'frame', frame: next, selected: null }, 1);
    expect(get('tick').textContent).toBe('TICK 123');
  });

  it('never treats validation recovery as permission to clear a fatal STOPPED display', () => {
    emit();
    worker.emit({ type: 'error', message: 'Tick failed', fatal: true });
    const commands = worker.postMessage.mock.calls.length;
    click('pause');
    expect(worker.postMessage).toHaveBeenCalledTimes(commands);
    worker.emit({
      type: 'playback',
      playback: { paused: false, pauseOnExtinction: false, extinction: null },
    });
    worker.emit({
      type: 'error',
      message: 'Invalid world',
      recovery: {
        frame: sample,
        selected: organism,
        settings: { ...DEFAULTS, seed: 123 },
        playback: { paused: false, pauseOnExtinction: false, extinction: null },
      },
    });
    expect(get('run-state').textContent).toBe('STOPPED');
    expect(get<HTMLButtonElement>('step').disabled).toBe(true);
    expect(get<HTMLInputElement>('seed').value).toBe('42');
    expect(get('notice').textContent).toBe('Invalid world');
  });
});
describe('pixel rendering and view transforms', () => {
  it('draws functional cells, food, temperature, selection and population history', () => {
    const canvas = get<HTMLCanvasElement>('world'),
      buffer = document.createElement('canvas'),
      camera = { zoom: 1, x: 0, y: 0 };
    expect(viewport(canvas, camera).width).toBe(900);
    expect(point(canvas, camera, -1, -1)).toBeNull();
    expect(point(canvas, camera, 450, 325)).not.toBeNull();
    draw(canvas, buffer, sample, camera, false, organism.id);
    draw(canvas, buffer, sample, camera, true, 0);
    Object.defineProperty(canvas, 'clientWidth', { value: 600 });
    Object.defineProperty(canvas, 'clientHeight', { value: 400 });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 0 });
    draw(canvas, buffer, sample, camera, false, 0);
    expect(genomeSvg(founder(0))).toContain('svg');
    expect(organismHtml(null, sample)).toContain('Click any');
    expect(organismHtml(organism, sample)).toContain('Preferred');
  });
});

describe('explicit painted temperature controls and authoritative views', () => {
  it('does not let held earlier mode receipts or frames revert a newer authoritative frame', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals((data) => data.operation === 'refuge-mode');
    click('refuge-enabled');
    const firstId = [...bridge.records.keys()][0],
      earlierFrame = structuredClone(bridge.latestFrame);
    click('refuge-enabled');
    const secondId = [...bridge.records.keys()].at(-1)!;
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(false);
    expect(bridge.latestFrame.refugeModeId).toBe(secondId);
    bridge.deliver(firstId);
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(false);
    bridge.emit(earlierFrame);
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(false);
    bridge.deliver(secondId);
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(false);
    expect(bridge.records.size).toBe(0);
  });
  it('keeps authoritative mode during pending delivery, rejects wrong echoes and drains the matching owner once', () => {
    const bridge = ownershipBridge();
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(false);
    bridge.holdTerminals((data) => data.operation === 'refuge-mode');
    click('refuge-enabled');
    const [id, record] = [...bridge.records].find(
      ([, record]) => record.command.type === 'refuge-mode',
    )!;
    expect(get('refuge-pending').textContent).toContain('Pending');
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(true);
    bridge.emit({ ...record.terminal, enabled: false });
    expect(get('refuge-pending').textContent).toContain('Pending');
    bridge.deliver(id);
    expect(get('refuge-pending').textContent).toBe('');
    expect(get('notice').textContent).toContain('applied');
    bridge.holdTerminals(() => false);
    click('refuge-enabled');
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(false);
    bridge.emit(record.terminal);
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(false);
  });
  it('paints temperature independently of invalid designer anatomy and freezes each stroke configuration', () => {
    const bridge = ownershipBridge();
    click('refuge-enabled');
    root.querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!.click();
    set('brush', '1');
    set('refuge-intensity', '25');
    root.querySelector<HTMLButtonElement>('[data-tool="warm"]')!.click();
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 60, 50);
    set('refuge-intensity', '4');
    pointer('pointermove', 70, 50);
    pointer('pointerup');
    const history = bridge.latestFrame.frame.interventions.entries;
    expect(history.at(-1)).toMatchObject({
      kind: 'refuge-paint',
      detail: { rulesVersion: 1, units: 25, radius: 1, successfulCommands: 2 },
    });
    root.querySelector<HTMLButtonElement>('[data-tool="cool"]')!.click();
    pointer('pointerdown');
    pointer('pointerup');
    expect(bridge.latestFrame.frame.interventions.entries.at(-1)).toMatchObject({
      detail: { tool: 'cool', units: -4 },
    });
    root.querySelector<HTMLButtonElement>('[data-tool="erase-temperature"]')!.click();
    expect(get<HTMLInputElement>('refuge-intensity').disabled).toBe(true);
    pointer('pointerdown');
    pointer('pointerup');
    expect(bridge.latestFrame.frame.interventions.entries.at(-1)).toMatchObject({
      detail: { tool: 'erase-temperature', units: 0 },
    });
    get<HTMLInputElement>('refuge-intensity').type = 'number';
    set('refuge-intensity', '33');
    expect(get('notice').textContent).toContain('whole-number');
    expect(bridge.records.size).toBe(0);
  });
  it('retains inactive stored paint, clears only temperature and truthfully distinguishes no-op actions', () => {
    const bridge = ownershipBridge();
    click('refuge-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="warm"]')!.click();
    pointer('pointerdown');
    pointer('pointerup');
    const before = bridge.latestFrame.frame;
    click('refuge-enabled');
    expect(get('refuge-summary').textContent).toContain('Disabled · stored paint');
    const disabledTool = root.querySelector<HTMLButtonElement>('button[data-tool="warm"]')!;
    expect(disabledTool.disabled).toBe(true);
    disabledTool.disabled = false;
    disabledTool.click();
    expect(get('notice').textContent).toContain('Enable painted temperature');
    pointer('pointerdown');
    pointer('pointerup');
    expect(get('notice').textContent).toContain('disabled');
    click('clear-refuges');
    expect(get('refuge-summary').textContent).toContain('Disabled · empty');
    expect(bridge.latestFrame.frame.stats).toEqual(before.stats);
    expect(bridge.latestFrame.frame.cells).toEqual(before.cells);
    click('clear-refuges');
    expect(get('notice').textContent).toContain('unchanged');
  });
  it('restores imported mode and failed-load field atomically without posting draft intensity as settings', async () => {
    const harness = realWorker();
    harness.deliver();
    const candidate = new Ecosystem();
    candidate.changeRefugeMode(true);
    candidate.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 25 }, 120, 78);
    await loadText(JSON.stringify(candidate.save()));
    harness.deliver();
    expect(get('notice').textContent).toContain('Imported painted field');
    set('refuge-intensity', '31');
    const before = harness.save(),
      calls = worker.postMessage.mock.calls.length;
    await loadText(
      JSON.stringify({
        ...before,
        thermalRefuges: { ...before.thermalRefuges, cells: [[37440, 4]] },
      }),
    );
    harness.deliver();
    expect(harness.save()).toEqual(before);
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(true);
    expect(get<HTMLInputElement>('refuge-intensity').value).toBe('31');
    expect(worker.postMessage.mock.calls.slice(calls).map(([command]) => command.type)).toEqual([
      'load',
    ]);
    click('pause');
    harness.deliver();
    click('step');
    harness.deliver();
    candidate.step();
    expect(harness.save()).toEqual(candidate.save());
  });
  it('shares all32 manual owners and the reserved close lease without retrying rejected thermal points', () => {
    const bridge = ownershipBridge();
    click('refuge-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="warm"]')!.click();
    bridge.blockProcessing();
    pointer('pointerdown');
    for (let point = 0; point < 32; point++) pointer('pointermove', 50 + point, 50);
    pointer('pointerup');
    expect(bridge.records.size).toBe(33);
    expect(bridge.counts.M).toBe(33);
    expect(bridge.counts.C).toBe(1);
    expect(get('notice').textContent).toContain('Partial temperature stroke');
    bridge.processAll();
    expect(bridge.records.size).toBe(0);
    const count = bridge.counts.M;
    expect(get('refuge-pending').textContent).toBe('');
    expect(bridge.counts.M).toBe(count);
  });
  it('stops an injected four-command thermal UI ceiling without modifying real production limits', async () => {
    vi.resetModules();
    vi.doMock('../src/model', async (original) => ({
      ...(await original<object>()),
      STROKE_COMMAND_CAPACITY: 4,
    }));
    const { mount: boundedMount } = await import('../src/main');
    vi.doUnmock('../src/model');
    const bridge = ownershipBridge(boundedMount);
    click('refuge-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="warm"]')!.click();
    pointer('pointerdown');
    for (let command = 1; command < 4; command++) pointer('pointermove');
    pointer('pointermove');
    pointer('pointerup');
    expect(bridge.counts).toMatchObject({ M: 6, C: 1 });
    expect(bridge.latestFrame.frame.interventions.entries.at(-1).detail.successfulCommands).toBe(4);
    expect(bridge.records.size).toBe(0);
  });
  it('presents all three distinct manual thermal detail kinds without treating them as shocks', () => {
    const bridge = ownershipBridge();
    click('refuge-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="warm"]')!.click();
    pointer('pointerdown');
    pointer('pointerup');
    click('clear-refuges');
    for (const entry of bridge.latestFrame.frame.interventions.entries) {
      set('telemetry-intervention', String(entry.sequence), 'change');
      paint(0);
      const detail = get('telemetry').textContent;
      expect(detail).toContain('Rules version');
      if (entry.kind === 'refuge-paint') expect(detail).toContain('not a replay');
      if (entry.kind === 'refuge-clear') expect(detail).toContain('Mode unchanged');
    }
  });
  it('uses exact authoritative normalized anchor input in inspection and temperature pixels, preserving functional colors', () => {
    const candidate = new Ecosystem({ ...DEFAULTS, climate: 0 }, false);
    candidate.spawn(
      { cells: [{ x: 0, y: 0, type: 7 }], preference: 0.75, tolerance: 0.125, tempo: 5 },
      120,
      78,
    );
    candidate.changeRefugeMode(true);
    candidate.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 25 }, 120, 78);
    const frame = candidate.frame(),
      selected = candidate.save().organisms[0];
    expect(organismHtml(selected, frame)).toContain('0.75');
    expect(organismHtml(selected, frame)).toContain('+0.25 (25 units)');
    const canvas = get<HTMLCanvasElement>('world'),
      buffer = document.createElement('canvas'),
      context = buffer.getContext('2d')!,
      putImageData = vi.fn();
    context.putImageData = putImageData;
    draw(canvas, buffer, frame, { zoom: 1, x: 0, y: 0 }, true, 0);
    const image = putImageData.mock.calls.at(-1)![0];
    expect(Array.from(image.data.slice(0, 3))).toEqual([28, 31, 40]);
    const position = (78 * 240 + 120) * 4;
    expect(Array.from(image.data.slice(position, position + 3))).not.toEqual([37, 25, 30]);
    candidate.changeRefugeMode(false);
    expect(organismHtml(selected, candidate.frame())).toContain('0 (0 units)');
  });
});
