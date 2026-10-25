import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/main';
import { chart, drawScene } from '../src/view';
import { DEFAULTS, Random, creature, type Generation } from '../src/model';
import { evaluate } from '../src/physics';

class WorkerStub {
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  emit(data: object, runId?: number): void {
    this.onmessage?.({
      data: {
        runId:
          runId ??
          this.postMessage.mock.calls.filter((c) => c[0].type === 'start').at(-1)?.[0].runId,
        ...data,
      },
    } as MessageEvent);
  }
}
const trial = evaluate(creature(new Random(42)), DEFAULTS);
const generation: Generation = {
  index: 1,
  best: trial.fitness,
  median: -1,
  diversity: 3,
  champion: trial,
};
let root: HTMLDivElement;
let worker: WorkerStub;
let dispose: () => void;
let paint: FrameRequestCallback;
let context: Record<string, any>;
const get = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`)!;
const click = (id: string): void => get(id).click();
const setting = (id: string, value: string): void => {
  get<HTMLInputElement>(id).value = value;
  get(id).dispatchEvent(new Event('input'));
};
function upload(value?: { size: number; text: () => Promise<string> }): void {
  Object.defineProperty(get('file'), 'files', { configurable: true, value: value ? [value] : [] });
  get('file').dispatchEvent(new Event('change'));
}
beforeEach(() => {
  context = new Proxy(
    { createLinearGradient: () => ({ addColorStop: vi.fn() }) },
    {
      get: (o, p) => (p in o ? o[p as keyof typeof o] : vi.fn()),
      set: (o, p, v) => {
        Reflect.set(o, p, v);
        return true;
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
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
      static createObjectURL = vi.fn(() => 'blob:test');
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
});

describe('the experiment desk', () => {
  it('starts, pauses, resumes, and keeps pending settings separate from the active habitat', () => {
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start', settings: DEFAULTS }),
    );
    paint(performance.now());
    click('follow');
    click('pause');
    expect(get('status').textContent).toContain('paused');
    click('pause');
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'resume' });
    root.querySelector<HTMLButtonElement>('[data-course="steps"]')!.click();
    setting('gravity', '1.6');
    setting('mutation', '0.3');
    setting('population-setting', '12');
    setting('seed', '99');
    expect(get('habitat-label').textContent).toContain('MEADOW');
    click('restart');
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'start',
        settings: { seed: 99, population: 12, course: 'steps', gravity: 1.6, mutation: 0.3 },
      }),
    );
    expect(get('habitat-label').textContent).toContain('STEPS');
    setting('seed', '-2');
    click('restart');
    expect(get('notice').textContent).toContain('whole-number');
  });
  it('shows progress, charts, bounded archives, and uninterrupted champion replays', () => {
    worker.emit({ type: 'progress', completed: 3, total: 24 });
    expect(get('progress-text').textContent).toContain('3 / 24');
    worker.emit({ type: 'unknown' });
    worker.emit({ type: 'generation', generation });
    paint(performance.now() + 50);
    const specimen = get('specimen').textContent;
    worker.emit({
      type: 'generation',
      generation: {
        ...generation,
        index: 2,
        champion: { ...trial, genome: { ...trial.genome, id: 'newborn' } },
      },
    });
    expect(get('specimen').textContent).toBe(specimen);
    paint(performance.now() + 9000);
    expect(get('specimen').textContent).toContain('NEWBORN');
    for (let i = 3; i < 250; i++)
      worker.emit({ type: 'generation', generation: { ...generation, index: i } });
    expect(root.querySelectorAll('.survivor')).toHaveLength(8);
    expect(get('generation').textContent).toBe('249');
    root.querySelector<HTMLButtonElement>('.survivor:last-child')!.click();
    expect(get('follow').hidden).toBe(false);
    worker.emit({ type: 'generation', generation: { ...generation, index: 250 } });
    click('follow');
    expect(get('follow').hidden).toBe(true);
    paint(performance.now() + 50);
    const before = get('generation').textContent;
    worker.emit({ type: 'generation', generation: { ...generation, index: 900 } }, 0);
    expect(get('generation').textContent).toBe(before);
    dispose();
    worker.emit({ type: 'generation', generation });
    expect(get('generation').textContent).toBe(before);
  });
  it('reports worker failures and can restart an experiment', () => {
    worker.emit({ type: 'error', message: 'Trial failed' });
    expect(get('notice').textContent).toBe('Trial failed');
    expect(get<HTMLButtonElement>('pause').disabled).toBe(true);
    click('restart');
    expect(get<HTMLButtonElement>('pause').disabled).toBe(false);
    worker.onerror?.();
    expect(get('notice').textContent).toContain('current browser');
  });
  it('exports the selected champion and loads validated founders', async () => {
    vi.useFakeTimers();
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    get<HTMLButtonElement>('export').disabled = false;
    click('export');
    expect(anchor).not.toHaveBeenCalled();
    worker.emit({ type: 'generation', generation });
    click('export');
    expect(anchor).toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
    vi.useRealTimers();
    const inputClick = vi.spyOn(get('file'), 'click');
    click('import');
    expect(inputClick).toHaveBeenCalled();
    upload();
    const saved = {
      version: 1,
      settings: { ...DEFAULTS, course: 'gaps', gravity: 2 },
      genome: trial.genome,
    };
    upload({ size: 1000, text: async () => JSON.stringify(saved) });
    await vi.waitFor(() => expect(get('notice').textContent).toContain('Champion loaded'));
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'start', founder: trial.genome, settings: saved.settings }),
    );
    expect(get('habitat-label').textContent).toContain('GAPS');
    expect(get<HTMLInputElement>('gravity').value).toBe('2');
    upload({ size: 32001, text: async () => '' });
    await vi.waitFor(() => expect(get('notice').textContent).toContain('too large'));
    upload({ size: 10, text: async () => '{' });
    await vi.waitFor(() => expect(get('notice').textContent).not.toContain('too large'));
    upload({
      size: 10,
      text: async () => {
        throw 'read failed';
      },
    });
    await vi.waitFor(() => expect(get('notice').textContent).toContain('Could not read'));
  });
  it('does not revive a disposed experiment after an asynchronous file read', async () => {
    let finish: (text: string) => void = () => {};
    upload({
      size: 10,
      text: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    dispose();
    finish(JSON.stringify({ version: 1, settings: DEFAULTS, genome: trial.genome }));
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });
  it('renders both habitat geometry and data without needing a GPU in unit tests', () => {
    const canvas = get<HTMLCanvasElement>('world');
    drawScene(canvas, undefined, 0, 'meadow');
    for (const course of ['meadow', 'steps', 'gaps'] as const)
      drawScene(canvas, trial, 99999, course);
    Object.defineProperty(canvas, 'clientWidth', { value: 640 });
    Object.defineProperty(canvas, 'clientHeight', { value: 420 });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 0 });
    drawScene(canvas, trial, 0, 'meadow');
    chart(canvas, [generation, { ...generation, index: 2 }]);
    expect(canvas.width).toBe(640);
  });
  it('boots the entry point when a host app element exists', async () => {
    root.id = 'app';
    const WorkerConstructor = vi.fn(function () {
      return worker;
    });
    vi.stubGlobal('Worker', WorkerConstructor);
    vi.resetModules();
    await import('../src/main');
    expect(WorkerConstructor).toHaveBeenCalled();
  });
});
