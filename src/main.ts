import './style.css';
import '@fontsource-variable/dm-sans';
import '@fontsource/dm-mono/400.css';
import {
  DEFAULTS,
  readChampion,
  validSettings,
  type Generation,
  type Genome,
  type Settings,
  type Trial,
} from './model';
import { chart, drawScene, markup } from './view';

export function mount(root: HTMLElement, worker: Worker): () => void {
  root.innerHTML = markup;
  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const world = get<HTMLCanvasElement>('world');
  let settings = { ...DEFAULTS };
  let pendingCourse = settings.course;
  let champion: Trial | undefined;
  let selected: Trial | undefined;
  let paused = false;
  let following = true;
  let replayStart = performance.now();
  let history: Pick<Generation, 'index' | 'best' | 'median'>[] = [];
  let survivors: Generation[] = [];
  let alive = true;
  let animation = 0;
  let runId = 0;
  const notice = (message: string): void => {
    get('notice').textContent = message;
  };
  const text = (id: string, value: string): void => {
    get(id).textContent = value;
  };
  const send = (type: string): void => worker.postMessage({ type });
  function select(trial: Trial): void {
    selected = trial;
    replayStart = performance.now();
    text(
      'specimen',
      `SPECIMEN ${trial.genome.id.toUpperCase()} / ${trial.genome.genes.length} SEGMENTS`,
    );
    text('replay-label', `${trial.distance.toFixed(2)} m TRAVELLED`);
  }
  function begin(founder?: Genome): void {
    champion = undefined;
    selected = undefined;
    history = [];
    survivors = [];
    paused = false;
    following = true;
    get<HTMLButtonElement>('export').disabled = true;
    get<HTMLButtonElement>('pause').disabled = false;
    get('follow').hidden = true;
    text('pause', 'Ⅱ Pause evolution');
    text('status', 'Evolving');
    text('generation', '000');
    text('best', '—');
    text('diversity', '—');
    get('population').innerHTML = `${settings.population}<span> creatures</span>`;
    text('habitat-label', `${settings.course.toUpperCase()} / ${settings.gravity.toFixed(2)} m/s²`);
    text('survivors', 'Your first champion will be here shortly.');
    text('specimen', 'Finding our first survivor…');
    text('replay-label', '8 SECOND TRIAL');
    text('progress-text', 'Preparing population');
    text(
      'chart-description',
      'Every generation gets the same course and eight seconds to make its case.',
    );
    text('pending', 'Same seed. Same settings. Same starting creatures.');
    notice('');
    root.classList.remove('paused');
    chart(get('chart'), []);
    worker.postMessage({ type: 'start', settings, founder, runId: ++runId });
  }
  function readSettings(): Settings {
    return {
      seed: Number(get<HTMLInputElement>('seed').value),
      population: Number(get<HTMLSelectElement>('population-setting').value),
      gravity: Number(get<HTMLInputElement>('gravity').value),
      mutation: Number(get<HTMLInputElement>('mutation').value),
      course: pendingCourse,
    };
  }
  root.querySelectorAll<HTMLButtonElement>('[data-course]').forEach((button) =>
    button.addEventListener('click', () => {
      pendingCourse = button.dataset.course as Settings['course'];
      root
        .querySelectorAll<HTMLButtonElement>('[data-course]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      text('pending', 'Settings changed. Begin a new experiment to apply.');
    }),
  );
  for (const id of ['gravity', 'mutation', 'population-setting', 'seed'])
    get(id).addEventListener('input', () => {
      text('gravity-value', `${Number(get<HTMLInputElement>('gravity').value).toFixed(2)} m/s²`);
      text(
        'mutation-value',
        `${Math.round(Number(get<HTMLInputElement>('mutation').value) * 100)}%`,
      );
      text('pending', 'Settings changed. Begin a new experiment to apply.');
    });
  get('restart').addEventListener('click', () => {
    const next = readSettings();
    if (!get<HTMLInputElement>('seed').checkValidity() || !validSettings(next)) {
      notice('Choose a whole-number seed between 0 and 4294967295.');
      return;
    }
    settings = next;
    begin();
  });
  get('pause').addEventListener('click', () => {
    paused = !paused;
    send(paused ? 'pause' : 'resume');
    root.classList.toggle('paused', paused);
    text('pause', paused ? '▶ Resume evolution' : 'Ⅱ Pause evolution');
    text('status', paused ? 'Evolution paused' : 'Evolving');
  });
  get('follow').addEventListener('click', () => {
    following = true;
    get('follow').hidden = true;
    if (champion) select(champion);
  });
  get('export').addEventListener('click', () => {
    if (!selected) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ version: 1, settings, genome: selected.genome }, null, 2)], {
        type: 'application/json',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `evolab-${selected.genome.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('Champion saved. Load it later to found a new population.');
  });
  get('import').addEventListener('click', () => get<HTMLInputElement>('file').click());
  get('file').addEventListener('change', async () => {
    const input = get<HTMLInputElement>('file');
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 32000)
        throw new Error('This file is too large. Choose an EvoLab champion JSON.');
      const saved = readChampion(await file.text());
      if (!alive) return;
      settings = saved.settings;
      pendingCourse = settings.course;
      for (const id of ['seed', 'gravity', 'mutation'])
        get<HTMLInputElement>(id).value = String(settings[id as 'seed' | 'gravity' | 'mutation']);
      get<HTMLSelectElement>('population-setting').value = String(settings.population);
      root
        .querySelectorAll<HTMLButtonElement>('[data-course]')
        .forEach((b) =>
          b.setAttribute('aria-pressed', String(b.dataset.course === settings.course)),
        );
      text('gravity-value', `${settings.gravity.toFixed(2)} m/s²`);
      text('mutation-value', `${Math.round(settings.mutation * 100)}%`);
      begin(saved.genome);
      notice('Champion loaded. Its descendants are entering a fresh experiment.');
    } catch (error) {
      if (alive)
        notice(error instanceof Error ? error.message : 'Could not read this champion file.');
    } finally {
      input.value = '';
    }
  });
  worker.onmessage = ({ data }) => {
    if (!alive || data.runId !== runId) return;
    if (data.type === 'error') {
      notice(data.message);
      text('status', 'Experiment stopped');
      get<HTMLButtonElement>('pause').disabled = true;
      return;
    }
    if (data.type === 'progress') {
      text('progress-text', `Testing creature ${data.completed} / ${data.total}`);
      return;
    }
    if (data.type !== 'generation') return;
    const generation = data.generation as Generation;
    champion = generation.champion;
    history.push({ index: generation.index, best: generation.best, median: generation.median });
    history = history.slice(-240);
    survivors.unshift(generation);
    survivors = survivors.slice(0, 8);
    if (following && !selected) select(champion);
    text('generation', String(generation.index).padStart(3, '0'));
    text('best', `${generation.best.toFixed(2)} m`);
    text('diversity', String(generation.diversity));
    get<HTMLButtonElement>('export').disabled = false;
    chart(get('chart'), history);
    text(
      'chart-description',
      `Generation ${generation.index}: best fitness ${generation.best.toFixed(2)} m; median ${generation.median.toFixed(2)} m. Showing up to 240 generations.`,
    );
    const list = get('survivors');
    list.replaceChildren();
    for (const g of survivors) {
      const button = document.createElement('button');
      button.className = 'survivor';
      button.innerHTML = `<span>GEN ${String(g.index).padStart(3, '0')}</span><strong>${g.best.toFixed(2)}<small> m</small></strong><span>${g.champion.genome.genes.length} segments ↗</span>`;
      button.addEventListener('click', () => {
        following = false;
        select(g.champion);
        get('follow').hidden = false;
      });
      list.append(button);
    }
  };
  worker.onerror = () => {
    notice('The simulation could not run. Reload the page or try a current browser.');
    text('status', 'Experiment stopped');
    get<HTMLButtonElement>('pause').disabled = true;
  };
  function render(now: number): void {
    const speed = Number(get<HTMLSelectElement>('speed').value);
    if (
      selected &&
      now - replayStart >= (selected.frames.length * 50) / speed &&
      following &&
      champion
    )
      select(champion);
    const frame = selected
      ? Math.floor((Math.max(0, now - replayStart) / 50) * speed) % selected.frames.length
      : 0;
    drawScene(world, selected, frame, settings.course);
    animation = requestAnimationFrame(render);
  }
  begin();
  animation = requestAnimationFrame(render);
  return () => {
    alive = false;
    cancelAnimationFrame(animation);
    worker.terminate();
  };
}

const root = document.getElementById('app');
if (root) mount(root, new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
