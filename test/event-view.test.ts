import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { eventMarkup, mountEvents } from '../src/event-view';
import { EventRecorder } from '../src/event-journal';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, WIDTH, HEIGHT } from '../src/model';

let root: HTMLElement, context: string, endpoint: Worker;
let view: ReturnType<typeof mountEvents>;
let hooks: {
  context: () => string;
  record: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
};
const get = <T extends HTMLElement = HTMLElement>(id: string) =>
  root.querySelector<T>('#event-' + id)!;
const click = (id: string) => get(id).click();
const recorder = () => new EventRecorder(new Ecosystem(DEFAULTS));
const evidence = () => recorder().replay(1);
const complete = () => ({
  type: 'complete',
  tick: 0,
  population: 1,
  verified: true,
  cells: new Uint8Array(WIDTH * HEIGHT),
});
beforeEach(() => {
  root = document.createElement('div');
  root.innerHTML = eventMarkup;
  document.body.append(root);
  context = 'one';
  hooks = { context: () => context, record: vi.fn(() => true), request: vi.fn(() => true) };
  endpoint = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  } as unknown as Worker;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    fillStyle: '',
  } as any);
  view = mountEvents(root, hooks, () => endpoint);
  view.update(recorder().snapshot());
});
afterEach(() => {
  view.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('navigates retained bookmarks with native controls and seeks only inside an independently verified window', () => {
  click('record');
  expect(hooks.record).toHaveBeenCalledWith(true);
  click('open');
  expect(hooks.request).toHaveBeenCalledWith(1);
  view.received(evidence());
  expect(endpoint.postMessage).toHaveBeenCalledWith({
    type: 'start',
    evidence: evidence(),
    tick: 0,
  });
  endpoint.onmessage!({ data: { type: 'progress', tick: 0, endpointTick: 0 } } as MessageEvent);
  expect(get('status').textContent).toContain('Verifying');
  expect(endpoint.postMessage).toHaveBeenLastCalledWith({ type: 'ack' });
  endpoint.onmessage!({ data: complete() } as MessageEvent);
  expect(get('status').textContent).toContain('Verified original complete endpoint');
  expect(get<HTMLCanvasElement>('canvas').hidden).toBe(false);
  get<HTMLInputElement>('tick').value = '2';
  click('seek');
  expect(get('status').textContent).toContain('whole tick');
  get<HTMLInputElement>('tick').value = '0';
  click('seek');
  expect(endpoint.postMessage).toHaveBeenLastCalledWith({
    type: 'start',
    evidence: evidence(),
    tick: 0,
  });
  get('cancel').focus();
  click('cancel');
  expect(document.activeElement).toBe(get('select'));
  view.received(evidence());
  get('seek').dispatchEvent(new Event('click'));
  expect(get<HTMLCanvasElement>('canvas').hidden).toBe(true);
  click('stop');
  expect(hooks.record).toHaveBeenCalledWith(false);
});
it('preserves selection through updates and discloses pruned events and replay evidence', () => {
  const snapshot = recorder().snapshot();
  snapshot.events[0].tick = 20;
  view.update(snapshot);
  expect(get<HTMLSelectElement>('select').options[0].textContent).toContain('Tick 20');
  get<HTMLSelectElement>('select').value = '2';
  get('select').dispatchEvent(new Event('change'));
  view.update(snapshot);
  expect(get<HTMLSelectElement>('select').value).toBe('2');
  snapshot.events[1].replay = false;
  view.update(snapshot);
  expect(get<HTMLButtonElement>('open').disabled).toBe(true);
  expect(get('detail').textContent).toContain('unavailable');
  snapshot.events.splice(1, 1);
  view.update(snapshot);
  expect(get<HTMLSelectElement>('select').value).toBe('1');
  expect(get('status').textContent).toContain('invalidated');
  view.update(undefined);
  expect(get('window').textContent).toContain('Recording off');
  expect(get('detail').textContent).toContain('No event');
});
it('rejects stale capture/completion/error callbacks after cancellation, replacement and disposal', () => {
  click('open');
  context = 'two';
  view.received(evidence());
  expect(endpoint.postMessage).not.toHaveBeenCalled();
  click('open');
  view.received(evidence());
  const completeLate = endpoint.onmessage!,
    errorLate = endpoint.onerror!;
  context = 'three';
  completeLate({ data: complete() } as MessageEvent);
  expect(get<HTMLCanvasElement>('canvas').hidden).toBe(true);
  view.invalidate();
  completeLate({ data: complete() } as MessageEvent);
  errorLate(new Event('error'));
  expect(get('status').textContent).toContain('invalidated');
  click('open');
  view.received(evidence());
  view.dispose();
  view.received(evidence());
  expect(endpoint.terminate).toHaveBeenCalled();
});
it('reports busy admission, engine errors, worker crashes and transport failures without a fake display', () => {
  hooks.record.mockReturnValue(false);
  click('record');
  expect(get('status').textContent).toContain('busy');
  hooks.request.mockReturnValue(false);
  click('open');
  expect(get('status').textContent).toContain('busy');
  hooks.request.mockReturnValue(true);
  click('open');
  view.received(evidence());
  endpoint.onmessage!({ data: { type: 'error', message: 'Unsupported rules' } } as MessageEvent);
  expect(get('status').textContent).toBe('Unsupported rules');
  click('open');
  view.received(evidence());
  endpoint.onerror!(new Event('error'));
  expect(get('status').textContent).toContain('worker failed');
  click('open');
  view.received(evidence());
  vi.mocked(endpoint.postMessage).mockImplementation(() => {
    throw Error('closed');
  });
  endpoint.onmessage!({ data: { type: 'progress', tick: 0, endpointTick: 1 } } as MessageEvent);
  expect(get('status').textContent).toContain('acknowledgement');
  click('open');
  view.received(evidence());
  expect(get('status').textContent).toContain('Could not start');
});
it('creates the dedicated native module worker by default', () => {
  view.dispose();
  const constructor = vi.fn(function () {
    return endpoint;
  });
  vi.stubGlobal('Worker', constructor);
  view = mountEvents(root, hooks);
  view.update(recorder().snapshot());
  click('open');
  view.received(evidence());
  expect(constructor).toHaveBeenCalledWith(expect.any(URL), { type: 'module' });
});
