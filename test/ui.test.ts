import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/main';
import { draw, drawChart, genomeSvg, organismHtml, point, viewport } from '../src/view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, type Frame, type PlaybackState, type WorldFile } from '../src/model';
import { startWorker, type Scope } from '../src/worker';
class WorkerStub {
  playback: PlaybackState = { paused: false, pauseOnExtinction: true, extinction: null };
  postMessage = vi.fn((data: any) => {
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
    if (data.playback) this.playback = data.playback;
    this.onmessage?.({
      data: {
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
function realWorker() {
  const tasks: (() => void)[] = [],
    outbox: any[] = [];
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
    command({ type: 'save' });
    return JSON.parse(outbox.pop().text);
  };
  return { tasks, outbox, command, deliver, save, advance: () => tasks.shift()!() };
}
function nearDeath(): WorldFile {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0 }, false);
  const organism = world.spawn(
    { cells: [{ x: 0, y: 0, type: 3 }], preference: 0.5, tolerance: 0.3, tempo: 2 },
    40,
    40,
  )!;
  organism.age = 975;
  organism.energy = 5;
  world.tick = 71;
  world.food[5] = 1;
  world.walls[6] = 1;
  return world.save();
}
function chartRecorder() {
  const paths: number[][][] = [];
  let points: number[][] = [];
  const chart = {
    clearRect: vi.fn(),
    beginPath: () => {
      points = [];
    },
    moveTo: (x: number, y: number) => points.push([x, y]),
    lineTo: (x: number, y: number) => points.push([x, y]),
    stroke: () => paths.push(points),
  };
  const original = get<HTMLCanvasElement>('world').getContext('2d');
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return this.id === 'chart' ? (chart as unknown as CanvasRenderingContext2D) : original;
  });
  const expected = (populations: number[]) =>
    populations.map((population, index) => [
      (index / Math.max(1, populations.length - 1)) * 250,
      64 - (population / Math.max(10, ...populations)) * 58,
    ]);
  return { paths, expected };
}
beforeEach(() => {
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
      runId: 1,
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
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'shock', kind: 'heat' });
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
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'save' });
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

  it.each(['energy', 'age', 'manual-erasure', 'empty-import'] as const)(
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
          'manual-erasure': 'manual erasure',
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

  it('renders empty successful loads as paused before the ecological frame and shows intentional running accurately', () => {
    const playback = {
      paused: true,
      pauseOnExtinction: true,
      extinction: { tick: 71, cause: 'empty-import' },
    };
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
        const history = [1, ...Array(cadence / 4 - 1).fill(0)];
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
          set('climate', '0.24');
        }
        set('nutrients', '7');
        const expected = {
          ...before,
          settings: {
            ...before.settings,
            ...(multiple ? { mutation: 0.37, climate: 0.24 } : {}),
            nutrients: 7,
          },
        };
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
        expect(chart.paths).toHaveLength(paths);
        window.dispatchEvent(new Event('resize'));
        expect(chart.paths.at(-1)).toEqual(chart.expected(history));
        harness.command({ type: 'snapshot' });
        harness.deliver();
        expect(chart.paths.at(-1)).toEqual(chart.expected([...history, 0]));
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
    set('mutation', '0.91');
    const imported = nearDeath();
    imported.settings.seed = 123;
    await loadText(JSON.stringify(imported));
    set('nutrients', '3');
    set('nutrients', '7');
    set('climate', '0.24');
    harness.deliver();
    const expected = { ...imported.settings, nutrients: 7, climate: 0.24 };
    expect(get<HTMLInputElement>('seed').value).toBe('123');
    expect(get('world-label').textContent).toBe('WORLD 0123');
    expect(get<HTMLInputElement>('mutation').value).toBe(String(imported.settings.mutation));
    expect(get('nutrients-value').textContent).toBe('7%');
    expect(get('climate-value').textContent).toBe('24%');
    expect(harness.save()).toEqual({ ...imported, settings: expected });
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
        const history = Array(cadence / 4).fill(1);
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
        const beforeDisplay = root.innerHTML;
        const paths = chart.paths.length;
        await loadText('{}');
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
        expect(chart.paths).toHaveLength(paths);
        window.dispatchEvent(new Event('resize'));
        expect(chart.paths.at(-1)).toEqual(chart.expected(history));
        harness.command({ type: 'snapshot' });
        harness.deliver();
        expect(chart.paths.at(-1)).toEqual(chart.expected([...history, before.organisms.length]));
        expect(get('notice').textContent).toContain('Not a valid EvoLab ecosystem');
      },
    );
  }

  it('does not prune, clear or fabricate bounded chart history on display recovery', () => {
    const chart = chartRecorder();
    for (let update = 0; update < 720; update++) emit();
    expect(chart.paths.at(-1)).toEqual(chart.expected(Array(180).fill(1)));
    const empty = new Ecosystem(DEFAULTS, false).frame();
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
    drawChart(canvas, [0, 10, 20]);
    drawChart(canvas, []);
    expect(genomeSvg(founder(0))).toContain('svg');
    expect(organismHtml(null, sample)).toContain('Click any');
    expect(organismHtml(organism, sample)).toContain('Preferred');
  });
});
