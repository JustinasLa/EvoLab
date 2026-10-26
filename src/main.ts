import './style.css';
import '@fontsource/dm-mono/400.css';
import {
  DEFAULTS,
  COLORS,
  WIDTH,
  HEIGHT,
  clamp,
  founder,
  validGenome,
  validSettings,
  type Frame,
  type Genome,
  type Organism,
  type Settings,
  type Tool,
  type CellType,
  type PlaybackState,
} from './model';
import {
  draw,
  drawChart,
  genomeSvg,
  markup,
  organismHtml,
  point,
  viewport,
  type Camera,
} from './view';

export function mount(root: HTMLElement, worker: Worker): () => void {
  root.innerHTML = markup;
  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const canvas = get<HTMLCanvasElement>('world'),
    buffer = document.createElement('canvas');
  const camera: Camera = { zoom: 1, x: 0, y: 0 };
  let settingsEdits: Partial<Settings> = {};
  let settings = { ...DEFAULTS },
    runId = 0,
    paused = false,
    stopped = false,
    thermal = false,
    tool: Tool = 'pan',
    brush = 2;
  let frame: Frame | undefined,
    selected: Organism | null = null,
    blueprint = founder(0),
    cellType: CellType = 4;
  let dragging = false,
    lastX = 0,
    lastY = 0,
    dirty = true,
    alive = true,
    animation = 0,
    updates = 0,
    history: number[] = [];
  const text = (id: string, value: string): void => {
    get(id).textContent = value;
  };
  const notice = (message: string): void => text('notice', message);
  const send = (data: object): void => worker.postMessage(data);
  function renderPlayback(playback: PlaybackState): void {
    if (stopped) return;
    paused = playback.paused;
    get<HTMLInputElement>('pause-on-extinction').checked = playback.pauseOnExtinction;
    text('pause', paused ? '▶ Resume' : 'Ⅱ Pause');
    get<HTMLButtonElement>('step').disabled = !paused;
    text('run-state', paused ? 'PAUSED' : 'LIVE');
    root.classList.toggle('paused', paused);
    const summary = playback.extinction;
    get('extinction-summary').hidden = !summary;
    if (!summary) {
      text('extinction-summary', '');
      return;
    }
    const cause = {
      energy: 'Last removal: energy exhaustion. World preserved.',
      age: 'Last removal: age limit. World preserved.',
      manual: 'Last removal: manual erasure. World preserved.',
      'empty-import': 'Original extinction cause unavailable. World preserved.',
    }[summary.cause];
    text(
      'extinction-summary',
      `${paused ? 'Paused' : 'Empty world running'} · ${summary.cause === 'empty-import' ? 'imported empty world' : 'total extinction'} at tick ${summary.tick.toLocaleString()}. ${cause}${!paused ? ' Pause on extinction is off.' : ''}`,
    );
  }
  function renderSettings(next: Settings): void {
    settings = { ...next, ...settingsEdits };
    settingsEdits = {};
    for (const id of ['seed', 'mutation', 'nutrients', 'climate'] as const)
      get<HTMLInputElement>(id).value = String(settings[id]);
    text('mutation-value', `${Math.round(settings.mutation * 100)}%`);
    text('climate-value', `${Math.round(settings.climate * 100)}%`);
    text('nutrients-value', `${settings.nutrients}%`);
    text('world-label', `WORLD ${String(settings.seed).padStart(4, '0')}`);
  }
  function stop(): void {
    stopped = true;
    paused = true;
    text('pause', '▶ Resume');
    get<HTMLButtonElement>('step').disabled = true;
    text('run-state', 'STOPPED');
    root.classList.add('paused');
  }
  const tab = (name: string): void => {
    root
      .querySelectorAll<HTMLButtonElement>('[data-tab]')
      .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    get('ecosystem-panel').hidden = name !== 'ecosystem';
    get('organism-panel').hidden = name !== 'organism';
  };
  function choose(next: Tool): void {
    if (next === 'plant' && !validGenome(blueprint)) {
      notice('Draw 1–16 connected cells before placing an organism.');
      tab('organism');
      return;
    }
    tool = next;
    root
      .querySelectorAll<HTMLButtonElement>('button[data-tool]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    canvas.dataset.tool = tool;
    if (tool === 'plant') tab('organism');
    const painting = ['food', 'wall', 'erase'].includes(tool);
    get('brush-control').hidden = !painting;
    get('tool-hint').hidden = painting;
    text(
      'tool-hint',
      {
        inspect: 'Click an organism to inspect its cells.',
        pan: 'Drag to move the world. Scroll to zoom.',
        food: 'Paint food.',
        wall: 'Paint walls.',
        erase: 'Erase life and terrain.',
        plant: 'Click an empty patch to place your body.',
      }[tool],
    );
  }
  function editor(): void {
    get('editor').replaceChildren();
    for (let y = -4; y <= 4; y++)
      for (let x = -4; x <= 4; x++) {
        const button = document.createElement('button'),
          cell = blueprint.cells.find((c) => c.x === x && c.y === y);
        button.type = 'button';
        button.dataset.x = String(x);
        button.dataset.y = String(y);
        button.setAttribute('aria-label', `Cell ${x}, ${y}`);
        button.style.background = cell ? COLORS[cell.type] : '#121b25';
        get('editor').append(button);
      }
    get<HTMLInputElement>('preference').value = String(blueprint.preference);
    text('preference-value', `${Math.round(blueprint.preference * 40)}°`);
  }
  function reset(): void {
    const seed = Number(get<HTMLInputElement>('seed').value),
      next = { ...settings, seed };
    if (!get<HTMLInputElement>('seed').checkValidity() || !validSettings(next)) {
      notice('Choose a whole-number seed from 0 to 4294967295.');
      return;
    }
    settings = next;
    settingsEdits = {};
    runId++;
    history = [];
    updates = 0;
    stopped = false;
    selected = null;
    frame = undefined;
    notice('');
    renderPlayback({
      paused: false,
      pauseOnExtinction: get<HTMLInputElement>('pause-on-extinction').checked,
      extinction: null,
    });
    text('world-label', `WORLD ${String(seed).padStart(4, '0')}`);
    send({ type: 'start', settings, runId });
  }
  function setZoom(next: number, anchorX?: number, anchorY?: number): void {
    const old = viewport(canvas, camera),
      zoom = clamp(next, 0.5, 10),
      factor = zoom / camera.zoom;
    const x = anchorX ?? old.width / 2,
      y = anchorY ?? old.height / 2;
    camera.x = (camera.x + old.width / 2 - x) * factor - old.width / 2 + x;
    camera.y = (camera.y + old.height / 2 - y) * factor - old.height / 2 + y;
    camera.zoom = zoom;
    dirty = true;
  }
  function act(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect(),
      p = point(canvas, camera, event.clientX - rect.left, event.clientY - rect.top);
    if (!p) return;
    if (tool === 'inspect') {
      get<HTMLDetailsElement>('specimen-details').open = true;
      send({ type: 'inspect', ...p });
      tab('organism');
    } else if (tool !== 'pan')
      send({ type: 'paint', tool, ...p, radius: brush, genome: blueprint });
  }
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    act(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    if (tool === 'pan') {
      camera.x += event.clientX - lastX;
      camera.y += event.clientY - lastY;
      dirty = true;
    } else if (tool !== 'inspect' && tool !== 'plant') act(event);
    lastX = event.clientX;
    lastY = event.clientY;
  });
  const release = (): void => {
    dragging = false;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      setZoom(
        camera.zoom * Math.exp(-event.deltaY * 0.0015),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    },
    { passive: false },
  );
  const fit = (): void => {
    Object.assign(camera, { zoom: 1, x: 0, y: 0 });
    dirty = true;
  };
  canvas.addEventListener('dblclick', fit);
  get('fit').addEventListener('click', fit);
  get('zoom-in').addEventListener('click', () => setZoom(camera.zoom * 1.4));
  get('zoom-out').addEventListener('click', () => setZoom(camera.zoom / 1.4));
  root
    .querySelectorAll<HTMLButtonElement>('button[data-tool]')
    .forEach((b) => b.addEventListener('click', () => choose(b.dataset.tool as Tool)));
  root
    .querySelectorAll<HTMLButtonElement>('[data-tab]')
    .forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab!)));
  get('pause').addEventListener('click', () => {
    if (stopped) return;
    if (paused && !frame?.stats.population && get<HTMLInputElement>('pause-on-extinction').checked)
      notice('Place an organism, or turn off Pause on extinction and press Resume.');
    send({ type: paused ? 'resume' : 'pause' });
  });
  get('pause-on-extinction').addEventListener('change', () =>
    send({
      type: 'pause-on-extinction',
      runId,
      value: get<HTMLInputElement>('pause-on-extinction').checked,
    }),
  );
  get('step').addEventListener('click', () => {
    send({ type: 'step' });
  });
  get('speed').addEventListener('change', () =>
    send({ type: 'speed', value: Number(get<HTMLSelectElement>('speed').value) }),
  );
  get('thermal').addEventListener('click', () => {
    thermal = !thermal;
    get('thermal').setAttribute('aria-pressed', String(thermal));
    text('thermal', thermal ? 'Hide temperature' : 'Show temperature');
    dirty = true;
  });
  for (const id of ['mutation', 'nutrients', 'climate'] as const)
    get(id).addEventListener('input', () => {
      settings[id] = Number(get<HTMLInputElement>(id).value);
      settingsEdits[id] = settings[id];
      text(
        `${id}-value`,
        id === 'nutrients' ? `${settings[id]}%` : `${Math.round(settings[id] * 100)}%`,
      );
      send({ type: 'settings', settings: { [id]: settings[id] } });
    });
  get('brush').addEventListener('input', () => {
    brush = Number(get<HTMLInputElement>('brush').value);
    text('brush-value', `${brush} cells`);
  });
  get('preference').addEventListener('input', () => {
    blueprint.preference = Number(get<HTMLInputElement>('preference').value);
    text('preference-value', `${Math.round(blueprint.preference * 40)}°`);
  });
  get('reset').addEventListener('click', reset);
  root
    .querySelectorAll<HTMLButtonElement>('[data-shock]')
    .forEach((b) =>
      b.addEventListener('click', () => send({ type: 'shock', kind: b.dataset.shock })),
    );
  root.querySelectorAll<HTMLButtonElement>('[data-cell]').forEach((b) =>
    b.addEventListener('click', () => {
      cellType = Number(b.dataset.cell) as CellType;
      text('cell-description', b.title.split(': ')[1]);
      root
        .querySelectorAll<HTMLButtonElement>('[data-cell]')
        .forEach((other) => other.setAttribute('aria-pressed', String(other === b)));
    }),
  );
  get('editor').addEventListener('click', (event) => {
    const b = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-x]');
    if (!b) return;
    const x = Number(b.dataset.x),
      y = Number(b.dataset.y),
      existing = blueprint.cells.findIndex((c) => c.x === x && c.y === y);
    if (existing >= 0 && blueprint.cells[existing].type === cellType)
      blueprint.cells.splice(existing, 1);
    else if (existing >= 0) blueprint.cells[existing].type = cellType;
    else blueprint.cells.push({ x, y, type: cellType });
    editor();
    text(
      'design-note',
      validGenome(blueprint)
        ? `${blueprint.cells.length} connected cells. Ready to place.`
        : 'Use 1–16 cells, connected edge to edge.',
    );
  });
  get('clear-design').addEventListener('click', () => {
    blueprint = founder(0);
    editor();
  });
  get('plant-design').addEventListener('click', () => {
    choose('plant');
    if (tool === 'plant') {
      notice('Click in the world to place your organism.');
      canvas.scrollIntoView({ block: 'center' });
    }
  });
  root.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('#copy-organism') && selected) {
      blueprint = structuredClone(selected.genome);
      editor();
      get<HTMLDetailsElement>('specimen-details').open = false;
      notice('Anatomy copied. Edit it, then place it in the world.');
    }
  });
  get('help').addEventListener('click', () => get<HTMLDialogElement>('help-dialog').showModal());
  get('close-help').addEventListener('click', () => get<HTMLDialogElement>('help-dialog').close());
  get('save').addEventListener('click', () => send({ type: 'save' }));
  get('load').addEventListener('click', () => get<HTMLInputElement>('file').click());
  get('file').addEventListener('change', async () => {
    const input = get<HTMLInputElement>('file'),
      file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2500000) throw new Error('World file exceeds 2.5 MB.');
      const text = await file.text();
      if (alive) {
        settingsEdits = {};
        send({ type: 'load', text, runId: ++runId });
      }
    } catch (error) {
      if (alive) notice(error instanceof Error ? error.message : 'Could not read this world.');
    } finally {
      input.value = '';
    }
  });
  const keyboard = (event: KeyboardEvent): void => {
    if (
      (event.target instanceof HTMLElement && event.target.matches('input,select,textarea')) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      get<HTMLDialogElement>('help-dialog').open
    )
      return;
    if (event.code === 'Space') {
      event.preventDefault();
      get('pause').click();
    }
    const keys: Record<string, Tool> = {
      i: 'inspect',
      h: 'pan',
      f: 'food',
      w: 'wall',
      e: 'erase',
      p: 'plant',
    };
    if (keys[event.key.toLowerCase()]) choose(keys[event.key.toLowerCase()]);
  };
  window.addEventListener('keydown', keyboard);
  const resize = (): void => {
    dirty = true;
    if (frame) drawChart(get('chart'), history);
  };
  window.addEventListener('resize', resize);
  function renderFrame(next: Frame, selection: Organism | null, displayOnly = false): void {
    const previousSelection = selected?.id;
    const previousPopulation = frame?.stats.population;
    frame = next;
    selected = selection;
    dirty = true;
    if (!displayOnly) updates++;
    const s = frame.stats;
    const lineages = `${s.species} lineage${s.species === 1 ? '' : 's'}`;
    text('population', s.population.toLocaleString());
    text('species-count', lineages);
    text('births', String(s.births));
    text('deaths', String(s.deaths));
    text('food-count', String(s.food));
    text('generation', `GEN ${s.generation}`);
    text('tick', `TICK ${s.tick.toLocaleString()}`);
    text('world-count', `${s.population} organism${s.population === 1 ? '' : 's'} · ${lineages}`);
    text('season', s.season);
    text('weather', s.event);
    history = frame.telemetry.samples.map((sample) => sample.population);
    drawChart(get('chart'), history);
    if (
      displayOnly ||
      paused ||
      !s.population ||
      updates % 4 === 1 ||
      previousSelection !== selected?.id
    )
      get('inspector').innerHTML = organismHtml(selected, frame);
    if (displayOnly || !s.population || previousPopulation === 0 || updates % 12 === 1) {
      const list = get('lineages');
      list.replaceChildren();
      for (const species of s.top) {
        const b = document.createElement('button');
        b.className = 'lineage';
        b.title = 'Copy this lineage into the organism designer';
        b.innerHTML = `${genomeSvg(species.genome, 56)}<span><strong>${species.name} <small>#${species.id}</small></strong><i><b style="width:${(species.count / Math.max(1, s.population)) * 100}%"></b></i></span><em>${species.count}</em>`;
        b.addEventListener('click', () => {
          blueprint = structuredClone(species.genome);
          editor();
          get<HTMLDetailsElement>('specimen-details').open = false;
          tab('organism');
        });
        list.append(b);
      }
      if (!s.population)
        list.innerHTML =
          '<p class="muted">This world is quiet. Plant a new organism or reseed.</p>';
    }
  }
  worker.onmessage = ({ data }) => {
    if (!alive || data.runId !== runId) return;
    if (data.type === 'error') {
      if (data.fatal) stop();
      else if (data.recovery && !stopped) {
        renderSettings(data.recovery.settings);
        renderPlayback(data.recovery.playback);
        renderFrame(data.recovery.frame, data.recovery.selected, true);
      }
      notice(data.message);
      return;
    }
    if (data.type === 'playback') {
      renderPlayback(data.playback);
      return;
    }
    if (data.type === 'loaded') {
      stopped = false;
      renderSettings(data.settings);
      history = [];
      updates = 0;
      renderPlayback(data.playback);
      notice('World restored. Playback follows Pause on extinction.');
      return;
    }
    if (data.type === 'saved') {
      const url = URL.createObjectURL(new Blob([data.text], { type: 'application/json' })),
        a = document.createElement('a');
      a.href = url;
      a.download = `evolab-world-${settings.seed}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice('World saved, including every organism and its ancestry.');
      return;
    }
    if (data.type !== 'frame') return;
    renderPlayback(data.playback);
    renderFrame(data.frame, data.selected);
  };
  worker.onerror = () => {
    if (!alive) return;
    notice('The ecosystem worker stopped. Reload the page to restart.');
    stop();
  };
  function render(): void {
    if (dirty && frame) {
      draw(canvas, buffer, frame, camera, thermal, selected?.id ?? 0);
      dirty = false;
    }
    animation = requestAnimationFrame(render);
  }
  editor();
  choose(tool);
  tab('organism');
  reset();
  animation = requestAnimationFrame(render);
  return () => {
    alive = false;
    cancelAnimationFrame(animation);
    worker.terminate();
    window.removeEventListener('keydown', keyboard);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
  };
}
const root = document.getElementById('app');
if (root) mount(root, new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
