import { emptyShade, shadeSummary, selectedLeafLight } from '../src/shade';
import { newController } from '../src/neural';
import { checkpointRecord } from '../src/checkpoints';
import { createComparison } from '../src/experiments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, captureCommand } from '../src/main';
import * as model from '../src/model';
import { draw, genomeSvg, organismHtml, point, viewport } from '../src/view';
import * as viewModule from '../src/view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULT_TERRAIN } from '../src/terrain';
import { DEFAULTS, founder, type Frame, type PlaybackState, type WorldFile } from '../src/model';
import { parseBlueprint, serializeBlueprint, BLUEPRINT_MAX_BYTES } from '../src/blueprint';
import { startWorker, type Scope } from '../src/worker';
import { emptyRefuges, refugeSummary, activeRefugeUnits, localTemperature } from '../src/refuges';
import { legacyV3, legacyV7 } from './fixtures/telemetry';
import { storedSensoryGenome } from './fixtures/sensory-legacy';
import { libraryHarness } from './fixtures/library';
import { classifyRecord, encodeRecord, libraryCandidate } from '../src/library';
class WorkerStub extends EventTarget {
  playback: PlaybackState = { paused: false, pauseOnExtinction: true, extinction: null };
  pendingCommand: any;
  commands = vi.fn((data: any) => {
    this.pendingCommand = data;
  });
  revision = 0;
  sequence = 0;
  progressSequence = 0;
  state: any;
  display = { epoch: 0, enabled: true, visible: true };
  fixture: Frame | undefined;
  postMessage = vi.fn((data: any) => {
    if (data.type === 'flow-ack') return;
    this.commands(data);
    if (data.type === 'load' || data.type === 'save' || data.type === 'export-measurements') return;
    if (data.type === 'pause' || data.type === 'resume')
      this.playback = { ...this.playback, paused: data.type === 'pause' };
    if (data.type === 'pause-on-extinction')
      this.playback = { ...this.playback, pauseOnExtinction: data.value };
    if (data.type === 'capture-design') {
      const source =
        data.source === 'organism'
          ? this.state?.selected
          : (this.fixture ?? sample).stats.top.find((value) => value.id === data.sourceId);
      if (source) this.emit({ type: 'design-captured', genome: structuredClone(source.genome) });
      else this.emit({ type: 'error', message: 'The design source is no longer alive.' });
      return;
    }
    if (data.type === 'display-view') this.display = { ...data.view };
    if (data.type === 'start') {
      this.display = { ...data.display };
      this.fixture = sample;
    }
    this.emit({
      type: 'control',
      settings:
        data.type === 'start'
          ? data.settings
          : data.type === 'settings'
            ? { ...this.state.settings, ...data.settings }
            : this.state?.settings,
      speed: data.type === 'speed' ? data.value : this.state?.speed,
    });
  });
  terminate = vi.fn();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  emit(fixture: any, run?: number): void {
    if (fixture.state || fixture.recovery?.state) {
      this.onmessage?.({ data: fixture } as MessageEvent);
      return;
    }
    const command = this.commands.mock.calls.at(-1)?.[0];
    const runId = run ?? command?.runId ?? 1;
    const frame = fixture.frame ?? this.fixture ?? sample;
    if (fixture.frame) this.fixture = fixture.frame;
    if (fixture.playback) this.playback = fixture.playback;
    const state = {
      replacementId:
        fixture.type === 'loaded' || command?.type === 'start'
          ? command.commandId
          : (this.state?.replacementId ?? 1),
      revision: ++this.revision,
      world: {
        mutationPolicy: { version: 1, mode: 'legacy' },
        lineage: fixture.lineage ?? world.presentation(0, true).lineage,
        stats: frame.stats,
        climate: frame.climate,
        offset: frame.offset,
        terrain: frame.terrain ?? DEFAULT_TERRAIN,
        thermalRefuges: refugeSummary(frame.thermalRefuges ?? emptyRefuges()),
        shadeHabitats: shadeSummary(frame.shadeHabitats ?? emptyShade()),
        selectedLeafLight: selectedLeafLight(
          frame.shadeHabitats ?? emptyShade(),
          fixture.selected ?? null,
        ),
        anchorTemperature: fixture.selected
          ? localTemperature(
              fixture.selected.x,
              fixture.selected.y,
              frame.stats.tick,
              frame.climate,
              frame.offset,
              frame.thermalRefuges ?? emptyRefuges(),
            )
          : null,
        anchorRefugeUnits: fixture.selected
          ? activeRefugeUnits(
              frame.thermalRefuges ?? emptyRefuges(),
              fixture.selected.x,
              fixture.selected.y,
            )
          : 0,
      },
      selected:
        fixture.selected === undefined
          ? command?.type === 'start' || fixture.type === 'loaded'
            ? null
            : (this.state?.selected ?? null)
          : fixture.selected,
      settings: fixture.settings ?? this.state?.settings ?? DEFAULTS,
      speed: fixture.speed ?? this.state?.speed ?? 4,
      playback: this.playback,
      target: null,
      display: this.display,
      rate: {
        value: null,
        elapsedMs: 0,
        completedTicks: 0,
        context: 'visible',
        status: this.playback.paused ? 'paused' : 'warming',
      },
    };
    this.state = state;
    const telemetry = {
      revision: state.revision,
      tick: frame.stats.tick,
      telemetry: frame.telemetry,
      interventions: frame.interventions,
    };
    let data: any;
    if (fixture.type === 'frame')
      data = {
        type: 'frame',
        runId,
        sequence: ++this.sequence,
        viewEpoch: this.display.epoch,
        state,
        frame: {
          ...state.world,
          cells: frame.cells,
          ids: frame.ids,
          thermalRefuges: frame.thermalRefuges ?? emptyRefuges(),
          shadeHabitats: frame.shadeHabitats ?? emptyShade(),
        },
        selectedId: state.selected?.id ?? 0,
      };
    else if (fixture.type === 'error')
      data = {
        type: 'error',
        runId,
        commandId: fixture.fatal && !this.pendingCommand ? undefined : command?.commandId,
        code: fixture.fatal ? 'fatal' : 'load-failed',
        message: fixture.message,
        ...(fixture.fatal ? { fatal: true } : {}),
        ...(fixture.recovery
          ? {
              recovery: {
                state: {
                  ...state,
                  world: {
                    mutationPolicy: { version: 1, mode: 'legacy' },
                    lineage: world.presentation(0, true).lineage,
                    stats: fixture.recovery.frame.stats,
                    climate: fixture.recovery.frame.climate,
                    offset: fixture.recovery.frame.offset,
                    terrain: fixture.recovery.frame.terrain,
                    thermalRefuges: refugeSummary(fixture.recovery.frame.thermalRefuges),
                    shadeHabitats: shadeSummary(fixture.recovery.frame.shadeHabitats),
                    selectedLeafLight: null,
                    anchorTemperature: null,
                    anchorRefugeUnits: 0,
                  },
                  selected: fixture.recovery.selected,
                  settings: fixture.recovery.settings,
                  playback: fixture.recovery.playback,
                },
                telemetry: { ...telemetry, telemetry: fixture.recovery.frame.telemetry },
              },
            }
          : {}),
      };
    else if (fixture.type === 'design-captured')
      data = {
        ...fixture,
        type: 'design-captured',
        operation: 'capture-design',
        state,
        runId,
        commandId: command?.commandId,
        completedTick: state.world.stats.tick,
        seed: state.settings.seed,
        source: command.source,
        sourceId: command.sourceId,
        captureId: command.captureId,
      };
    else if (fixture.type === 'saved')
      data = {
        type: 'saved',
        runId,
        commandId: command?.commandId,
        state,
        text: fixture.text,
        completedTick: state.world.stats.tick,
        seed: state.settings.seed,
        byteLength: new TextEncoder().encode(fixture.text).byteLength,
      };
    else if (fixture.type === 'playback' && !this.pendingCommand)
      data = { type: 'progress', runId, sequence: ++this.progressSequence, state, telemetry };
    else
      data = {
        type:
          fixture.type === 'loaded'
            ? 'loaded'
            : ['begin-stroke', 'end-stroke', 'paint', 'settings', 'shock'].includes(command?.type)
              ? 'manual-result'
              : 'control',
        ...(command?.type ? { operation: command.type } : {}),
        ...(command?.strokeId === undefined ? {} : { strokeId: command.strokeId }),
        status: 'no-op',
        completedTick: state.world.stats.tick,
        rowSequence: null,
        runId,
        commandId: command?.commandId,
        state,
        telemetry,
      };
    if (data.commandId !== undefined) {
      data.operation = command?.type;
      this.pendingCommand = null;
    }
    this.onmessage?.({ data } as MessageEvent);
    if (fixture.type === 'frame')
      this.onmessage?.({
        data: { type: 'progress', runId, sequence: ++this.progressSequence, state, telemetry },
      } as MessageEvent);
  }
}
let root: HTMLDivElement, worker: WorkerStub, dispose: () => void, paint: FrameRequestCallback;
const world = new Ecosystem(),
  sample = world.frame(),
  organism = [...world.organisms.values()][0];
