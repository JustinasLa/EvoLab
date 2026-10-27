import './style.css';
import '@fontsource/dm-mono/400.css';
import {
  DEFAULTS,
  COLORS,
  WIDTH,
  HEIGHT,
  WORLD_MAX_BYTES,
  clamp,
  founder,
  speciesName,
  validGenome,
  validSettings,
  integer,
  observedGenome,
  observedSettings,
  nextSessionId,
  type HabitatFrame,
  type WorldPresentation,
  type CommandPayload,
  type ControlState,
  type DisplayView,
  type AcceptedTelemetrySource,
  type TelemetrySnapshot,
  type WorkerResponse,
  type Genome,
  type Organism,
  type Settings,
  type Tool,
  type CellType,
  type PlaybackState,
} from './model';
import { draw, genomeSvg, markup, organismHtml, point, viewport, type Camera } from './view';
import { createTelemetryView } from './telemetry-view';
import {
  BLUEPRINT_DEFAULT_NAME,
  BLUEPRINT_MAX_BYTES,
  parseBlueprint,
  serializeBlueprint,
} from './blueprint';

export function captureCommand(data: any, settings: Settings): CommandPayload {
  if (!data || typeof data !== 'object') throw new Error('Invalid control.');
  const coordinates = (): void => {
    if (!integer(data.x, 0, WIDTH - 1) || !integer(data.y, 0, HEIGHT - 1))
      throw new Error('Invalid habitat coordinates.');
  };
  switch (data.type) {
    case 'start':
      if (
        !validSettings(data.settings) ||
        !data.display ||
        !integer(data.display.epoch, 0, Number.MAX_SAFE_INTEGER) ||
        typeof data.display.enabled !== 'boolean' ||
        typeof data.display.visible !== 'boolean'
      )
        throw new Error('Invalid initial settings or display.');
      return {
        type: 'start',
        settings: observedSettings(data.settings),
        display: {
          epoch: data.display.epoch,
          enabled: data.display.enabled,
          visible: data.display.visible,
        },
      };
    case 'load':
      if (
        typeof data.text !== 'string' ||
        data.text.length > WORLD_MAX_BYTES ||
        new TextEncoder().encode(data.text).byteLength > WORLD_MAX_BYTES
      )
        throw new Error('World file exceeds 2.5 MB or is not text.');
      return { type: 'load', text: data.text };
    case 'pause':
    case 'resume':
    case 'step':
    case 'save':
      return { type: data.type };
    case 'snapshot':
      if (typeof data.display !== 'boolean') throw new Error('Invalid refresh request.');
      return { type: 'snapshot', display: data.display };
    case 'run-to':
      if (!integer(data.targetTick, 0, 1e9))
        throw new Error('Choose an absolute whole tick from 0 to 1000000000.');
      return { type: 'run-to', targetTick: data.targetTick };
    case 'cancel-target':
      if (!integer(data.targetId, 1, Number.MAX_SAFE_INTEGER))
        throw new Error('No active target to cancel.');
      return { type: 'cancel-target', targetId: data.targetId };
    case 'speed':
      if (![1, 4, 12].includes(data.value)) throw new Error('Invalid speed.');
      return { type: 'speed', value: data.value };
    case 'pause-on-extinction':
      if (typeof data.value !== 'boolean') throw new Error('Invalid extinction preference.');
      return { type: 'pause-on-extinction', value: data.value };
    case 'settings': {
      if (
        !data.settings ||
        typeof data.settings !== 'object' ||
        Object.keys(data.settings).some(
          (key) => !['mutation', 'nutrients', 'climate'].includes(key),
        ) ||
        !validSettings({ ...settings, ...data.settings })
      )
        throw new Error('Invalid live settings.');
      const patch: Partial<Settings> = {};
      for (const key of ['mutation', 'nutrients', 'climate'] as const)
        if (Object.hasOwn(data.settings, key)) patch[key] = data.settings[key];
      return { type: 'settings', settings: patch };
    }
    case 'inspect':
      coordinates();
      return { type: 'inspect', x: data.x, y: data.y };
    case 'paint':
      coordinates();
      if (
        !['food', 'wall', 'erase', 'plant'].includes(data.tool) ||
        !integer(data.radius, 0, 8) ||
        !validGenome(data.genome)
      )
        throw new Error('Draw 1–16 connected cells with valid traits before painting.');
      return {
        type: 'paint',
        tool: data.tool,
        x: data.x,
        y: data.y,
        radius: data.radius,
        genome: observedGenome(data.genome),
      };
    case 'shock':
      if (data.kind !== 'cold' && data.kind !== 'heat') throw new Error('Invalid climate event.');
      return { type: 'shock', kind: data.kind };
    default:
      throw new Error('Unknown control.');
  }
}

