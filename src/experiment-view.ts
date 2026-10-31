import { integer } from './model';
import {
  COMPARISON_MAX_TICKS,
  type ComparisonPlan,
  type ComparisonResponse,
  type ComparisonResult,
} from './experiment-model';

export function mountComparisons(
  root: HTMLElement,
  hooks: { context: () => string; capture: () => boolean },
  createWorker: () => Worker = () =>
    new Worker(new URL('./comparison-worker.ts', import.meta.url), { type: 'module' }),
) {
  const controls = new Map(
    [...root.querySelectorAll<HTMLElement>('[id]')].map((element) => [element.id, element]),
  );
  const get = <T extends HTMLElement>(id: string): T => controls.get('comparison-' + id) as T;
  let alive = true,
    generation = 0;
  let capture:
    | {
        context: string;
        duration: number;
        delay: number;
        intervention: ComparisonPlan['intervention'];
      }
    | undefined;
  let worker: Worker | undefined;
  let result: ComparisonResult | undefined;
  let url: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = (message: string): void => {
    get('status').textContent = message;
  };
  const downloadDone = (): void => {
    clearTimeout(timer);
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    for (const branch of ['control', 'treatment'])
      get<HTMLButtonElement>(branch).disabled = !result;
  };
  const releaseWorker = (): void => {
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    capture = undefined;
    get<HTMLButtonElement>('start').disabled = false;
    get<HTMLButtonElement>('cancel').disabled = true;
  };
  const clear = (): void => {
    generation++;
    releaseWorker();
    result = undefined;
    downloadDone();
    get('results').replaceChildren();
    for (const branch of ['control', 'treatment']) get<HTMLButtonElement>(branch).disabled = true;
  };
  const failed = (message: string): void => {
    if (!alive) return;
    clear();
    status(message);
  };
  const start = (): void => {
    if (!alive || capture || worker) return;
    clear();
    const duration = Number(get<HTMLInputElement>('duration').value),
      delay = Number(get<HTMLInputElement>('delay').value),
      intervention = get<HTMLSelectElement>('intervention').value as ComparisonPlan['intervention'];
    if (
      !integer(duration, 1, COMPARISON_MAX_TICKS) ||
      !integer(delay, 0, duration - 1) ||
      !['none', 'heat', 'cold'].includes(intervention)
    ) {
      status('Use a horizon of 1–3600 ticks and a treatment delay smaller than the horizon.');
      return;
    }
    capture = { context: hooks.context(), duration, delay, intervention };
    get<HTMLButtonElement>('start').disabled = true;
    get<HTMLButtonElement>('cancel').disabled = false;
    status('Capturing one complete native checkpoint; the sandbox is unchanged.');
    if (!hooks.capture()) failed('World Save busy or unavailable. No comparison was queued.');
  };
  const cancel = (): void => failed('Comparison cancelled; no partial result retained.');
  const listeners: (() => void)[] = [];
  const listen = (id: string, callback: () => void): void => {
    get(id).addEventListener('click', callback);
    listeners.push(() => get(id).removeEventListener('click', callback));
  };
  listen('start', start);
  listen('cancel', cancel);
  for (const branch of ['control', 'treatment'] as const)
    listen(branch, () => {
      if (!result || url) return;
      try {
        url = URL.createObjectURL(new Blob([result[branch].state], { type: 'application/json' }));
        for (const branch of ['control', 'treatment'])
          get<HTMLButtonElement>(branch).disabled = true;
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `evolab-${branch}-${result.seed}-tick-${result.plan.horizonTick}.json`;
        anchor.click();
        timer = setTimeout(downloadDone, 1000);
      } catch {
        downloadDone();
        status('Could not download the comparison checkpoint. Retry explicitly.');
      }
    });
  return {
    saved(text: string, completedTick: number): void {
      if (!alive || !capture) return;
      const request = capture;
      if (request.context !== hooks.context()) {
        failed('Comparison capture cancelled: the world changed.');
        return;
      }
      const owner = generation;
      const current = (): boolean =>
        alive && owner === generation && request.context === hooks.context();
      try {
        worker = createWorker();
        worker.onerror = worker.onmessageerror = () => {
          if (current()) failed('Comparison worker failed; no result retained.');
        };
        worker.onmessage = ({ data }: MessageEvent<ComparisonResponse>) => {
          if (!current()) return;
          if (data.type === 'error') failed(data.message);
          else if (data.type === 'progress') {
            status(
              `Comparison tick ${data.progress.tick} / ${data.progress.horizonTick}; sandbox unchanged.`,
            );
            try {
              worker!.postMessage({ type: 'ack' });
            } catch {
              failed('Comparison progress acknowledgement failed; no result retained.');
            }
          } else {
            result = data.result;
            releaseWorker();
            const table = document.createElement('table');
            table.innerHTML =
              '<caption>Retained population samples</caption><thead><tr><th>Tick</th><th>Control</th><th>Treatment</th></tr></thead>';
            const body = document.createElement('tbody');
            for (const [position, sample] of result.control.samples.entries()) {
              const row = body.insertRow();
              for (const value of [
                sample.tick,
                sample.population,
                result.treatment.samples[position].population,
              ])
                row.insertCell().textContent = String(value);
            }
            table.append(body);
            get('results').replaceChildren(table);
            const outcome = (branch: 'control' | 'treatment'): string => {
              const extinction = result![branch].extinction;
              return extinction
                ? `${branch}: extinct (${extinction.tick === null ? 'initially empty; historical tick unknown' : `tick ${extinction.tick}`}, ${extinction.cause})`
                : `${branch}: alive at horizon`;
            };
            status(
              `Complete: checkpoint tick ${result.sourceTick}, equal horizon ${result.plan.horizonTick}. ${result.plan.intervention === 'none' ? 'No intervention (control/control).' : `${result.plan.intervention} applied after completed tick ${result.plan.treatmentTick}, before its next tick.`} ${outcome('control')}; ${outcome('treatment')}.`,
            );
            for (const branch of ['control', 'treatment'])
              get<HTMLButtonElement>(branch).disabled = false;
          }
        };
        worker.postMessage({
          type: 'start',
          text,
          plan: {
            intervention: request.intervention,
            treatmentTick: completedTick + request.delay,
            horizonTick: completedTick + request.duration,
          },
        });
      } catch {
        failed('Could not start the comparison worker. No result retained.');
      }
    },
    failed(message: string): void {
      if (capture) failed(message);
    },
    invalidate(): void {
      if (capture || worker || result) failed('Comparison cleared: the sandbox lifecycle changed.');
    },
    dispose(): void {
      clear();
      alive = false;
      for (const cleanup of listeners) cleanup();
    },
  };
}
