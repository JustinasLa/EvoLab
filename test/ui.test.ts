import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/main';
import { draw, genomeSvg, organismHtml, point, viewport } from '../src/view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, type Frame, type PlaybackState, type WorldFile } from '../src/model';
import { parseBlueprint, serializeBlueprint, BLUEPRINT_MAX_BYTES } from '../src/blueprint';
import { startWorker, type Scope } from '../src/worker';
import { libraryHarness } from './fixtures/library';
import { classifyRecord, encodeRecord, libraryCandidate } from '../src/library';
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
    worker.emit({ type: 'saved', text: '{}' });
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
    expect(root.querySelector<HTMLButtonElement>('[data-repair-index="0"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-repair-index="0"]')!.click();
    storage.values.set(first, encodeRecord(draft('repaired elsewhere'), 1));
    click('library-confirm');
    await flush();
    expect(storage.values.has(first)).toBe(true);
    storage.values.set(first, bad);
    click('library-refresh');
    await flush();
    root.querySelector<HTMLButtonElement>('[data-repair-index="0"]')!.click();
    click('library-confirm');
    await flush();
    expect(storage.values.has(first)).toBe(false);
    expect(storage.values.size).toBe(2);
    for (const button of root.querySelectorAll<HTMLButtonElement>('#library-rows button'))
      expect(button.disabled).toBe(true);
  });

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
    expect(get('library-status').textContent).toContain('native owner has not settled');
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
      expect(Object.keys(message)).toEqual(['type', 'tool', 'x', 'y', 'radius', 'genome']);
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
    const deferred: (() => void)[] = [],
      messages: any[] = [];
    const scope: Scope = {
      onmessage: null,
      postMessage: (data) => {
        messages.push(data);
        worker.emit(data);
      },
    };
    startWorker(scope, (callback) => deferred.push(callback));
    const send = (data: object) => scope.onmessage!({ data } as MessageEvent);
    worker.postMessage.mockImplementation(send);
    send({ type: 'start', settings: DEFAULTS, runId: 1 });
    click('pause');
    deferred.shift()!();
    const save = () => {
      send({ type: 'save' });
      return messages.at(-1).text as string;
    };
    const before = save();
    await importDraft();
    await exported();
    expect(save()).toBe(before);
    expect(deferred).toHaveLength(0);
    const population = JSON.parse(before).organisms.length;
    click('plant-design');
    pointer('pointerdown');
    window.dispatchEvent(new Event('pointerup'));
    expect(JSON.parse(save()).organisms).toHaveLength(population + 1);
    expect(get('run-state').textContent).toBe('PAUSED');
    click('step');
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
        const expected = {
          ...before,
          settings: {
            ...before.settings,
            ...(multiple ? { mutation: 0.37, climate: 0.25 } : {}),
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
