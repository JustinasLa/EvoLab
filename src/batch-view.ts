import {
  BATCH_MAX_BYTES,
  encodeBatch,
  validateBatchPlan,
  type BatchExport,
  type BatchPlan,
} from './batch-model';
import { EXPERIMENT_INTERVENTIONS } from './experiment-interventions';
import type { BatchResponse } from './batch-worker';
import { renderBatchReport } from './batch-report';

export function mountBatches(
  anchor: HTMLElement,
  context: () => string,
  beforeStart: () => void,
  createWorker: () => Worker = () =>
    new Worker(new URL('./batch-worker.ts', import.meta.url), { type: 'module' }),
) {
  const root = document.createElement('details');
  root.id = 'experiment-batches';
  root.innerHTML = `<summary>Independent seeded batches</summary>
    <p>Opt-in fresh single-founder worlds, not the sandbox. One unique seed per replicate. Burn in without rescue, then fork identical complete checkpoints. Treatment applies after the delay boundary, before the next tick. At most two experimental engines, eight pairs, 28800 engine ticks, 121 samples per branch and a 16 MB export. No world schema change.</p>
    <label>Independent uint32 seeds (comma separated)<input data-batch="seeds" value="42,43" /></label>
    <label>Burn-in ticks (0–1200)<input data-batch="burn" type="number" min="0" max="1200" value="0" /></label>
    <label>Paired horizon duration (1–3600)<input data-batch="duration" type="number" min="1" max="3600" value="300" /></label>
    <label>Treatment delay<input data-batch="delay" type="number" min="0" value="0" /></label>
    <label>Initial mutation probability<input data-batch="mutation" type="number" min="0" max="0.4" step="0.01" value="0.12" /></label>
    <label>Initial leaf food chance (%)<input data-batch="nutrients" type="number" min="0" max="20" value="5" /></label>
    <label>Initial climate pressure<input data-batch="climate" type="number" min="0" max="1" step="0.1" value="0.8" /></label>
    <label>Terrain (seed follows each world)<select data-batch="terrain"><option value="porous-ridges">Porous ridges</option><option value="open-field">Open field</option><option value="chambered-refuges">Chambered refuges</option></select></label>
    <label>Intervention preset<select data-batch="intervention">${Object.entries(
      EXPERIMENT_INTERVENTIONS,
    )
      .map(([key, value]) => `<option value="${key}">${value.label}</option>`)
      .join('')}</select></label>
    <p>Shade enables full attenuation on a radius-eight center disk, reducing real leaf energy and food production. Mutation presets change birth probability, not fitness or existing bodies. Settings can already equal a preset: a documented no-op is valid. Existing energy and mutation-policy rules apply.</p>
    <button data-batch="start">Run independent batch</button><button data-batch="cancel" disabled>Cancel batch</button>
    <button data-batch="export" disabled>Export batch plan and results</button><button data-batch="import">Replay batch export</button>
    <input data-batch="file" type="file" accept="application/json,.json" hidden />
    <p data-batch="status" role="status">Ready. Replays verify completed observations; incomplete or failed seeds run afresh, never count twice.</p><div data-batch="report"></div>`;
  anchor.after(root);
  const get = <T extends HTMLElement>(name: string): T =>
    root.querySelector(`[data-batch="${name}"]`)!;
  let worker: Worker | undefined,
    result: BatchExport | undefined,
    generation = 0,
    alive = true,
    reading = false;
  let url: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const status = (text: string): void => {
    get('status').textContent = text;
  };
  const releaseDownload = (): void => {
    clearTimeout(timer);
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    get<HTMLButtonElement>('export').disabled = !result;
  };
  const releaseWorker = (): void => {
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    get<HTMLButtonElement>('start').disabled = false;
    get<HTMLButtonElement>('import').disabled = reading;
    get<HTMLButtonElement>('cancel').disabled = true;
  };
  const clear = (): void => {
    generation++;
    releaseWorker();
    result = undefined;
    releaseDownload();
    get('report').replaceChildren();
  };
  const fail = (error: unknown): void => {
    clear();
    status(error instanceof Error ? error.message : 'Batch failed; no results retained.');
  };
  const begin = (): void => {
    beforeStart();
    clear();
    for (const name of ['start', 'import']) get<HTMLButtonElement>(name).disabled = true;
    get<HTMLButtonElement>('cancel').disabled = false;
  };
  const launch = (
    message: { type: 'start'; plan: BatchPlan } | { type: 'replay'; text: string },
  ): void => {
    const owner = generation,
      source = context();
    const current = () => alive && owner === generation && source === context();
    try {
      worker = createWorker();
      worker.onerror = worker.onmessageerror = () => {
        if (current())
          fail(new Error('Batch worker failed; outcomes are incomplete, no result retained.'));
      };
      worker.onmessage = ({ data }: MessageEvent<BatchResponse>) => {
        if (!current()) return;
        if (data.type === 'error') fail(new Error(data.message));
        else if (data.type === 'complete') {
          result = data.result;
          releaseWorker();
          renderBatchReport(get('report'), result);
          get<HTMLButtonElement>('export').disabled = false;
          status(
            'Batch stopped. Per-seed completion, failure and cancellation evidence below; sandbox unchanged.',
          );
        } else {
          status(
            `Seed index ${data.progress.run + 1}, ${data.progress.phase}, tick ${data.progress.tick}; sandbox unchanged.`,
          );
          try {
            worker!.postMessage({ type: 'ack' });
          } catch (error) {
            fail(error);
          }
        }
      };
      worker.postMessage(message);
    } catch (error) {
      fail(error);
    }
  };
  get('start').onclick = () => {
    begin();
    const number = (name: string) => Number(get<HTMLInputElement>(name).value || NaN);
    const plan: BatchPlan = {
      seeds: get<HTMLInputElement>('seeds')
        .value.split(',')
        .map((value) => (value.trim() ? Number(value) : NaN)),
      initialization: 'single-founder',
      settings: {
        mutation: number('mutation'),
        nutrients: number('nutrients'),
        climate: number('climate'),
      },
      terrain: {
        version: 1,
        seed: null,
        preset: get<HTMLSelectElement>('terrain').value as BatchPlan['terrain']['preset'],
      },
      burnInTicks: number('burn'),
      durationTicks: number('duration'),
      treatmentDelay: number('delay'),
      intervention: get<HTMLSelectElement>('intervention').value as BatchPlan['intervention'],
    };
    try {
      validateBatchPlan(plan);
      launch({ type: 'start', plan });
    } catch (error) {
      fail(error);
    }
  };
  get('cancel').onclick = () => {
    if (worker) {
      try {
        worker.postMessage({ type: 'cancel' });
        get<HTMLButtonElement>('cancel').disabled = true;
      } catch (error) {
        fail(error);
      }
    } else {
      clear();
      status('Batch read cancelled; no seeds run.');
    }
  };
  const file = get<HTMLInputElement>('file');
  get('import').onclick = () => {
    file.value = '';
    file.click();
  };
  file.onchange = async () => {
    const selected = file.files?.[0];
    file.value = '';
    if (!alive || !selected || reading) return;
    begin();
    reading = true;
    const owner = generation,
      source = context();
    const current = () => alive && owner === generation && source === context();
    status('Reading batch export; sandbox unchanged.');
    try {
      if (selected.size > BATCH_MAX_BYTES) throw new Error('Batch export exceeds 16 MB.');
      const text = await selected.text();
      if (current()) launch({ type: 'replay', text });
    } catch (error) {
      if (current()) fail(error);
    } finally {
      reading = false;
      if (alive) get<HTMLButtonElement>('import').disabled = !!worker;
    }
  };
  get('export').onclick = () => {
    if (!result || url) return;
    try {
      url = URL.createObjectURL(new Blob([encodeBatch(result)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'evolab-batch.json';
      link.click();
      get<HTMLButtonElement>('export').disabled = true;
      timer = setTimeout(releaseDownload, 1000);
    } catch (error) {
      releaseDownload();
      status(error instanceof Error ? error.message : 'Could not export batch.');
    }
  };
  return {
    invalidate(): void {
      clear();
      status('Batch cleared: sandbox lifecycle or experiment ownership changed.');
    },
    dispose(): void {
      alive = false;
      clear();
      for (const name of ['start', 'cancel', 'export', 'import']) get(name).onclick = null;
      file.onchange = null;
    },
  };
}
