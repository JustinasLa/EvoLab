import { renderComparisonReport, type ComparisonMetric } from './experiment-report';
import { mountBatches } from './batch-view';
import { integer } from './model';
import {
  COMPARISON_MAX_TICKS,
  RECIPE_MAX_BYTES,
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
  let reading = false;
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
    for (const branch of ['control', 'treatment', 'recipe'])
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
    for (const branch of ['control', 'treatment', 'recipe'])
      get<HTMLButtonElement>(branch).disabled = true;
  };
  const failed = (message: string): void => {
    if (!alive) return;
    clear();
    status(message);
  };
  const start = (): void => {
    if (!alive || capture || worker) return;
    batches.invalidate();
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
  for (const branch of ['control', 'treatment', 'recipe'] as const)
    listen(branch, () => {
      if (!result || url) return;
      try {
        url = URL.createObjectURL(
          new Blob([branch === 'recipe' ? result.recipe : result[branch].state], {
            type: 'application/json',
          }),
        );
        for (const branch of ['control', 'treatment', 'recipe'])
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
  function render(): void {
    if (result)
      renderComparisonReport(
        get('results'),
        result,
        get<HTMLSelectElement>('metric').value as ComparisonMetric,
      );
  }
  get('metric').addEventListener('change', render);
  listeners.push(() => get('metric').removeEventListener('change', render));
  function launch(
    message:
      { type: 'start'; text: string; plan: ComparisonPlan } | { type: 'replay'; text: string },
    context: string,
  ): void {
    const owner = generation;
    const current = (): boolean => alive && owner === generation && context === hooks.context();
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
          render();
          const outcome = (branch: 'control' | 'treatment'): string => {
            const extinction = result![branch].extinction;
            return extinction
              ? `${branch}: extinct (${extinction.tick === null ? 'initially empty; historical tick unknown' : `tick ${extinction.tick}`}, ${extinction.cause})`
              : `${branch}: alive at horizon`;
          };
          status(
            `Complete: checkpoint tick ${result.sourceTick}, equal horizon ${result.plan.horizonTick}. ${result.plan.intervention === 'none' ? 'No intervention (control/control).' : `${result.plan.intervention} applied after completed tick ${result.plan.treatmentTick}, before its next tick.`} ${outcome('control')}; ${outcome('treatment')}.`,
          );
          if (result.reproduced)
            status(
              get('status').textContent +
                ' Recipe reproduced: all recorded observations and extinction outcomes match.',
            );
          for (const branch of ['control', 'treatment', 'recipe'])
            get<HTMLButtonElement>(branch).disabled = false;
        }
      };
      worker.postMessage(message);
    } catch {
      failed('Could not start the comparison worker. No result retained.');
    }
  }
  const input = get<HTMLInputElement>('file');
  listen('import', () => {
    input.value = '';
    input.click();
  });
  const readRecipe = async (): Promise<void> => {
    const file = input.files?.[0];
    input.value = '';
    if (!alive || !file || reading) return;
    batches.invalidate();
    clear();
    reading = true;
    const owner = generation,
      context = hooks.context();
    const current = () => alive && owner === generation && context === hooks.context();
    get<HTMLButtonElement>('start').disabled = true;
    get<HTMLButtonElement>('cancel').disabled = false;
    get<HTMLButtonElement>('import').disabled = true;
    status('Reading experiment recipe; sandbox unchanged.');
    try {
      if (file.size > RECIPE_MAX_BYTES) throw new Error('Experiment recipe exceeds 15.2 MB.');
      const text = await file.text();
      if (current()) launch({ type: 'replay', text }, context);
    } catch (error) {
      if (current())
        failed(error instanceof Error ? error.message : 'Could not read experiment recipe.');
    } finally {
      reading = false;
      if (alive) get<HTMLButtonElement>('import').disabled = false;
    }
  };
  input.addEventListener('change', readRecipe);
  listeners.push(() => input.removeEventListener('change', readRecipe));
  const batches = mountBatches(
    get('status').closest('details') ?? get('status'),
    hooks.context,
    () => {
      clear();
      status('Comparison cleared: an independent batch started.');
    },
  );
  return {
    saved(text: string, completedTick: number): void {
      if (!alive || !capture) return;
      const request = capture;
      if (request.context !== hooks.context()) {
        failed('Comparison capture cancelled: the world changed.');
        return;
      }
      launch(
        {
          type: 'start',
          text,
          plan: {
            intervention: request.intervention,
            treatmentTick: completedTick + request.delay,
            horizonTick: completedTick + request.duration,
          },
        },
        request.context,
      );
    },
    failed(message: string): void {
      if (capture) failed(message);
    },
    invalidate(): void {
      batches.invalidate();
      if (capture || worker || result || reading)
        failed('Comparison cleared: the sandbox lifecycle changed.');
    },
    dispose(): void {
      batches.dispose();
      clear();
      alive = false;
      for (const cleanup of listeners) cleanup();
    },
  };
}