const get = <T extends HTMLElement>(id: string): T => {
  const element = root.ownerDocument.getElementById(id);
  return element && element !== root && root.contains(element)
    ? (element as T)
    : root.querySelector<T>(`#${id}`)!;
};
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
function realWorker(clean = false, renderHabitat = true) {
  if (clean) {
    dispose();
    worker = new WorkerStub();
  }
  const tasks: (() => void)[] = [],
    outbox: any[] = [];
  let commandId = 0,
    currentRun = 1,
    time = 0;
  const identities = new Map<number, number>();
  const direct = new WeakSet<object>();
  let gridTransfers = 0;
  const scope: Scope = {
    onmessage: null,
    postMessage: (data, transfer = []) => {
      if (data.type === 'frame') gridTransfers += transfer.length;
      const response: any = structuredClone(data, { transfer });
      if ('commandId' in response) {
        const pageId = identities.get(response.commandId);
        identities.delete(response.commandId);
        if (pageId !== undefined) response.commandId = pageId;
        else direct.add(response);
      }
      outbox.push(response);
    },
  };
  startWorker(
    scope,
    (callback) => tasks.push(callback),
    () => time,
  );
  const command = (data: any, page = false) => {
    if (!page && data.type === 'snapshot') {
      click('refresh-habitat');
      return;
    }
    if (!page && data.type === 'pause-on-extinction') {
      get<HTMLInputElement>('pause-on-extinction').checked = data.value;
      get('pause-on-extinction').dispatchEvent(new Event('change'));
      return;
    }
    if (!page && data.type === 'inspect') {
      root.querySelector<HTMLButtonElement>('[data-tool="inspect"]')!.click();
      const canvas = get<HTMLCanvasElement>('world'),
        view = viewport(canvas, { zoom: 1, x: 0, y: 0 });
      pointer(
        'pointerdown',
        view.left + (data.x + 0.5) * view.scale,
        view.top + (data.y + 0.5) * view.scale,
      );
      window.dispatchEvent(new Event('pointerup'));
      return;
    }
    if (data.type === 'flow-ack') {
      scope.onmessage!({ data } as MessageEvent);
      return;
    }
    if (data.type === 'start' || data.type === 'load') currentRun = data.runId;
    const identity = ++commandId;
    if (page) identities.set(identity, data.commandId);
    scope.onmessage!({
      data: {
        ...(data.type === 'snapshot' ? { display: true } : {}),
        ...data,
        commandId: identity,
        runId: data.runId ?? currentRun,
      },
    } as MessageEvent);
  };
  const initial = clean ? undefined : worker.commands.mock.calls[0][0];
  worker.postMessage.mockImplementation((data) => {
    if (data.type !== 'flow-ack') worker.commands(data);
    command(data, true);
  });
  if (initial) command(initial, true);
  else dispose = mount(root, worker as unknown as Worker, renderHabitat);
  const deliver = () => {
    let deliveries = 0;
    while (outbox.length) {
      if (++deliveries > 100) throw new Error('Unbounded message pump.');
      const data = outbox.shift()!;
      if (!direct.has(data)) worker.onmessage!({ data } as MessageEvent);
    }
  };
  const save = (): WorldFile => {
    command({ type: 'save' });
    const saved = outbox.findLastIndex((data) => data.type === 'saved');
    return JSON.parse(outbox.splice(saved, 1)[0].text);
  };
  return {
    tasks,
    outbox,
    command,
    deliver,
    save,
    gridTransfers: () => gridTransfers,
    advance: () => {
      time += 40;
      tasks.shift()!();
    },
  };
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
    latestFrame: any,
    latestSource: any;
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
      if ('telemetry' in data) latestSource = data.telemetry;
      if (data.type === 'error' && data.recovery) latestSource = data.recovery.telemetry;
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
      return (
        latestFrame && {
          ...latestFrame,
          frame: {
            ...latestFrame.frame,
            telemetry: latestSource?.telemetry,
            interventions: latestSource?.interventions,
          },
        }
      );
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
      const presentation = Ecosystem.prototype.presentation;
      vi.spyOn(Ecosystem.prototype, 'presentation').mockImplementation(function (this: Ecosystem) {
        currentWorld = this;
        return presentation.call(this);
      });
      const bridge = ownershipBridge(mount, (data) => {
        if (targetId && data.commandId === targetId) {
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
      paint(0);
      paint(0);
      expect(bridge.callbackCount).toBe(0);
      const candidate = new Ecosystem({ ...DEFAULTS, seed: 73, nutrients: 0 }, false);
      if (operation === 'paint-refuge' || operation === 'clear-refuges') {
        click('refuge-enabled');
        if (operation === 'clear-refuges') {
          root.querySelector<HTMLButtonElement>('[data-tool="warm"]')!.click();
          pointer('pointerdown', 50, 50);
          pointer('pointerup');
        }
      }
      paint(0);
      paint(0);
      paint(0);
      let reference = Ecosystem.load(JSON.stringify(currentWorld.save()));
      const post = bridge.endpoint.postMessage;
      let command: any;
      vi.spyOn(bridge.endpoint, 'postMessage').mockImplementation((data: any) => {
        if (!targetId && data.type === operation) {
          targetId = data.commandId;
          command = structuredClone(data);
        }
        post(data);
      });
      bridge.holdTerminals((data) => data.operation === operation);
      if (operation === 'start') click('reset');
      else if (operation === 'load') await loadText(JSON.stringify(candidate.save()));
      else if (operation === 'settings') set('nutrients', '7');
      else if (operation === 'refuge-mode') click('refuge-enabled');
      else if (operation === 'clear-refuges') click('clear-refuges');
      else if (operation === 'shock')
        root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
      else {
        root
          .querySelector<HTMLButtonElement>(
            `[data-tool="${operation === 'paint-refuge' ? 'warm' : 'food'}"]`,
          )!
          .click();
        pointer('pointerdown', 50, 50);
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
      expect(bridge.records.size).toBe(1);
      if (operation === 'start') reference = new Ecosystem(command.settings);
      else if (operation === 'load') reference = candidate;
      else if (operation === 'settings') reference.changeSettings(command.settings);
      else if (operation === 'paint') {
        const outcome = reference.paint(
          command.tool,
          command.x,
          command.y,
          command.radius,
          command.genome,
        );
        reference.recordPaint(outcome, command.tool, command.radius, command.x, command.y, null);
      } else if (operation === 'refuge-mode') reference.changeRefugeMode(command.enabled);
      else if (operation === 'clear-refuges') reference.clearRefuges();
      else if (operation === 'paint-refuge')
        reference.paintRefuge(
          { rulesVersion: 1, tool: command.tool, radius: command.radius, units: command.units },
          command.x,
          command.y,
        );
      else {
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
      }
      expect(currentWorld.save()).toEqual(reference.save());
      bridge.deliver(targetId);
      expect(get('run-state').textContent).toBe('STOPPED');
      expect(bridge.records.size).toBe(0);
      targetId = 0;
      vi.mocked(bridge.endpoint.postMessage).mockRestore();
      bridge.holdTerminals(() => false);
      await loadText('{}');
      expect(get('run-state').textContent).toBe('PAUSED');
      expect(get('notice').textContent).toContain('Not a valid');
      expect(bridge.callbackCount).toBe(0);
      expect(currentWorld.save()).toEqual(reference.save());
      expect(get<HTMLButtonElement>('measurements-json').disabled).toBe(false);
      expect(get<HTMLButtonElement>('save').disabled).toBe(false);
      if (!reference.organisms.size) {
        get<HTMLInputElement>('pause-on-extinction').checked = false;
        get('pause-on-extinction').dispatchEvent(new Event('change'));
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
  it('reserves close inside30 general places through saturation, Pause, view disable, fatal stop and explicit replacement', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
    pointer('pointerdown');
    const begin = [...bridge.records.keys()][0];
    for (let point = 0; point < 40; point++) pointer('pointermove', 151 + point, 150);
    pointer('pointerup');
    click('pause');
    get<HTMLInputElement>('render-habitat').checked = false;
    get('render-habitat').dispatchEvent(new Event('change'));
    expect(bridge.records.size).toBe(1);
    expect(bridge.records.get(begin)!.command.type).toBe('begin-stroke');
    expect(bridge.counts.C).toBe(0);
    bridge.emit({ type: 'error', runId: 1, fatal: true, message: 'injected independent fatal' });
    expect(get('run-state').textContent).toBe('STOPPED');
    click('reset');
    bridge.deliver(begin);
    const close = [...bridge.records.keys()][0];
    expect(bridge.records.get(close)!.command.type).toBe('end-stroke');
    expect(bridge.counts.L).toBe(1);
    bridge.deliver(close);
    const start = [...bridge.records.keys()][0];
    expect(bridge.records.get(start)!.command).toMatchObject({
      type: 'start',
      display: { enabled: false },
    });
    bridge.deliverAll();
    expect(bridge.counts.C).toBe(1);
    expect(bridge.counts.maximum).toBe(1);
    expect(bridge.latestFrame.frame.interventions.entries).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it.each(['save', 'export-measurements'])(
    'keeps the %s subtype fenced through exact delivery and URL cleanup',
    (operation) => {
      vi.useFakeTimers();
      const bridge = ownershipBridge();
      bridge.holdTerminals();
      const id = operation === 'save' ? 'save' : 'measurements-json';
      click(id);
      const owner = [...bridge.records.keys()][0];
      get(id).dispatchEvent(new Event('click'));
      expect(get('notice').textContent).toContain('earlier download');
      expect(bridge.records.size).toBe(1);
      bridge.deliver(owner);
      get(id).dispatchEvent(new Event('click'));
      expect(get('notice').textContent).toContain('earlier download');
      expect(bridge.records.size).toBe(0);
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      click(id);
      expect(bridge.records.size).toBe(1);
      bridge.deliverAll();
      expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['start', 'load'])(
    'retires both native URL leases only when queued %s actually posts after the predecessor',
    async (operation) => {
      vi.useFakeTimers();
      const bridge = ownershipBridge();
      vi.mocked(URL.createObjectURL)
        .mockReturnValueOnce('blob:save')
        .mockReturnValueOnce('blob:export');
      click('save');
      click('measurements-json');
      expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
      bridge.holdTerminals();
      set('nutrients', '7');
      if (operation === 'start') click('reset');
      else await loadText(JSON.stringify(new Ecosystem().save()));
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      expect(bridge.records.size).toBe(1);
      bridge.deliverAll();
      expect(URL.revokeObjectURL.mock.calls).toEqual([['blob:save'], ['blob:export']]);
      expect(bridge.records.size).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
      expect(get<HTMLButtonElement>('save').disabled).toBe(false);
      expect(get<HTMLButtonElement>('measurements-json').disabled).toBe(false);
    },
  );
  it('retires both completed URL leases once on independent fatal without refunding a posted owner', () => {
    vi.useFakeTimers();
    const bridge = ownershipBridge();
    click('save');
    click('measurements-json');
    bridge.holdTerminals();
    set('nutrients', '7');
    const owner = [...bridge.records.keys()][0],
      terminal = bridge.records.get(owner)!.terminal;
    bridge.emit({
      type: 'error',
      runId: terminal.runId,
      code: 'fatal',
      fatal: true,
      message: 'fault',
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(bridge.records.size).toBe(1);
    expect(bridge.records.has(owner)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    bridge.deliverAll();
    expect(bridge.records.size).toBe(0);
    expect(get('run-state').textContent).toBe('STOPPED');
  });
  it.each(['start', 'load'])(
    'D9-A10 proven nonposted %s preserves the retained world after predecessor downloads finish',
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
      const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      if (operation === 'load') await loadText('{}');
      bridge.deliverAll();
      expect(anchor).toHaveBeenCalledTimes(2);
      if (operation === 'start') click('reset');
      expect(bridge.counts.L).toBe(1);
      expect(bridge.records.size).toBe(0);
      expect(bridge.counts.terminated).toBe(0);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      expect(get('notice').textContent).toContain('No automatic retry');
      expect(get('run-state').textContent).toBe('PAUSED');
    },
  );
  it('retains successful predecessor settings and exact ecology when queued reseed is proven not posted', async () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals((data) => data.operation === 'settings');
    set('nutrients', '11');
    const id = [...bridge.records.keys()][0];
    const post = bridge.endpoint.postMessage;
    vi.spyOn(bridge.endpoint, 'postMessage').mockImplementation((data: any) => {
      if (data.type === 'start') throw new DOMException('proven nonpost', 'DataCloneError');
      post(data);
    });
    click('reset');
    bridge.deliver(id);
    expect(get<HTMLInputElement>('nutrients').value).toBe('11');
    expect(get('nutrients-value').textContent).toBe('11%');
    expect(get('run-state').textContent).toBe('PAUSED');
    expect(get('notice').textContent).toContain('No automatic retry');
    expect(bridge.records.size).toBe(0);
    bridge.holdTerminals(() => false);
    click('save');
    const reference = new Ecosystem();
    reference.changeSettings({ nutrients: 11 });
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(text).toBe(JSON.stringify(reference.save()));
    expect(bridge.latestFrame.state.settings.nutrients).toBe(11);
  });
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
    expect([...current.records.keys()][0]).toBe(receipt.commandId);
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
    if (failure === 'lifecycle') record.terminal.state.settings.seed = -1;
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
    if (failure === 'lifecycle')
      expect(get('notice').textContent).toContain('Invalid lifecycle terminal');
    if (failure === 'manual')
      expect(get<HTMLInputElement>('nutrients').value).toBe(String(DEFAULTS.nutrients));
    if (failure === 'rejected')
      expect(get<HTMLInputElement>('nutrients').value).toBe(
        String(record.terminal.state.settings.nutrients),
      );
    if (failure === 'rejected') expect(get('notice').textContent).toContain('Worker rejected');
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
    const before = bridge.counts.M;
    root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
    get('world').dispatchEvent(new MouseEvent('pointerdown', { button: 2 }));
    expect(bridge.counts.M).toBe(before);
    pointer('pointerdown');
    pointer('pointerdown');
    for (let command = 1; command < 4; command++) pointer('pointermove');
    pointer('pointermove');
    pointer('pointerup');
    expect(bridge.counts).toMatchObject({ M: before + 5, C: 1 });
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
    expect(get('notice').textContent).toContain('Session counter exhausted');
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
  it('D9-A1 reserves C inside30 pending places, stalls processing and rejects256 replacement refills under36 owners', async () => {
    const bridge = ownershipBridge();
    bridge.blockProcessing();
    saturate();
    expect(bridge.records.size).toBe(1);
    expect(bridge.counts).toMatchObject({ E: 1, S: 0, C: 0, L: 1 });
    click('reset');
    const admitted = { ...bridge.counts };
    for (let attempt = 0; attempt < 256; attempt++) {
      click('reset');
      await loadText('{"invalid":true}');
      click('measurements-csv');
      click('save');
      pointer('pointerdown');
      pointer('pointerup');
      expect(bridge.records.size).toBe(1);
      expect(bridge.counts).toEqual(admitted);
    }
    bridge.processAll();
    expect(bridge.records.size).toBe(0);
    expect(bridge.latestFrame.frame.stats.tick).toBe(0);
    expect(bridge.latestFrame.frame.interventions.entries).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(get<HTMLButtonElement>('save').disabled).toBe(false);
    expect(bridge.counts.maximum).toBe(1);
    expect(bridge.counts.maximum).toBeLessThanOrEqual(36);
  });
  it('D9-A2 holds real serialized results across256 successful and failed replacement barriers without refilling', async () => {
    // Own the actual download lease timers. Keep this fixture's deliberately
    // held RAF callback: fake-clock advancement must not introduce 60 native
    // rendering turns per barrier that this ownership test never requested.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bridge = ownershipBridge(),
      captures = vi.spyOn(Ecosystem.prototype, 'measurements'),
      saves = vi.spyOn(Ecosystem.prototype, 'save');
    bridge.holdTerminals((data) => ['save', 'export-measurements'].includes(data.operation));
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    for (let replacement = 0; replacement < 256; replacement++) {
      const operation = replacement % 2 ? 'save' : 'export-measurements';
      click(operation === 'save' ? 'save' : 'measurements-json');
      const [id, record] = [...bridge.records][0];
      expect(record.command.type).toBe(operation);
      const lifecycle = bridge.counts.L;
      if (replacement % 2) await loadText('{"invalid":true}');
      else click('reset');
      for (let refill = 0; refill < 2; refill++) {
        click('measurements-json');
        click('measurements-csv');
        click('save');
        pointer('pointerdown');
        pointer('pointerup');
        set('nutrients', '11');
      }
      expect(bridge.records.size).toBe(1);
      expect(bridge.counts.L).toBe(lifecycle);
      expect(bridge.records.get(id)).toBe(record);
      bridge.deliverAll();
      expect(bridge.counts.L).toBe(lifecycle + 1);
      expect(bridge.records.size).toBe(0);
      vi.advanceTimersByTime(1000);
    }
    expect(bridge.counts).toMatchObject({ E: 128, S: 128, L: 257, maximum: 1 });
    expect(captures).toHaveBeenCalledTimes(128);
    expect(saves).toHaveBeenCalledTimes(128);
    expect(anchor).toHaveBeenCalledTimes(128);
    expect(bridge.counts.maximum).toBeLessThanOrEqual(36);
  });
  it.each(
    ['reset', 'valid-load', 'invalid-last-log', 'same-tick-failure'].flatMap((replacement) =>
      ['old-first', 'lifecycle-first'].map((order) => ({ replacement, order })),
    ),
  )(
    'D9-A3/A8 drains predecessor E/S/M/C before %j without stale effects or a scheduler wake',
    async ({ replacement, order }) => {
      vi.useFakeTimers();
      const bridge = ownershipBridge();
      bridge.advance();
      paint(0);
      bridge.holdTerminals();
      root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
      pointer('pointerdown');
      pointer('pointerup');
      const first = [...bridge.records.keys()][0];
      click('measurements-json');
      click('save');
      set('nutrients', '7');
      root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
      const initialLifecycle = bridge.counts.L;
      if (replacement === 'reset') click('reset');
      else {
        const candidate = new Ecosystem();
        if (replacement === 'invalid-last-log') {
          candidate.changeSettings({ nutrients: 7 });
          const file = candidate.save();
          file.interventions.entries[0].sequence = 2;
          await loadText(JSON.stringify(file));
        } else
          await loadText(replacement === 'valid-load' ? JSON.stringify(candidate.save()) : '{}');
      }
      expect(bridge.counts.L).toBe(initialLifecycle);
      expect(bridge.records.size).toBe(1);
      if (order === 'lifecycle-first') {
        const before = get('notice').textContent;
        bridge.emit({
          ...bridge.records.get(first)!.terminal,
          type: 'loaded',
          operation: 'load',
          commandId: first + 100,
        });
        expect(bridge.records.size).toBe(1);
        expect(get('notice').textContent).toBe(before);
      }
      bridge.deliverAll();
      expect(bridge.counts.L).toBe(initialLifecycle + 1);
      expect(bridge.records.size).toBe(0);
      expect(bridge.callbackCount).toBe(
        replacement === 'reset' || replacement === 'valid-load' ? 1 : 0,
      );
      if (replacement === 'reset' || replacement === 'valid-load')
        expect(bridge.latestFrame.frame.interventions.entries).toEqual([]);
      else
        expect(
          bridge.latestFrame.frame.interventions.entries.map((entry: any) => entry.kind),
        ).toEqual(['paint', 'settings', 'shock']);
      expect(URL.createObjectURL).toHaveBeenCalledTimes(replacement === 'reset' ? 0 : 2);
      vi.advanceTimersByTime(1000);
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
    expect(bridge.counts.L).toBe(1);
    bridge.deliverAll();
    click('measurements-csv');
    const current = [...bridge.records.keys()][0],
      receipt = bridge.records.get(current)!.terminal;
    for (const wrong of [
      old,
      { ...old, type: 'error', message: 'obsolete error' },
      { ...receipt, operation: 'save' },
      { ...receipt, format: 'json' },
      { ...receipt, runId: receipt.runId - 1 },
      { ...receipt, commandId: current + 100 },
      { ...receipt, requestId: current },
      { ...receipt, strokeId: 1 },
      { type: 'frame', runId: receipt.runId - 1 },
      null,
    ])
      bridge.emit(wrong);
    expect(bridge.records.size).toBe(1);
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
      vi.useFakeTimers();
      const bridge = ownershipBridge(),
        operation = target === 'placement' ? 'paint' : target;
      bridge.holdTerminals((data) => data.operation === operation);
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      async function action() {
        if (target === 'export-measurements') click('measurements-json');
        else if (target === 'save') click('save');
        else if (target === 'start') click('reset');
        else if (target === 'load') await loadText(JSON.stringify(new Ecosystem().save()));
        else if (target === 'settings')
          set('nutrients', get<HTMLInputElement>('nutrients').value === '7' ? '3' : '7');
        else if (target === 'shock')
          root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
        else {
          root
            .querySelector<HTMLButtonElement>(
              '[data-tool="' + (target === 'placement' ? 'plant' : 'food') + '"]',
            )!
            .click();
          pointer('pointerdown', 50, 50);
          pointer('pointerup');
        }
      }
      await action();
      const first = [...bridge.records.keys()][0],
        old = bridge.records.get(first)!.terminal;
      bridge.deliverAll();
      vi.advanceTimersByTime(1000);
      await action();
      const id = [...bridge.records.keys()][0],
        receipt = bridge.records.get(id)!.terminal;
      for (const wrong of [
        old,
        { ...old, type: 'error', message: 'duplicate error' },
        {
          ...old,
          type: 'error',
          fatal: true,
          message: 'stale correlated fatal',
          runId: receipt.runId,
        },
        { ...receipt, operation: operation === 'save' ? 'export-measurements' : 'save' },
        { ...receipt, operation: undefined },
        { ...receipt, runId: receipt.runId - 1 },
        { ...receipt, format: receipt.format === 'csv' ? 'json' : 'csv' },
        { ...receipt, strokeId: 999 },
        { ...receipt, commandId: undefined },
        { ...receipt, requestId: id },
        { ...receipt, commandId: id + 1000 },
        ...['snapshot', 'progress', 'flow-ack'].map((type) => ({
          type,
          runId: receipt.runId,
          commandId: id,
        })),
      ]) {
        bridge.emit(wrong);
        expect(bridge.records.get(id)?.terminal).toBe(receipt);
        expect(get('run-state').textContent).not.toBe('STOPPED');
      }
      const posts = { ...bridge.counts };
      for (let entry = 0; entry < 31; entry++) set('nutrients', entry % 2 ? '1' : '2');
      expect(bridge.records.size).toBe(1);
      expect(bridge.counts).toEqual(posts);
      bridge.deliverAll();
      expect(bridge.records.size).toBe(0);
      expect(bridge.counts.maximum).toBeLessThanOrEqual(36);
    },
  );
  it.each(['end-first', 'paint-first'])(
    'D9-A5 keeps paint and reserved C independent under attempted %s delivery',
    (order) => {
      const bridge = ownershipBridge();
      bridge.holdTerminals();
      root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
      pointer('pointerdown');
      pointer('pointerup');
      const begin = [...bridge.records.keys()][0];
      bridge.deliver(begin);
      const paintId = [...bridge.records.keys()][0],
        receipt = bridge.records.get(paintId)!.terminal;
      if (order === 'end-first')
        bridge.emit({ ...receipt, operation: 'end-stroke', commandId: paintId + 1 });
      pointer('pointerdown', 170, 150);
      pointer('pointerup');
      expect(bridge.records.size).toBe(1);
      expect(bridge.counts.C).toBe(0);
      bridge.deliver(paintId);
      const end = [...bridge.records.keys()][0];
      expect(bridge.records.get(end)!.command.type).toBe('end-stroke');
      bridge.emit(receipt);
      pointer('pointerdown', 170, 150);
      pointer('pointerup');
      expect(bridge.counts.C).toBe(1);
      bridge.deliver(end);
      pointer('pointerdown', 170, 150);
      pointer('pointerup');
      bridge.deliverAll();
      expect(bridge.records.size).toBe(0);
      expect(bridge.counts.C).toBe(2);
      expect(bridge.counts.M).toBe(5);
      expect(bridge.latestFrame.frame.interventions.entries.length).toBe(2);
    },
  );
  it('D9-A6/A7 keeps fatal-flagged native work charged until exact results or actual endpoint termination', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    saturate();
    bridge.emit({ type: 'error', runId: 1, fatal: true, message: 'injected tick failure' });
    expect(bridge.records.size).toBe(1);
    click('reset');
    expect(bridge.records.size).toBe(1);
    expect(bridge.counts.L).toBe(1);
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
      get: (target, property) => {
        if (!(property in target)) Reflect.set(target, property, vi.fn());
        return Reflect.get(target, property);
      },
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
describe('owned command admission and real-worker interleavings', () => {
  it('nutrient reseed freezes opt-in and exposes observational fields without editing ecology', () => {
    const harness = realWorker();
    harness.deliver();
    click('pause');
    harness.deliver();
    expect(harness.save().nutrientCycle).toBeNull();
    get<HTMLInputElement>('nutrient-next').checked = true;
    get('reset').click();
    expect(get('reset-payload').textContent).toContain('finite 149760 N');
    get<HTMLInputElement>('nutrient-next').checked = false;
    get('confirm-reset').click();
    harness.deliver();
    click('pause');
    harness.deliver();
    paint(0);
    harness.deliver();
    const before = harness.save();
    expect(before.nutrientCycle).not.toBeNull();
    expect(get('nutrient-summary').textContent).toContain('149760/149760 N');
    for (const layer of ['minerals', 'detritus', 'none']) {
      set('nutrient-layer', layer, 'change');
      paint(1);
      harness.deliver();
    }
    set('nutrient-x', '120');
    set('nutrient-y', '78');
    expect(get('nutrient-cell').textContent).toContain('mineral N');
    set('nutrient-x', '-1');
    expect(get('nutrient-cell').textContent).toContain('whole-number');
    expect(harness.save()).toEqual(before);
    click('step');
    harness.deliver();
    paint(2);
    harness.deliver();
    expect(get('nutrient-summary').textContent).toContain('Last completed tick');
    expect(() =>
      captureCommand(
        {
          type: 'start',
          settings: DEFAULTS,
          terrain: DEFAULT_TERRAIN,
          display: { epoch: 0, enabled: true, visible: true },
          nutrientCycle: 'true',
        },
        DEFAULTS,
      ),
    ).toThrow();
  });
  it('owns event recording, replay evidence, busy requests and failed capture without touching the sandbox', () => {
    expect(() => captureCommand({ type: 'event-recording', enabled: 1 }, DEFAULTS)).toThrow();
    expect(() => captureCommand({ type: 'event-replay', eventId: 0 }, DEFAULTS)).toThrow();
    const bridge = realWorker();
    bridge.deliver();
    root.querySelector<HTMLButtonElement>('#pause')!.click();
    bridge.deliver();
    const before = bridge.save();
    root.querySelector<HTMLButtonElement>('#event-record')!.click();
    bridge.deliver();
    expect(root.querySelector('#event-window')!.textContent).toContain('Recording since');
    const endpoint = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
      onmessageerror: null,
    };
    vi.stubGlobal(
      'Worker',
      vi.fn(function () {
        return endpoint;
      }),
    );
    root.querySelector<HTMLButtonElement>('#event-open')!.click();
    bridge.deliver();
    expect(endpoint.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start' }));
    expect(bridge.save()).toEqual(before);
    root.querySelector<HTMLButtonElement>('#event-cancel')!.click();
    root.querySelector<HTMLButtonElement>('#event-open')!.click();
    root.querySelector<HTMLButtonElement>('#event-open')!.click();
    expect(root.querySelector('#event-status')!.textContent).toContain('busy');
    bridge.deliver();
    root.querySelector<HTMLButtonElement>('#event-open')!.click();
    const response = bridge.outbox.find((message) => message.type === 'event-evidence');
    response.type = 'error';
    response.message = 'Evidence evicted';
    response.code = 'invalid-command';
    bridge.deliver();
    expect(root.querySelector('#event-status')!.textContent).toBe('Evidence evicted');
    root.querySelector<HTMLButtonElement>('#event-stop')!.click();
    bridge.deliver();
    expect(root.querySelector('#event-window')!.textContent).toContain('Recording off');
  });
  it('preserves native comparison disclosure activation without a sandbox playback command', () => {
    const summary = get('comparisons').querySelector('summary')!;
    const before = worker.commands.mock.calls.length;
    const space = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Space',
      key: ' ',
    });
    summary.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(worker.commands.mock.calls).toHaveLength(before);
  });
  it('captures comparison sources through complete native Save without advancing or replacing the sandbox', () => {
    const endpoint = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const construct = vi.fn(function () {
      return endpoint;
    });
    vi.stubGlobal('Worker', construct);
    const harness = realWorker(true);
    click('comparison-start');
    expect(get('comparison-status').textContent).toContain('busy or unavailable');
    harness.deliver();
    click('pause');
    harness.deliver();
    const before = harness.save();
    click('comparison-start');
    harness.deliver();
    expect(construct).toHaveBeenCalledTimes(1);
    const source = endpoint.postMessage.mock.calls[0][0];
    expect(source.type).toBe('start');
    expect(JSON.parse(source.text)).toEqual(before);
    expect(harness.save()).toEqual(before);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    click('load');
    expect(endpoint.terminate).toHaveBeenCalledTimes(1);
    expect(get('comparison-status').textContent).toContain('lifecycle changed');
  });
  for (const phase of ['active', 'complete'] as const) {
    for (const outcome of ['valid', 'invalid', 'read-error'] as const) {
      it(`clears a ${phase} comparison started during a delayed ${outcome} world read`, async () => {
        const endpoint = {
          onmessage: null as ((event: MessageEvent) => void) | null,
          onerror: null,
          onmessageerror: null,
          postMessage: vi.fn(),
          terminate: vi.fn(),
        };
        vi.stubGlobal(
          'Worker',
          vi.fn(function () {
            return endpoint;
          }),
        );
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const harness = realWorker(true);
        harness.deliver();
        click('pause');
        harness.deliver();
        const before = harness.save();
        let resolve!: (text: string) => void;
        let reject!: (error: Error) => void;
        upload({
          size: 1,
          text: () =>
            new Promise<string>((yes, no) => {
              resolve = yes;
              reject = no;
            }),
        });
        set('comparison-intervention', 'none', 'change');
        set('comparison-delay', '0');
        set('comparison-duration', '31');
        click('comparison-start');
        harness.deliver();
        expect(endpoint.postMessage).toHaveBeenCalledTimes(1);
        const source = endpoint.postMessage.mock.calls[0][0];
        expect(JSON.parse(source.text)).toEqual(before);
        const runner = createComparison(source.text, source.plan);
        while (runner.advance(() => 0).tick < source.plan.horizonTick) {}
        const completion = { type: 'complete', result: runner.result() };
        runner.dispose();
        const deliver = endpoint.onmessage!;
        if (phase === 'complete') {
          deliver({ data: completion } as MessageEvent);
          expect(get('comparison-results').querySelector('table')).not.toBeNull();
          click('comparison-control');
          expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        } else expect(get<HTMLButtonElement>('comparison-start').disabled).toBe(true);
        const replacement = new Ecosystem(DEFAULTS, false);
        replacement.step();
        if (outcome === 'read-error') reject(new Error('Unreadable selected world.'));
        else resolve(outcome === 'valid' ? JSON.stringify(replacement.save()) : '{}');
        await Promise.resolve();
        harness.deliver();
        expect(endpoint.terminate).toHaveBeenCalledTimes(1);
        expect(endpoint.onmessage).toBeNull();
        expect(get('comparison-status').textContent).toContain('lifecycle changed');
        expect(get('comparison-results').children).toHaveLength(0);
        expect(get<HTMLButtonElement>('comparison-start').disabled).toBe(false);
        expect(get<HTMLButtonElement>('comparison-cancel').disabled).toBe(true);
        expect(get<HTMLButtonElement>('comparison-control').disabled).toBe(true);
        expect(get<HTMLButtonElement>('comparison-treatment').disabled).toBe(true);
        if (phase === 'complete') expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:world');
        deliver({ data: completion } as MessageEvent);
        expect(get('comparison-results').children).toHaveLength(0);
        expect(harness.save()).toEqual(outcome === 'valid' ? replacement.save() : before);
      });
    }
  }
  it('routes rejected comparison Saves and transport failures without downloads or wedged ownership', () => {
    click('comparison-start');
    worker.emit({ type: 'error', message: 'Complete checkpoint rejected.', fatal: false });
    expect(get('comparison-status').textContent).toContain('checkpoint rejected');
    worker.postMessage.mockImplementationOnce(() => {
      throw new DOMException('clone', 'DataCloneError');
    });
    click('comparison-start');
    expect(get('comparison-status').textContent).toContain('busy or unavailable');
    expect(get<HTMLButtonElement>('comparison-start').disabled).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects a delayed comparison capture when confirmed reset has taken ownership', () => {
    const construct = vi.fn();
    vi.stubGlobal('Worker', construct);
    const harness = realWorker(true);
    harness.deliver();
    click('comparison-start');
    click('reset');
    click('confirm-reset');
    harness.deliver();
    expect(construct).not.toHaveBeenCalled();
    expect(get('comparison-status').textContent).toContain('lifecycle changed');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects invalid slider edits, non-Error reads and conflicting same-run replacement identities', async () => {
    const harness = realWorker(true);
    harness.deliver();
    const input = get<HTMLInputElement>('mutation');
    input.type = 'text';
    set('mutation', '1');
    expect(input.value).toBe(String(DEFAULTS.mutation));
    upload({
      size: 1,
      text: async () => {
        throw 'not an Error';
      },
    });
    await Promise.resolve();
    expect(get('notice').textContent).toBe('Could not read this world.');
    const progress = worker.postMessage.mock.calls.find(
      ([command]) => command.type === 'flow-ack' && command.channel === 'progress',
    )![0];
    const control = worker.state;
    expect(control).toBeUndefined();
    const before = root.innerHTML;
    const world = new Ecosystem().presentation();
    worker.onmessage!({
      data: {
        type: 'progress',
        runId: 1,
        sequence: progress.sequence + 1,
        state: { replacementId: 999, revision: 99, world },
      },
    } as MessageEvent);
    expect(root.innerHTML).toBe(before);
  });
  it('keeps correlated fatal commands and failed startup stopped and reports real download failure', () => {
    const harness = realWorker(true);
    harness.deliver();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementationOnce(() => {
      throw new Error('download failed');
    });
    click('save');
    harness.deliver();
    expect(get('notice').textContent).toContain('Could not download this world');
    click('pause');
    harness.deliver();
    const step = vi.spyOn(Ecosystem.prototype, 'step').mockImplementationOnce(() => {
      throw new Error('step failed');
    });
    click('step');
    harness.deliver();
    step.mockRestore();
    expect(get('run-state').textContent).toBe('STOPPED');
    click('reset');
    harness.outbox.length = 0;
    const command = worker.commands.mock.calls.at(-1)![0];
    worker.onmessage!({
      data: {
        type: 'error',
        runId: command.runId,
        commandId: command.commandId,
        code: 'invalid-command',
        operation: 'start',
        message: 'cannot start',
      },
    } as MessageEvent);
    expect(get('run-state').textContent).toBe('STOPPED');
    expect(get('telemetry-summary').textContent).toContain('history unknown');
  });
  it('keeps terrain seed drafts through running observations and frozen reset confirmation', () => {
    const harness = realWorker(true);
    harness.deliver();
    set('seed', '99');
    harness.advance();
    harness.deliver();
    expect(get<HTMLInputElement>('seed').value).toBe('99');
    get('reset').click();
    expect(get('reset-payload').textContent).toContain('World seed 99');
    set('seed', '101');
    set('terrain-preset', 'open-field', 'change');
    get('confirm-reset').click();
    harness.deliver();
    expect(harness.save().settings.seed).toBe(99);
    expect(get<HTMLInputElement>('seed').value).toBe('101');
    expect(get<HTMLSelectElement>('terrain-preset').value).toBe('open-field');
    expect(get('world-label').textContent).toBe('WORLD 0099');
  });
  it('keeps edits newer than the original world-file read separate from its committed recipe and seed', async () => {
    const harness = realWorker(true);
    harness.deliver();
    let finish!: (text: string) => void;
    upload({
      size: 1,
      text: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    set('seed', '99');
    set('terrain-preset', 'open-field', 'change');
    const incoming = new Ecosystem({ ...DEFAULTS, seed: 73 }).save();
    finish(JSON.stringify(incoming));
    await Promise.resolve();
    harness.deliver();
    expect(get<HTMLInputElement>('seed').value).toBe('99');
    expect(get<HTMLSelectElement>('terrain-preset').value).toBe('open-field');
    expect(get('world-label').textContent).toBe('WORLD 0073');
    expect(harness.save().settings.seed).toBe(73);
  });
  it('rejects complete invalid payloads before capture and detaches every admitted field', () => {
    const invalid = [
      null,
      { type: 'unknown' },
      { type: 'begin-stroke', strokeId: 0, tool: 'food', radius: 0 },
      { type: 'begin-stroke', strokeId: 1, tool: 'plant', radius: 0 },
      { type: 'begin-stroke', strokeId: 1, tool: 'food', radius: 9 },
      { type: 'end-stroke', strokeId: 0 },
      { type: 'export-measurements', format: 'html' },
      { type: 'start', settings: DEFAULTS },
      { type: 'load', text: {} },
      { type: 'snapshot', display: 1 },
      { type: 'run-to', targetTick: -1 },
      { type: 'cancel-target', targetId: 0 },
      { type: 'speed', value: 2 },
      { type: 'pause-on-extinction', value: 'false' },
      { type: 'settings', settings: { seed: 4 } },
      { type: 'inspect', x: -1, y: 0 },
      { type: 'paint', tool: 'plant', x: 0, y: 0, radius: 0, genome: { ...founder(0), cells: [] } },
      { type: 'shock', kind: 'rain' },
      { type: 'capture-design', source: 'unsupported', sourceId: 1, captureId: 1 },
      { type: 'refuge-mode', rulesVersion: 2, enabled: true },
      { type: 'shade-mode', rulesVersion: 2, enabled: true },
      { type: 'clear-shade', rulesVersion: 2 },
      {
        type: 'paint-shade',
        rulesVersion: 1,
        tool: 'shade',
        units: 17,
        radius: 0,
        x: 0,
        y: 0,
        strokeId: 1,
      },
      {
        type: 'paint-refuge',
        rulesVersion: 1,
        tool: 'warm',
        units: 33,
        radius: 0,
        x: 0,
        y: 0,
        strokeId: 1,
      },
      { type: 'clear-walls', action: 'clear', recipe: DEFAULT_TERRAIN },
      { type: 'regenerate-walls', action: 'regenerate', recipe: DEFAULT_TERRAIN, resolvedSeed: -1 },
    ];
    for (const payload of invalid) expect(() => captureCommand(payload, DEFAULTS)).toThrow();
    const original = { type: 'paint', tool: 'plant', x: 40, y: 40, radius: 0, genome: founder(0) };
    const captured = captureCommand(original, DEFAULTS);
    original.genome.cells[0].type = 8;
    expect(captured).toMatchObject({ genome: founder(0) });
    expect(captureCommand({ type: 'inspect', x: 239, y: 155, extra: 1 }, DEFAULTS)).toEqual({
      type: 'inspect',
      x: 239,
      y: 155,
    });
    expect(captureCommand({ type: 'shock', kind: 'heat' }, DEFAULTS)).toEqual({
      type: 'shock',
      kind: 'heat',
    });
  });
  it('cancels a queued target by its eventual exact wire identity and disables cancellation after settling', () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    set('target-tick', '120');
    click('run-to-tick');
    expect(get<HTMLButtonElement>('cancel-target').disabled).toBe(false);
    click('cancel-target');
    harness.deliver();
    const commands = worker.commands.mock.calls.map(([command]) => command);
    const target = commands.find((command) => command.type === 'run-to');
    expect(commands.find((command) => command.type === 'cancel-target').targetId).toBe(
      target.commandId,
    );
    expect(get('target-status').textContent).toContain('cancelled');
    expect(get('run-state').textContent).toBe('PAUSED');
    expect(get<HTMLButtonElement>('cancel-target').disabled).toBe(true);
    expect(harness.save().tick).toBe(0);
    set('target-tick', '');
    click('run-to-tick');
    expect(get('target-status').textContent).toContain('absolute whole tick');
    set('target-tick', '0');
    get('target-tick').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    harness.deliver();
    expect(get('target-status').textContent).toContain('reached');
    expect(get<HTMLProgressElement>('target-progress').value).toBe(1);
  });
  it('reconciles unchanged target rejection revisions and clears successful replacement presentation', async () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    click('step');
    harness.deliver();
    set('target-tick', '0');
    click('run-to-tick');
    harness.deliver();
    expect(get('target-status').textContent).toContain('already passed');
    set('target-tick', '120');
    click('run-to-tick');
    harness.deliver();
    click('pause');
    harness.deliver();
    set('target-tick', '150');
    click('run-to-tick');
    harness.deliver();
    expect(get('target-status').textContent).toContain('Cancel the active target');
    expect(get('target-details').textContent).toContain('suspended');
    const details = get('target-details').textContent;
    await loadText('{}');
    harness.deliver();
    expect(get('target-details').textContent).toBe(details);
    expect(get('target-progress').hidden).toBe(false);
    for (const replace of ['load', 'reset']) {
      if (replace === 'load') await loadText(JSON.stringify(new Ecosystem(DEFAULTS).save()));
      else click('reset');
      harness.deliver();
      expect(get('target-status').textContent).toBe('');
      expect(get('target-details').textContent).toBe('');
      expect(get('target-progress').getAttribute('aria-valuetext')).toBeNull();
      expect(get('target-progress').hidden).toBe(true);
      click('pause');
      harness.deliver();
      set('target-tick', String(harness.save().tick));
      click('run-to-tick');
      harness.deliver();
      expect(get('target-status').textContent).toContain('reached');
    }
  });
  it.each(['past', 'busy'] as const)(
    'publishes one live diagnostic for a %s target rejection without moving focus',
    (kind) => {
      const harness = realWorker(true);
      harness.deliver();
      click('pause');
      harness.deliver();
      if (kind === 'past') {
        click('step');
        harness.deliver();
      } else {
        set('target-tick', '120');
        click('run-to-tick');
        harness.deliver();
        click('pause');
        harness.deliver();
      }
      const regions = [get('notice'), get('target-status')],
        publications = regions.map((region) => vi.spyOn(region, 'textContent', 'set'));
      for (const region of regions) expect(region.getAttribute('role')).toBe('status');
      const diagnostic =
        kind === 'past'
          ? 'That absolute tick has already passed.'
          : 'Cancel the active target before starting another.';
      get('target-tick').focus();
      set('target-tick', kind === 'past' ? '0' : '150');
      click('run-to-tick');
      const rejection = harness.outbox.find((data) => data.type === 'error');
      expect(rejection.message).toBe(diagnostic);
      harness.deliver();
      expect(
        publications.flatMap((spy) => spy.mock.calls).filter(([message]) => message === diagnostic),
      ).toHaveLength(1);
      expect(get('target-status').textContent).toBe(diagnostic);
      expect(document.activeElement).toBe(get('target-tick'));
    },
  );
  it.each(['past', 'busy'] as const)(
    'does not publish an older %s rejection over a newer queued target presentation',
    (kind) => {
      const harness = realWorker(true);
      harness.deliver();
      click('pause');
      harness.deliver();
      if (kind === 'past') {
        click('step');
        harness.deliver();
      } else {
        set('target-tick', '120');
        click('run-to-tick');
        harness.deliver();
        click('pause');
        harness.deliver();
      }
      const publications = [get('notice'), get('target-status')].map((region) =>
        vi.spyOn(region, 'textContent', 'set'),
      );
      get('target-tick').focus();
      set('target-tick', kind === 'past' ? '0' : '150');
      click('run-to-tick');
      const older = harness.outbox.splice(
        harness.outbox.findIndex((data) => data.type === 'error'),
        1,
      )[0];
      set('target-tick', '180');
      click('run-to-tick');
      const pending = get('target-status').textContent;
      worker.onmessage!({ data: older } as MessageEvent);
      expect(get('target-status').textContent).toBe(pending);
      expect(
        publications
          .flatMap((spy) => spy.mock.calls)
          .filter(([message]) => message === older.message),
      ).toHaveLength(0);
      harness.deliver();
      if (kind === 'past') {
        expect(get('target-details').textContent).toContain('absolute target 180');
        expect(get('target-status').textContent).toContain('running');
        expect(
          publications
            .flatMap((spy) => spy.mock.calls)
            .filter(([message]) => message === older.message),
        ).toHaveLength(0);
      } else {
        expect(get('target-status').textContent).toBe(older.message);
        expect(
          publications
            .flatMap((spy) => spy.mock.calls)
            .filter(([message]) => message === older.message),
        ).toHaveLength(1);
      }
      expect(document.activeElement).toBe(get('target-tick'));
    },
  );
  it('keeps a newer queued target request pending until its own correlated rejection', () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    set('target-tick', '120');
    click('run-to-tick');
    set('target-tick', '150');
    click('run-to-tick');
    const older = harness.outbox.splice(
      harness.outbox.findIndex((data) => data.type === 'control'),
      1,
    )[0];
    worker.onmessage!({ data: older } as MessageEvent);
    expect(get('target-status').textContent).toContain('pending acknowledgement');
    harness.deliver();
    expect(get('target-status').textContent).toContain('Cancel the active target');
    expect(get('target-details').textContent).toContain('absolute target 120');
  });
  it('announces target transitions once without announcing advancing numerical progress or moving focus', async () => {
    const harness = realWorker(true);
    harness.deliver();
    const status = get('target-status'),
      announcements = vi.spyOn(status, 'textContent', 'set');
    get('target-tick').focus();
    set('target-tick', '120');
    click('run-to-tick');
    harness.deliver();
    const node = status.firstChild;
    const previousDetails = get('target-progress').getAttribute('aria-valuetext');
    for (let batch = 0; batch < 3; batch++) {
      harness.advance();
      harness.deliver();
    }
    expect(status.firstChild).toBe(node);
    expect(get('target-progress').getAttribute('aria-valuetext')).not.toBe(previousDetails);
    expect(
      announcements.mock.calls.filter(([text]) => String(text).endsWith('running.')),
    ).toHaveLength(1);
    click('pause');
    harness.deliver();
    expect(
      announcements.mock.calls.filter(([text]) => String(text).endsWith('suspended.')),
    ).toHaveLength(1);
    click('cancel-target');
    harness.deliver();
    expect(
      announcements.mock.calls.filter(([text]) => String(text).endsWith('cancelled.')),
    ).toHaveLength(1);
    set('target-tick', String(harness.save().tick));
    click('run-to-tick');
    harness.deliver();
    expect(
      announcements.mock.calls.filter(([text]) => String(text).endsWith('reached.')),
    ).toHaveLength(1);
    await loadText(JSON.stringify(nearDeath()));
    harness.deliver();
    set('target-tick', '1000');
    click('run-to-tick');
    harness.deliver();
    for (let batch = 0; batch < 10 && harness.tasks.length; batch++) {
      harness.advance();
      harness.deliver();
    }
    expect(
      announcements.mock.calls.filter(([text]) => String(text).endsWith('extinct.')),
    ).toHaveLength(1);
    expect(document.activeElement).toBe(get('target-tick'));
    expect(get('target-details').hasAttribute('aria-live')).toBe(false);
  });
  it('preserves admitted plant A after designer edits, Clear, successful import B and later invalidity', async () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    const before = harness.save();
    const expected = Ecosystem.load(JSON.stringify(before));
    set('mutation', '0.2');
    click('plant-design');
    pointer('pointerdown');
    window.dispatchEvent(new Event('pointerup'));
    const view = viewport(get<HTMLCanvasElement>('world'), { zoom: 1, x: 0, y: 0 });
    const location = point(get<HTMLCanvasElement>('world'), { zoom: 1, x: 0, y: 0 }, 150, 150)!;
    expect(view.scale).toBeGreaterThan(0);
    expected.changeSettings({ mutation: 0.2 });
    const placement = expected.paint('plant', location.x, location.y, 2, founder(0));
    if (placement.placement)
      expected.appendIntervention({ kind: 'placement', detail: placement.placement });
    set('preference', '0.9');
    click('clear-design');
    const imported = serializeBlueprint({ name: 'B', description: '', genome: founder(2) });
    Object.defineProperty(get('blueprint-file'), 'files', {
      configurable: true,
      value: [{ size: imported.length, text: async () => imported }],
    });
    get('blueprint-file').dispatchEvent(new Event('change'));
    await Promise.resolve();
    const cells = [...get('editor').querySelectorAll<HTMLButtonElement>('button')];
    for (const cell of cells.filter((cell) => cell.dataset.x === '4' && cell.dataset.y === '4'))
      cell.click();
    const rejected = worker.commands.mock.calls.length;
    pointer('pointerdown');
    window.dispatchEvent(new Event('pointerup'));
    expect(worker.commands.mock.calls).toHaveLength(rejected);
    harness.deliver();
    expect(harness.save()).toEqual(expected.save());
    const plant = worker.commands.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'paint');
    expect(plant).toHaveLength(1);
    expect(plant[0].genome).toEqual(founder(0));
    click('step');
    harness.deliver();
    expected.step();
    expect(harness.save()).toEqual(expected.save());
  });
  it('finishes real Save download bookkeeping and every admitted predecessor before posting a candidate load', async () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    const events: string[] = [],
      original = worker.postMessage.getMockImplementation()!;
    worker.postMessage.mockImplementation((command) => {
      if (command.type !== 'flow-ack') events.push(command.type);
      original(command);
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      events.push(this.download);
    });
    set('mutation', '0.2');
    click('save');
    const candidate = new Ecosystem({ ...DEFAULTS, seed: 99 }).save();
    await loadText(JSON.stringify(candidate));
    set('nutrients', '7');
    expect(events).toEqual(['settings']);
    harness.deliver();
    expect(events).toEqual(['settings', 'save', 'evolab-world-42.json', 'load', 'settings']);
    const downloaded = URL.createObjectURL.mock.calls[0][0] as Blob;
    const file = JSON.parse(await downloaded.text());
    expect(file.settings).toEqual({ ...DEFAULTS, mutation: 0.2 });
    const expected = Ecosystem.load(JSON.stringify(candidate));
    expected.changeSettings({ nutrients: 7 });
    expect(harness.save()).toEqual(expected.save());
  });
  it('downloads a posted obsolete-generation Save once before reseeding without taking its notice', async () => {
    vi.useFakeTimers();
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    const before = harness.save();
    const events: string[] = [],
      original = worker.postMessage.getMockImplementation()!;
    worker.postMessage.mockImplementation((command) => {
      if (command.type !== 'flow-ack') events.push(command.type);
      original(command);
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      events.push(this.download);
    });
    click('save');
    set('seed', '99');
    click('reset');
    const newerNotice = get('notice').textContent;
    expect(events).toEqual(['save']);
    const saved = harness.outbox.splice(
      harness.outbox.findIndex((data) => data.type === 'saved'),
      1,
    )[0];
    worker.onmessage!({ data: saved } as MessageEvent);
    expect(events).toEqual(['save', 'evolab-world-42.json', 'start']);
    expect(get('notice').textContent).toBe(newerNotice);
    expect(JSON.parse(await (URL.createObjectURL.mock.calls[0][0] as Blob).text())).toEqual(before);
    worker.onmessage!({ data: saved } as MessageEvent);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    harness.deliver();
    vi.advanceTimersByTime(1000);
    click('save');
    harness.deliver();
    expect(get('notice').textContent).toContain('World saved');
  });
  it.each(
    [false, true].flatMap((frameFirst) =>
      ['valid', 'invalid', 'empty'].map((candidate) => ({ frameFirst, candidate })),
    ),
  )(
    'releases held old display after $candidate replacement proof (frame first=$frameFirst)',
    async ({ frameFirst, candidate }) => {
      const displays = vi.spyOn(Ecosystem.prototype, 'display');
      const harness = realWorker(true);
      const frame = harness.outbox.find((data) => data.type === 'frame');
      harness.outbox.splice(harness.outbox.indexOf(frame), 1);
      harness.deliver();
      if (frameFirst) worker.onmessage!({ data: frame } as MessageEvent);
      await loadText(
        candidate === 'invalid'
          ? '{}'
          : JSON.stringify(new Ecosystem(DEFAULTS, candidate !== 'empty').save()),
      );
      harness.deliver();
      if (!frameFirst) worker.onmessage!({ data: frame } as MessageEvent);
      const acknowledgement = worker.postMessage.mock.calls
        .map(([command]) => command)
        .find(
          (command) =>
            command.type === 'flow-ack' &&
            command.channel === 'display' &&
            command.sequence === frame.sequence,
        );
      expect(acknowledgement).toMatchObject({ runId: 1, sequence: frame.sequence });
      expect(displays).toHaveBeenCalledTimes(2);
      harness.deliver();
      paint(0);
      expect(get('habitat-freshness').textContent).toContain('tick 0');
    },
  );
  it.each(['retained', 'valid', 'invalid'])(
    'never acknowledges a discarded pending frame by redrawing cached habitat after %s replacement',
    async (candidate) => {
      const displays = vi.spyOn(Ecosystem.prototype, 'display');
      const harness = realWorker(true);
      harness.deliver();
      paint(0);
      harness.deliver();
      if (candidate !== 'retained') {
        await loadText(
          candidate === 'invalid' ? '{}' : JSON.stringify(new Ecosystem(DEFAULTS).save()),
        );
        harness.deliver();
        paint(0);
        harness.deliver();
      }
      harness.advance();
      const pending = harness.outbox.find((data) => data.type === 'frame');
      expect(pending).toBeDefined();
      harness.deliver();
      set('speed', '12', 'change');
      expect(harness.outbox.some((data) => data.type === 'control')).toBe(true);
      get<HTMLInputElement>('render-habitat').checked = false;
      get('render-habitat').dispatchEvent(new Event('change'));
      const before = displays.mock.calls.length;
      const acknowledgements = () =>
        worker.postMessage.mock.calls.filter(
          ([data]) =>
            data.type === 'flow-ack' &&
            data.channel === 'display' &&
            data.sequence === pending.sequence,
        );
      expect(acknowledgements()).toHaveLength(0);
      paint(0);
      expect(acknowledgements()).toHaveLength(0);
      expect(displays).toHaveBeenCalledTimes(before);
      harness.deliver();
      expect(acknowledgements()).toHaveLength(1);
      expect(displays).toHaveBeenCalledTimes(before);
      expect(harness.save().tick).toBe(pending.state.world.stats.tick);
    },
  );
  it.each(
    [false, true].flatMap((frameFirst) =>
      ['valid', 'invalid'].map((candidate) => ({ frameFirst, candidate })),
    ),
  )(
    'keeps discarded display fenced across $candidate replacement and disabling proof (frame first=$frameFirst)',
    async ({ frameFirst, candidate }) => {
      const displays = vi.spyOn(Ecosystem.prototype, 'display');
      const harness = realWorker(true);
      harness.deliver();
      paint(0);
      harness.deliver();
      harness.advance();
      const held = harness.outbox.splice(
        harness.outbox.findIndex((data) => data.type === 'frame'),
        1,
      )[0];
      harness.deliver();
      await loadText(
        candidate === 'invalid' ? '{}' : JSON.stringify(new Ecosystem(DEFAULTS).save()),
      );
      const terminal = harness.outbox.splice(
        harness.outbox.findIndex((data) => data.type === 'loaded' || data.type === 'error'),
        1,
      )[0];
      get<HTMLInputElement>('render-habitat').checked = false;
      get('render-habitat').dispatchEvent(new Event('change'));
      const before = displays.mock.calls.length;
      const acknowledgements = () =>
        worker.postMessage.mock.calls.filter(
          ([data]) =>
            data.type === 'flow-ack' &&
            data.channel === 'display' &&
            data.sequence === held.sequence,
        );
      if (frameFirst) worker.onmessage!({ data: held } as MessageEvent);
      paint(0);
      expect(acknowledgements()).toHaveLength(0);
      worker.onmessage!({ data: terminal } as MessageEvent);
      if (!frameFirst) worker.onmessage!({ data: held } as MessageEvent);
      paint(0);
      expect(acknowledgements()).toHaveLength(0);
      expect(displays).toHaveBeenCalledTimes(before);
      harness.deliver();
      expect(acknowledgements()).toHaveLength(1);
      expect(displays).toHaveBeenCalledTimes(before);
    },
  );
  it('retains a newly admitted target dependency while startup proof is still held', () => {
    const harness = realWorker(true);
    set('target-tick', '120');
    click('run-to-tick');
    click('cancel-target');
    harness.deliver();
    const commands = worker.commands.mock.calls.map(([command]) => command);
    expect(commands.map((command) => command.type)).toEqual(['start', 'run-to', 'cancel-target']);
    expect(commands[2].targetId).toBe(commands[1].commandId);
    expect(get('target-status').textContent).toContain('cancelled');
    expect(get<HTMLButtonElement>('cancel-target').disabled).toBe(true);
  });
  it('keeps the newer disabling-view fence through failed adoption before retiring an old display owner', async () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    await loadText('{}');
    click('render-habitat');
    const before = worker.postMessage.mock.calls.length;
    const recovery = harness.outbox.find((data) => data.type === 'error');
    harness.outbox.splice(harness.outbox.indexOf(recovery), 1);
    worker.onmessage!({ data: recovery } as MessageEvent);
    expect(worker.commands.mock.calls.at(-1)![0]).toMatchObject({
      type: 'display-view',
      view: { enabled: false },
    });
    expect(
      worker.postMessage.mock.calls
        .slice(before)
        .some(([command]) => command.type === 'flow-ack' && command.channel === 'display'),
    ).toBe(false);
    harness.deliver();
    expect(
      worker.postMessage.mock.calls
        .slice(before)
        .some(([command]) => command.type === 'flow-ack' && command.channel === 'display'),
    ).toBe(true);
    expect(get('habitat-freshness').textContent).toContain('Rendering off');
  });
  it('bounds general/lifecycle/latest-view owners and converges to the newest view without displacing queued effects', () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    for (let index = 0; index < 30; index++) click('refresh-habitat');
    click('refresh-habitat');
    expect(get('notice').textContent).toContain('Controls busy');
    click('pause');
    click('pause');
    for (let index = 0; index < 21; index++) click('render-habitat');
    expect(worker.commands.mock.calls).toHaveLength(2);
    harness.deliver();
    const commands = worker.commands.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command.type === 'snapshot')).toHaveLength(30);
    expect(commands.filter((command) => command.type === 'pause')).toHaveLength(2);
    expect(commands.filter((command) => command.type === 'display-view')).toHaveLength(1);
    expect(commands.find((command) => command.type === 'display-view').view).toMatchObject({
      epoch: 21,
      enabled: false,
    });
    expect(commands.map((command) => command.commandId)).toEqual(
      commands.map((_, index) => index + 1),
    );
    expect(harness.save().tick).toBe(0);
  });
  it('coalesces only the unsent replaceable tail, preserving fields and identities through barriers', () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    set('mutation', '0.2');
    set('nutrients', '3');
    set('mutation', '0.3');
    set('speed', '1', 'change');
    set('speed', '12', 'change');
    harness.deliver();
    expect(harness.save().settings).toEqual({ ...DEFAULTS, mutation: 0.3, nutrients: 3 });
    const commands = worker.commands.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command.type === 'settings')).toHaveLength(1);
    expect(commands.filter((command) => command.type === 'speed')).toHaveLength(1);
    expect(get<HTMLSelectElement>('speed').value).toBe('12');
  });
  it.each(['settings', 'speed', 'pause-on-extinction', 'run-to'])(
    'retires a queued nonposted %s and completes its admitted Save without extra events or ticks',
    (operation) => {
      const harness = realWorker(true);
      harness.deliver();
      click('pause');
      harness.deliver();
      const before = harness.save();
      click('refresh-habitat');
      const terminal = harness.outbox.splice(
        harness.outbox.findIndex((data) => data.operation === 'snapshot'),
        1,
      )[0];
      harness.deliver(); // Consume unrelated stream events BEFORE admission.
      expect(harness.outbox).toHaveLength(0);
      const post = worker.postMessage.getMockImplementation()!;
      let attempts = 0;
      worker.postMessage.mockImplementation((data) => {
        if (data.type === operation) {
          attempts++;
          throw new DOMException('proven nonpost', 'DataCloneError');
        }
        post(data);
      });
      const start = worker.commands.mock.calls.length;
      if (operation === 'settings') set('nutrients', '7');
      if (operation === 'speed') set('speed', '12', 'change');
      if (operation === 'pause-on-extinction') click('pause-on-extinction');
      if (operation === 'run-to') {
        set('target-tick', '120');
        click('run-to-tick');
        click('cancel-target'); // Depends on the rejected target, not a real worker target.
      }
      click('save');
      expect(worker.commands.mock.calls).toHaveLength(start);
      worker.onmessage!({ data: terminal } as MessageEvent);
      // Only the held terminal was delivered. No stream/input/timer/RAF or
      // ecological callback is available to rescue a stranded queue.
      const saved = harness.outbox.find((data) => data.type === 'saved');
      expect(saved).toBeDefined();
      expect(JSON.parse(saved.text)).toEqual(before);
      expect(attempts).toBe(1);
      expect(worker.commands.mock.calls.slice(start).map(([data]) => data.type)).toEqual(['save']);
      expect(get<HTMLInputElement>('nutrients').value).toBe(String(before.settings.nutrients));
      expect(get<HTMLSelectElement>('speed').value).toBe('4');
      expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(true);
      expect(get('target-status').textContent).not.toContain('pending');
      expect(get<HTMLButtonElement>('cancel-target').disabled).toBe(true);
      harness.deliver(); // Only necessary admitted-successor receipts/flow ACKs.
      expect(attempts).toBe(1);
      expect(get('run-state').textContent).toBe('PAUSED');
    },
  );
  it('keeps newer settings and target ownership across failed tickets and Save barriers', () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    click('refresh-habitat');
    const held = harness.outbox.splice(
      harness.outbox.findIndex((data) => data.operation === 'snapshot'),
      1,
    )[0];
    harness.deliver();
    const post = worker.postMessage.getMockImplementation()!;
    let failedSettings = false,
      failedTarget = false;
    worker.postMessage.mockImplementation((data) => {
      if (
        (data.type === 'settings' && !failedSettings) ||
        (data.type === 'run-to' && !failedTarget)
      ) {
        if (data.type === 'settings') failedSettings = true;
        else failedTarget = true;
        throw new DOMException('proven nonpost', 'DataCloneError');
      }
      post(data);
    });
    set('nutrients', '7');
    set('target-tick', '120');
    click('run-to-tick');
    click('cancel-target');
    click('save'); // Keeps independent later edits out of the rejected settings segment.
    set('nutrients', '3');
    set('target-tick', '0');
    click('run-to-tick');
    worker.onmessage!({ data: held } as MessageEvent);
    expect(get<HTMLInputElement>('nutrients').value).toBe('3');
    expect(get('target-status').textContent).toContain('pending');
    harness.deliver();
    expect(get<HTMLInputElement>('nutrients').value).toBe('3');
    expect(get('target-status').textContent).toContain('reached');
    expect(
      worker.commands.mock.calls.filter(([data]) => data.type === 'cancel-target'),
    ).toHaveLength(0);
    expect(harness.save().settings.nutrients).toBe(3);
  });
  it.each(['begin-stroke', 'end-stroke'])(
    'retires a queued nonposted %s without leaking stroke-dependent work',
    (operation) => {
      const harness = realWorker(true);
      harness.deliver();
      click('pause');
      harness.deliver();
      const before = harness.save();
      click('refresh-habitat');
      const held = harness.outbox.splice(
        harness.outbox.findIndex((data) => data.operation === 'snapshot'),
        1,
      )[0];
      harness.deliver();
      const post = worker.postMessage.getMockImplementation()!;
      let attempts = 0;
      worker.postMessage.mockImplementation((data) => {
        if (data.type === operation) {
          attempts++;
          throw new DOMException('proven nonpost', 'DataCloneError');
        }
        post(data);
      });
      root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
      pointer('pointerdown');
      pointer('pointermove', 152, 152);
      pointer('pointerup');
      click('save');
      const start = worker.commands.mock.calls.length;
      worker.onmessage!({ data: held } as MessageEvent);
      harness.deliver();
      expect(attempts).toBe(1);
      if (operation === 'begin-stroke') {
        expect(worker.commands.mock.calls.slice(start).map(([data]) => data.type)).toEqual([
          'save',
        ]);
        expect(harness.save()).toEqual(before);
        expect(worker.terminate).not.toHaveBeenCalled();
      } else {
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(get('run-state').textContent).toBe('STOPPED');
        expect(worker.commands.mock.calls.slice(start).some(([data]) => data.type === 'save')).toBe(
          false,
        );
      }
    },
  );
  it('boundedly drains a full nonposting queue without retrying or admitting beyond its cap', () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    click('refresh-habitat');
    const held = harness.outbox.splice(
      harness.outbox.findIndex((data) => data.operation === 'snapshot'),
      1,
    )[0];
    harness.deliver();
    const post = worker.postMessage.getMockImplementation()!;
    let attempts = 0;
    worker.postMessage.mockImplementation((data) => {
      if (data.type === 'snapshot') {
        attempts++;
        throw new DOMException('proven nonpost', 'DataCloneError');
      }
      post(data);
    });
    for (let i = 0; i < 29; i++) click('refresh-habitat');
    click('save');
    click('refresh-habitat');
    expect(get('notice').textContent).toContain('Controls busy');
    click('pause'); // The one reserved lifecycle slot is still independent.
    worker.onmessage!({ data: held } as MessageEvent);
    expect(attempts).toBe(29);
    expect(harness.outbox.some((data) => data.type === 'saved')).toBe(true);
    harness.deliver();
    expect(attempts).toBe(29);
    expect(get('run-state').textContent).toBe('PAUSED');
  });
  it('keeps a load behind the admitted Save after nonposting and retains authoritative recovery', async () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    const before = harness.save();
    click('refresh-habitat');
    const held = harness.outbox.splice(
      harness.outbox.findIndex((data) => data.operation === 'snapshot'),
      1,
    )[0];
    harness.deliver();
    const post = worker.postMessage.getMockImplementation()!;
    worker.postMessage.mockImplementation((data) => {
      if (data.type === 'settings') throw new DOMException('proven nonpost', 'DataCloneError');
      post(data);
    });
    const start = worker.commands.mock.calls.length;
    set('nutrients', '7');
    click('save');
    await loadText('{}');
    worker.onmessage!({ data: held } as MessageEvent);
    expect(worker.commands.mock.calls.slice(start).map(([data]) => data.type)).toEqual(['save']);
    expect(JSON.parse(harness.outbox.find((data) => data.type === 'saved').text)).toEqual(before);
    harness.deliver();
    expect(worker.commands.mock.calls.slice(start).map(([data]) => data.type)).toEqual([
      'save',
      'load',
    ]);
    expect(get('run-state').textContent).toBe('PAUSED');
    expect(harness.save()).toEqual(before);
  });
  it('serializes candidate reads and keeps only the latest waiting read, cancelling unposted candidates', async () => {
    const harness = realWorker(true);
    harness.deliver();
    let finish!: (text: string) => void;
    const discarded = vi.fn(async () => '{}'),
      latest = vi.fn(async () => JSON.stringify(nearDeath()));
    upload({
      size: 1,
      text: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    upload({ size: 1, text: discarded });
    upload({ size: 1, text: latest });
    expect(latest).not.toHaveBeenCalled();
    finish('{}');
    await Promise.resolve();
    await Promise.resolve();
    harness.deliver();
    expect(discarded).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(harness.save().tick).toBe(71);
    click('pause');
    await loadText('{}');
    get('file').dispatchEvent(new Event('cancel'));
    harness.deliver();
    expect(
      worker.commands.mock.calls
        .map(([command]) => command)
        .filter((command) => command.type === 'load'),
    ).toHaveLength(1);
  });
  it('wires intersection/document visibility, preserves monotonic view epochs and disconnects on teardown', () => {
    let intersection!: IntersectionObserverCallback;
    const disconnected = vi.fn(),
      observed = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersection = callback;
        }
        observe = observed;
        disconnect = disconnected;
      },
    );
    const harness = realWorker(true);
    harness.deliver();
    const notify = (isIntersecting: boolean) =>
      intersection(
        [
          {
            target: get('world'),
            isIntersecting,
            intersectionRect: { width: isIntersecting ? 250 : 0, height: 180 },
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    notify(false);
    harness.deliver();
    expect(get('habitat-freshness').textContent).toContain('not visible');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    notify(true);
    harness.deliver();
    expect(get('habitat-freshness').textContent).toContain('not visible');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    harness.deliver();
    paint(0);
    expect(get('habitat-freshness').textContent).toContain('Habitat current');
    expect(observed).toHaveBeenCalledWith(get('world'));
    dispose();
    notify(false);
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
  it('fails closed on session-counter exhaustion without retaining a pending action', () => {
    const harness = realWorker(true);
    harness.deliver();
    const increment = vi.spyOn(model, 'nextSessionId').mockImplementationOnce(() => {
      throw new Error('counter exhausted');
    });
    click('refresh-habitat');
    expect(get('run-state').textContent).toBe('STOPPED');
    expect(get('notice').textContent).toBe('counter exhausted');
    increment.mockRestore();
    click('render-habitat');
    expect(get('notice').textContent).toContain('cannot change while stopped');
  });
});
describe('actual grid-free telemetry transport composition', () => {
  it.each(['settings', 'inspect', 'paint', 'shock'] as const)(
    'consumes one latest Refresh after a running off-mode %s command releases the held display',
    (type) => {
      const displays = vi.spyOn(Ecosystem.prototype, 'display'),
        draws = vi.spyOn(viewModule, 'draw'),
        harness = realWorker(true, false);
      harness.deliver();
      harness.advance();
      harness.deliver();
      expect(displays).not.toHaveBeenCalled();
      expect(draws).not.toHaveBeenCalled();
      expect(harness.gridTransfers()).toBe(0);
      click('refresh-habitat');
      harness.deliver();
      click('refresh-habitat');
      harness.deliver();
      if (type === 'settings') set('mutation', '0.2');
      else if (type === 'inspect') harness.command({ type, x: 120, y: 78 });
      else if (type === 'shock')
        root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
      else {
        root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
        pointer('pointerdown');
        window.dispatchEvent(new Event('pointerup'));
      }
      harness.deliver();
      expect(worker.commands.mock.calls.some(([command]) => command.type === type)).toBe(true);
      const before = harness.save(),
        queued = harness.tasks[0];
      expect(displays).toHaveBeenCalledTimes(1);
      expect(draws).not.toHaveBeenCalled();
      paint(0);
      expect(draws).toHaveBeenCalledTimes(1);
      expect(displays).toHaveBeenCalledTimes(2);
      expect(harness.outbox.filter((data) => data.type === 'frame')).toHaveLength(1);
      const latest = harness.outbox.find((data) => data.type === 'frame');
      expect(latest.state.world.stats.tick).toBe(before.tick);
      expect(latest.state.playback.paused).toBe(false);
      harness.deliver();
      paint(0);
      expect(draws).toHaveBeenCalledTimes(2);
      expect(draws.mock.calls.at(-1)![2]).toEqual(latest.frame);
      expect(harness.save()).toEqual(before);
      expect(harness.tasks).toEqual([queued]);
      expect(harness.gridTransfers()).toBe(8);
      harness.advance();
      harness.deliver();
      paint(0);
      expect(harness.gridTransfers()).toBe(8);
      expect(draws).toHaveBeenCalledTimes(2);
    },
  );
  it('accepts one delayed detached source30 after current65 without rolling progress back or drawing from startup', async () => {
    const displays = vi.spyOn(Ecosystem.prototype, 'display'),
      draws = vi.spyOn(viewModule, 'draw');
    const harness = realWorker(true, false),
      chart = chartRecorder();
    const receive = worker.onmessage!;
    let held: any,
      received: any,
      holdAt = 0;
    worker.onmessage = (event) => {
      const data = event.data;
      expect(data.type).not.toBe('frame');
      if (holdAt >= 0 && data.telemetry) {
        if (!held && data.type === 'progress' && data.telemetry.tick === holdAt) held = data;
        const { telemetry: _source, ...progress } = data;
        receive({ data: progress } as MessageEvent);
      } else {
        if (data.telemetry) received = data.telemetry;
        receive(event);
      }
    };
    harness.deliver();
    expect(get('telemetry-summary').textContent).toContain('history not yet known');
    expect(held.telemetry.tick).toBe(0);
    receive({ data: held } as MessageEvent);
    held = undefined;
    expect(get('telemetry-summary').textContent).toContain('empty at source tick 0');
    holdAt = 30;
    set('speed', '1', 'change');
    harness.deliver();
    const runTo = (tick: number) => {
      set('target-tick', String(tick));
      click('run-to-tick');
      harness.deliver();
      while (harness.save().tick < tick) {
        harness.advance();
        harness.deliver();
      }
    };
    runTo(30);
    expect(held.telemetry.tick).toBe(30);
    const expected30 = new Ecosystem(DEFAULTS);
    for (let tick = 0; tick < 30; tick++) expected30.step();
    expect(held.telemetry.telemetry).toEqual(expected30.save().telemetry);
    runTo(65);
    expect(get('tick').textContent).toBe('TICK 65');
    expect(get('telemetry-summary').textContent).toContain('awaiting newer telemetry observations');
    const old = held,
      acknowledgementCount = worker.postMessage.mock.calls.filter(
        ([data]) => data.type === 'flow-ack',
      ).length;
    receive({ data: old } as MessageEvent);
    held = undefined;
    expect(worker.postMessage.mock.calls.filter(([data]) => data.type === 'flow-ack')).toHaveLength(
      acknowledgementCount,
    );
    expect(get('telemetry-summary').textContent).toContain('World tick 65');
    expect(get('telemetry-summary').textContent).toContain('source observed at tick 30');
    expect(get('telemetry-summary').textContent).toContain('last received recorded sample tick 30');
    expect(chart.paths.at(-1)).toEqual([[30, expected30.organisms.size]]);
    holdAt = -1;
    set('target-tick', '90');
    click('run-to-tick');
    harness.deliver();
    expect(get('telemetry-summary').textContent).toContain('source observed at tick 65');
    expect(get('telemetry-summary').textContent).toContain('last received recorded sample tick 60');
    while (harness.save().tick < 90) {
      harness.advance();
      harness.deliver();
    }
    const expected90 = new Ecosystem(DEFAULTS);
    for (let tick = 0; tick < 90; tick++) expected90.step();
    expect(harness.save()).toEqual(expected90.save());
    expect(received.tick).toBe(90);
    expect(received.telemetry).toEqual(expected90.save().telemetry);
    expect(chart.paths.at(-1)).toEqual(
      expected90.save().telemetry.samples.map((sample) => [sample.tick, sample.population]),
    );
    const rows = () =>
      new Map(
        [...get('telemetry-details').querySelectorAll('tbody tr')].map((row) => [
          row.querySelector('th')!.textContent,
          row.querySelector('td')!.textContent,
        ]),
      );
    set('telemetry-view', 'food', 'change');
    paint(0);
    expect(rows().get('Leaf energy gained over this interval')).toBe(
      String(expected90.save().telemetry.samples.at(-1)!.energy.leavesGained),
    );
    set('telemetry-view', 'adaptation', 'change');
    paint(0);
    expect(
      [...root.querySelectorAll('[data-bin]')].map((bin) => Number(bin.getAttribute('data-count'))),
    ).toEqual(expected90.save().telemetry.samples.at(-1)!.adaptation!.preferenceBins);
    const before = root.innerHTML;
    for (const stale of [old, { ...old, runId: old.runId + 999, sequence: old.sequence + 999 }])
      receive({ data: stale } as MessageEvent);
    expect(root.innerHTML).toBe(before);
    click('ecosystem-tab');
    set('telemetry-sample', '30', 'change');
    const selector = get<HTMLSelectElement>('telemetry-sample');
    selector.focus();
    paint(0);
    await loadText('{}');
    harness.deliver();
    paint(0);
    expect(selector.value).toBe('30');
    expect(document.activeElement).toBe(selector);
    expect(harness.save()).toEqual(expected90.save());
    const replacement = new Ecosystem({ ...DEFAULTS, nutrients: 0 });
    for (let tick = 0; tick < 90; tick++) replacement.step();
    await loadText(JSON.stringify(replacement.save()));
    harness.deliver();
    paint(0);
    expect(selector.value).toBe('latest');
    expect(document.activeElement).toBe(selector);
    const replaced = root.innerHTML;
    receive({ data: old } as MessageEvent);
    expect(root.innerHTML).toBe(replaced);
    expect(displays).not.toHaveBeenCalled();
    expect(draws).not.toHaveBeenCalled();
    expect(harness.gridTransfers()).toBe(0);
    dispose();
    const disposed = root.innerHTML;
    receive({ data: old } as MessageEvent);
    paint(0);
    expect(root.innerHTML).toBe(disposed);
    expect(draws).not.toHaveBeenCalled();
  });
  it('integrates genuine v3 null gaps, v4 continuation, empty origins and pin eviction with zero grids', async () => {
    const displays = vi.spyOn(Ecosystem.prototype, 'display'),
      draws = vi.spyOn(viewModule, 'draw');
    const harness = realWorker(true, false);
    harness.deliver();
    for (const origin of [25, 30, 31]) {
      const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0 }, false);
      while (world.tick < origin) world.step();
      const legacy = legacyV3(world.save());
      await loadText(JSON.stringify(legacy));
      harness.deliver();
      paint(0);
      const migrated = harness.save();
      expect(migrated.telemetry.adaptationOriginTick).toBe(origin);
      expect(migrated.telemetry.samples.every((sample) => sample.adaptation === null)).toBe(true);
      expect(migrated.telemetry.pending).toEqual(legacy.telemetry.pending);
      if (origin === 25)
        expect(get('telemetry-summary').textContent).toContain('empty at source tick 25');
      else {
        set('telemetry-view', 'adaptation', 'change');
        paint(0);
        expect(get('telemetry-details').textContent).toContain('were not recorded');
        expect(get('telemetry-details').textContent).toContain('Unavailable');
      }
      await loadText(JSON.stringify(migrated));
      harness.deliver();
      expect(harness.save()).toEqual(migrated);
    }
    const reference = Ecosystem.load(JSON.stringify(harness.save()));
    get<HTMLInputElement>('pause-on-extinction').checked = false;
    get('pause-on-extinction').dispatchEvent(new Event('change'));
    harness.deliver();
    set('speed', '12', 'change');
    harness.deliver();
    set('target-tick', '90');
    click('run-to-tick');
    harness.deliver();
    while (harness.tasks.length) {
      expect(harness.tasks).toHaveLength(1);
      harness.advance();
      harness.deliver();
    }
    while (reference.tick < 90) reference.step();
    expect(harness.save()).toEqual(reference.save());
    expect(get('tick').textContent).toBe('TICK 90');
    click('ecosystem-tab');
    set('telemetry-sample', '30', 'change');
    get('telemetry-sample').focus();
    paint(0);
    set('target-tick', '5430');
    click('run-to-tick');
    harness.deliver();
    while (harness.tasks.length) {
      expect(harness.tasks).toHaveLength(1);
      harness.advance();
      harness.deliver();
    }
    while (reference.tick < 5430) reference.step();
    const completed = harness.save();
    expect(completed).toEqual(reference.save());
    expect(get('tick').textContent).toBe('TICK 5,430');
    paint(0);
    expect(completed.telemetry.samples).toHaveLength(180);
    expect(get<HTMLSelectElement>('telemetry-sample').value).toBe('60');
    expect(get('telemetry-status').textContent).toContain('30');
    expect(document.activeElement).toBe(get('telemetry-sample'));
    expect(displays).not.toHaveBeenCalled();
    expect(draws).not.toHaveBeenCalled();
    expect(harness.gridTransfers()).toBe(0);
  });
  it('keeps natural progress100ms and source250ms cadence independent without any transport hold', () => {
    const displays = vi.spyOn(Ecosystem.prototype, 'display');
    const harness = realWorker(true, false);
    harness.deliver();
    set('speed', '1', 'change');
    harness.deliver();
    for (let batch = 0; batch < 39; batch++) {
      harness.advance();
      harness.deliver();
    }
    expect(get('tick').textContent).toBe('TICK 39');
    expect(get('telemetry-summary').textContent).toContain('source observed at tick 36');
    expect(get('telemetry-summary').textContent).toContain('last received recorded sample tick 30');
    expect(get('telemetry-summary').textContent).toContain('Observation/transport lag');
    const reference = new Ecosystem(DEFAULTS);
    for (let tick = 0; tick < 39; tick++) reference.step();
    expect(harness.save()).toEqual(reference.save());
    expect(displays).not.toHaveBeenCalled();
    expect(harness.gridTransfers()).toBe(0);
  });
});

