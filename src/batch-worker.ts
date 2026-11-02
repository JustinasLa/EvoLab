import { createBatch, replayBatch, type BatchExport, type BatchProgress } from './experiment-batch';

export type BatchResponse =
  | { type: 'progress'; progress: BatchProgress }
  | { type: 'complete'; result: BatchExport }
  | { type: 'error'; message: string };
export interface BatchScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: BatchResponse) => void;
}
export function startBatchWorker(
  scope: BatchScope,
  defer: (callback: () => void) => unknown = (callback) => setTimeout(callback, 0),
  cancel: (handle: any) => void = clearTimeout,
  now: () => number = () => performance.now(),
) {
  let runner: ReturnType<typeof createBatch> | undefined;
  let scheduled: unknown;
  let alive = true,
    started = false,
    pending = false;
  const dispose = (): void => {
    alive = false;
    cancel(scheduled);
    runner?.dispose();
    runner = undefined;
    scope.onmessage = null;
  };
  const fail = (error: unknown): void => {
    dispose();
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message.slice(0, 512) : 'Batch worker failed.',
    });
  };
  const finish = (result: BatchExport): void => {
    dispose();
    scope.postMessage({ type: 'complete', result });
  };
  const tick = (): void => {
    if (!alive || !runner) return;
    try {
      const progress = runner.advance(now);
      if (progress.done) finish(runner.snapshot());
      else {
        if (!pending) {
          pending = true;
          scope.postMessage({ type: 'progress', progress });
        }
        scheduled = defer(tick);
      }
    } catch (error) {
      fail(error);
    }
  };
  scope.onmessage = ({ data }) => {
    if (!alive || !data) return;
    try {
      if (data.type === 'cancel' && runner) finish(runner.cancel());
      else if (data.type === 'ack') pending = false;
      else if (!started && (data.type === 'start' || data.type === 'replay')) {
        started = true;
        runner = data.type === 'start' ? createBatch(data.plan) : replayBatch(data.text);
        scheduled = defer(tick);
      }
    } catch (error) {
      fail(error);
    }
  };
  return dispose;
}
if (typeof self !== 'undefined' && typeof document === 'undefined')
  startBatchWorker(self as unknown as BatchScope);
