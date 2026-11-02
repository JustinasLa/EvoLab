import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountComparisons } from '../src/experiment-view';
import { createComparison } from '../src/experiments';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS } from '../src/model';
import { RECIPE_MAX_BYTES } from '../src/experiment-model';
import { markup } from '../src/view';

let root: HTMLElement, context: string;
let capture: ReturnType<typeof vi.fn>;
let view: ReturnType<typeof mountComparisons>;
let endpoint: Worker;
const text = () => JSON.stringify(new Ecosystem(DEFAULTS, false).save());
const get = <T extends HTMLElement = HTMLElement>(id: string) =>
  root.querySelector<T>('#comparison-' + id)!;
const click = (id: string) => get(id).click();
const set = (id: string, value: string) => {
  get<HTMLInputElement>(id).value = value;
};
function completed(alive = false) {
  const checkpoint = JSON.stringify(new Ecosystem(DEFAULTS, alive).save());
  const runner = createComparison(checkpoint, {
    intervention: 'none',
    treatmentTick: 0,
    horizonTick: 31,
  });
  while (runner.advance(() => 0).tick < 31) {}
  const result = runner.result();
  runner.dispose();
  return { type: 'complete', result };
}
const emit = (data: any) => endpoint.onmessage!({ data } as MessageEvent);
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
  root.innerHTML = markup;
  context = '1';
  capture = vi.fn(() => true);
  endpoint = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  } as unknown as Worker;
  view = mountComparisons(root, { context: () => context, capture }, () => endpoint);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:world');
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  view.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('comparison presentation ownership', () => {
  it('hands ownership to a batch and back without accepting late comparison completion or capture', () => {
    const batch = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    vi.stubGlobal(
      'Worker',
      vi.fn(function () {
        return batch;
      }),
    );
    const startBatch = () => root.querySelector<HTMLButtonElement>('[data-batch="start"]')!.click();
    click('start');
    view.saved(text(), 0);
    const late = endpoint.onmessage!;
    startBatch();
    expect(endpoint.terminate).toHaveBeenCalledTimes(1);
    expect(get('status').textContent).toContain('independent batch started');
    expect(batch.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start' }));
    late({ data: completed() } as MessageEvent);
    expect(get('results').childElementCount).toBe(0);
    expect(get<HTMLButtonElement>('control').disabled).toBe(true);
    click('start');
    expect(batch.terminate).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(endpoint.postMessage).mock.calls.length;
    startBatch();
    view.saved(text(), 0);
    expect(vi.mocked(endpoint.postMessage).mock.calls).toHaveLength(sent);
    expect(get('status').textContent).toContain('independent batch started');
  });
  it('freezes the requested plan at the native capture tick without issuing sandbox edits', () => {
    set('delay', '12');
    set('duration', '31');
    click('start');
    click('start');
    expect(capture).toHaveBeenCalledTimes(1);
    set('delay', '0');
    view.saved(text(), 100);
    expect(endpoint.postMessage).toHaveBeenCalledWith({
      type: 'start',
      text: text(),
      plan: { intervention: 'heat', treatmentTick: 112, horizonTick: 131 },
    });
    emit({ type: 'progress', progress: { sourceTick: 100, tick: 112, horizonTick: 131 } });
    expect(get('status').textContent).toContain('112 / 131');
    expect(endpoint.postMessage).toHaveBeenLastCalledWith({ type: 'ack' });
    emit(completed());
    expect(get('status').textContent).toContain('historical tick unknown');
    expect(get('status').textContent).toContain('control/control');
    expect(get('results').querySelectorAll('tbody tr')).toHaveLength(3);
    expect(endpoint.terminate).toHaveBeenCalledTimes(1);
    expect(get<HTMLButtonElement>('control').disabled).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it('renders exact treatment and observed extinction, releases a result before rerun, and permits bounded downloads', () => {
    click('control');
    click('start');
    view.saved(text(), 0);
    const done = completed(true);
    done.result.plan.intervention = 'cold';
    done.result.treatment.extinction = { tick: 17, cause: 'energy' };
    emit(done);
    expect(get('status').textContent).toContain('after completed tick 0');
    expect(get('status').textContent).toContain('alive at horizon');
    expect(get('status').textContent).toContain('tick 17, energy');
    click('control');
    click('treatment');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:world');
    click('treatment');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    click('start');
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(get('results').childElementCount).toBe(0);
    expect(get<HTMLButtonElement>('control').disabled).toBe(true);
    view.saved(text(), 0);
    emit(completed());
    vi.spyOn(URL, 'createObjectURL').mockImplementationOnce(() => {
      throw new Error('download');
    });
    click('control');
    expect(get('status').textContent).toContain('Could not download');
  });
  it('validates finite bounded durations, exact delays and declared interventions before capturing', () => {
    for (const [duration, delay] of [
      ['0', '0'],
      ['3601', '0'],
      ['1.5', '0'],
      ['30', '30'],
      ['30', '-1'],
      ['30', '0.5'],
    ]) {
      set('duration', duration);
      set('delay', delay);
      click('start');
      expect(get('status').textContent).toContain('1–3600');
    }
    set('duration', '30');
    set('delay', '0');
    set('intervention', 'unknown');
    click('start');
    expect(capture).not.toHaveBeenCalled();
    set('intervention', 'heat');
    capture.mockReturnValue(false);
    click('start');
    expect(get('status').textContent).toContain('busy or unavailable');
    expect(get<HTMLButtonElement>('start').disabled).toBe(false);
  });
  it('fences delayed capture, messages, errors and downloads across cancel, context changes and disposal', () => {
    view.invalidate();
    click('start');
    click('cancel');
    view.saved(text(), 0);
    expect(endpoint.postMessage).not.toHaveBeenCalled();
    click('start');
    context = '2';
    view.saved(text(), 0);
    expect(get('status').textContent).toContain('world changed');
    click('start');
    view.saved(text(), 0);
    const late = endpoint.onmessage!,
      lateError = endpoint.onerror!;
    context = '3';
    late({ data: completed() } as MessageEvent);
    expect(get('results').childElementCount).toBe(0);
    view.invalidate();
    expect(get('status').textContent).toContain('lifecycle changed');
    view.failed('An old capture failed after invalidation.');
    expect(get('status').textContent).toContain('lifecycle changed');
    click('start');
    view.saved(text(), 0);
    late({ data: completed() } as MessageEvent);
    expect(get('results').childElementCount).toBe(0);
    view.dispose();
    lateError.call(endpoint, new ErrorEvent('error'));
    view.failed('late failure');
    view.saved(text(), 0);
    click('start');
    expect(endpoint.onmessage).toBeNull();
    expect(get('results').childElementCount).toBe(0);
  });
  it('reports native worker/start/progress errors without retaining partial results', () => {
    click('start');
    view.saved(text(), 0);
    emit({ type: 'error', message: 'Source validation failed.' });
    expect(get('status').textContent).toContain('validation failed');
    click('start');
    view.saved(text(), 0);
    endpoint.onerror!.call(endpoint, new ErrorEvent('error'));
    expect(get('status').textContent).toContain('worker failed');
    vi.mocked(endpoint.postMessage).mockImplementationOnce(() => {
      throw new Error('post');
    });
    click('start');
    view.saved(text(), 0);
    expect(get('status').textContent).toContain('Could not start');
    click('start');
    view.saved(text(), 0);
    vi.mocked(endpoint.postMessage).mockImplementationOnce(() => {
      throw new Error('ack');
    });
    emit({ type: 'progress', progress: { sourceTick: 0, tick: 12, horizonTick: 31 } });
    expect(get('status').textContent).toContain('acknowledgement failed');
    view.dispose();
    view = mountComparisons(root, { context: () => context, capture }, () => {
      throw new Error('unavailable');
    });
    click('start');
    view.saved(text(), 0);
    expect(get('status').textContent).toContain('Could not start');
  });
  it('switches shared-axis metrics and exports a recipe only after complete results', () => {
    click('recipe');
    get('metric').dispatchEvent(new Event('change'));
    click('start');
    view.saved(text(), 0);
    expect(get<HTMLButtonElement>('recipe').disabled).toBe(true);
    emit(completed());
    set('metric', 'meanPreference');
    get('metric').dispatchEvent(new Event('change'));
    expect(get('results').textContent).toContain('Undefined (extinct)');
    expect(get('results').querySelector('svg')?.getAttribute('aria-label')).toContain(
      'shared axes',
    );
    click('recipe');
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(blob.size).toBe(new Blob([completed().result.recipe]).size);
  });
  it('reads a bounded recipe, replaces the comparison alone and guards delayed reads/cancellation', async () => {
    const input = get<HTMLInputElement>('file');
    const importFile = (file?: { size: number; text: () => Promise<string> }) => {
      Object.defineProperty(input, 'files', { configurable: true, value: file ? [file] : [] });
      input.dispatchEvent(new Event('change'));
    };
    const picker = vi.spyOn(input, 'click');
    click('import');
    expect(picker).toHaveBeenCalled();
    importFile();
    const recipe = completed().result.recipe;
    importFile({ size: recipe.length, text: async () => recipe });
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled();
    expect(endpoint.postMessage).toHaveBeenLastCalledWith({ type: 'replay', text: recipe });
    emit({ type: 'complete', result: { ...completed().result, reproduced: true } });
    expect(get('status').textContent).toContain('Recipe reproduced');
    let resolve!: (s: string) => void;
    importFile({ size: 1, text: () => new Promise((r) => (resolve = r)) });
    importFile({ size: 1, text: async () => 'ignored concurrent read' });
    expect(get('results').childElementCount).toBe(0);
    click('cancel');
    click('start');
    resolve(recipe);
    await Promise.resolve();
    expect(endpoint.postMessage).toHaveBeenCalledTimes(1);
    view.saved(text(), 0);
    emit(completed());
    importFile({ size: 1, text: () => new Promise((r) => (resolve = r)) });
    context = '2';
    resolve(recipe);
    await Promise.resolve();
    expect(get('results').childElementCount).toBe(0);
    view.invalidate();
    expect(get('status').textContent).toContain('Reading');
    // Actual lifecycle invalidation arrives before the read settles.
    importFile({ size: 1, text: () => new Promise((r) => (resolve = r)) });
    view.invalidate();
    resolve(recipe);
    await Promise.resolve();
    expect(get('status').textContent).toContain('lifecycle changed');
    importFile({ size: 1, text: () => new Promise((r) => (resolve = r)) });
    view.dispose();
    resolve(recipe);
    await Promise.resolve();
    importFile({ size: 1, text: async () => recipe });
    expect(endpoint.onmessage).toBeNull();
  });
  it('handles oversized/rejected/failed recipe reads without capturing or replacing sandbox state', async () => {
    const input = get<HTMLInputElement>('file');
    async function read(file: any) {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new Event('change'));
      await Promise.resolve();
    }
    await read({ size: RECIPE_MAX_BYTES + 1, text: vi.fn() });
    expect(get('status').textContent).toContain('exceeds');
    await read({
      size: 1,
      text: async () => {
        throw new Error('disk');
      },
    });
    expect(get('status').textContent).toContain('disk');
    await read({
      size: 1,
      text: async () => {
        throw null;
      },
    });
    expect(get('status').textContent).toContain('Could not read');
    await read({ size: 2, text: async () => '{}' });
    emit({ type: 'error', message: 'Invalid recipe' });
    expect(get<HTMLButtonElement>('recipe').disabled).toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });
  it('constructs the native module worker through the default isolated entrypoint', () => {
    view.dispose();
    const constructor = vi.fn(function () {
      return endpoint;
    });
    vi.stubGlobal('Worker', constructor);
    view = mountComparisons(root, { context: () => context, capture });
    click('start');
    view.saved(text(), 0);
    expect(constructor).toHaveBeenCalledWith(expect.anything(), { type: 'module' });
  });
});
