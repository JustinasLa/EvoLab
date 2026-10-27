import './style.css';
import '@fontsource/dm-mono/400.css';
import {
  DEFAULTS,
  COLORS,
  WIDTH,
  HEIGHT,
  WORLD_MAX_BYTES,
  MANUAL_CAPACITY,
  STROKE_COMMAND_CAPACITY,
  integer,
  clamp,
  founder,
  speciesName,
  validGenome,
  validSettings,
  type Frame,
  type Genome,
  type Organism,
  type Settings,
  type Tool,
  type CellType,
  type PlaybackState,
  type PaintTool,
  type TrackedOperation,
  type MeasurementFormat,
} from './model';
import { draw, genomeSvg, markup, organismHtml, point, viewport, type Camera } from './view';
import { createTelemetryView } from './telemetry-view';
import {
  BLUEPRINT_DEFAULT_NAME,
  BLUEPRINT_MAX_BYTES,
  parseBlueprint,
  serializeBlueprint,
} from './blueprint';

export function mount(root: HTMLElement, worker: Worker): () => void {
  root.innerHTML = markup;
  const elements = new Map(
    [...root.querySelectorAll<HTMLElement>('[id]')].map((element) => [element.id, element]),
  );
  const get = <T extends HTMLElement>(id: string): T => elements.get(id) as T;
  const canvas = get<HTMLCanvasElement>('world'),
    buffer = document.createElement('canvas');
  const camera: Camera = { zoom: 1, x: 0, y: 0 };
  let settingsEdits: Partial<Settings> = {};
  let confirmedSettings = { ...DEFAULTS };
  let settledSettings: Partial<Settings> = {};
  const latestSettingId: Partial<Record<keyof Settings, number>> = {};
  const settledSettingId: Partial<Record<keyof Settings, number>> = {};
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
  const send = (data: object): void => worker.postMessage(data);
  type Owner = {
    id: number;
    run: number;
    operation: TrackedOperation;
    applicable: boolean;
    format?: MeasurementFormat;
    strokeId?: number;
    completing: boolean;
    failed: boolean;
    setting?: { key: 'mutation' | 'nutrients' | 'climate'; value: number };
  };
  const owners = new Map<number, Owner>();
  type Download = { url: string; timer?: ReturnType<typeof setTimeout> };
  const downloads: Partial<Record<'save' | 'export-measurements', Download>> = {};
  let postingId = 0,
    strokeId = 0,
    terminated = false,
    worldRead = false,
    readGeneration = 0;
  let closeLease: { run: number; strokeId: number; posted: boolean } | null = null;
  let localStroke: { id: number; tool: PaintTool; radius: number; count: number } | null = null;
  let ownerPointer: number | null = null;
  let availabilityState = -1;
  const isManual = (operation: TrackedOperation): boolean =>
    ['begin-stroke', 'paint', 'settings', 'shock'].includes(operation);
  const hasOwner = (operation: TrackedOperation): boolean =>
    [...owners.values()].some((owner) => owner.operation === operation);
  const lifecycleBusy = (): boolean => hasOwner('start') || hasOwner('load');
  const manualCount = (): number =>
    [...owners.values()].filter((owner) => isManual(owner.operation)).length;
  function availability(): void {
    const unavailable = terminated || stopped || lifecycleBusy(),
      exportBlocked =
        unavailable || hasOwner('export-measurements') || !!downloads['export-measurements'],
      saveBlocked = unavailable || hasOwner('save') || !!downloads.save,
      state = Number(exportBlocked) + Number(saveBlocked) * 2;
    if (state === availabilityState) return;
    availabilityState = state;
    for (const format of ['json', 'csv'])
      get<HTMLButtonElement>(`measurements-${format}`).disabled = exportBlocked;
    get<HTMLButtonElement>('save').disabled = saveBlocked;
  }
  function clearDownload(
    operation: 'save' | 'export-measurements',
    owned = downloads[operation],
  ): void {
    if (!owned || downloads[operation] !== owned) return;
    delete downloads[operation];
    if (owned.timer !== undefined) clearTimeout(owned.timer);
    URL.revokeObjectURL(owned.url);
    if (alive) availability();
  }
  function invalidate(keepRun?: number): void {
    for (const owner of owners.values()) if (owner.run !== keepRun) owner.applicable = false;
    clearDownload('save');
    clearDownload('export-measurements');
  }
  function terminate(): void {
    invalidate();
    if (!terminated) {
      worker.terminate();
      terminated = true;
      owners.clear();
      closeLease = null;
    }
    localStroke = null;
    ownerPointer = null;
    dragging = false;
    if (alive) availability();
  }
  function admissible(operation: TrackedOperation): boolean {
    if (
      !alive ||
      terminated ||
      postingId >=
        Number.MAX_SAFE_INTEGER -
          (closeLease && !closeLease.posted && operation !== 'end-stroke' ? 1 : 0) ||
      (stopped && operation !== 'start' && operation !== 'load' && operation !== 'end-stroke')
    ) {
      if (alive) notice('Ecosystem transport unavailable; no new action admitted.');
      return false;
    }
    const busy =
      operation === 'start' || operation === 'load'
        ? lifecycleBusy()
        : operation === 'end-stroke'
          ? false
          : operation === 'settings'
            ? manualCount() >= MANUAL_CAPACITY
            : lifecycleBusy() ||
              (isManual(operation)
                ? manualCount() >= MANUAL_CAPACITY
                : hasOwner(operation) || !!downloads[operation as 'save' | 'export-measurements']);
    if (busy)
      notice(
        'Worker capacity busy. Earlier admitted actions may still complete; try a new action after they drain.',
      );
    return !busy;
  }
  function postTracked(
    operation: TrackedOperation,
    payload: Record<string, unknown> = {},
    requestedRun = runId,
  ): boolean {
    if (!admissible(operation)) return false;
    const owner: Owner = {
      id: ++postingId,
      run: requestedRun,
      operation,
      applicable: true,
      completing: false,
      failed: false,
      ...(payload.format ? { format: payload.format as MeasurementFormat } : {}),
      ...(payload.strokeId ? { strokeId: payload.strokeId as number } : {}),
    };
    if (operation === 'settings') {
      const [key, value] = Object.entries(payload.settings as object)[0];
      owner.setting = { key: key as 'mutation' | 'nutrients' | 'climate', value: value as number };
      latestSettingId[key as keyof Settings] = owner.id;
    }
    owners.set(owner.id, owner);
    availability();
    try {
      send({
        type: operation,
        ...payload,
        runId: requestedRun,
        ...(['begin-stroke', 'paint', 'settings', 'shock', 'end-stroke'].includes(operation)
          ? { commandId: owner.id }
          : { requestId: owner.id }),
      });
      return operation !== 'settings' || !owner.failed;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'DataCloneError') owners.delete(owner.id);
      else terminate();
      if (alive) notice('Could not post this action. No automatic retry was queued.');
      availability();
      return false;
    }
  }
  function endStroke(): void {
    dragging = false;
    ownerPointer = null;
    localStroke = null;
    const lease = closeLease;
    if (!lease || lease.posted) return;
    lease.posted = true;
    if (!postTracked('end-stroke', { strokeId: lease.strokeId }, lease.run)) {
      terminate();
      stop();
    }
  }
  function download(owner: Owner, data: any): void {
    const operation = owner.operation as 'save' | 'export-measurements';
    if (
      typeof data.text !== 'string' ||
      !integer(data.completedTick, 0, 1e9) ||
      !integer(data.seed, 0, 4294967295) ||
      data.text.length > WORLD_MAX_BYTES ||
      !integer(data.byteLength, 0, WORLD_MAX_BYTES) ||
      new TextEncoder().encode(data.text).byteLength !== data.byteLength
    )
      throw new Error('Invalid completed download payload; no download created.');
    const anchor = document.createElement('a');
    let lease: Download | undefined,
      dispatched = false;
    try {
      const format = owner.format ?? 'json';
      const url = URL.createObjectURL(
        new Blob([data.text], {
          type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
        }),
      );
      lease = { url };
      downloads[operation] = lease;
      anchor.href = url;
      anchor.download =
        operation === 'save'
          ? `evolab-world-${data.seed}.json`
          : `evolab-measurements-${data.seed}-tick-${data.completedTick}.${format}`;
      document.body.append(anchor);
      anchor.click();
      const owned = lease;
      lease.timer = setTimeout(() => clearDownload(operation, owned), 1000);
      dispatched = true;
      notice(
        operation === 'save'
          ? 'World saved, including every organism and its ancestry.'
          : `Download requested: retained observations as of completed tick ${data.completedTick}.`,
      );
    } finally {
      anchor.remove();
      if (!dispatched && lease) clearDownload(operation, lease);
    }
  }
  function terminal(data: any): boolean {
    const kinds = ['saved', 'measurement-exported', 'manual-result', 'started', 'loaded'];
    if (
      !kinds.includes(data.type) &&
      !(data.type === 'error' && typeof data.operation === 'string')
    )
      return false;
    const operation = data.operation as TrackedOperation,
      manual = ['begin-stroke', 'paint', 'settings', 'shock', 'end-stroke'].includes(operation),
      id = manual ? data.commandId : data.requestId,
      owner = owners.get(id);
    const expected =
      operation === 'save'
        ? 'saved'
        : operation === 'export-measurements'
          ? 'measurement-exported'
          : operation === 'start'
            ? 'started'
            : operation === 'load'
              ? 'loaded'
              : 'manual-result';
    if (
      !owner ||
      owner.completing ||
      owner.operation !== operation ||
      owner.run !== data.runId ||
      owner.format !== data.format ||
      owner.strokeId !== data.strokeId ||
      (manual ? data.requestId !== undefined : data.commandId !== undefined) ||
      (data.type !== 'error' && data.type !== expected)
    )
      return true;
    owner.completing = true;
    try {
      if (!alive || !owner.applicable || owner.run !== runId) return true;
      if (data.type === 'error') {
        owner.failed = true;
        settleSetting(owner, false);
        if (typeof data.message !== 'string' || data.message.length > 512)
          throw new Error('Invalid worker error payload.');
        if (data.fatal) {
          invalidate();
          stop();
        } else if (data.recovery && (operation === 'load' || operation === 'start')) {
          stopped = false;
          renderSettings(data.recovery.settings);
          renderPlayback(data.recovery.playback);
          renderFrame(data.recovery.frame, data.recovery.selected, true);
        }
        notice(data.message);
      } else if (data.type === 'started' || data.type === 'loaded') {
        if (
          !integer(data.completedTick, 0, 1e9) ||
          !validSettings(data.settings) ||
          data.seed !== data.settings.seed
        )
          throw new Error('Invalid lifecycle terminal.');
        stopped = false;
        renderSettings(data.settings);
        renderPlayback(data.playback);
        telemetry.reset();
        updates = 0;
        if (data.type === 'started') {
          selected = null;
          frame = undefined;
          notice('');
        } else {
          notice('World restored. Playback follows Pause on extinction.');
        }
      } else if (data.type === 'manual-result') {
        if (
          !['applied', 'no-op', 'rejected'].includes(data.status) ||
          !integer(data.completedTick, 0, 1e9) ||
          (data.rowSequence !== null && !integer(data.rowSequence, 1, Number.MAX_SAFE_INTEGER))
        )
          throw new Error('Invalid manual completion payload.');
        owner.failed = data.status === 'rejected';
        settleSetting(owner, !owner.failed);
        if (owner.failed)
          notice('Worker rejected this manual action; no successful effect recorded.');
      } else if (!stopped) download(owner, data);
    } catch (error) {
      owner.failed = true;
      settleSetting(owner, false);
      if (alive && owner.applicable && owner.run === runId)
        notice(
          error instanceof Error
            ? error.message.slice(0, 512)
            : 'Could not complete this download.',
        );
    } finally {
      if (owners.get(id) === owner) owners.delete(id);
      if (
        operation === 'end-stroke' &&
        closeLease?.posted &&
        closeLease.run === owner.run &&
        closeLease.strokeId === owner.strokeId
      )
        closeLease = null;
      if (alive) availability();
    }
    return true;
  }
  function settleSetting(owner: Owner, applied: boolean): void {
    if (!owner.setting) return;
    const { key, value } = owner.setting;
    if (applied && owner.id > (settledSettingId[key] ?? 0)) {
      settledSettingId[key] = owner.id;
      settledSettings[key] = value;
      confirmedSettings[key] = value;
    } else if (!applied && latestSettingId[key] === owner.id) {
      delete settingsEdits[key];
      settings[key] = confirmedSettings[key];
      get<HTMLInputElement>(key).value = String(settings[key]);
      text(
        `${key}-value`,
        key === 'nutrients' ? `${settings[key]}%` : `${Math.round(settings[key] * 100)}%`,
      );
    }
  }
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
    confirmedSettings = { ...next, ...settledSettings };
    settings = { ...confirmedSettings, ...settingsEdits };
    settingsEdits = {};
    settledSettings = {};
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
    availability();
  }
  const tab = (name: string): void => {
    root
      .querySelectorAll<HTMLButtonElement>('[data-tab]')
      .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    get('ecosystem-panel').hidden = name !== 'ecosystem';
    get('organism-panel').hidden = name !== 'organism';
  };
  function choose(next: Tool): void {
    endStroke();
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
    endStroke();
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
    replaceWorld('start', { settings: next });
  }
  function replaceWorld(operation: 'start' | 'load', payload: Record<string, unknown>): boolean {
    if (!admissible(operation)) return false;
    endStroke();
    if (terminated) return false;
    const previousRun = runId,
      previousEdits = settingsEdits,
      previousSettled = settledSettings;
    settingsEdits = {};
    settledSettings = {};
    runId++;
    if (operation === 'start') notice('');
    if (!postTracked(operation, payload, runId)) {
      runId = previousRun;
      settingsEdits = previousEdits;
      settledSettings = previousSettled;
      return false;
    }
    readGeneration++;
    invalidate(runId);
    return true;
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
    } else if (tool !== 'pan') {
      if (!validGenome(blueprint)) {
        notice('Draw 1–16 connected cells before painting.');
        return;
      }
      const genome: Genome = {
        cells: blueprint.cells.map(({ x, y, type }) => ({ x, y, type })),
        preference: blueprint.preference,
        tolerance: blueprint.tolerance,
        tempo: blueprint.tempo,
      };
      if (tool === 'plant') {
        endStroke();
        postTracked('paint', { tool, ...p, radius: brush, genome });
        return;
      }
      const stroke = localStroke!;
      if (
        stroke.count >= STROKE_COMMAND_CAPACITY ||
        !postTracked('paint', {
          tool: stroke.tool,
          ...p,
          radius: stroke.radius,
          genome,
          strokeId: stroke.id,
        })
      ) {
        endStroke();
        notice(
          'Partial brush stroke stopped at its command/capacity limit. Earlier admitted points may still complete.',
        );
      } else {
        stroke.count++;
        if (stroke.count === STROKE_COMMAND_CAPACITY) {
          endStroke();
          notice('Partial brush stroke reached 4096 commands. Start a new gesture to continue.');
        }
      }
    }
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (
      ownerPointer !== null ||
      (event.button !== undefined && event.button !== 0) ||
      event.isPrimary === false
    )
      return;
    if (tool !== 'pan' && tool !== 'inspect' && (lifecycleBusy() || stopped || terminated)) {
      notice('World replacement or transport is not ready for editing.');
      return;
    }
    if (
      ['food', 'wall', 'erase'].includes(tool) &&
      (closeLease ||
        manualCount() > MANUAL_CAPACITY - 2 ||
        postingId > Number.MAX_SAFE_INTEGER - 3 ||
        strokeId === Number.MAX_SAFE_INTEGER)
    ) {
      notice('Brush capacity busy. A fresh pointer press is required after earlier work drains.');
      return;
    }
    if (['food', 'wall', 'erase'].includes(tool)) {
      const id = ++strokeId;
      closeLease = { run: runId, strokeId: id, posted: false };
      localStroke = { id, tool: tool as PaintTool, radius: brush, count: 0 };
      if (!postTracked('begin-stroke', { strokeId: id, tool, radius: brush })) {
        closeLease = null;
        localStroke = null;
        return;
      }
    }
    ownerPointer = event.pointerId;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    act(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== ownerPointer) return;
    if (tool === 'pan') {
      camera.x += event.clientX - lastX;
      camera.y += event.clientY - lastY;
      dirty = true;
    } else if (tool !== 'inspect' && tool !== 'plant') act(event);
    lastX = event.clientX;
    lastY = event.clientY;
  });
  const release = (event: Event): void => {
    if ('pointerId' in event && event.pointerId !== ownerPointer) return;
    endStroke();
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
  canvas.addEventListener('lostpointercapture', release);
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
      endStroke();
      const value = Number(get<HTMLInputElement>(id).value);
      if (
        !validSettings({ ...settings, [id]: value }) ||
        !postTracked('settings', { settings: { [id]: value } })
      ) {
        get<HTMLInputElement>(id).value = String(settings[id]);
        return;
      }
      settings[id] = value;
      settingsEdits[id] = settings[id];
      text(
        `${id}-value`,
        id === 'nutrients' ? `${settings[id]}%` : `${Math.round(settings[id] * 100)}%`,
      );
    });
  get('brush').addEventListener('input', () => {
    endStroke();
    brush = Number(get<HTMLInputElement>('brush').value);
    text('brush-value', `${brush} cells`);
  });
  get('preference').addEventListener('input', () => {
    endStroke();
    designRevision++;
    blueprint.preference = Number(get<HTMLInputElement>('preference').value);
    text('preference-value', `${Math.round(blueprint.preference * 40)}°`);
  });
  get('reset').addEventListener('click', reset);
  root.querySelectorAll<HTMLButtonElement>('[data-shock]').forEach((b) =>
    b.addEventListener('click', () => {
      endStroke();
      postTracked('shock', { kind: b.dataset.shock });
    }),
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
    endStroke();
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
    endStroke();
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
      endStroke();
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
  get('save').addEventListener('click', () => postTracked('save'));
  for (const format of ['json', 'csv'] as const)
    get(`measurements-${format}`).addEventListener('click', () =>
      postTracked('export-measurements', { format }),
    );
  get('load').addEventListener('click', () => {
    readGeneration++;
    get<HTMLInputElement>('file').value = '';
    get<HTMLInputElement>('file').click();
  });
  get('file').addEventListener('cancel', () => {
    readGeneration++;
    get<HTMLInputElement>('file').value = '';
  });
  get('file').addEventListener('change', async () => {
    const input = get<HTMLInputElement>('file'),
      file = input.files?.[0],
      generation = ++readGeneration,
      capturedRun = runId;
    if (!file) return;
    if (worldRead) {
      notice('A native world-file read is still outstanding. No second read was started.');
      input.value = '';
      return;
    }
    const current = (): boolean => alive && generation === readGeneration && capturedRun === runId;
    worldRead = true;
    try {
      if (file.size > WORLD_MAX_BYTES) throw new Error('World file exceeds 2.5 MB.');
      const content = await file.text();
      if (current() && replaceWorld('load', { text: content })) input.value = '';
    } catch (error) {
      if (current()) notice(error instanceof Error ? error.message : 'Could not read this world.');
    } finally {
      worldRead = false;
      if (generation === readGeneration) input.value = '';
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
    telemetry.update(frame, runId);
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
  worker.onmessage = ({ data }) => {
    if (!alive || terminated) return;
    if (!data || typeof data !== 'object') return;
    if (terminal(data)) return;
    if (data.runId !== runId) return;
    if (data.type === 'error') {
      if (data.fatal) {
        invalidate();
        stop();
      } else if (data.recovery && !stopped) {
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
    if (data.type !== 'frame' || stopped) return;
    renderPlayback(data.playback);
    renderFrame(data.frame, data.selected);
  };
  const workerFailed = (): void => {
    if (!alive) return;
    notice('The ecosystem worker stopped. Reload the page to restart.');
    terminate();
    stop();
  };
  worker.onerror = workerFailed;
  worker.addEventListener('messageerror', workerFailed);
  function render(): void {
    telemetry.render();
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
    readGeneration++;
    telemetry.dispose();
    cancelAnimationFrame(animation);
    terminate();
    window.removeEventListener('keydown', keyboard);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
    window.removeEventListener('blur', release);
    canvas.removeEventListener('lostpointercapture', release);
  };
}
const root = document.getElementById('app');
if (root) mount(root, new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
