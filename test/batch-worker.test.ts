import { afterEach, expect, it, vi } from 'vitest';
import { startBatchWorker, type BatchResponse, type BatchScope } from '../src/batch-worker';
import { encodeBatch } from '../src/experiment-batch';
import { batchPlan, batchResult } from './batch-fixture';

function harness() {
  const tasks: (() => void)[] = [],
    messages: BatchResponse[] = [];
  const scope: BatchScope = { onmessage: null, postMessage: (data) => messages.push(data) };
  const cancel = vi.fn();
  const dispose = startBatchWorker(
    scope,
    (callback) => tasks.push(callback),
    cancel,
    () => 0,
  );
  const send = (data: unknown) => scope.onmessage?.({ data } as MessageEvent);
  const drain = () => {
    while (tasks.length) tasks.shift()!();
  };
  return { scope, tasks, messages, cancel, dispose, send, drain };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('boots the native worker entrypoint, yields, completes and disposes the real engine', async () => {
  vi.useFakeTimers();
  const scope: BatchScope = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  vi.stubGlobal('document', undefined);
  vi.resetModules();
  await import('../src/batch-worker');
  scope.onmessage!({ data: { type: 'start', plan: batchPlan() } } as MessageEvent);
  vi.runAllTimers();
  expect(scope.postMessage).toHaveBeenLastCalledWith({ type: 'complete', result: batchResult() });
  expect(scope.onmessage).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('backpressures progress, ignores duplicate starts, replays exact results and rejects malformed imports', () => {
  const test = harness(),
    receive = test.scope.onmessage!;
  test.send(null);
  test.send({ type: 'other' });
  test.send({ type: 'start', plan: batchPlan() });
  test.send({ type: 'start', plan: {} });
  expect(test.tasks).toHaveLength(1);
  test.tasks.shift()!();
  test.tasks.shift()!();
  expect(test.messages).toHaveLength(1);
  test.send({ type: 'ack' });
  test.tasks.shift()!();
  expect(test.messages).toHaveLength(2);
  test.drain();
  expect(test.messages.at(-1)).toEqual({ type: 'complete', result: batchResult() });
  expect(test.cancel).toHaveBeenCalledTimes(1);
  receive({ data: { type: 'ack' } } as MessageEvent);
  const replay = harness();
  replay.send({ type: 'replay', text: encodeBatch(batchResult()) });
  replay.drain();
  expect(replay.messages.at(-1)).toMatchObject({
    type: 'complete',
    result: { runs: [{ reproduced: true }, { reproduced: true }] },
  });
  const invalid = harness();
  invalid.send({ type: 'replay', text: '{}' });
  expect(invalid.messages[0]).toMatchObject({ type: 'error' });
  expect(invalid.scope.onmessage).toBeNull();
});
it('cancels with truthful incomplete statuses, stops late callbacks and disposes before start', () => {
  const test = harness();
  test.send({ type: 'start', plan: batchPlan() });
  test.tasks.shift()!();
  const late = test.tasks.shift()!;
  test.send({ type: 'cancel' });
  late();
  expect(test.messages.at(-1)).toMatchObject({
    type: 'complete',
    result: { runs: [{ status: 'cancelled' }, { status: 'pending' }] },
  });
  const unused = harness();
  unused.dispose();
  unused.send({ type: 'start', plan: batchPlan() });
  expect(unused.tasks).toHaveLength(0);
  expect(unused.messages).toHaveLength(0);
});
it('releases on scheduler and transport failures without misreporting completion', () => {
  const scope: BatchScope = { onmessage: null, postMessage: vi.fn() };
  startBatchWorker(scope, () => {
    throw 'scheduler';
  });
  scope.onmessage!({ data: { type: 'start', plan: batchPlan() } } as MessageEvent);
  expect(scope.postMessage).toHaveBeenLastCalledWith({
    type: 'error',
    message: 'Batch worker failed.',
  });
  const test = harness();
  test.send({ type: 'start', plan: batchPlan() });
  test.scope.postMessage = vi.fn().mockImplementationOnce(() => {
    throw new Error('transport');
  });
  test.tasks.shift()!();
  expect(test.scope.postMessage).toHaveBeenLastCalledWith({ type: 'error', message: 'transport' });
  expect(test.scope.onmessage).toBeNull();
});
