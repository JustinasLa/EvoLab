import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorker } from '../src/worker';
import { Evolution } from '../src/evolution';
import { DEFAULTS } from '../src/model';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('background evolution lifecycle', () => {
  it('yields between creatures, pauses, resumes, and replaces experiments without duplicate loops', () => {
    const callbacks: (() => void)[] = [];
    const scope = { postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null };
    startWorker(scope, (cb) => callbacks.push(cb));
    const send = (data: object): void => scope.onmessage!({ data } as MessageEvent);
    send({ type: 'resume' });
    callbacks.shift()!();
    expect(scope.postMessage).not.toHaveBeenCalled();
    send({ type: 'start', settings: { ...DEFAULTS, population: 12 }, runId: 1 });
    send({ type: 'pause' });
    callbacks.shift()!();
    expect(callbacks).toHaveLength(0);
    send({ type: 'resume' });
    send({ type: 'resume' });
    expect(callbacks).toHaveLength(1);
    for (let i = 0; i < 12; i++) callbacks.shift()!();
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'generation', runId: 1 }),
    );
    send({ type: 'start', settings: DEFAULTS, runId: 2 });
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: 'progress',
      completed: 1,
      total: 24,
      runId: 2,
    });
    send({ type: 'unknown' });
    send({ type: 'start', settings: {}, runId: 3 });
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'error', runId: 3 }),
    );
  });
  it('stops evaluation and reports an actionable failure', () => {
    vi.useFakeTimers();
    const scope = { postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null };
    startWorker(scope);
    vi.spyOn(Evolution.prototype, 'assess').mockImplementation(() => {
      throw new Error('Physics failed');
    });
    scope.onmessage!({ data: { type: 'start', settings: DEFAULTS, runId: 4 } } as MessageEvent);
    vi.runAllTimers();
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      message: 'Physics failed',
      runId: 4,
    });
    vi.mocked(Evolution.prototype.assess).mockImplementation(() => {
      throw 'failed';
    });
    scope.onmessage!({ data: { type: 'resume' } } as MessageEvent);
    vi.runAllTimers();
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      message: 'failed',
      runId: 4,
    });
  });
  it('registers its message handler in a worker environment', async () => {
    vi.stubGlobal('document', undefined);
    const scope = { postMessage: vi.fn(), onmessage: null };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('../src/worker');
    expect(scope.onmessage).toBeTypeOf('function');
  });
});
