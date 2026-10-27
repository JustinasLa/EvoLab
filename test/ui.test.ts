import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, captureCommand } from '../src/main';
import * as model from '../src/model';
import { draw, genomeSvg, organismHtml, point, viewport } from '../src/view';
import * as viewModule from '../src/view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, type Frame, type PlaybackState, type WorldFile } from '../src/model';
import { parseBlueprint, serializeBlueprint, BLUEPRINT_MAX_BYTES } from '../src/blueprint';
import { startWorker, type Scope } from '../src/worker';
import { legacyV3 } from './fixtures/telemetry';
class WorkerStub {
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
    if (data.type === 'load' || data.type === 'save') return;
    if (data.type === 'pause' || data.type === 'resume')
      this.playback = { ...this.playback, paused: data.type === 'pause' };
    if (data.type === 'pause-on-extinction')
      this.playback = { ...this.playback, pauseOnExtinction: data.value };
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
      world: { stats: frame.stats, climate: frame.climate, offset: frame.offset },
      selected: fixture.selected ?? null,
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
    };
    let data: any;
    if (fixture.type === 'frame')
      data = {
        type: 'frame',
        runId,
        sequence: ++this.sequence,
        viewEpoch: this.display.epoch,
        state,
        frame: { cells: frame.cells, ids: frame.ids, ...state.world },
        selectedId: state.selected?.id ?? 0,
      };
    else if (fixture.type === 'error')
      data = {
        type: 'error',
        runId,
        commandId: command?.commandId,
        code: fixture.fatal ? 'fatal' : 'load-failed',
        message: fixture.message,
        ...(fixture.fatal ? { fatal: true } : {}),
        ...(fixture.recovery
          ? {
              recovery: {
                state: {
                  ...state,
                  world: {
                    stats: fixture.recovery.frame.stats,
                    climate: fixture.recovery.frame.climate,
                    offset: fixture.recovery.frame.offset,
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
    else if (fixture.type === 'saved')
      data = { type: 'saved', runId, commandId: command?.commandId, state, text: fixture.text };
    else if (fixture.type === 'playback' && !this.pendingCommand)
      data = { type: 'progress', runId, sequence: ++this.progressSequence, state, telemetry };
    else
      data = {
        type: fixture.type === 'loaded' ? 'loaded' : 'control',
        runId,
        commandId: command?.commandId,
        state,
        telemetry,
      };
    if (data.commandId !== undefined) this.pendingCommand = null;
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
const get = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`)!;
const click = (id: string) => get(id).click();
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
describe('owned command admission and real-worker interleavings', () => {
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
        message: 'cannot start',
      },
    } as MessageEvent);
    expect(get('run-state').textContent).toBe('STOPPED');
    expect(get('telemetry-summary').textContent).toContain('history unknown');
  });
  it('rejects complete invalid payloads before capture and detaches every admitted field', () => {
    const invalid = [
      null,
      { type: 'unknown' },
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
    expected.settings.mutation = 0.2;
    expected.paint('plant', location.x, location.y, 2, founder(0));
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
    expect(harness.save()).toEqual({
      ...candidate,
      settings: { ...candidate.settings, nutrients: 7 },
    });
  });
  it('downloads a posted obsolete-generation Save once before reseeding without taking its notice', async () => {
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
      expect(worker.commands.mock.calls.at(-1)![0].type).toBe(type);
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
      expect(harness.gridTransfers()).toBe(4);
      harness.advance();
      harness.deliver();
      paint(0);
      expect(harness.gridTransfers()).toBe(4);
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

describe('ecosystem desk', () => {
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
    const commands = worker.commands.mock.calls.length;
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
        if (worker.pendingCommand) worker.emit({ type: 'loaded', settings: DEFAULTS });
        upload({ size: 1, text: async () => 'world' });
        await flush();
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
    expect(worker.commands).toHaveBeenCalledTimes(1);
    expect(get('world').dataset.tool).toBe('pan');
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
      expect(get('inspector').textContent).toContain('Click any organism');
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
        const expected = {
          ...before,
          settings: {
            ...before.settings,
            ...(multiple ? { mutation: 0.37, climate: 0.25 } : {}),
            nutrients: 7,
          },
        };
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
    expect(harness.save()).toEqual({ ...imported, settings: expected });
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
          expect(get('inspector').textContent).toContain('Click any organism');
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