describe('explicit native full design ownership', () => {
  it.each(['copy', 'export'] as const)(
    'keeps a delayed full %s from overwriting newer designer edits',
    (action) => {
      const bridge = ownershipBridge();
      root.querySelector<HTMLButtonElement>('[data-tool="inspect"]')!.click();
      const canvas = get<HTMLCanvasElement>('world');
      const view = viewport(canvas, { zoom: 1, x: 0, y: 0 });
      pointer('pointerdown', view.left + 120.5 * view.scale, view.top + 78.5 * view.scale);
      pointer('pointerup');
      bridge.holdTerminals((data) => data.operation === 'capture-design');
      const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      click(action === 'copy' ? 'copy-organism' : 'export-organism-blueprint');
      const id = [...bridge.records.keys()][0];
      expect(bridge.records.get(id)!.command.type).toBe('capture-design');
      set('blueprint-name', 'newer retained design');
      bridge.deliver(id);
      expect(get<HTMLInputElement>('blueprint-name').value).toBe('newer retained design');
      expect(anchor).not.toHaveBeenCalled();
      expect(get('notice').textContent).toContain('cancelled');
      expect(bridge.records.size).toBe(0);
    },
  );
  function inspectedBridge() {
    const bridge = ownershipBridge();
    root.querySelector<HTMLButtonElement>('[data-tool="inspect"]')!.click();
    const area = viewport(get<HTMLCanvasElement>('world'), { zoom: 1, x: 0, y: 0 });
    pointer('pointerdown', area.left + 120.5 * area.scale, area.top + 78.5 * area.scale);
    pointer('pointerup');
    return bridge;
  }
  it('keeps one full capture charged while repeated copy and library admissions report busy', () => {
    const bridge = inspectedBridge();
    bridge.holdTerminals((data) => data.operation === 'capture-design');
    click('copy-organism');
    const id = [...bridge.records.keys()][0];
    click('copy-organism');
    expect(get('notice').textContent).toContain('capture busy');
    click('capture-selected');
    expect(get('library-status').textContent).toContain('unavailable or busy');
    expect(bridge.records.size).toBe(1);
    bridge.deliver(id);
    expect(bridge.records.size).toBe(0);
    expect(get('notice').textContent).toContain('copied in full');
  });
  it('retires a proven nonposting full capture without changing the design or queuing a retry', () => {
    const bridge = inspectedBridge();
    const original = bridge.endpoint.postMessage;
    vi.spyOn(bridge.endpoint, 'postMessage').mockImplementation((command: any) => {
      if (command.type === 'capture-design')
        throw new DOMException('proven capture nonpost', 'DataCloneError');
      original(command);
    });
    set('blueprint-name', 'retained after nonpost');
    click('copy-organism');
    expect(get('notice').textContent).toContain('No automatic retry');
    expect(get<HTMLInputElement>('blueprint-name').value).toBe('retained after nonpost');
    expect(bridge.records.size).toBe(0);
    expect(bridge.counts.terminated).toBe(0);
    expect(get('run-state').textContent).toBe('PAUSED');
  });
  it.each(['copy', 'library'] as const)(
    'reports a failed full %s source read and retains designer, playback and native ownership truthfully',
    (action) => {
      const bridge = inspectedBridge();
      bridge.holdTerminals((data) => data.operation === 'capture-design');
      set('blueprint-name', 'retained on source failure');
      click(action === 'library' ? 'capture-selected' : 'copy-organism');
      const [id, record] = [...bridge.records][0];
      record.terminal = {
        ...record.terminal,
        type: 'error',
        code: 'invalid-command',
        message: 'The design source is no longer alive.',
      };
      bridge.deliver(id);
      expect(get('notice').textContent).toContain('no longer alive');
      if (action === 'library')
        expect(get('library-status').textContent).toContain('no longer alive');
      expect(get<HTMLInputElement>('blueprint-name').value).toBe('retained on source failure');
      expect(get('run-state').textContent).toBe('PAUSED');
      expect(bridge.records.size).toBe(0);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    },
  );
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

  it.each(['library-first', 'capture-first'])(
    'keeps the newest designer replacement intent across held library and full-capture owners: %s',
    async (order) => {
      const playback = get('run-state').textContent;
      storage.values.set(first, encodeRecord(draft('Library replacement'), 1));
      await open();
      const original = worker.postMessage.getMockImplementation()!;
      let held: any;
      worker.postMessage.mockImplementation((command) => {
        if (command.type === 'capture-design') held = command;
        else original(command);
      });
      storage.faults.completionStall = 'readonly';
      if (order === 'capture-first') click('copy-organism');
      click('library-load');
      await flush();
      const owner = storage.current;
      if (order === 'library-first') click('copy-organism');
      expect(held?.type).toBe('capture-design');
      delete storage.faults.completionStall;
      if (order === 'library-first') {
        owner.releaseCompletion();
        await flush();
        expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
        original(held);
        await flush();
        expect(get<HTMLInputElement>('blueprint-name').value).toBe(
          model.speciesName(organism.genome),
        );
      } else {
        original(held);
        await flush();
        owner.releaseCompletion();
        await flush();
        expect(get<HTMLDialogElement>('library-dialog').open).toBe(true);
        click('library-confirm');
        await flush();
        expect(get<HTMLInputElement>('blueprint-name').value).toBe('Library replacement');
      }
      expect(storage.values.get(first)).toBe(encodeRecord(draft('Library replacement'), 1));
      expect(get('run-state').textContent).toBe(playback);
    },
  );

  function holdLibraryCapture() {
    const original = worker.postMessage.getMockImplementation()!;
    let held: any;
    worker.postMessage.mockImplementation((command) => {
      if (command.type === 'capture-design') held = command;
      else original(command);
    });
    click('capture-selected');
    return { deliver: () => original(held), command: () => held };
  }
  it.each(['name', 'rotate', 'mirror'])(
    'cancels a delayed library full capture after %s without storing a stale candidate',
    async (action) => {
      const capture = holdLibraryCapture();
      if (action === 'name') set('blueprint-name', 'newer design');
      else click(`${action}-design`);
      capture.deliver();
      await flush();
      expect(get('library-status').textContent).toContain('Capture cancelled');
      if (action === 'name')
        expect(get<HTMLInputElement>('blueprint-name').value).toBe('newer design');
      expect(get('library-candidate').hidden).toBe(true);
      expect(storage.values.size).toBe(0);
    },
  );
  it('preserves a newer unsaved candidate when an earlier complete library capture returns', async () => {
    const capture = holdLibraryCapture();
    await uploadLocal(serializeBlueprint(draft('Retained newer candidate').blueprint));
    capture.deliver();
    await flush();
    expect(get('library-candidate-name').textContent).toBe('Retained newer candidate');
    expect(get('library-status').textContent).toContain('Existing candidate preserved');
    expect(storage.values.size).toBe(0);
  });
  it.each(['oversized', 'malformed'] as const)(
    'preserves design and library after a %s complete source response',
    async (kind) => {
      const capture = holdLibraryCapture();
      const emit = worker.emit.bind(worker);
      const original = worker.postMessage.getMockImplementation();
      worker.postMessage.mockImplementation((command) => {
        if (command.type === 'capture-design') {
          const genome: any = structuredClone(organism.genome);
          if (kind === 'oversized')
            genome.legacyExtensions = [['retained', [['string', 'é'.repeat(20000)]]]];
          else genome.cells = [];
          emit({ type: 'design-captured', genome });
        } else original!(command);
      });
      worker.commands(capture.command());
      worker.postMessage(capture.command());
      await flush();
      expect(storage.values.size).toBe(0);
      expect(get('library-candidate').hidden).toBe(true);
      expect(get('library-status').textContent).not.toBe('');
      expect(get('library-status').textContent).not.toContain('Write committed');
      expect(get('run-state').textContent).toBe('LIVE');
    },
  );

  it('preserves current world and manual interventions through library design replacement with the real worker', async () => {
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
    harness.deliver();
    const before = harness.save();
    expect(before.version).toBe(16);
    expect(before.lineageArchive.summaries.length).toBeGreaterThan(0);
    expect(before.telemetry.version).toBe(2);
    expect(before.interventions.version).toBe(5);
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

  it.each(
    ['initial', 'final'].flatMap((phase) =>
      ['rotate', 'mirror'].map((action) => ({ phase, action })),
    ),
  )(
    'keeps a $action transform authoritative across a delayed $phase library load',
    async ({ phase, action }) => {
      storage.values.set(first, encodeRecord(draft('must not publish'), 1));
      await open();
      if (phase === 'final') {
        click('library-load');
        await flush();
      }
      storage.faults.txStall = true;
      storage.faults.abortThrow = true;
      click(phase === 'initial' ? 'library-load' : 'library-confirm');
      await flush();
      const owner = storage.current;
      click(`${action}-design`);
      const transformed = get('editor').innerHTML;
      expect(get('library-status').textContent).toContain('Load into designer cancelled');
      expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
      expect(owner.native.abort).toHaveBeenCalledOnce();
      delete storage.faults.txStall;
      delete storage.faults.abortThrow;
      owner.complete();
      await flush();
      expect(get('editor').innerHTML).toBe(transformed);
      expect(get<HTMLInputElement>('blueprint-name').value).not.toBe('must not publish');
      expect(get<HTMLDialogElement>('library-dialog').open).toBe(false);
      expect(storage.values.get(first)).toBe(encodeRecord(draft('must not publish'), 1));
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
  it('keeps canvas method identities and complete invocation records stable within each fixture', () => {
    const context = get<HTMLCanvasElement>('world').getContext('2d')!,
      fillRect = context.fillRect,
      before = vi.mocked(fillRect).mock.calls.length;
    expect(context.fillRect).toBe(fillRect);
    expect(context.clearRect).not.toBe(fillRect);
    context.fillRect(1, 2, 3, 4);
    expect(vi.mocked(fillRect).mock.calls).toHaveLength(before + 1);
    expect(vi.mocked(fillRect).mock.calls.at(-1)).toEqual([1, 2, 3, 4]);
    context.lineWidth = 3;
    expect(context.lineWidth).toBe(3);
    expect(context.createImageData(2, 3).data).toEqual(new Uint8ClampedArray(24));
    context.fillRect = vi.fn();
    expect(context.fillRect).not.toBe(fillRect);
    expect(context.toString).toBe(Object.prototype.toString);
  });
  it('confirms every user reset with a frozen payload, cancellation focus and no ecological command on cancellation', () => {
    click('ecosystem-tab');
    expect(root.querySelectorAll('.world-settings')).toHaveLength(1);
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
  it('preserves existing terrain and world seed drafts when a real import is rejected', async () => {
    const bridge = ownershipBridge();
    set('terrain-preset', 'open-field', 'change');
    click('terrain-follow');
    set('terrain-seed', '99');
    set('seed', '123');
    const before = {
      preset: get<HTMLSelectElement>('terrain-preset').value,
      follows: get<HTMLInputElement>('terrain-follow').checked,
      terrainSeed: get<HTMLInputElement>('terrain-seed').value,
      seed: get<HTMLInputElement>('seed').value,
    };
    await loadText('{}');
    expect(get('notice').textContent).toContain('Not a valid EvoLab ecosystem');
    expect({
      preset: get<HTMLSelectElement>('terrain-preset').value,
      follows: get<HTMLInputElement>('terrain-follow').checked,
      terrainSeed: get<HTMLInputElement>('terrain-seed').value,
      seed: get<HTMLInputElement>('seed').value,
    }).toEqual(before);
    expect(bridge.records.size).toBe(0);
  });
  it('keeps newer terrain drafts through rejected real imports and revokes old wall results across reset', async () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals();
    click('clear-walls');
    const old = [...bridge.records.values()][0];
    await loadText('{}');
    set('terrain-preset', 'open-field', 'change');
    expect([...bridge.records.values()].some((record) => record.command.type === 'load')).toBe(
      false,
    );
    bridge.deliver(old.command.commandId);
    const load = [...bridge.records.values()].find((record) => record.command.type === 'load')!;
    bridge.deliver(load.command.commandId);
    expect(get('terrain-committed').textContent).toContain('Porous ridges');
    expect(get<HTMLSelectElement>('terrain-preset').value).toBe('open-field');
    bridge.emit(old.terminal);
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
    expect(observer.takeRecords()).toEqual([]);
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
    expect(worker.commands).toHaveBeenCalledTimes(1);
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
    expect(worker.commands).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'start',
        settings: DEFAULTS,
        runId: 1,
      }),
    );
    paint(0);
    window.dispatchEvent(new Event('resize'));
    click('step');
    expect(get<HTMLButtonElement>('step').disabled).toBe(true);
    click('pause');
    expect(get<HTMLButtonElement>('step').disabled).toBe(false);
    click('step');
    expect(worker.commands).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'step' }));
    click('pause');
    set('speed', '12', 'change');
    expect(worker.commands).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'speed', value: 12 }),
    );
    set('mutation', '.2');
    set('nutrients', '8');
    set('climate', '.5');
    set('brush', '5');
    expect(get('nutrients-value').textContent).toBe('8%');
    expect(get('brush-value').textContent).toBe('5 cells');
    root.querySelector<HTMLButtonElement>('[data-shock="heat"]')!.click();
    expect(worker.commands).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'shock', kind: 'heat' }),
    );
    set('seed', '-1');
    click('reset');
    expect(get('notice').textContent).toContain('whole-number');
    set('seed', '99');
    click('reset');
    expect(worker.commands).toHaveBeenLastCalledWith(
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
    populated.changeTerrain('clear');
    populated.spawn(founder(1), 2, 10);
    populated.spawn(founder(2), 2, 25);
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
    expect(get('organism-observed').textContent).toContain('Stale');
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
    expect(points(() => emit(ring.frame()))).toHaveLength(180);
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
    expect(worker.commands).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'inspect' }));
    pointer('pointermove', 155, 155);
    window.dispatchEvent(new Event('pointerup'));
    root.querySelector<HTMLButtonElement>('[data-tool="food"]')!.click();
    pointer('pointerdown');
    pointer('pointermove', 160, 150);
    expect(worker.commands).toHaveBeenLastCalledWith(
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
    expect(get('world').scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'center' }),
    );
    pointer('pointerdown');
    pointer('pointermove');
    window.dispatchEvent(new Event('pointerup'));
    expect(worker.commands).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'paint', tool: 'plant' }),
    );
    click('clear-design');
    expect(root.querySelectorAll('#editor button')).toHaveLength(81);
  });
  it('handles keyboard shortcuts, help, errors, and disposal', async () => {
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
    await loadText('{}');
    worker.emit({
      type: 'error',
      message: 'Bad import',
      recovery: { frame: sample, selected: null, settings: DEFAULTS, playback: worker.playback },
    });
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
    expect(worker.commands).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'save' }));
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
      expect(worker.commands).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'load',
          text: 'world',
          runId: 2,
        }),
      ),
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
    expect(worker.commands).toHaveBeenCalledTimes(1);
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

  it('rejects late native neural observations from a replaced run without changing paused state', async () => {
    const bridge = realWorker();
    bridge.deliver();
    click('pause');
    bridge.deliver();
    const source = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false);
    const genome = founder(0);
    genome.controller = newController();
    source.spawn(genome, 60, 60);
    await loadText(JSON.stringify(source.save()));
    const stale = structuredClone(
      bridge.outbox.filter((response) => response.type === 'frame' || response.type === 'loaded'),
    );
    expect(stale.length).toBeGreaterThan(0);
    bridge.deliver();
    await loadText(JSON.stringify(source.save()));
    bridge.deliver();
    if (get('run-state').textContent === 'LIVE') {
      click('pause');
      bridge.deliver();
    }
    const before = bridge.save(),
      markup = root.innerHTML;
    for (const response of stale) worker.onmessage!({ data: response } as MessageEvent);
    expect(root.innerHTML).toBe(markup);
    expect(bridge.save()).toEqual(before);
    click('step');
    bridge.deliver();
    const expected = Ecosystem.load(JSON.stringify(before));
    expected.step();
    expect(bridge.save()).toEqual(expected.save());
  });

  it('edits opt-in neural parameters without ticks and rejects invalid or stale designer data', async () => {
    const bridge = realWorker();
    bridge.deliver();
    click('pause');
    bridge.advance();
    bridge.deliver();
    const before = bridge.save();
    expect(get<HTMLInputElement>('neural-enabled').checked).toBe(false);
    get('neural-controls').dispatchEvent(new Event('change', { bubbles: true }));
    click('neural-enabled');
    expect(get('behavior-status').textContent).toContain('Neural controller v1');
    const weight = root.querySelector<HTMLInputElement>(
      '[data-neural="weights"][data-offset="0"]',
    )!;
    weight.value = '0.125';
    weight.dispatchEvent(new Event('change', { bubbles: true }));
    expect((await exported()).genome.controller!.weights[0]).toBe(0.125);
    for (const invalid of ['5', '-5', '']) {
      weight.value = invalid;
      weight.dispatchEvent(new Event('change', { bubbles: true }));
      expect(weight.value).toBe('0.125');
    }
    weight.dataset.offset = '100';
    weight.dispatchEvent(new Event('change', { bubbles: true }));
    weight.dataset.offset = '0';
    weight.dataset.neural = 'invalid';
    weight.dispatchEvent(new Event('change', { bubbles: true }));
    weight.dataset.neural = 'weights';
    const enabled = await exported();
    await importDraft(serializeBlueprint(enabled));
    expect((await exported()).genome).toEqual(enabled.genome);
    let resolve!: (text: string) => void;
    uploadBlueprint({ size: 20, text: () => new Promise((done) => (resolve = done)) });
    click('neural-enabled');
    resolve(serializeBlueprint(enabled));
    await flush();
    expect((await exported()).genome).not.toHaveProperty('controller');
    expect(get('neural-controls').innerHTML).toBe('');
    expect(bridge.save()).toEqual(before);
  });

  it('edits explicit propensity without world commands, retains exact imported values, and cancels stale designer reads', async () => {
    const bridge = realWorker();
    bridge.deliver();
    click('pause');
    bridge.advance();
    bridge.deliver();
    const before = bridge.save();
    expect(get<HTMLInputElement>('inherited-mutation').checked).toBe(false);
    expect(get<HTMLInputElement>('propensity').disabled).toBe(true);
    get('propensity').dispatchEvent(new Event('input'));
    expect((await exported()).genome).not.toHaveProperty('mutationPropensity');
    click('inherited-mutation');
    expect(get<HTMLInputElement>('propensity').disabled).toBe(false);
    expect((await exported()).genome.mutationPropensity).toBe(1);
    get<HTMLInputElement>('propensity').value = '0';
    get('propensity').dispatchEvent(new Event('input'));
    expect(get('propensity-value').textContent).toBe('0');
    expect((await exported()).genome.mutationPropensity).toBe(0);
    expect(bridge.save()).toEqual(before);
    const enabled = {
      ...fixture(),
      genome: { ...fixture().genome, mutationPropensity: 0.1234567890123456 },
    };
    await importDraft(serializeBlueprint(enabled));
    expect(get<HTMLInputElement>('inherited-mutation').checked).toBe(true);
    expect(get('propensity-value').textContent).toBe('0.1234567890123456');
    expect((await exported()).genome).toEqual(enabled.genome);
    let resolve!: (text: string) => void;
    uploadBlueprint({ size: 20, text: () => new Promise((r) => (resolve = r)) });
    click('inherited-mutation');
    resolve(serializeBlueprint(enabled));
    await flush();
    expect((await exported()).genome).not.toHaveProperty('mutationPropensity');
    expect(get('propensity-value').textContent).toBe('Global rate');
    expect(bridge.save()).toEqual(before);
    click('inherited-mutation');
    click('clear-design');
    expect((await exported()).genome).not.toHaveProperty('mutationPropensity');
  });

  it.each(['legacy', 'stored'])(
    'creates a fresh active design without activating %s data or changing the paused world',
    async (mode) => {
      const bridge = realWorker();
      bridge.deliver();
      click('pause');
      bridge.advance();
      bridge.deliver();
      const source = mode === 'stored' ? storedSensoryGenome() : founder(2);
      await importDraft(
        serializeBlueprint({ name: 'Retained', description: 'old metadata', genome: source }),
      );
      const before = bridge.save(),
        old = structuredClone(source);
      expect(root.querySelector('#reaction-editor')).toBeNull();
      click('new-active-design');
      const active = await exported();
      expect(active.genome).toEqual({
        ...founder(1),
        behavior: {
          version: 2,
          mode: 'evolved',
          reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
        },
      });
      expect(active.name).toBe('Untitled organism');
      expect(active.description).toBe('');
      expect(get('behavior-status').textContent).toContain('Active reactions');
      expect(root.querySelectorAll('[data-reaction]')).toHaveLength(4);
      expect(source).toEqual(old);
      expect(bridge.save()).toEqual(before);
      expect(get('run-state').textContent).toBe('PAUSED');
      click('clear-design');
      expect((await exported()).genome).toEqual(founder(0));
      expect(root.querySelector('#reaction-editor')).toBeNull();
    },
  );

  it('edits all inherited active reactions with stable native controls and complete detached placement', async () => {
    const bridge = realWorker();
    bridge.deliver();
    click('pause');
    bridge.advance();
    bridge.deliver();
    const source = storedSensoryGenome();
    if (source.behavior.mode === 'evolved') source.behavior.version = 2;
    await importDraft(
      serializeBlueprint({
        name: 'Active retained',
        description: 'exact metadata',
        genome: source,
      }),
    );
    const before = bridge.save();
    const edited = structuredClone(source);
    for (const category of ['food', 'wall', 'harmless', 'dangerous'] as const) {
      const select = get<HTMLSelectElement>(`reaction-${category}`);
      select.focus();
      for (const reaction of ['ignore', 'chase', 'flee'] as const) {
        select.value = reaction;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (edited.behavior.mode === 'evolved') edited.behavior.reactions[category] = reaction;
        expect((await exported()).genome).toEqual(edited);
        expect(get(`reaction-${category}`)).toBe(select);
        expect(document.activeElement).toBe(select);
      }
    }
    const controls = get('behavior-controls');
    controls.dispatchEvent(new Event('change', { bubbles: true }));
    const forged = document.createElement('select');
    controls.append(forged);
    forged.dataset.reaction = 'unknown';
    forged.innerHTML = '<option value="chase">Chase</option>';
    forged.dispatchEvent(new Event('change', { bubbles: true }));
    forged.dataset.reaction = 'food';
    forged.innerHTML = '<option value="attack">Attack</option>';
    forged.dispatchEvent(new Event('change', { bubbles: true }));
    expect((await exported()).genome).toEqual(edited);
    expect(bridge.save()).toEqual(before);
    click('plant-design');
    pointer('pointerdown');
    window.dispatchEvent(new Event('pointerup'));
    bridge.deliver();
    const planted = bridge.save();
    expect(planted.organisms.at(-1)!.genome).toEqual(edited);
    expect(planted.births).toBe(before.births);
    click('new-active-design');
    expect(bridge.save()).toEqual(planted);
    click('clear-design');
    const passiveForged = document.createElement('select');
    passiveForged.dataset.reaction = 'food';
    passiveForged.innerHTML = '<option value="flee">Flee</option>';
    get('behavior-controls').append(passiveForged);
    passiveForged.dispatchEvent(new Event('change', { bubbles: true }));
    expect((await exported()).genome).toEqual(founder(0));
  });

  it.each(['pointer-plant', 'inspector-capture'])(
    'detaches complete evolved and opaque data through real %s',
    async (boundary) => {
      const bridge = realWorker();
      bridge.deliver();
      click('pause');
      bridge.advance();
      bridge.deliver();
      const source = storedSensoryGenome(),
        original = structuredClone(source);
      await importDraft(
        serializeBlueprint({ name: 'Inherited λ', description: 'Complete', genome: source }),
      );
      const before = bridge.save();
      click('plant-design');
      pointer('pointerdown');
      window.dispatchEvent(new Event('pointerup'));
      bridge.deliver();
      const planted = bridge.save(),
        living = planted.organisms.at(-1)!;
      expect(living.genome).toEqual(original);
      expect(planted.births).toBe(before.births);
      expect(planted.interventions.entries.at(-1)?.kind).toBe('placement');
      if (boundary === 'inspector-capture') {
        root.querySelector<HTMLButtonElement>('[data-tool="inspect"]')!.click();
        pointer('pointerdown');
        window.dispatchEvent(new Event('pointerup'));
        bridge.deliver();
        expect(get('inspector').textContent).toContain('Stored reactions — inactive');
        click('copy-organism');
      }
      expect((await exported()).genome).toEqual(original);
      source.behavior = { version: 1, mode: 'legacy' };
      source.legacyExtensions![0][1] = [['null']];
      const posted = worker.postMessage.mock.calls
        .map(([message]) => message)
        .findLast((message) => message.type === 'paint');
      posted.genome.legacyExtensions[0][1] = [['string', 'posted-only']];
      expect((await exported()).genome).toEqual(original);
      expect(bridge.save()).toEqual(planted);
      expect(get('run-state').textContent).toBe('PAUSED');
    },
  );

  it.each(['legacy', 'evolved', 'edit', 'new-cell', 'reset', 'oversize-capture'])(
    'keeps passive status and complete designer semantics for %s',
    async (operation) => {
      const bridge = realWorker();
      bridge.deliver();
      click('pause');
      bridge.advance();
      bridge.deliver();
      const source = storedSensoryGenome();
      if (operation === 'legacy') source.behavior = { version: 1, mode: 'legacy' };
      await importDraft(serializeBlueprint({ name: 'Stored', description: '', genome: source }));
      const before = bridge.save();
      expect(get('behavior-status').textContent).toBe(
        operation === 'legacy'
          ? 'Legacy behavior — steering uses legacy rules.'
          : 'Stored reactions — inactive; steering uses legacy rules.',
      );
      if (operation === 'edit') {
        root.querySelector<HTMLButtonElement>('[data-cell="7"]')!.click();
        get('editor').querySelector<HTMLButtonElement>('[data-x="0"][data-y="0"]')!.click();
        set('preference', '0.75');
        const edited = (await exported()).genome;
        expect(edited.cells[0]).toEqual({ ...source.cells[0], type: 7 });
        expect(edited.behavior).toEqual(source.behavior);
        expect(edited.legacyExtensions).toEqual(source.legacyExtensions);
        expect(edited.preference).toBe(0.75);
      } else if (operation === 'new-cell') {
        get('editor').querySelector<HTMLButtonElement>('[data-x="-2"][data-y="0"]')!.click();
        const edited = (await exported()).genome;
        expect(edited.cells.at(-1)).toEqual({ x: -2, y: 0, type: 4 });
        expect(edited.cells.slice(0, -1)).toEqual(source.cells);
        expect(edited.behavior).toEqual(source.behavior);
        expect(edited.legacyExtensions).toEqual(source.legacyExtensions);
      } else if (operation === 'reset') {
        click('clear-design');
        expect((await exported()).genome).toEqual(founder(0));
        expect(get('behavior-status').textContent).toContain('Legacy behavior');
      } else if (operation === 'oversize-capture') {
        const large = storedSensoryGenome();
        large.legacyExtensions!.push(['large', [['string', 'λ'.repeat(9000)]]]);
        const candidate = new Ecosystem(DEFAULTS, false);
        candidate.spawn(large, 30, 30);
        await loadText(JSON.stringify(candidate.save()));
        bridge.deliver();
        click('pause');
        while (bridge.tasks.length) bridge.advance();
        bridge.deliver();
        bridge.command({ type: 'inspect', x: 30, y: 30 });
        bridge.deliver();
        const draft = draftState(),
          saved = bridge.save();
        click('copy-organism');
        bridge.deliver();
        expect(draftState()).toEqual(draft);
        expect(get('notice').textContent).toContain('16 KiB');
        expect(bridge.save()).toEqual(saved);
        expect((await exported()).genome).toEqual(source);
        return;
      } else expect((await exported()).genome).toEqual(source);
      expect(bridge.save()).toEqual(before);
    },
  );

  it.each([false, true])(
    'imports only into the designer, preserving exact traits and world commands (paused=%s)',
    async (paused) => {
      emit(sample, organism);
      if (paused) click('pause');
      click('plant-design');
      click('ecosystem-tab');
      const commands = worker.commands.mock.calls.length;
      vi.mocked(get('world').scrollIntoView).mockClear();
      await importDraft();
      expect(worker.commands).toHaveBeenCalledTimes(commands);
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
      expect(worker.commands).toHaveBeenCalledTimes(commands);
      click('plant-design');
      pointer('pointerdown');
      const message = worker.commands.mock.calls.at(-1)![0];
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
      version: 5,
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
    const commands = worker.commands.mock.calls.length;
    const invalid = [
      '{',
      '{}',
      'null',
      JSON.stringify({ ...JSON.parse(serializeBlueprint(fixture())), version: 6 }),
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
    expect(worker.commands).toHaveBeenCalledTimes(commands);
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
    'active-design',
    'reaction',
    'rotate',
    'mirror',
    'copy',
    'common',
    'reseed',
    'world-load',
    'picker',
    'cancel',
    'dispose',
  ])('ignores a delayed result and error after %s', async (action) => {
    emit(sample, organism);
    if (action === 'reaction') click('new-active-design');
    let finish!: (value: string) => void, reject!: (reason: unknown) => void;
    const change = async () => {
      if (action === 'cell')
        get('editor').querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!.click();
      if (action === 'preference') set('preference', '0.75');
      if (action === 'name') set('blueprint-name', 'edited');
      if (action === 'description') set('blueprint-description', 'edited');
      if (action === 'reset-design') click('clear-design');
      if (action === 'active-design') click('new-active-design');
      if (action === 'reaction') {
        const control = get<HTMLSelectElement>('reaction-food');
        control.value = 'flee';
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (action === 'rotate') click('rotate-design');
      if (action === 'mirror') click('mirror-design');
      if (action === 'copy') click('copy-organism');
      if (action === 'common') root.querySelector<HTMLButtonElement>('.lineage')!.click();
      if (action === 'reseed') click('reset');
      if (action === 'world-load') {
        if (worker.pendingCommand) worker.emit({ type: 'loaded', settings: DEFAULTS });
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
    for (const summary of root.querySelectorAll('summary')) {
      const space = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Space',
        key: ' ',
      });
      summary.dispatchEvent(space);
      expect(space.defaultPrevented).toBe(false);
    }
    expect(worker.commands).toHaveBeenCalledTimes(1);
    expect(get('world').dataset.tool).toBe('pan');
  });

  it('transforms full passive and opaque payloads in the designer without changing a real paused world', async () => {
    const harness = realWorker();
    harness.deliver();
    click('pause');
    harness.deliver();
    harness.advance();
    const original = storedSensoryGenome();
    await importDraft(
      serializeBlueprint({ name: 'Full design', description: 'Retain payload', genome: original }),
    );
    const before = harness.save();
    click('rotate-design');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    const transformed = viewModule.transformDesign(
      viewModule.transformDesign(original, 'rotate'),
      'mirror',
    );
    expect((await exported()).genome).toEqual(transformed);
    expect(harness.save()).toEqual(before);
    click('plant-design');
    pointer('pointerdown');
    window.dispatchEvent(new Event('pointerup'));
    harness.deliver();
    expect(harness.save().organisms.at(-1)!.genome).toEqual(transformed);
    expect(get('notice').textContent).toContain('Organism placed');
    expect(get('run-state').textContent).toBe('PAUSED');
  });

  it('keeps complete paused real-worker saves identical until explicit planting and exact Step', async () => {
    const harness = realWorker();
    harness.deliver();
    click('pause');
    harness.deliver();
    harness.advance();
    const save = () => JSON.stringify(harness.save());
    const before = save();
    await importDraft();
    await exported();
    expect(save()).toBe(before);
    expect(harness.tasks).toHaveLength(0);
    const population = JSON.parse(before).organisms.length;
    click('plant-design');
    pointer('pointerdown');
    window.dispatchEvent(new Event('pointerup'));
    harness.deliver();
    expect(JSON.parse(save()).organisms).toHaveLength(population + 1);
    expect(get('run-state').textContent).toBe('PAUSED');
    click('step');
    harness.deliver();
    expect(JSON.parse(save()).tick).toBe(JSON.parse(before).tick + 1);
    expect(get('run-state').textContent).toBe('PAUSED');
    expect(harness.tasks).toHaveLength(0);
  });
});

