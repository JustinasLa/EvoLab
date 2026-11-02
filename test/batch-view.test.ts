import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountBatches } from '../src/batch-view';
import { BATCH_MAX_BYTES } from '../src/experiment-batch';
import { batchResult } from './batch-fixture';

let view: ReturnType<typeof mountBatches>, endpoint: Worker, context: string;
let beforeStart: ReturnType<typeof vi.fn>, factory: ReturnType<typeof vi.fn>;
const get = <T extends HTMLElement = HTMLElement>(name: string): T =>
  document.querySelector(`[data-batch="${name}"]`)!;
const click = (name: string) => get(name).click();
const set = (name: string, value: string) => {
  get<HTMLInputElement>(name).value = value;
};
const emit = (data: any) => endpoint.onmessage!({ data } as MessageEvent);
const complete = () => emit({ type: 'complete', result: batchResult() });
async function read(file: { size: number; text: () => Promise<string> } | undefined) {
  const input = get<HTMLInputElement>('file');
  Object.defineProperty(input, 'files', { configurable: true, value: file ? [file] : [] });
  await input.onchange!(new Event('change'));
}
beforeEach(() => {
  vi.useFakeTimers();
  context = 'original';
  document.body.innerHTML = '<div id="anchor"></div>';
  endpoint = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  } as unknown as Worker;
  beforeStart = vi.fn();
  factory = vi.fn(() => endpoint);
  view = mountBatches(document.getElementById('anchor')!, () => context, beforeStart, factory);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:batch');
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  view.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('launches only validated independent plans, renders real results and bounds download leases', () => {
  click('export');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  click('start');
  expect(beforeStart).toHaveBeenCalledTimes(1);
  expect(endpoint.postMessage).toHaveBeenCalledWith({
    type: 'start',
    plan: expect.objectContaining({
      seeds: [42, 43],
      burnInTicks: 0,
      durationTicks: 300,
      intervention: 'none',
    }),
  });
  expect(get<HTMLButtonElement>('start').disabled).toBe(true);
  emit({ type: 'progress', progress: { run: 0, tick: 12, phase: 'paired', done: false } });
  expect(get('status').textContent).toContain('tick 12');
  expect(endpoint.postMessage).toHaveBeenLastCalledWith({ type: 'ack' });
  complete();
  expect(endpoint.terminate).toHaveBeenCalledTimes(1);
  expect(get('report').textContent).toContain('2/2 independent seed pairs complete');
  click('export');
  click('export');
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:batch');
  click('export');
  view.invalidate();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  expect(get('report').childElementCount).toBe(0);
  expect(get<HTMLButtonElement>('export').disabled).toBe(true);
  for (const seeds of ['42,42', '', '42,', '-1']) {
    set('seeds', seeds);
    click('start');
    expect(get('status').textContent).toContain('Invalid batch plan');
  }
  set('seeds', '0,4294967295');
  set('duration', '');
  click('start');
  expect(get('status').textContent).toContain('Invalid batch plan');
  expect(factory).toHaveBeenCalledTimes(1);
});
it('rejects stale callbacks and context changes, cancels active workers and detaches disposed controls', () => {
  click('start');
  const callback = endpoint.onmessage!,
    error = endpoint.onerror!;
  click('cancel');
  expect(endpoint.postMessage).toHaveBeenLastCalledWith({ type: 'cancel' });
  complete();
  click('start');
  callback({ data: { type: 'complete', result: batchResult() } } as MessageEvent);
  expect(get('report').childElementCount).toBe(0);
  error(new ErrorEvent('error'));
  expect(get('status').textContent).not.toContain('worker failed');
  const latest = endpoint.onmessage!;
  context = 'new';
  latest({ data: { type: 'complete', result: batchResult() } } as MessageEvent);
  expect(get('report').childElementCount).toBe(0);
  view.dispose();
  latest({ data: { type: 'error', message: 'late' } } as MessageEvent);
  expect(document.querySelector('#experiment-batches')).not.toBeNull();
  const count = factory.mock.calls.length;
  click('start');
  click('import');
  expect(factory).toHaveBeenCalledTimes(count);
  expect(get<HTMLInputElement>('file').onchange).toBeNull();
});
it('surfaces startup, transport, native worker and result failures without leaving a usable stale result', () => {
  factory.mockImplementationOnce(() => {
    throw new Error('startup');
  });
  click('start');
  expect(get('status').textContent).toBe('startup');
  click('start');
  emit({ type: 'error', message: 'invalid replay' });
  expect(get('status').textContent).toBe('invalid replay');
  click('start');
  endpoint.onmessageerror!(new MessageEvent('messageerror'));
  expect(get('status').textContent).toContain('outcomes are incomplete');
  click('start');
  vi.mocked(endpoint.postMessage).mockImplementationOnce(() => {
    throw 'transport';
  });
  emit({ type: 'progress', progress: { run: 0, tick: 0, phase: 'initialization' } });
  expect(get('status').textContent).toBe('Batch failed; no results retained.');
  click('start');
  vi.mocked(endpoint.postMessage).mockImplementationOnce(() => {
    throw new Error('cancel failed');
  });
  click('cancel');
  expect(get('status').textContent).toBe('cancel failed');
  expect(get<HTMLButtonElement>('export').disabled).toBe(true);
});
it('uses its native module worker factory and reports bounded export failures with retry available', () => {
  view.dispose();
  document.getElementById('experiment-batches')!.remove();
  const Native = vi.fn(function () {
    return endpoint;
  });
  vi.stubGlobal('Worker', Native);
  view = mountBatches(document.getElementById('anchor')!, () => context, beforeStart);
  click('start');
  expect(Native).toHaveBeenCalledWith(expect.any(URL), { type: 'module' });
  complete();
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
    throw new Error('blob failed');
  });
  click('export');
  expect(get('status').textContent).toBe('blob failed');
  expect(get<HTMLButtonElement>('export').disabled).toBe(false);
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
    throw 'blob';
  });
  click('export');
  expect(get('status').textContent).toBe('Could not export batch.');
});
it('reads bounded exports, opens the native picker, and invalidates late reads on cancellation or world replacement', async () => {
  const picker = vi.spyOn(get<HTMLInputElement>('file'), 'click').mockImplementation(() => {});
  click('import');
  expect(picker).toHaveBeenCalledTimes(1);
  await read(undefined);
  await read({ size: BATCH_MAX_BYTES + 1, text: vi.fn() });
  expect(get('status').textContent).toContain('16 MB');
  expect(factory).not.toHaveBeenCalled();
  await read({
    size: 1,
    text: async () => {
      throw new Error('read failed');
    },
  });
  expect(get('status').textContent).toBe('read failed');
  await read({ size: 1, text: async () => '{}' });
  expect(endpoint.postMessage).toHaveBeenLastCalledWith({ type: 'replay', text: '{}' });
  complete();
  for (const action of ['cancel', 'invalidate', 'context', 'dispose']) {
    let resolve!: (value: string) => void;
    const pending = read({
      size: 1,
      text: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const count = factory.mock.calls.length;
    await read({
      size: 1,
      text: async () => {
        throw new Error('Duplicate reads must not start');
      },
    });
    if (action === 'cancel') {
      click('cancel');
      expect(get('status').textContent).toContain('no seeds run');
      expect(get<HTMLButtonElement>('import').disabled).toBe(true);
    }
    if (action === 'invalidate') view.invalidate();
    if (action === 'context') context += '-changed';
    if (action === 'dispose') view.dispose();
    resolve('{}');
    await pending;
    expect(factory).toHaveBeenCalledTimes(count);
  }
});