export function mount(root: HTMLElement, worker: Worker): () => void {
  root.innerHTML = markup;
  const controls = new Map(
    [...root.querySelectorAll<HTMLElement>('[id]')].map((element) => [element.id, element]),
  );
  const get = <T extends HTMLElement>(id: string): T =>
    (controls.get(id) as T | undefined) ?? root.querySelector<T>(`#${id}`)!;
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
  let frame: HabitatFrame | undefined,
    selected: Organism | null = null,
    blueprint = founder(0),
    cellType: CellType = 4;
  let blueprintName = BLUEPRINT_DEFAULT_NAME,
    blueprintDescription = '',
    designRevision = 0,
    blueprintRequest = 0;
  let dragging = false,
    lastX = 0,
    lastY = 0,
    dirty = true,
    alive = true,
    animation = 0,
    updates = 0;
  const telemetry = createTelemetryView(root);
  const text = (id: string, value: string): void => {
    const element = get(id);
    if (element.textContent !== value) element.textContent = value;
  };
  const notice = (message: string): void => text('notice', message);
  type TargetTicket = { wireId: number | null };
  type Entry = {
    ticket: number;
    payload: CommandPayload;
    generation: number;
    reserved: boolean;
    targetTicket?: TargetTicket;
    cancelTicket?: TargetTicket;
  };
  type Posted = Omit<Entry, 'payload'> & {
    type: CommandPayload['type'];
    commandId: number;
    runId: number;
  };
  const pending: Entry[] = [];
  const pendingSettings: Partial<Record<keyof Settings, { ticket: number; value: number }>> = {};
  let posted: Posted | null = null,
    ticket = 0,
    wireId = 0,
    generation = 0;
  let latestState: ControlState | undefined,
    acceptedRun = 0,
    latestTelemetry: AcceptedTelemetrySource | null = null;
  let targetTicket: TargetTicket | undefined;
  let targetPresentationReplacement: number | undefined,
    targetTransition = '';
  let establishedRun: number | null = null,
    discardFenceEpoch = 0,
    displayWatermark = 0,
    progressWatermark = 0;
  let desiredView: DisplayView = {
    epoch: 0,
    enabled: true,
    visible:
      document.visibilityState !== 'hidden' &&
      canvas.getBoundingClientRect().width > 0 &&
      canvas.getBoundingClientRect().height > 0,
  };
  let acknowledgedView: DisplayView = { ...desiredView },
    viewIntent: DisplayView | null = null;
  let heldDisplay: { runId: number; sequence: number; viewEpoch: number } | null = null;
  let pendingFrame: Extract<WorkerResponse, { type: 'frame' }> | null = null;
  let displayedRevision = -1,
    displayedEpoch = -1,
    displayedSelected = 0;
  let worldRequest = 0,
    reading = false;
  let pendingSpeed: { ticket: number; value: number } | null = null,
    pendingExtinction: { ticket: number; value: boolean } | null = null;
  let waitingFile: { file: File; request: number; generation: number; run: number } | null = null;
  function increment(value: number): number {
    try {
      return nextSessionId(value);
    } catch (error) {
      stop();
      throw error;
    }
  }
  function releaseDiscard(): void {
    if (
      !alive ||
      !heldDisplay ||
      pendingFrame ||
      establishedRun !== runId ||
      acknowledgedView.epoch < discardFenceEpoch ||
      ((!desiredView.enabled || !desiredView.visible) &&
        acknowledgedView.enabled &&
        acknowledgedView.visible)
    )
      return;
    const token = heldDisplay;
    heldDisplay = null;
    displayWatermark = token.sequence;
    worker.postMessage({
      type: 'flow-ack',
      channel: 'display',
      runId: token.runId,
      sequence: token.sequence,
    });
  }
  function pump(): void {
    if (!alive || posted) return;
    const start = pending[0]?.payload.type === 'start';
    if (viewIntent && !start && establishedRun === runId && !stopped) {
      const view = viewIntent;
      viewIntent = null;
      wireId = increment(wireId);
      posted = {
        type: 'display-view',
        ticket: 0,
        generation,
        reserved: false,
        runId,
        commandId: wireId,
      };
      worker.postMessage({ type: 'display-view', view, runId, commandId: wireId });
      return;
    }
    const entry = pending.shift();
    if (!entry) {
      releaseDiscard();
      return;
    }
    let payload = entry.payload;
    if (payload.type === 'cancel-target' && entry.cancelTicket) {
      payload.targetId = entry.cancelTicket.wireId!;
    }
    wireId = increment(wireId);
    if (entry.targetTicket) entry.targetTicket.wireId = wireId;
    if (payload.type === 'start' || payload.type === 'load') {
      runId = increment(runId);
      establishedRun = null;
      pendingFrame = null;
      telemetry.update({ status: 'pending', commandId: wireId });
      if (payload.type === 'start') {
        payload.display = { ...desiredView };
        if (viewIntent?.epoch === desiredView.epoch) viewIntent = null;
      }
      text('run-state', 'LOADING');
    }
    posted = {
      type: payload.type,
      ticket: entry.ticket,
      generation: entry.generation,
      reserved: entry.reserved,
      commandId: wireId,
      runId,
      targetTicket: entry.targetTicket,
      cancelTicket: entry.cancelTicket,
    };
    worker.postMessage({ ...payload, runId, commandId: wireId });
  }
  function send(data: any): boolean {
    if (!alive || (stopped && data.type !== 'start' && data.type !== 'load')) return false;
    try {
      let payload = captureCommand(data, settings);
      const reserved = payload.type === 'pause' || payload.type === 'cancel-target';
      let segment = pending.length;
      while (
        segment > 0 &&
        ['speed', 'inspect', 'settings'].includes(pending[segment - 1].payload.type)
      )
        segment--;
      const superseded = ['speed', 'inspect', 'settings'].includes(payload.type)
        ? pending.slice(segment).filter((entry) => entry.payload.type === payload.type)
        : [];
      if (payload.type === 'settings') {
        const merged: Partial<Settings> = {};
        for (const entry of superseded)
          if (entry.payload.type === 'settings') Object.assign(merged, entry.payload.settings);
        payload = { type: 'settings', settings: { ...merged, ...payload.settings } };
      }
      if (
        payload.type !== 'start' &&
        (reserved
          ? pending.some((entry) => entry.reserved)
          : pending.filter((entry) => !entry.reserved).length - superseded.length >= 30)
      ) {
        dragging = false;
        notice('Controls busy; wait for acknowledgement.');
        return false;
      }
      for (const entry of superseded) pending.splice(pending.indexOf(entry), 1);
      ticket = increment(ticket);
      const entry: Entry = { ticket, payload, generation, reserved };
      if (payload.type === 'speed') pendingSpeed = { ticket, value: payload.value };
      if (payload.type === 'pause-on-extinction')
        pendingExtinction = { ticket, value: payload.value };
      if (payload.type === 'run-to') {
        targetTicket = { wireId: null };
        entry.targetTicket = targetTicket;
        text('target-status', 'Target request pending acknowledgement.');
        get<HTMLButtonElement>('cancel-target').disabled = false;
      }
      if (payload.type === 'cancel-target' && targetTicket) entry.cancelTicket = targetTicket;
      if (payload.type === 'settings')
        for (const key of ['mutation', 'nutrients', 'climate'] as const) {
          const value = payload.settings[key];
          if (value !== undefined) {
            pendingSettings[key] = { ticket, value };
            settingsEdits[key] = value;
          }
        }
      pending.push(entry);
      pump();
      return true;
    } catch (error) {
      dragging = false;
      notice((error as Error).message);
      return false;
    }
  }
  function freshness(): void {
    const current = latestState;
    text(
      'habitat-freshness',
      `World tick ${current?.world.stats.tick ?? 'unknown'} · habitat tick ${frame?.stats.tick ?? 'not received'} · ${!desiredView.visible ? 'Habitat not visible' : !desiredView.enabled ? 'Rendering off' : !frame || displayedEpoch !== desiredView.epoch ? 'Refreshing habitat…' : displayedRevision !== current?.revision ? (frame.stats.tick === current?.world.stats.tick ? 'Habitat awaiting latest edit' : 'Habitat is behind world progress') : `Habitat current at tick ${frame.stats.tick}`}`,
    );
  }
  function changeView(enabled = desiredView.enabled, visible = desiredView.visible): void {
    if (!alive || (enabled === desiredView.enabled && visible === desiredView.visible)) return;
    desiredView = { epoch: increment(desiredView.epoch), enabled, visible };
    viewIntent = { ...desiredView };
    if (!enabled || !visible) discardFenceEpoch = desiredView.epoch;
    if (pendingFrame) {
      pendingFrame = null;
      discardFenceEpoch = desiredView.epoch;
    }
    get<HTMLInputElement>('render-habitat').checked = enabled;
    text('render-pending', 'Rendering preference pending');
    freshness();
    pump();
    releaseDiscard();
  }
  function renderPlayback(playback: PlaybackState): void {
    if (stopped) return;
    paused = playback.paused;
    get<HTMLInputElement>('pause-on-extinction').checked =
      pendingExtinction?.value ?? playback.pauseOnExtinction;
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
    settingsEdits = {};
    for (const key of ['mutation', 'nutrients', 'climate'] as const)
      if (pendingSettings[key]) settingsEdits[key] = pendingSettings[key]!.value;
    settings = { ...next, ...settingsEdits };
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
    pending.length = 0;
    viewIntent = null;
    establishedRun = null;
    pendingFrame = null;
    targetTicket = undefined;
    get<HTMLButtonElement>('cancel-target').disabled = true;
    text('pause', '▶ Resume');
    get<HTMLButtonElement>('step').disabled = true;
    text('run-state', 'STOPPED');
    text('tick-rate', 'Measured ticks/s: — · paused/stopped');
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
    get<HTMLInputElement>('blueprint-name').value = blueprintName;
    get<HTMLTextAreaElement>('blueprint-description').value = blueprintDescription;
    text(
      'design-note',
      validGenome(blueprint)
        ? `${blueprint.cells.length} connected cells. Ready to place.`
        : 'Use 1–16 cells, connected edge to edge.',
    );
  }
  function copyDesign(genome: Genome): void {
    designRevision++;
    blueprint = structuredClone(genome);
    blueprintName = speciesName(genome);
    blueprintDescription = '';
    editor();
    get<HTMLDetailsElement>('specimen-details').open = false;
  }
  function exportBlueprint(genome: Genome, name: string, description: string): void {
    let content: string;
    try {
      content = serializeBlueprint({ name, description, genome });
    } catch (error) {
      notice((error as Error).message);
      return;
    }
    let url: string | undefined;
    const anchor = document.createElement('a');
    try {
      url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      anchor.href = url;
      anchor.download = 'evolab-blueprint.json';
      document.body.append(anchor);
      anchor.click();
      notice('Blueprint exported. Import it into the designer to reuse its anatomy and traits.');
    } catch {
      notice('Could not download this blueprint. Try exporting again.');
    } finally {
      anchor.remove();
      if (url) {
        const downloadUrl = url;
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      }
    }
  }
  function reset(): void {
    const seed = Number(get<HTMLInputElement>('seed').value),
      next = { ...settings, seed };
    if (!get<HTMLInputElement>('seed').checkValidity() || !validSettings(next)) {
      notice('Choose a whole-number seed from 0 to 4294967295.');
      return;
    }
    const payload = captureCommand(
      { type: 'start', settings: next, display: desiredView },
      settings,
    );
    generation = increment(generation);
    worldRequest++;
    waitingFile = null;
    blueprintRequest++;
    pending.length = 0;
    targetTicket = undefined;
    for (const key of ['mutation', 'nutrients', 'climate'] as const) delete pendingSettings[key];
    settingsEdits = {};
    pendingSpeed = pendingExtinction = null;
    establishedRun = null;
    pendingFrame = null;
    updates = 0;
    stopped = false;
    notice(
      'Reseeding cancels unposted old-world controls. An already posted Save still completes.',
    );
    text('run-state', 'LOADING');
    send(payload);
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
    if (
      paused &&
      !latestState?.world.stats.population &&
      get<HTMLInputElement>('pause-on-extinction').checked
    )
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
  get('render-habitat').addEventListener('change', () => {
    if (stopped || !alive) {
      get<HTMLInputElement>('render-habitat').checked = desiredView.enabled;
      notice('Rendering preference cannot change while stopped.');
      return;
    }
    changeView(get<HTMLInputElement>('render-habitat').checked);
  });
  get('refresh-habitat').addEventListener('click', () => send({ type: 'snapshot', display: true }));
  const runToTick = (): void => {
    const input = get<HTMLInputElement>('target-tick');
    if (!input.value.trim() || !input.checkValidity()) {
      text('target-status', 'Choose an absolute whole tick from 0 to 1000000000.');
      return;
    }
    send({ type: 'run-to', targetTick: Number(input.value) });
  };
  get('run-to-tick').addEventListener('click', runToTick);
  get('target-tick').addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault();
      runToTick();
    }
  });
  get('cancel-target').addEventListener('click', () => {
    send({ type: 'cancel-target', targetId: targetTicket?.wireId ?? latestState?.target?.id ?? 1 });
  });
  get('thermal').addEventListener('click', () => {
    thermal = !thermal;
    get('thermal').setAttribute('aria-pressed', String(thermal));
    text('thermal', thermal ? 'Hide temperature' : 'Show temperature');
    dirty = true;
  });
  for (const id of ['mutation', 'nutrients', 'climate'] as const)
    get(id).addEventListener('input', () => {
      const value = Number(get<HTMLInputElement>(id).value);
      if (!send({ type: 'settings', settings: { [id]: value } })) {
        get<HTMLInputElement>(id).value = String(settings[id]);
        return;
      }
      settings[id] = value;
      text(
        `${id}-value`,
        id === 'nutrients' ? `${settings[id]}%` : `${Math.round(settings[id] * 100)}%`,
      );
    });
  get('brush').addEventListener('input', () => {
    brush = Number(get<HTMLInputElement>('brush').value);
    text('brush-value', `${brush} cells`);
  });
  get('preference').addEventListener('input', () => {
    designRevision++;
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
    designRevision++;
    const x = Number(b.dataset.x),
      y = Number(b.dataset.y),
      existing = blueprint.cells.findIndex((c) => c.x === x && c.y === y);
    if (existing >= 0 && blueprint.cells[existing].type === cellType)
      blueprint.cells.splice(existing, 1);
    else if (existing >= 0) blueprint.cells[existing].type = cellType;
    else blueprint.cells.push({ x, y, type: cellType });
    editor();
  });
  get('clear-design').addEventListener('click', () => {
    designRevision++;
    blueprint = founder(0);
    blueprintName = BLUEPRINT_DEFAULT_NAME;
    blueprintDescription = '';
    editor();
  });
  get('blueprint-name').addEventListener('input', () => {
    designRevision++;
    blueprintName = get<HTMLInputElement>('blueprint-name').value;
  });
  get('blueprint-description').addEventListener('input', () => {
    designRevision++;
    blueprintDescription = get<HTMLTextAreaElement>('blueprint-description').value;
  });
  get('export-blueprint').addEventListener('click', () =>
    exportBlueprint(blueprint, blueprintName, blueprintDescription),
  );
  const blueprintInput = get<HTMLInputElement>('blueprint-file');
  get('import-blueprint').addEventListener('click', () => {
    blueprintRequest++;
    blueprintInput.value = '';
    blueprintInput.click();
  });
  blueprintInput.addEventListener('cancel', () => {
    blueprintRequest++;
    blueprintInput.value = '';
  });
  blueprintInput.addEventListener('change', async () => {
    const request = ++blueprintRequest,
      revision = designRevision,
      worldRun = runId,
      file = blueprintInput.files?.[0];
    if (!file) return;
    const current = (): boolean =>
      alive && request === blueprintRequest && revision === designRevision && worldRun === runId;
    try {
      if (file.size > BLUEPRINT_MAX_BYTES)
        throw new Error('Blueprint files must be 16 KiB or smaller.');
      let content: string;
      try {
        content = await file.text();
      } catch {
        throw new Error('Could not read this blueprint. Choose a readable JSON file.');
      }
      if (!current()) return;
      const imported = parseBlueprint(content);
      blueprint = imported.genome;
      blueprintName = imported.name;
      blueprintDescription = imported.description;
      designRevision++;
      editor();
      get<HTMLDetailsElement>('specimen-details').open = false;
      tab('organism');
      choose('pan');
      notice('Blueprint loaded into the designer. Place it explicitly to add an organism.');
    } catch (error) {
      if (current()) notice((error as Error).message);
    } finally {
      if (request === blueprintRequest) blueprintInput.value = '';
    }
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
      copyDesign(selected.genome);
      notice('Anatomy copied. Edit it, then place it in the world.');
    }
    if ((event.target as HTMLElement).closest('#export-organism-blueprint') && selected)
      exportBlueprint(selected.genome, speciesName(selected.genome), '');
  });
  get('help').addEventListener('click', () => get<HTMLDialogElement>('help-dialog').showModal());
  get('close-help').addEventListener('click', () => get<HTMLDialogElement>('help-dialog').close());
  get('save').addEventListener('click', () => send({ type: 'save' }));
  const worldInput = get<HTMLInputElement>('file');
  function invalidateCandidate(): void {
    worldRequest++;
    waitingFile = null;
    const index = pending.findIndex((entry) => entry.payload.type === 'load');
    if (index >= 0) pending.splice(index, 1);
  }
  async function readWorld(): Promise<void> {
    if (reading || !waitingFile || !alive) return;
    const request = waitingFile;
    waitingFile = null;
    reading = true;
    const current = (): boolean =>
      alive &&
      request.request === worldRequest &&
      request.generation === generation &&
      request.run === runId;
    try {
      if (request.file.size > WORLD_MAX_BYTES) throw new Error('World file exceeds 2.5 MB.');
      const content = await request.file.text();
      if (current()) send({ type: 'load', text: content });
    } catch (error) {
      if (current()) notice(error instanceof Error ? error.message : 'Could not read this world.');
    } finally {
      reading = false;
      if (request.request === worldRequest) worldInput.value = '';
      if (alive) void readWorld();
    }
  }
  get('load').addEventListener('click', () => {
    invalidateCandidate();
    worldInput.value = '';
    worldInput.click();
  });
  worldInput.addEventListener('cancel', () => {
    invalidateCandidate();
    worldInput.value = '';
  });
  worldInput.addEventListener('change', () => {
    invalidateCandidate();
    const file = worldInput.files?.[0];
    if (!file) return;
    waitingFile = { file, request: worldRequest, generation, run: runId };
    void readWorld();
  });
  const keyboard = (event: KeyboardEvent): void => {
    if (
      (event.target instanceof HTMLElement &&
        event.target.closest('input,select,textarea,button,[contenteditable="true"],dialog')) ||
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
  };
  window.addEventListener('resize', resize);
  function renderObservation(
    next: WorldPresentation,
    selection: Organism | null,
    displayOnly = false,
  ): void {
    const previousSelection = selected?.id;
    const previousPopulation = latestState?.world.stats.population;
    selected = selection;
    if (!displayOnly) updates++;
    const s = next.stats;
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
    if (
      displayOnly ||
      paused ||
      (s.population
        ? updates % 4 === 1
        : previousPopulation !== 0 || latestState?.world.stats.tick !== s.tick) ||
      previousSelection !== selected?.id
    )
      get('inspector').innerHTML =
        `${organismHtml(selected, next)}<p class="muted">Observed at tick ${s.tick}.</p>`;
    if (
      displayOnly ||
      (!s.population && previousPopulation !== 0) ||
      (previousPopulation === 0 && s.population > 0) ||
      updates % 12 === 1
    ) {
      const list = get('lineages');
      list.replaceChildren();
      for (const species of s.top) {
        const b = document.createElement('button');
        b.className = 'lineage';
        b.title = 'Copy this lineage into the organism designer';
        b.innerHTML = `${genomeSvg(species.genome, 56)}<span><strong>${species.name} <small>#${species.id}</small></strong><i><b style="width:${(species.count / Math.max(1, s.population)) * 100}%"></b></i></span><em>${species.count}</em>`;
        b.addEventListener('click', () => {
          copyDesign(species.genome);
          tab('organism');
        });
        list.append(b);
      }
      if (!s.population)
        list.innerHTML =
          '<p class="muted">This world is quiet. Plant a new organism or reseed.</p>';
    }
  }
  function renderTarget(observation: ControlState): void {
    const replacement = targetPresentationReplacement !== observation.replacementId;
    targetPresentationReplacement = observation.replacementId;
    const active = observation.target;
    const progress = get<HTMLProgressElement>('target-progress');
    progress.hidden = !active;
    if (active) {
      progress.max = Math.max(1, active.targetTick - active.fromTick);
      progress.value = Math.max(
        0,
        Math.min(progress.max, observation.world.stats.tick - active.fromTick),
      );
      if (active.targetTick === active.fromTick) progress.value = progress.max;
      const message = `Tick ${observation.world.stats.tick} / absolute target ${active.targetTick}; ${Math.max(0, active.targetTick - observation.world.stats.tick)} remaining · ${active.status}`;
      text('target-details', message);
      progress.setAttribute('aria-valuetext', message);
      const transition = `${observation.replacementId}:${active.id}:${active.status}`;
      if (!targetTicket && transition !== targetTransition) {
        targetTransition = transition;
        text('target-status', `Absolute target ${active.targetTick} ${active.status}.`);
      }
    } else {
      text('target-details', '');
      progress.removeAttribute('aria-valuetext');
      progress.removeAttribute('value');
      if (replacement) {
        targetTransition = '';
        if (!targetTicket) text('target-status', '');
      }
    }
  }
  function accept(observation: ControlState, source?: TelemetrySnapshot): void {
    if (stopped || establishedRun !== runId) return;
    const differentRun = acceptedRun !== runId;
    if (differentRun) {
      acceptedRun = runId;
      latestTelemetry = null;
    }
    if (!latestState || differentRun || observation.revision > latestState.revision) {
      if (!differentRun && latestState && observation.replacementId !== latestState.replacementId)
        return;
      renderObservation(
        observation.world,
        observation.selected,
        differentRun || observation.playback.paused,
      );
      latestState = observation;
      renderSettings(observation.settings);
      renderPlayback(observation.playback);
      get<HTMLSelectElement>('speed').value = String(pendingSpeed?.value ?? observation.speed);
      const measured = observation.rate;
      text(
        'tick-rate',
        measured.status === 'paused'
          ? 'Measured ticks/s: — · paused/stopped'
          : measured.value === null
            ? 'Measured ticks/s: measuring…'
            : `Measured ${measured.value.toFixed(1)} ticks/s · ${measured.completedTicks} ticks / ${measured.elapsedMs.toFixed(0)} ms · observed tick ${observation.world.stats.tick}${measured.context === 'hidden' ? ' · hidden/throttled' : ''}${measured.status === 'timing-gap' ? ' · timing-gap (full elapsed interval)' : ''}`,
      );
      freshness();
    }
    const current = latestState;
    if (!current || observation.replacementId !== current.replacementId) return;
    renderTarget(current);
    get<HTMLButtonElement>('cancel-target').disabled =
      !targetTicket &&
      (!current.target || !['running', 'suspended'].includes(current.target.status));
    if (
      source &&
      source.revision <= current.revision &&
      source.tick <= current.world.stats.tick &&
      (!latestTelemetry ||
        (source.revision > latestTelemetry.revision && source.tick >= latestTelemetry.tick))
    )
      latestTelemetry = { ...source, runId, replacementId: current.replacementId };
    telemetry.update({
      status: 'accepted',
      runId,
      replacementId: current.replacementId,
      currentTick: current.world.stats.tick,
      currentRevision: current.revision,
      source: latestTelemetry,
    });
  }
  function download(data: Extract<WorkerResponse, { type: 'saved' }>): void {
    const url = URL.createObjectURL(new Blob([data.text], { type: 'application/json' })),
      anchor = document.createElement('a');
    try {
      anchor.href = url;
      anchor.download = `evolab-world-${data.state.settings.seed}.json`;
      anchor.click();
    } finally {
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  worker.onmessage = ({ data: raw }) => {
    if (!alive) return;
    const data = raw as WorkerResponse;
    if (data.type === 'progress') {
      if (data.sequence <= progressWatermark) return;
      if (data.runId === runId && establishedRun === runId && !stopped)
        accept(data.state, data.telemetry);
      progressWatermark = data.sequence;
      worker.postMessage({
        type: 'flow-ack',
        channel: 'progress',
        runId: data.runId,
        sequence: data.sequence,
      });
      pump();
      return;
    }
    if (data.type === 'frame') {
      if (data.sequence <= displayWatermark) return;
      heldDisplay = { runId: data.runId, sequence: data.sequence, viewEpoch: data.viewEpoch };
      if (data.runId === runId && establishedRun === runId && !stopped) accept(data.state);
      if (
        data.runId !== runId ||
        establishedRun !== runId ||
        stopped ||
        !desiredView.visible ||
        data.viewEpoch !== desiredView.epoch ||
        data.state.revision < displayedRevision
      ) {
        if (data.viewEpoch !== desiredView.epoch || !desiredView.visible)
          discardFenceEpoch = Math.max(discardFenceEpoch, desiredView.epoch);
        pendingFrame = null;
        pump();
        releaseDiscard();
        return;
      }
      pendingFrame = data;
      dirty = true;
      return;
    }
    const completion = posted;
    if (
      !completion ||
      data.commandId !== completion.commandId ||
      data.runId !== completion.runId ||
      !(
        data.type === 'error' ||
        data.type ===
          (completion.type === 'save' ? 'saved' : completion.type === 'load' ? 'loaded' : 'control')
      )
    ) {
      if (data.type === 'error' && data.fatal && data.runId === runId) {
        stop();
        notice(data.message);
      }
      return;
    }
    const current = completion.generation === generation && data.runId === runId;
    if (current) {
      if (completion.targetTicket === targetTicket) targetTicket = undefined;
      for (const key of ['mutation', 'nutrients', 'climate'] as const)
        if (pendingSettings[key] && pendingSettings[key]!.ticket <= completion.ticket)
          delete pendingSettings[key];
      if (pendingSpeed && pendingSpeed.ticket <= completion.ticket) pendingSpeed = null;
      if (pendingExtinction && pendingExtinction.ticket <= completion.ticket)
        pendingExtinction = null;
      const observation = data.type === 'error' ? data.recovery?.state : data.state;
      const source =
        data.type === 'error'
          ? data.recovery?.telemetry
          : data.type === 'saved'
            ? undefined
            : data.telemetry;
      if (data.type === 'error' && data.fatal) {
        stop();
        establishedRun = null;
      } else if (observation) {
        if (
          (completion.type === 'start' && data.type === 'control') ||
          (completion.type === 'load' &&
            (data.type === 'loaded' ||
              (data.type === 'error' && data.code === 'load-failed' && data.recovery)))
        ) {
          establishedRun = runId;
          if (data.type !== 'error') {
            stopped = false;
            updates = 0;
          }
        }
        if (establishedRun === runId) {
          if (observation.display.epoch >= acknowledgedView.epoch)
            acknowledgedView = { ...observation.display };
          if (acknowledgedView.epoch === desiredView.epoch) text('render-pending', '');
          accept(observation, source);
        }
      } else if (completion.type === 'load' || completion.type === 'start') {
        stop();
        telemetry.update({ status: 'unavailable' });
      }
      if (data.type === 'error') {
        notice(data.message);
        if (completion.type === 'run-to' && !targetTicket) text('target-status', data.message);
      } else if (data.type === 'loaded')
        notice('World restored. Playback follows Pause on extinction.');
    }
    if (data.type === 'saved') {
      try {
        download(data);
        if (current) notice('World saved, including every organism and its ancestry.');
      } catch {
        if (current) notice('Could not download this world. Try saving again.');
      }
    }
    posted = null;
    pump();
    releaseDiscard();
  };
  worker.onerror = () => {
    if (!alive) return;
    notice('The ecosystem worker stopped. Reload the page to restart.');
    stop();
  };
  function render(): void {
    telemetry.render();
    if (
      dirty &&
      !stopped &&
      establishedRun === runId &&
      desiredView.visible &&
      (pendingFrame || frame)
    ) {
      const consumed = pendingFrame;
      if (pendingFrame) {
        frame = pendingFrame.frame;
        displayedRevision = pendingFrame.state.revision;
        displayedEpoch = pendingFrame.viewEpoch;
        displayedSelected = pendingFrame.selectedId;
        pendingFrame = null;
      }
      draw(canvas, buffer, frame!, camera, thermal, displayedSelected);
      dirty = false;
      freshness();
      if (consumed) {
        const token = consumed;
        heldDisplay = null;
        displayWatermark = token.sequence;
        worker.postMessage({
          type: 'flow-ack',
          channel: 'display',
          runId: token.runId,
          sequence: token.sequence,
        });
        pump();
      }
    }
    animation = requestAnimationFrame(render);
  }
  editor();
  let intersecting = desiredView.visible;
  const visibility = (): void =>
    changeView(
      desiredView.enabled,
      document.visibilityState !== 'hidden' &&
        intersecting &&
        canvas.getBoundingClientRect().width > 0 &&
        canvas.getBoundingClientRect().height > 0,
    );
  const intersection =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver((entries) => {
          for (const entry of entries)
            if (entry.target === canvas)
              intersecting =
                entry.isIntersecting &&
                entry.intersectionRect.width > 0 &&
                entry.intersectionRect.height > 0;
          visibility();
        });
  intersection?.observe(canvas);
  document.addEventListener('visibilitychange', visibility);
  choose(tool);
  tab('organism');
  reset();
  animation = requestAnimationFrame(render);
  return () => {
    alive = false;
    worldRequest++;
    blueprintRequest++;
    waitingFile = null;
    pending.length = 0;
    posted = null;
    frame = undefined;
    pendingFrame = null;
    heldDisplay = null;
    latestState = undefined;
    latestTelemetry = null;
    viewIntent = null;
    targetTicket = undefined;
    intersection?.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    telemetry.dispose();
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