describe('authoritative playback presentation', () => {
  it('starts checked, sends a session-only boolean command, and waits for authoritative control acknowledgements', () => {
    expect(get<HTMLInputElement>('pause-on-extinction').checked).toBe(true);
    expect(get('extinction-summary').hidden).toBe(true);
    expect(get('extinction-help').textContent).toBe('On by default; applies to this tab.');
    expect(worker.commands).toHaveBeenCalledTimes(1);
    worker.postMessage.mockImplementation((data) => {
      if (data.type !== 'flow-ack') worker.commands(data);
    });
    click('pause');
    expect(get('run-state').textContent).toBe('LIVE');
    worker.emit({
      type: 'playback',
      playback: { paused: true, pauseOnExtinction: true, extinction: null },
    });
    expect(get('run-state').textContent).toBe('PAUSED');
    click('pause-on-extinction');
    expect(worker.commands).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'pause-on-extinction',
        runId: 1,
        value: false,
      }),
    );
    worker.emit({
      type: 'playback',
      playback: { paused: true, pauseOnExtinction: false, extinction: null },
    });
    expect(get<HTMLButtonElement>('step').disabled).toBe(false);
    expect(get('run-state').textContent).toBe('PAUSED');
    click('pause');
    expect(worker.commands).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'resume' }));
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
      expect(get('organism-observed').textContent).toContain('Stale');
      expect(get('lineages').textContent).toContain('quiet');
      const summary = get('extinction-summary').textContent;
      worker.postMessage.mockImplementation((data) => {
        if (data.type !== 'flow-ack') worker.commands(data);
      });
      click('pause');
      expect(get('notice').textContent).toContain(
        'Place an organism, or turn off Pause on extinction and press Resume.',
      );
      expect(get('run-state').textContent).toBe('PAUSED');
      worker.emit({ type: 'playback', playback });
      const beforeNotice = get('notice').textContent;
      worker.emit({ type: 'error', message: 'Rejected file' });
      expect(get('notice').textContent).toBe(beforeNotice);
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
      const empty = legacyV7(nearDeath());
      empty.organisms = [];
      expect(Ecosystem.load(JSON.stringify(empty)).save().organisms).toEqual([]);
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
        expect(harness.outbox.filter((data) => data.type === 'error')).toHaveLength(1);
        expect(harness.outbox.find((data) => data.type === 'error')).toMatchObject({
          type: 'error',
          runId: 3,
          recovery: { state: { settings: { nutrients: 0 } } },
        });
        const paths = chart.paths.length;
        if (multiple) {
          set('nutrients', '3');
          set('mutation', '0.37');
          set('climate', '0.25');
        }
        set('nutrients', '7');
        click('ecosystem-tab');
        const commands = worker.commands.mock.calls.length;
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
        expect(worker.commands.mock.calls).toHaveLength(commands);
        const reference = Ecosystem.load(JSON.stringify(before));
        reference.changeSettings({
          nutrients: 7,
          ...(multiple ? { mutation: 0.37, climate: 0.25 } : {}),
        });
        const expected = reference.save();
        expect(harness.save()).toEqual(before);
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
        const started = worker.commands.mock.calls.at(-1)![0];
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
    reference.changeSettings({ nutrients: 7, climate: 0.25 });
    expect(harness.save()).toEqual(reference.save());
    click('reset');
    expect(worker.commands.mock.calls.at(-1)![0]).toMatchObject({ settings: expected });
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
      const recovery = harness.outbox.find((data) => data.type === 'error');
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
        const held = [...harness.outbox];
        harness.deliver();
        const before = harness.save();
        const pending = harness.tasks.length;

        const paths = chart.paths.length;
        await loadText('{}');
        expect(get<HTMLButtonElement>('capture-selected').disabled).toBe(true);
        const beforeDisplay = root.innerHTML;
        for (const data of held) worker.onmessage!({ data } as MessageEvent);
        expect(root.innerHTML).toBe(beforeDisplay);
        expect(chart.paths).toHaveLength(paths);
        expect(harness.outbox.filter((data) => data.type === 'error')).toHaveLength(1);
        const recovery = harness.outbox.find((data) => data.type === 'error');
        expect(recovery).toMatchObject({ type: 'error', runId: 3 });
        harness.deliver();
        expect(get('notice').textContent).toContain('Not a valid EvoLab ecosystem');
        expect(get('population').textContent).toBe(String(before.organisms.length));
        expect(get('tick').textContent).toBe(`TICK ${before.tick}`);
        expect(get<HTMLInputElement>('seed').value).toBe(String(before.settings.seed));
        expect(get('nutrients-value').textContent).toBe(`${before.settings.nutrients}%`);
        const playback = recovery.recovery.state.playback;
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
          expect(get('organism-observed').textContent).toContain('Stale');
          expect(get('lineages').textContent).toContain('quiet');
          expect(get('extinction-summary').textContent).toContain('tick 72');
          expect(get('extinction-summary').textContent).toContain('age limit');
        }
        expect(harness.save()).toEqual(before);
        expect(harness.tasks).toHaveLength(pending);
        expect(chart.paths).toHaveLength(paths);
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
    emit(empty);
    const quietInspector = get('inspector').firstElementChild;
    const stableTick = get('tick').firstChild;
    for (let update = 0; update < 720; update++) {
      emit(empty);
      expect(get('inspector').firstElementChild).toBe(quietInspector);
      expect(get('tick').firstChild).toBe(stableTick);
    }
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
        { ...recovery, commandId: 0 },
        { type: 'loaded', runId: 2, state: recovery.recovery.state },
        { type: 'control', runId: 2, state: recovery.recovery.state },
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
    const count = worker.commands.mock.calls.length;
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
    expect(worker.commands).toHaveBeenCalledTimes(count);
    const next = world.frame();
    next.stats.tick = 123;
    worker.emit({ type: 'frame', frame: next, selected: null }, 1);
    expect(get('tick').textContent).toBe('TICK 123');
  });

  it('never treats validation recovery as permission to clear a fatal STOPPED display', () => {
    emit();
    worker.emit({ type: 'error', message: 'Tick failed', fatal: true });
    const commands = worker.commands.mock.calls.length;
    click('pause');
    expect(worker.commands).toHaveBeenCalledTimes(commands);
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
    expect(get('notice').textContent).toBe('Tick failed');
  });
});
describe('placement preview controls', () => {
  it.each(['pan', 'plant'])(
    'does not redraw an absent %s preview while failed-load recovery awaits its new frame',
    async (tool) => {
      const draws = vi.spyOn(viewModule, 'draw');
      const harness = realWorker(true);
      harness.deliver();
      paint(0);
      harness.deliver();
      click('pause');
      harness.deliver();
      paint(0);
      harness.deliver();
      if (tool === 'plant') {
        click('plant-design');
        paint(0);
      }
      const before = harness.save();
      click('refresh-habitat');
      const held = harness.outbox.splice(
        harness.outbox.findIndex((data) => data.type === 'frame'),
        1,
      )[0];
      expect(held).toBeDefined();
      harness.deliver();
      draws.mockClear();
      await loadText('{}');
      const terminal = harness.outbox.splice(
        harness.outbox.findIndex((data) => data.type === 'error'),
        1,
      )[0];
      expect(terminal.recovery).toBeDefined();
      worker.onmessage!({ data: held } as MessageEvent);
      worker.onmessage!({ data: terminal } as MessageEvent);
      paint(0);
      expect(draws).not.toHaveBeenCalled();
      harness.deliver();
      paint(0);
      expect(draws).toHaveBeenCalledTimes(1);
      expect(harness.save()).toEqual(before);
    },
  );

  const touch = (type: string, x: number, y: number, id = 7) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
    Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: id } });
    get('world').dispatchEvent(event);
  };
  it('draws seam ghosts with feedback through the same zoom/pan camera and cancels without commands', () => {
    const drawSpy = vi.spyOn(viewModule, 'draw');
    emit(new Ecosystem(DEFAULTS, false).frame());
    paint(0);
    click('plant-design');
    const canvas = get<HTMLCanvasElement>('world');
    let v = viewport(canvas, { zoom: 1, x: 0, y: 0 });
    const commands = worker.commands.mock.calls.length;
    pointer('pointermove', v.left + v.scale / 2, v.top + v.scale / 2);
    paint(1);
    expect(get('placement-feedback').textContent).toContain('Valid in displayed tick 0 at 0, 0');
    expect(drawSpy.mock.calls.at(-1)![6]!.positions).toContain(model.index(239, 0));
    click('zoom-in');
    pointer('dblclick');
    paint(2);
    const camera = drawSpy.mock.calls.at(-1)![3];
    expect(camera.zoom).toBe(1.4);
    v = viewport(canvas, camera);
    pointer('pointermove', v.left + 239.5 * v.scale, v.top + 155.5 * v.scale);
    paint(3);
    expect(get('placement-feedback').textContent).toContain('at 239, 155');
    expect(drawSpy.mock.calls.at(-1)![6]!.positions).toEqual(
      model.positions({ genome: founder(0), x: 239, y: 155, rotation: 0 }),
    );
    const blocked = new Ecosystem(DEFAULTS, false);
    blocked.walls[model.index(239, 155)] = 1;
    emit(blocked.frame());
    paint(4);
    expect(get('placement-feedback').textContent).toContain('Blocked');
    pointer('pointerleave');
    paint(5);
    expect(drawSpy.mock.calls.at(-1)![6]).toBeUndefined();
    pointer('pointermove', v.left - 1, v.top - 1);
    paint(6);
    expect(get('placement-feedback').textContent).toContain('Move over');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    paint(7);
    expect(get('placement-feedback').textContent).toBe('');
    expect(get('world').dataset.tool).toBe('pan');
    expect(worker.commands).toHaveBeenCalledTimes(commands);
  });
  it('previews touch before stamping, invalidates confirmation on a transform, and cancels pointers', () => {
    emit(new Ecosystem(DEFAULTS, false).frame());
    paint(0);
    click('plant-design');
    const v = viewport(get<HTMLCanvasElement>('world'), { zoom: 1, x: 0, y: 0 });
    const x = v.left + 20.5 * v.scale,
      y = v.top + 20.5 * v.scale;
    const commands = worker.commands.mock.calls.length;
    touch('pointerdown', x, y);
    touch('pointermove', x, y, 9);
    touch('pointercancel', x, y, 9);
    touch('pointerup', x, y);
    pointer('pointerleave');
    paint(1);
    expect(get('placement-feedback').textContent).toContain('Tap this anchor again');
    expect(worker.commands).toHaveBeenCalledTimes(commands);
    click('rotate-design');
    touch('pointerdown', x, y);
    touch('pointerup', x, y);
    expect(worker.commands).toHaveBeenCalledTimes(commands);
    touch('pointerdown', x, y);
    touch('pointerup', x, y);
    expect(worker.commands).toHaveBeenCalledTimes(commands + 1);
    touch('pointerdown', -100, -100);
    touch('pointercancel', -100, -100);
    paint(2);
    expect(get('placement-feedback').textContent).toContain('Move over');
    click('cancel-placement');
    expect(canvasTool()).toBe('pan');
  });
  it('keeps an armed touch ghost at its world anchor through dragging, zoom and resize', () => {
    const drawSpy = vi.spyOn(viewModule, 'draw');
    emit(new Ecosystem(DEFAULTS, false).frame());
    paint(0);
    click('plant-design');
    const canvas = get<HTMLCanvasElement>('world');
    const v = viewport(canvas, { zoom: 1, x: 0, y: 0 });
    const commands = worker.commands.mock.calls.length;
    const a = { x: v.left + 100.5 * v.scale, y: v.top + 70.5 * v.scale };
    const b = { x: v.left + 110.5 * v.scale, y: v.top + 80.5 * v.scale };
    touch('pointerdown', a.x, a.y);
    touch('pointermove', b.x, b.y);
    touch('pointerup', b.x, b.y);
    paint(1);
    const expected = model.positions({ genome: founder(0), x: 100, y: 70, rotation: 0 });
    expect(drawSpy.mock.calls.at(-1)![6]!.positions).toEqual(expected);
    expect(get('placement-feedback').textContent).toContain('at 100, 70');
    click('zoom-in');
    paint(2);
    Object.defineProperty(canvas, 'clientWidth', { value: 600 });
    window.dispatchEvent(new Event('resize'));
    paint(3);
    expect(drawSpy.mock.calls.at(-1)![6]!.positions).toEqual(expected);
    expect(get('placement-feedback').textContent).toContain('at 100, 70');
    expect(worker.commands).toHaveBeenCalledTimes(commands);
    const camera = drawSpy.mock.calls.at(-1)![3];
    const changed = viewport(canvas, camera);
    const next = { x: changed.left + 110.5 * changed.scale, y: changed.top + 80.5 * changed.scale };
    touch('pointerdown', next.x, next.y);
    touch('pointerup', next.x, next.y);
    paint(4);
    expect(get('placement-feedback').textContent).toContain('at 110, 80');
    expect(worker.commands).toHaveBeenCalledTimes(commands);
    touch('pointerdown', next.x, next.y);
    touch('pointerup', next.x, next.y);
    expect(worker.commands).toHaveBeenCalledTimes(commands + 1);
    expect(worker.commands.mock.calls.at(-1)![0]).toMatchObject({ type: 'paint', x: 110, y: 80 });
  });
  it.each(['mouse', 'pen'])(
    'releases staged touch ownership to a %s preview and stamp',
    (pointerType) => {
      const drawSpy = vi.spyOn(viewModule, 'draw');
      const harness = realWorker(true);
      harness.deliver();
      click('pause');
      harness.deliver();
      paint(0);
      click('plant-design');
      const before = harness.save();
      const canvas = get<HTMLCanvasElement>('world');
      const v = viewport(canvas, { zoom: 1, x: 0, y: 0 });
      touch('pointerdown', v.left + 100.5 * v.scale, v.top + 70.5 * v.scale);
      touch('pointerup', v.left + 100.5 * v.scale, v.top + 70.5 * v.scale);
      paint(1);
      expect(get('placement-feedback').textContent).toContain('at 100, 70');
      const x = v.left + 110.5 * v.scale,
        y = v.top + 80.5 * v.scale;
      const input = (type: string) => {
        const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
        Object.defineProperties(event, {
          pointerType: { value: pointerType },
          pointerId: { value: 8 },
        });
        canvas.dispatchEvent(event);
      };
      input('pointermove');
      paint(2);
      expect(get('placement-feedback').textContent).toContain('at 110, 80');
      expect(get('placement-feedback').textContent).not.toContain('Tap this anchor again');
      expect(drawSpy.mock.calls.at(-1)![6]!.positions).toEqual(
        model.positions({ genome: founder(0), x: 110, y: 80, rotation: 0 }),
      );
      expect(harness.save()).toEqual(before);
      input('pointerdown');
      input('pointerup');
      harness.deliver();
      expect(
        worker.commands.mock.calls.findLast(([data]) => data.type === 'paint')![0],
      ).toMatchObject({ x: 110, y: 80 });
      expect(harness.save().organisms.at(-1)).toMatchObject({ x: 110, y: 80 });
    },
  );
  function canvasTool() {
    return get('world').dataset.tool;
  }
  it('rejects invalid transforms, preserves native input keys, and ignores held transform shortcuts', () => {
    const before = get('editor').innerHTML;
    get('blueprint-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', repeat: true }));
    expect(get('editor').innerHTML).toBe(before);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    get('editor').querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!.click();
    click('rotate-design');
    expect(get('notice').textContent).toContain('connected cells before transforming');
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
    draw(canvas, buffer, sample, camera, false, 0, undefined, new Set([organism.id]));
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
    const firstId = [...bridge.records.keys()][0];
    paint(0);
    const earlierFrame = structuredClone(bridge.latestFrame);
    expect(get<HTMLInputElement>('refuge-enabled').checked).toBe(true);
    click('refuge-enabled');
    expect(bridge.records.size).toBe(1);
    bridge.deliver(firstId);
    const secondId = [...bridge.records.keys()][0];
    paint(0);
    expect(bridge.latestFrame.state.revision).toBeGreaterThan(earlierFrame.state.revision);
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
    paint(0);
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
    expect(
      worker.postMessage.mock.calls
        .slice(calls)
        .map(([command]) => command.type)
        .filter((type) => type !== 'flow-ack'),
    ).toEqual(['load']);
    click('pause');
    harness.deliver();
    click('step');
    harness.deliver();
    candidate.step();
    expect(harness.save()).toEqual(candidate.save());
  });
  it('bounds thermal intents behind one native owner and reserves close without retrying rejected points', () => {
    const bridge = ownershipBridge();
    click('refuge-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="warm"]')!.click();
    bridge.blockProcessing();
    pointer('pointerdown');
    for (let point = 0; point < 32; point++) pointer('pointermove', 50 + point, 50);
    pointer('pointerup');
    expect(bridge.records.size).toBe(1);
    expect(bridge.counts.C).toBe(0);
    expect(get('notice').textContent).toContain('Partial temperature stroke');
    bridge.processAll();
    expect(bridge.records.size).toBe(0);
    expect(bridge.counts.M).toBeLessThanOrEqual(32);
    expect(bridge.counts.C).toBe(1);
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
    expect(bridge.counts).toMatchObject({ M: 7, C: 1 });
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
      {
        behavior: { version: 1 as const, mode: 'legacy' as const },
        cells: [{ x: 0, y: 0, type: 7 }],
        preference: 0.75,
        tolerance: 0.125,
        tempo: 5,
      },
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

describe('explicit painted shade controls and authoritative views', () => {
  it('does not let held earlier mode receipts or frames revert a newer authoritative frame', () => {
    const bridge = ownershipBridge();
    bridge.holdTerminals((data) => data.operation === 'shade-mode');
    click('shade-enabled');
    const firstId = [...bridge.records.keys()][0];
    paint(0);
    const earlierFrame = structuredClone(bridge.latestFrame);
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(true);
    click('shade-enabled');
    expect(bridge.records.size).toBe(1);
    bridge.deliver(firstId);
    const secondId = [...bridge.records.keys()][0];
    paint(0);
    expect(bridge.latestFrame.state.revision).toBeGreaterThan(earlierFrame.state.revision);
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(false);
    bridge.emit(earlierFrame);
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(false);
    bridge.deliver(secondId);
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(false);
    expect(bridge.records.size).toBe(0);
  });
  it('keeps authoritative mode during pending delivery, rejects wrong echoes and drains the matching owner once', () => {
    const bridge = ownershipBridge();
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(false);
    bridge.holdTerminals((data) => data.operation === 'shade-mode');
    click('shade-enabled');
    const [id, record] = [...bridge.records].find(
      ([, record]) => record.command.type === 'shade-mode',
    )!;
    expect(get('shade-pending').textContent).toContain('Pending');
    paint(0);
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(true);
    bridge.emit({ ...record.terminal, enabled: false });
    expect(get('shade-pending').textContent).toContain('Pending');
    bridge.deliver(id);
    expect(get('shade-pending').textContent).toBe('');
    expect(get('notice').textContent).toContain('applied');
    bridge.holdTerminals(() => false);
    click('shade-enabled');
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(false);
    bridge.emit(record.terminal);
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(false);
  });
  it('paints shade independently of invalid designer anatomy and freezes each stroke configuration', () => {
    const bridge = ownershipBridge();
    click('shade-enabled');
    root.querySelector<HTMLButtonElement>('[data-x="4"][data-y="4"]')!.click();
    set('brush', '1');
    set('shade-intensity', '12');
    root.querySelector<HTMLButtonElement>('[data-tool="shade"]')!.click();
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 60, 50);
    set('shade-intensity', '4');
    pointer('pointermove', 70, 50);
    pointer('pointerup');
    const history = bridge.latestFrame.frame.interventions.entries;
    expect(history.at(-1)).toMatchObject({
      kind: 'shade-paint',
      detail: { rulesVersion: 1, units: 12, radius: 1, successfulCommands: 2 },
    });
    root.querySelector<HTMLButtonElement>('[data-tool="lighten"]')!.click();
    pointer('pointerdown', 50, 50);
    pointer('pointerup');
    expect(bridge.latestFrame.frame.interventions.entries.at(-1)).toMatchObject({
      detail: { tool: 'lighten', units: -4 },
    });
    root.querySelector<HTMLButtonElement>('[data-tool="erase-shade"]')!.click();
    expect(get<HTMLInputElement>('shade-intensity').disabled).toBe(true);
    pointer('pointerdown', 50, 50);
    pointer('pointerup');
    expect(bridge.latestFrame.frame.interventions.entries.at(-1)).toMatchObject({
      detail: { tool: 'erase-shade', units: 0 },
    });
    get<HTMLInputElement>('shade-intensity').type = 'number';
    set('shade-intensity', '33');
    expect(get('notice').textContent).toContain('whole-number');
    expect(bridge.records.size).toBe(0);
  });
  it('retains inactive stored paint, clears only shade and truthfully distinguishes no-op actions', () => {
    const bridge = ownershipBridge();
    click('shade-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="shade"]')!.click();
    pointer('pointerdown', 50, 50);
    pointer('pointerup');
    const before = bridge.latestFrame.frame;
    click('shade-enabled');
    expect(get('shade-summary').textContent).toContain('Disabled · stored paint');
    const disabledTool = root.querySelector<HTMLButtonElement>('button[data-tool="shade"]')!;
    expect(disabledTool.disabled).toBe(true);
    disabledTool.disabled = false;
    disabledTool.click();
    expect(get('notice').textContent).toContain('Enable painted shade');
    pointer('pointerdown', 50, 50);
    pointer('pointerup');
    expect(get('notice').textContent).toContain('disabled');
    click('clear-shade');
    expect(get('shade-summary').textContent).toContain('Disabled · empty');
    expect(bridge.latestFrame.frame.stats).toEqual(before.stats);
    expect(bridge.latestFrame.frame.cells).toEqual(before.cells);
    click('clear-shade');
    expect(get('notice').textContent).toContain('unchanged');
  });
  it('restores imported mode and failed-load field atomically without posting draft intensity as settings', async () => {
    const harness = realWorker();
    harness.deliver();
    const candidate = new Ecosystem();
    candidate.changeShadeMode(true);
    candidate.paintShade({ rulesVersion: 1, tool: 'shade', radius: 0, units: 12 }, 120, 78);
    await loadText(JSON.stringify(candidate.save()));
    harness.deliver();
    expect(get('notice').textContent).toContain('Imported painted field');
    set('shade-intensity', '15');
    const before = harness.save(),
      calls = worker.postMessage.mock.calls.length;
    await loadText(
      JSON.stringify({
        ...before,
        shadeHabitats: { ...before.shadeHabitats, cells: [[37440, 4]] },
      }),
    );
    harness.deliver();
    expect(harness.save()).toEqual(before);
    expect(get<HTMLInputElement>('shade-enabled').checked).toBe(true);
    expect(get<HTMLInputElement>('shade-intensity').value).toBe('15');
    expect(
      worker.postMessage.mock.calls
        .slice(calls)
        .map(([command]) => command.type)
        .filter((type) => type !== 'flow-ack'),
    ).toEqual(['load']);
    click('pause');
    harness.deliver();
    click('step');
    harness.deliver();
    candidate.step();
    expect(harness.save()).toEqual(candidate.save());
  });
  it('bounds shade intents behind one native owner and reserves close without retrying rejected points', () => {
    const bridge = ownershipBridge();
    click('shade-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="shade"]')!.click();
    bridge.blockProcessing();
    pointer('pointerdown', 50, 50);
    for (let point = 0; point < 32; point++) pointer('pointermove', 50 + point, 50);
    pointer('pointerup');
    expect(bridge.records.size).toBe(1);
    expect(bridge.counts.C).toBe(0);
    expect(get('notice').textContent).toContain('Partial shade stroke');
    bridge.processAll();
    expect(bridge.records.size).toBe(0);
    expect(bridge.counts.M).toBeLessThanOrEqual(32);
    expect(bridge.counts.C).toBe(1);
    const count = bridge.counts.M;
    expect(get('shade-pending').textContent).toBe('');
    expect(bridge.counts.M).toBe(count);
  });
  it('stops an injected four-command shade UI ceiling without modifying real production limits', async () => {
    vi.resetModules();
    vi.doMock('../src/model', async (original) => ({
      ...(await original<object>()),
      STROKE_COMMAND_CAPACITY: 4,
    }));
    const { mount: boundedMount } = await import('../src/main');
    vi.doUnmock('../src/model');
    const bridge = ownershipBridge(boundedMount);
    click('shade-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="shade"]')!.click();
    pointer('pointerdown', 50, 50);
    for (let command = 1; command < 4; command++) pointer('pointermove');
    pointer('pointermove');
    pointer('pointerup');
    expect(bridge.counts).toMatchObject({ M: 7, C: 1 });
    expect(bridge.latestFrame.frame.interventions.entries.at(-1).detail.successfulCommands).toBe(4);
    expect(bridge.records.size).toBe(0);
  });
  it('presents all three distinct manual shade detail kinds without treating them as shocks', () => {
    const bridge = ownershipBridge();
    click('shade-enabled');
    root.querySelector<HTMLButtonElement>('[data-tool="shade"]')!.click();
    pointer('pointerdown', 50, 50);
    pointer('pointerup');
    click('clear-shade');
    for (const entry of bridge.latestFrame.frame.interventions.entries) {
      set('telemetry-intervention', String(entry.sequence), 'change');
      paint(0);
      const detail = get('telemetry').textContent;
      expect(detail).toContain('Rules version');
      if (entry.kind === 'shade-paint') expect(detail).toContain('not a replay');
      if (entry.kind === 'shade-clear') expect(detail).toContain('Mode unchanged');
    }
  });
});

describe('internal transport posting failures', () => {
  it.each(['Error', 'DataCloneError'])(
    'terminates latest-view posting failure %s without wedging command credit',
    (kind) => {
      const harness = realWorker(true);
      harness.deliver();
      const nativePost = worker.postMessage.getMockImplementation()!;
      worker.postMessage.mockImplementation((data) => {
        if (data.type === 'display-view') {
          if (kind === 'DataCloneError') throw new DOMException('proven internal nonpost', kind);
          throw new Error('internal transport failed');
        }
        nativePost(data);
      });
      click('render-habitat');
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(get('run-state').textContent).toBe('STOPPED');
      const before = worker.commands.mock.calls.length;
      click('save');
      expect(worker.commands.mock.calls).toHaveLength(before);
    },
  );
  it.each(['progress', 'display-rendered', 'display-discarded'])(
    'terminates failed internal acknowledgement %s',
    (channel) => {
      const harness = realWorker(true);
      const nativePost = worker.postMessage.getMockImplementation()!;
      worker.postMessage.mockImplementation((data) => {
        if (
          data.type === 'flow-ack' &&
          data.channel === (channel === 'progress' ? 'progress' : 'display')
        )
          throw new Error('internal acknowledgement failed');
        nativePost(data);
      });
      expect(() => {
        harness.deliver();
        if (channel === 'display-rendered') paint(0);
        if (channel === 'display-discarded') {
          click('render-habitat');
          harness.deliver();
        }
      }).not.toThrow();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(get('run-state').textContent).toBe('STOPPED');
      const before = worker.postMessage.mock.calls.length;
      worker.onmessage!({
        data: { type: 'progress', runId: 1, sequence: Number.MAX_SAFE_INTEGER },
      } as MessageEvent);
      expect(worker.postMessage.mock.calls).toHaveLength(before);
    },
  );
});

describe('lineage exploration with real worker state', () => {
  it('requests archive evidence only on opening, preserves paused ecology and failed-load identity, and clears on reseed', async () => {
    const bridge = realWorker(true);
    expect(bridge.outbox.find((data) => data.state)?.state.world.lineage).toBeUndefined();
    bridge.deliver();
    click('pause');
    bridge.deliver();
    const before = bridge.save();
    click('ecosystem-tab');
    const explorer = get<HTMLDetailsElement>('lineage-explorer');
    explorer.open = true;
    explorer.dispatchEvent(new Event('toggle'));
    bridge.deliver();
    expect(get('lineage-rows').children).toHaveLength(1);
    get('lineage-rows').querySelector<HTMLButtonElement>('button')!.click();
    const painter = vi.spyOn(viewModule, 'draw');
    paint(0);
    expect(painter.mock.calls.at(-1)![7]).toEqual(new Set([before.organisms[0].id]));
    click('plant-design');
    pointer('pointermove', 450, 325);
    paint(1);
    expect(painter.mock.calls.at(-1)![6]).toEqual(
      expect.objectContaining({ positions: expect.any(Array), blocked: expect.any(Boolean) }),
    );
    expect(painter.mock.calls.at(-1)![7]).toEqual(new Set([before.organisms[0].id]));
    click('cancel-placement');
    expect(bridge.save()).toEqual(before);
    const retained = get('lineage-detail').textContent;
    await loadText('{"invalid":true}');
    bridge.deliver();
    expect(get('lineage-detail').textContent).toBe(retained);
    expect(get('lineage-rows').querySelector('[aria-pressed="true"]')).not.toBeNull();
    click('organism-tab');
    click('step');
    bridge.deliver();
    expect(bridge.save().tick).toBe(before.tick + 1);
    click('ecosystem-tab');
    expect(get('lineage-observed').textContent).toContain(`Observed at tick ${before.tick + 1}`);
    explorer.open = false;
    explorer.dispatchEvent(new Event('toggle'));
    click('reset');
    bridge.deliver();
    explorer.open = true;
    explorer.dispatchEvent(new Event('toggle'));
    expect(get('lineage-detail').textContent).toContain('Select a lineage');
    expect(get('lineage-rows').querySelector('[aria-pressed="true"]')).toBeNull();
  });
});

it('keeps roles subscription across views, resets evidence on replacement and retains failed-load evidence', async () => {
  const bridge = realWorker(true);
  bridge.deliver();
  click('pause');
  bridge.deliver();
  const before = bridge.save();
  const panel = get<HTMLDetailsElement>('ecological-roles');
  panel.open = true;
  panel.dispatchEvent(new Event('toggle'));
  bridge.deliver();
  expect(get('roles-coverage').textContent).toContain('0 completed ticks covered');
  expect(bridge.save()).toEqual(before);
  click('step');
  bridge.deliver();
  expect(get('roles-coverage').textContent).toContain('1 completed ticks covered');
  expect(get('roles-tables').textContent).toContain('photosynthesis');
  const retained = get('roles-tables').textContent;
  await loadText('{}');
  bridge.deliver();
  expect(get('roles-tables').textContent).toBe(retained);
  click('organism-tab');
  click('ecosystem-tab');
  bridge.deliver();
  expect(get('roles-tables').textContent).toBe(retained);
  click('reset');
  bridge.deliver();
  expect(get('roles-coverage').textContent).toContain('Session began at tick 0');
  expect(get('roles-tables').querySelectorAll('tbody tr')).toHaveLength(0);
});

it('validates and retains the opt-in ecological roles display flag', () => {
  const display = { epoch: 7, enabled: false, visible: true, roles: true };
  expect(captureCommand({ type: 'start', settings: DEFAULTS, display }, DEFAULTS)).toMatchObject({
    display,
  });
  expect(() =>
    captureCommand(
      { type: 'start', settings: DEFAULTS, display: { ...display, roles: false } },
      DEFAULTS,
    ),
  ).toThrow('Invalid initial settings or display.');
});

it('validates and retains the opt-in lineage display flag without changing ecology settings', () => {
  const display = { epoch: 7, enabled: true, visible: false, lineage: true };
  expect(captureCommand({ type: 'start', settings: DEFAULTS, display }, DEFAULTS)).toMatchObject({
    display,
  });
  expect(() =>
    captureCommand(
      { type: 'start', settings: DEFAULTS, display: { ...display, lineage: false } },
      DEFAULTS,
    ),
  ).toThrow('Invalid initial settings or display.');
});

describe('complete local checkpoint worker integration', () => {
  const pending = async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
  };
  it('captures the complete real-worker Save without a download and restores via the existing validator', async () => {
    const native = libraryHarness();
    vi.stubGlobal('indexedDB', native.factory);
    const harness = realWorker(true);
    harness.deliver();
    click('pause');
    harness.deliver();
    const before = harness.save();
    click('checkpoint-refresh');
    await pending();
    click('checkpoint-save');
    harness.deliver();
    await pending();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    const stored = JSON.parse(native.values.get(1) as string);
    expect(JSON.parse(stored.world)).toEqual(before);
    click('step');
    harness.deliver();
    expect(harness.save().tick).toBe(before.tick + 1);
    click('checkpoint-restore');
    click('checkpoint-confirm');
    await pending();
    harness.deliver();
    expect(harness.save()).toEqual(before);
    const invalid = JSON.parse(stored.world);
    invalid.random = 'invalid';
    native.values.set(1, checkpointRecord('invalid world', JSON.stringify(invalid)));
    click('checkpoint-refresh');
    await pending();
    click('checkpoint-restore');
    click('checkpoint-confirm');
    await pending();
    harness.deliver();
    expect(harness.save()).toEqual(before);
    expect(get('notice').textContent).toContain('Not a valid');
  });
  it('rejects capture and restore while another lifecycle owns capacity, and cancels stale Save delivery', async () => {
    const native = libraryHarness();
    vi.stubGlobal('indexedDB', native.factory);
    native.values.set(1, checkpointRecord('stored', JSON.stringify(world.save())));
    click('checkpoint-refresh');
    await pending();
    click('save');
    set('checkpoint-slot', '2', 'change');
    click('checkpoint-save');
    expect(get('checkpoint-status').textContent).toContain('not saved');
    let finish!: (text: string) => void;
    upload({
      size: 2,
      text: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    set('checkpoint-slot', '1', 'change');
    click('checkpoint-restore');
    finish(JSON.stringify(world.save()));
    await pending();
    click('checkpoint-confirm');
    await pending();
    expect(get('checkpoint-status').textContent).toContain('active world was retained');
  });
  it('clears capture ownership after fatal post failures and stale world generation delivery', async () => {
    const native = libraryHarness();
    vi.stubGlobal('indexedDB', native.factory);
    click('checkpoint-refresh');
    await pending();
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('native transport stopped');
    });
    click('checkpoint-save');
    expect(get('checkpoint-status').textContent).toContain('not saved');
    const harness = realWorker(true);
    harness.deliver();
    click('checkpoint-refresh');
    await pending();
    click('checkpoint-save');
    click('reset');
    harness.deliver();
    await pending();
    expect(native.values.size).toBe(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(get('checkpoint-status').textContent).toContain('cancelled');
  });
  it('rejects busy lifecycle capture and native post failure without wedging checkpoint controls', async () => {
    const native = libraryHarness();
    vi.stubGlobal('indexedDB', native.factory);
    click('checkpoint-refresh');
    await pending();
    click('load');
    worker.postMessage.mockImplementationOnce(() => {
      throw new DOMException('failed clone', 'DataCloneError');
    });
    click('checkpoint-save');
    await pending();
    expect(get('checkpoint-status').textContent).toContain('not saved');
    click('checkpoint-save');
    worker.emit({ type: 'error', message: 'World file exceeds 2.5 MB.', fatal: false });
    await pending();
    expect(get('checkpoint-status').textContent).toContain('2.5 MB');
    expect(native.values.size).toBe(0);
  });
});

it('keeps follow, wrapped highlights and differences read-only through paused real-worker death, stale frames and replacement', async () => {
  const bridge = realWorker(true);
  bridge.deliver();
  click('pause');
  bridge.deliver();
  const organism = bridge.save().organisms[0];
  bridge.command({ type: 'inspect', x: organism.x, y: organism.y });
  bridge.deliver();
  paint(0);
  bridge.deliver();
  const before = bridge.save(),
    commands = worker.commands.mock.calls.length;
  expect(get('organism-diff').textContent).toContain('own lineage');
  const painter = vi.spyOn(viewModule, 'draw');
  click('follow-organism');
  paint(1);
  bridge.deliver();
  expect(painter.mock.calls.at(-1)![3].wrapped).toBe(true);
  expect(get('follow-status').textContent).toContain(`Following organism ${organism.id}`);
  click('release-follow');
  click('follow-organism');
  paint(2);
  bridge.deliver();
  expect(worker.commands.mock.calls).toHaveLength(commands);
  expect(bridge.save()).toEqual(before);
  click('zoom-in');
  expect(get('follow-status').textContent).toContain('off');
  click('follow-organism');
  paint(3);
  bridge.deliver();
  click('fit');
  expect(get('follow-status').textContent).toContain('off');
  click('follow-organism');
  paint(4);
  bridge.deliver();
  root.querySelector<HTMLButtonElement>('[data-tool="pan"]')!.click();
  pointer('pointerdown', 100, 100);
  expect(get('follow-status').textContent).toContain('off');
  window.dispatchEvent(new Event('pointerup'));
  expect(bridge.save()).toEqual(before);
  click('follow-organism');
  paint(5);
  bridge.deliver();
  // An authoritative rejected import keeps the same world and identity.
  await loadText('{}');
  bridge.deliver();
  expect(get('follow-status').textContent).toContain(`Following organism ${organism.id}`);
  expect(bridge.save()).toEqual(before);
  paint(6);
  bridge.deliver();
  // Hold an actual native frame lease while a later death control is accepted.
  click('refresh-habitat');
  const position = bridge.outbox.findIndex((data) => data.type === 'frame');
  expect(position).toBeGreaterThanOrEqual(0);
  const old = bridge.outbox.splice(position, 1)[0];
  bridge.deliver();
  root.querySelector<HTMLButtonElement>('[data-tool="erase"]')!.click();
  const transform = viewport(get('world'), painter.mock.calls.at(-1)![3]);
  pointer(
    'pointerdown',
    transform.left + (organism.x + 0.5) * transform.scale,
    transform.top + (organism.y + 0.5) * transform.scale,
  );
  window.dispatchEvent(new Event('pointerup'));
  bridge.deliver();
  paint(8);
  bridge.deliver();
  expect(get('organism-observed').textContent).toContain('Stale');
  expect(get('inspector').textContent).toContain(`Organism ${organism.id}`);
  expect(get<HTMLButtonElement>('follow-organism').disabled).toBe(true);
  const after = bridge.save();
  worker.onmessage!({ data: old } as MessageEvent);
  paint(9);
  bridge.deliver();
  expect(get('organism-observed').textContent).toContain('Stale');
  expect(painter.mock.calls.at(-1)![5]).toBe(0);
  expect(bridge.save()).toEqual(after);
  await loadText(JSON.stringify(before));
  bridge.deliver();
  expect(get('organism-observed').textContent).toBe('');
  expect(get('organism-diff').textContent).toBe('');
  expect(get('follow-status').textContent).toContain('off');
  click('reset');
  bridge.deliver();
  expect(get('inspector').textContent).toContain('Click any organism');
});

describe('separate light display and current leaf observations', () => {
  it('shows active transmission independently of temperature and retains functional colors', () => {
    const candidate = new Ecosystem({ ...DEFAULTS, climate: 0 }, false);
    const organism = candidate.spawn(
      {
        cells: [
          { x: 0, y: 0, type: 4 },
          { x: 1, y: 0, type: 4 },
        ],
        preference: 0.5,
        tolerance: 0.2,
        tempo: 2,
        behavior: { version: 1, mode: 'legacy' },
      },
      120,
      78,
    )!;
    candidate.changeShadeMode(true);
    candidate.paintShade({ rulesVersion: 1, tool: 'shade', radius: 0, units: 16 }, 120, 78);
    candidate.paintShade({ rulesVersion: 1, tool: 'shade', radius: 0, units: 8 }, 0, 0);
    const before = JSON.stringify(candidate.save());
    expect(organismHtml(organism, candidate.presentation(organism.id))).toContain(
      'mean 0.5 transmission; range 0/16..16/16 across 2 leaves',
    );
    expect(organismHtml(organism, candidate.frame())).toContain('mean 0.5 transmission');
    const canvas = get<HTMLCanvasElement>('world'),
      buffer = document.createElement('canvas');
    const put = vi.fn();
    buffer.getContext('2d')!.putImageData = put;
    const frame = candidate.frame();
    draw(canvas, buffer, frame, { zoom: 1, x: 0, y: 0 }, false, 0, undefined, undefined, true);
    const pixels = put.mock.calls.at(-1)![0].data;
    expect(Array.from(pixels.slice(0, 3))).toEqual([49, 53, 46]);
    expect(Array.from(pixels.slice(4, 7))).toEqual([89, 90, 70]);
    const leaf = (78 * 240 + 120) * 4;
    expect(Array.from(pixels.slice(leaf, leaf + 3))).toEqual([102, 219, 139]);
    expect(JSON.stringify(candidate.save())).toBe(before);
    candidate.changeShadeMode(false);
    expect(organismHtml(organism, candidate.presentation(organism.id))).toContain(
      'mean 1 transmission',
    );
    draw(
      canvas,
      buffer,
      candidate.frame(),
      { zoom: 1, x: 0, y: 0 },
      false,
      0,
      undefined,
      undefined,
      true,
    );
    expect(Array.from(put.mock.calls.at(-1)![0].data.slice(0, 3))).toEqual([89, 90, 70]);
    organism.genome.cells = [{ x: 0, y: 0, type: 7 }];
    expect(organismHtml(organism, candidate.presentation(organism.id))).toContain('no leaf cells');
  });
  it('toggles mutually exclusive backgrounds while paused without ecological commands', () => {
    const bridge = ownershipBridge();
    paint(0);
    const calls = bridge.counts.M;
    click('light');
    expect(get('light').getAttribute('aria-pressed')).toBe('true');
    paint(0);
    click('thermal');
    expect(get('light').getAttribute('aria-pressed')).toBe('false');
    expect(get('thermal').getAttribute('aria-pressed')).toBe('true');
    click('light');
    expect(get('thermal').getAttribute('aria-pressed')).toBe('false');
    click('light');
    expect(get('light').getAttribute('aria-pressed')).toBe('false');
    expect(bridge.counts.M).toBe(calls);
    expect(bridge.latestFrame.frame.stats.tick).toBe(0);
  });
});

it('draws only an accepted selected actual perception and keeps local overlay controls ecologically neutral', async () => {
  const bridge = realWorker(true);
  bridge.deliver();
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false),
    source = {
      ...founder(1),
      cells: [
        { x: 0, y: 0, type: 8 },
        { x: 1, y: 0, type: 5 },
      ],
      tempo: 2,
      behavior: {
        version: 2,
        mode: 'evolved',
        reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
      },
    } as model.Genome;
  const mover = world.spawn(source, 60, 60)!;
  mover.age = 1;
  world.food[model.index(60, 57)] = 1;
  await loadText(JSON.stringify(world.save()));
  bridge.deliver();
  click('pause');
  bridge.deliver();
  bridge.command({ type: 'inspect', x: 60, y: 60 });
  bridge.deliver();
  click('perception-enabled');
  click('step');
  bridge.deliver();
  const painter = vi.spyOn(viewModule, 'draw');
  paint(0);
  bridge.deliver();
  paint(1); // release the held older native frame before drawing the Step frame
  bridge.deliver();
  expect(painter.mock.calls.at(-1)![9]).toMatchObject({
    id: mover.id,
    tick: 1,
    chosenEye: 0,
    direction: 3,
  });
  expect(get('perception-observation').textContent).toContain('Last perception at tick 1');
  const before = bridge.save(),
    posts = worker.commands.mock.calls.length;
  click('perception-enabled');
  paint(1);
  bridge.deliver();
  expect(painter.mock.calls.at(-1)![9]).toBeNull();
  click('perception-enabled');
  paint(2);
  bridge.deliver();
  expect(painter.mock.calls.at(-1)![9]).not.toBeNull();
  expect(worker.commands.mock.calls).toHaveLength(posts);
  expect(bridge.save()).toEqual(before);
  await loadText('{}');
  bridge.deliver();
  expect(get('perception-observation').textContent).toContain('Last perception at tick 1');
  expect(bridge.save()).toEqual(before);
  await loadText(JSON.stringify(before));
  bridge.deliver();
  paint(3);
  bridge.deliver();
  expect(get('perception-observation').textContent).toContain('No retained perception');
  expect(painter.mock.calls.at(-1)![9]).toBeNull();
});

