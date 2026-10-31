import { createComparison } from './experiments';
import type { ComparisonResponse } from './experiment-model';

export interface ComparisonScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (data: ComparisonResponse) => void;
}
export function startComparisonWorker(
  scope: ComparisonScope,
  defer: (callback: () => void) => unknown = (callback) => setTimeout(callback, 0),
  cancel: (handle: any) => void = clearTimeout,
  now: () => number = () => performance.now(),
) {
  let runner: ReturnType<typeof createComparison> | undefined;
  let alive = true,
    started = false,
    progressPending = false;
  let scheduled: unknown;
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
      message: error instanceof Error ? error.message.slice(0, 512) : 'Comparison failed.',
    });
  };
  const tick = (): void => {
    if (!alive || !runner) return;
    try {
      const progress = runner.advance(now);
      if (progress.tick === progress.horizonTick) {
        const result = runner.result();
        dispose();
        scope.postMessage({ type: 'complete', result });
      } else {
        if (!progressPending) {
          progressPending = true;
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
    if (data.type === 'cancel') dispose();
    else if (data.type === 'ack') progressPending = false;
    else if (data.type === 'start' && !started) {
      started = true;
      try {
        runner = createComparison(data.text, data.plan);
        scheduled = defer(tick);
      } catch (error) {
        fail(error);
      }
    }
  };
  return dispose;
}
if (typeof self !== 'undefined' && typeof document === 'undefined')
  startComparisonWorker(self as unknown as ComparisonScope);
