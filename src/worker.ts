import { Evolution } from './evolution';
import { validSettings, type Genome, type Settings, type Trial } from './model';

export interface Start {
  type: 'start';
  settings: Settings;
  founder?: Genome;
  runId: number;
}
export function startWorker(
  scope: Pick<Worker, 'postMessage'> & { onmessage: ((event: MessageEvent) => void) | null },
  defer: (callback: () => void) => unknown = (callback) => setTimeout(callback, 0),
): void {
  let run: Evolution | undefined;
  let trials: Trial[] = [];
  let paused = false;
  let queued = false;
  let runId = 0;
  function queue(): void {
    if (!queued) {
      queued = true;
      defer(tick);
    }
  }
  function tick(): void {
    queued = false;
    if (!run || paused) return;
    try {
      trials.push(run.assess(trials.length));
      scope.postMessage({
        type: 'progress',
        runId,
        completed: trials.length,
        total: run.settings.population,
      });
      if (trials.length === run.settings.population) {
        scope.postMessage({ type: 'generation', runId, generation: run.advance(trials) });
        trials = [];
      }
      queue();
    } catch (error) {
      paused = true;
      scope.postMessage({
        type: 'error',
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  scope.onmessage = ({ data }) => {
    if (data.type === 'start') {
      runId = data.runId;
      if (!validSettings(data.settings)) {
        scope.postMessage({ type: 'error', runId, message: 'Invalid experiment settings.' });
        return;
      }
      run = new Evolution(data.settings, data.founder);
      trials = [];
      paused = false;
      queue();
    } else if (data.type === 'pause') paused = true;
    else if (data.type === 'resume') {
      paused = false;
      queue();
    }
  };
}

if (typeof document === 'undefined' && typeof self !== 'undefined')
  startWorker(self as unknown as Parameters<typeof startWorker>[0]);