describe('worker-owned mutation controls', () => {
  it('holds command capacity until matching delivery and rejects stale policy observations after replacement', () => {
    const bridge = ownershipBridge();
    set('mutation-mode', 'weighted', 'change');
    set('mutation-weight-add', '0');
    bridge.holdTerminals((data) => data.operation === 'mutation-policy');
    click('mutation-apply');
    const [id, record] = [...bridge.records].find(
      ([, record]) => record.command.type === 'mutation-policy',
    )!;
    expect(get<HTMLFieldSetElement>('mutation-fields').disabled).toBe(true);
    expect(get('mutation-status').textContent).toContain('Waiting');
    click('mutation-apply');
    expect(bridge.records.size).toBe(1);
    bridge.emit({ ...record.terminal, operation: 'settings' });
    expect(get<HTMLFieldSetElement>('mutation-fields').disabled).toBe(true);
    bridge.deliver(id);
    expect(get<HTMLFieldSetElement>('mutation-fields').disabled).toBe(false);
    expect(get('mutation-status').textContent).toContain('Confirmed policy: Weighted');
    set('mutation-weight-add', '19');
    paint(0);
    expect(get<HTMLInputElement>('mutation-weight-add').value).toBe('19');
    bridge.holdTerminals(() => false);
    click('reset');
    expect(get<HTMLSelectElement>('mutation-mode').value).toBe('legacy');
    bridge.emit(record.terminal);
    expect(get<HTMLSelectElement>('mutation-mode').value).toBe('legacy');
    expect(bridge.records.size).toBe(0);
  });
});
