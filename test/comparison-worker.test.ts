import { afterEach, describe, expect, it, vi } from 'vitest';
import { startComparisonWorker, type ComparisonScope } from '../src/comparison-worker';
import { Ecosystem } from '../src/ecosystem';
import { createComparison } from '../src/experiments';
import { DEFAULTS } from '../src/model';
import type { ComparisonResponse } from '../src/experiment-model';

const plan = { intervention: 'heat', treatmentTick: 12, horizonTick: 31 } as const;
const text = () => JSON.stringify(new Ecosystem(DEFAULTS).save());
function harness(now = () => 0) {
  const messages: ComparisonResponse[] = [],
    tasks: (() => void)[] = [];
  const scope: ComparisonScope = { onmessage: null, postMessage: (data) => messages.push(data) };
  const cancel = vi.fn();
  const dispose = startComparisonWorker(
    scope,
    (callback) => {
      tasks.push(callback);
      return tasks.length;
    },
    cancel,
    now,
  );
  const send = (data: any) => scope.onmessage?.({ data } as MessageEvent);
  return { scope, messages, tasks, send, dispose, cancel };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('bounded comparison worker', () => {
  it('boots its native module entrypoint with the real default scheduler and monotonic clock', async () => {
    vi.useFakeTimers();
    const scope = { onmessage: null, postMessage: vi.fn() } as ComparisonScope;
    vi.stubGlobal('self', scope);
    vi.stubGlobal('document', undefined);
    vi.resetModules();
    await import('../src/comparison-worker');
    expect(scope.onmessage).toBeTypeOf('function');
    scope.onmessage!({ data: { type: 'start', text: text(), plan } } as MessageEvent);
    vi.runAllTimers();
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'complete' }),
    );
    expect(scope.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('runs the real engine with one scheduled callback and one unacknowledged progress, then releases', () => {
    const test = harness(),
      checkpoint = text();
    test.send({ type: 'start', text: checkpoint, plan });
    test.send({ type: 'start', text: '{}', plan });
    expect(test.tasks).toHaveLength(1);
    test.tasks.shift()!();
    expect(test.messages).toEqual([
      { type: 'progress', progress: { sourceTick: 0, tick: 12, horizonTick: 31 } },
    ]);
    test.tasks.shift()!();
    expect(test.messages).toHaveLength(1);
    test.send({ type: 'ack' });
    test.tasks.shift()!();
    const result = test.messages.at(-1);
    expect(result?.type).toBe('complete');
    const reference = createComparison(checkpoint, plan);
    while (reference.advance(() => 0).tick < 31) {}
    expect(result).toEqual({ type: 'complete', result: reference.result() });
    expect(test.scope.onmessage).toBeNull();
    expect(test.tasks).toHaveLength(0);
    expect(test.cancel).toHaveBeenCalledTimes(1);
    reference.dispose();
  });
  it('acknowledges compact progress, ignores unrelated input and cancels queued/late work', () => {
    const test = harness();
    const receive = test.scope.onmessage!;
    receive({ data: null } as MessageEvent);
    test.send({ type: 'unknown' });
    test.send({ type: 'start', text: text(), plan });
    test.tasks.shift()!();
    test.send({ type: 'ack' });
    test.tasks.shift()!();
    expect(test.messages).toHaveLength(2);
    const late = test.tasks.shift()!;
    test.send({ type: 'cancel' });
    late();
    receive({ data: { type: 'start', text: text(), plan } } as MessageEvent);
    expect(test.messages).toHaveLength(2);
    expect(test.scope.onmessage).toBeNull();
    test.dispose();
  });
  it('cancels before start and disposes after start without publishing partial results', () => {
    const before = harness();
    before.send({ type: 'cancel' });
    expect(before.scope.onmessage).toBeNull();
    const test = harness();
    test.send({ type: 'start', text: text(), plan });
    test.dispose();
    test.tasks.shift()!();
    expect(test.messages).toHaveLength(0);
  });
  it('rejects incomplete source worlds and preserves the native sandbox worker independently', () => {
    const test = harness();
    test.send({ type: 'start', text: '{}', plan });
    expect(test.messages[0]).toMatchObject({
      type: 'error',
      message: expect.stringContaining('valid EvoLab'),
    });
    expect(test.scope.onmessage).toBeNull();
    expect(test.tasks).toHaveLength(0);
  });
  it('releases scheduling and engines on a failed logical tick or publication', () => {
    const test = harness();
    test.send({ type: 'start', text: text(), plan });
    vi.spyOn(Ecosystem.prototype, 'step').mockImplementationOnce(() => {
      throw 'failed';
    });
    test.tasks.shift()!();
    expect(test.messages).toEqual([{ type: 'error', message: 'Comparison failed.' }]);
    expect(test.scope.onmessage).toBeNull();
    const post = harness();
    post.send({ type: 'start', text: text(), plan });
    post.scope.postMessage = vi.fn().mockImplementationOnce(() => {
      throw new Error('transport');
    });
    post.tasks.shift()!();
    expect(post.scope.onmessage).toBeNull();
    expect(post.scope.postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      message: 'transport',
    });
  });
  it('bounds initial scheduler failures and costly real-engine chunks', () => {
    const test = harness(() => Infinity);
    test.send({ type: 'start', text: text(), plan });
    test.tasks.shift()!();
    expect(test.tasks).toHaveLength(1);
    test.dispose();
    const scope: ComparisonScope = { onmessage: null, postMessage: vi.fn() };
    startComparisonWorker(scope, () => {
      throw new Error('scheduler');
    });
    scope.onmessage!({ data: { type: 'start', text: text(), plan } } as MessageEvent);
    expect(scope.onmessage).toBeNull();
    expect(scope.postMessage).toHaveBeenCalledWith({ type: 'error', message: 'scheduler' });
  });
});
