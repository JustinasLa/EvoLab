import { mountCheckpoints } from './checkpoint-view';
import { mountComparisons } from './experiment-view';
import './style.css';
import {
  DEFAULT_TERRAIN,
  TERRAIN_LABELS,
  generateTerrain,
  resolvedTerrainSeed,
  sameTerrain,
  validTerrain,
} from './terrain';
import '@fontsource/dm-mono/400.css';
import {
  DEFAULTS,
  COLORS,
  WIDTH,
  commandEcho,
  HEIGHT,
  WORLD_MAX_BYTES,
  MANUAL_CAPACITY,
  STROKE_COMMAND_CAPACITY,
  integer,
  clamp,
  founder,
  speciesName,
  validGenome,
  cloneGenome,
  validSettings,
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
  type PaintTool,
  type StrokeTool,
  type RefugeBrush,
  type RefugeSummary,
  type TrackedOperation,
  type MeasurementFormat,
  type TerrainRecipe,
} from './model';
import {
  behaviorStatus,
  draw,
  genomeSvg,
  markup,
  organismHtml,
  point,
  placementGhost,
  transformDesign,
  viewport,
  type Camera,
} from './view';
import { createTelemetryView } from './telemetry-view';
import { createLineageView } from './lineage-view';
import { emptyRefuges, refugeTool, refugeSummary, validRefugeBrush } from './refuges';
import {
  createLibrary,
  libraryCandidate,
  LibraryError,
  type LibraryCandidate,
  type LibraryEntry,
  type LibraryProblem,
  type LibraryMutation,
  type LibrarySnapshot,
} from './library';
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
        (data.terrain !== undefined && !validTerrain(data.terrain)) ||
        !data.display ||
        !integer(data.display.epoch, 0, Number.MAX_SAFE_INTEGER) ||
        typeof data.display.enabled !== 'boolean' ||
        typeof data.display.visible !== 'boolean' ||
        (data.display.lineage !== undefined && data.display.lineage !== true)
      )
        throw new Error('Invalid initial settings or display.');
      return {
        type: 'start',
        settings: observedSettings(data.settings),
        terrain: { ...(data.terrain === undefined ? DEFAULT_TERRAIN : data.terrain) },
        display: {
          epoch: data.display.epoch,
          enabled: data.display.enabled,
          visible: data.display.visible,
          ...(data.display.lineage ? { lineage: true as const } : {}),
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
    case 'capture-design':
      if (
        !['organism', 'lineage'].includes(data.source) ||
        !integer(data.sourceId, 1, 1e9) ||
        !integer(data.captureId, 1, Number.MAX_SAFE_INTEGER)
      )
        throw new Error('Invalid design capture source.');
      return {
        type: 'capture-design',
        source: data.source,
        sourceId: data.sourceId,
        captureId: data.captureId,
      };
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
        genome: cloneGenome(data.genome),
        ...(data.strokeId === undefined ? {} : { strokeId: data.strokeId }),
      };
    case 'export-measurements':
      if (!['csv', 'json'].includes(data.format)) throw new Error('Invalid measurement format.');
      return { type: 'export-measurements', format: data.format };
    case 'begin-stroke':
      if (
        !integer(data.strokeId, 1, Number.MAX_SAFE_INTEGER) ||
        (!['food', 'wall', 'erase'].includes(data.tool) && !validRefugeBrush(data)) ||
        !integer(data.radius, 0, 8)
      )
        throw new Error('Invalid brush stroke.');
      return {
        type: 'begin-stroke',
        ...(refugeTool(data.tool) ? { rulesVersion: 1 as const, units: data.units } : {}),
        strokeId: data.strokeId,
        tool: data.tool,
        radius: data.radius,
      };
    case 'end-stroke':
      if (!integer(data.strokeId, 1, Number.MAX_SAFE_INTEGER))
        throw new Error('Invalid stroke closure.');
      return { type: 'end-stroke', strokeId: data.strokeId };
    case 'refuge-mode':
      if (data.rulesVersion !== 1 || typeof data.enabled !== 'boolean')
        throw new Error('Invalid painted temperature mode payload.');
      return { type: 'refuge-mode', rulesVersion: 1, enabled: data.enabled };
    case 'clear-refuges':
      if (data.rulesVersion !== 1) throw new Error('Invalid painted temperature clear payload.');
      return { type: 'clear-refuges', rulesVersion: 1 };
    case 'paint-refuge':
      coordinates();
      if (!validRefugeBrush(data) || !integer(data.strokeId, 1, Number.MAX_SAFE_INTEGER))
        throw new Error('Invalid painted temperature payload.');
      return {
        type: 'paint-refuge',
        rulesVersion: 1,
        tool: data.tool,
        units: data.units,
        radius: data.radius,
        strokeId: data.strokeId,
        x: data.x,
        y: data.y,
      };
    case 'clear-walls':
      if (data.action !== 'clear' || data.recipe !== undefined || data.resolvedSeed !== undefined)
        throw new Error('Invalid clear walls action.');
      return { type: 'clear-walls', action: 'clear' };
    case 'regenerate-walls':
      if (
        data.action !== 'regenerate' ||
        !validTerrain(data.recipe) ||
        !integer(data.resolvedSeed, 0, 4294967295)
      )
        throw new Error('Invalid regenerate walls action.');
      return {
        type: 'regenerate-walls',
        action: 'regenerate',
        recipe: { ...data.recipe },
        resolvedSeed: data.resolvedSeed,
      };
    case 'shock':
      if (data.kind !== 'cold' && data.kind !== 'heat') throw new Error('Invalid climate event.');
      return { type: 'shock', kind: data.kind };
    default:
      throw new Error('Unknown control.');
  }
}

export function mount(root: HTMLElement, worker: Worker, renderHabitat = true): () => void {
  root.innerHTML = markup;
  const controls = new Map(
    [...root.querySelectorAll<HTMLElement>('[id]')].map((element) => [element.id, element]),
  );
  const get = <T extends HTMLElement>(id: string): T =>
    (controls.get(id) as T | undefined) ?? root.querySelector<T>(`#${id}`)!;
  const refugeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-refuge-tool]')];
  const captureButton = document.createElement('button');
  captureButton.id = 'capture-selected';
  captureButton.textContent = 'Capture selected organism';
  captureButton.disabled = true;
  const captureStatus = document.createElement('p');
  captureStatus.id = 'capture-status';
  captureStatus.className = 'muted';
  captureStatus.textContent = 'Inspect an organism to request its complete current genotype.';
  captureButton.setAttribute('aria-describedby', captureStatus.id);
  get('specimen-details').append(captureButton, captureStatus);
  get('help-dialog').append(
    Object.assign(document.createElement('p'), {
      textContent:
        'Reloading starts a fresh world. Explicitly saved local library designs survive in this browser profile, subject to browser eviction or clearing. Download blueprints for portable backups; there is no account or sync.',
    }),
  );
  const canvas = get<HTMLCanvasElement>('world'),
    buffer = document.createElement('canvas');
  const camera: Camera = { zoom: 1, x: 0, y: 0 };
  let hover: { x: number; y: number } | undefined,
    touchAnchor: { x: number; y: number } | undefined;
  function clearPlacement(): void {
    const preview = tool === 'plant' && (hover !== undefined || touchAnchor !== undefined);
    hover = touchAnchor = undefined;
    text('placement-feedback', '');
    if (preview) dirty = true;
  }
  let settingsEdits: Partial<Settings> = {};
  let confirmedSettings = { ...DEFAULTS };
  let committedTerrain: TerrainRecipe = { ...DEFAULT_TERRAIN },
    draftTerrain: TerrainRecipe = { ...DEFAULT_TERRAIN },
    terrainRevision = 0,
    settledTerrainId = 0;
  let resetPayload: {
    settings: Settings;
    terrain: TerrainRecipe;
    run: number;
    revision: number;
    refugeReset: 'off-empty';
  } | null = null;
  let settings = { ...DEFAULTS },
    runId = 0,
    paused = false,
    stopped = false,
    thermal = false,
    tool: Tool = 'pan',
    brush = 2;
  let refugeIntensity = 4,
    confirmedRefuges = refugeSummary(emptyRefuges()),
    settledRefugeId = 0;
  let frame: HabitatFrame | undefined,
    selected: Organism | null = null,
    blueprint = founder(0),
    cellType: CellType = 4;
  let blueprintName = BLUEPRINT_DEFAULT_NAME,
    blueprintDescription = '',
    designRevision = 0,
    blueprintRequest = 0;
  let acceptedObservationRun: number | undefined;
  let observationTick: number | undefined;
  let replacementGeneration = 0;
  let replacement:
    | {
        generation: number;
        kind: 'file' | 'library';
        revision: number;
        run: number;
        selection: number;
      }
    | undefined;
  let blueprintReader: FileReader | undefined;
  let picker: { input: HTMLInputElement; generation: number; expired: boolean } | undefined;
  let fileTimer: ReturnType<typeof setTimeout> | undefined;
  let dialogTimer: ReturnType<typeof setTimeout> | undefined;
  let exportTimer: ReturnType<typeof setTimeout> | undefined;
  let exportUrl: string | undefined;
  let librarySnapshot: LibrarySnapshot = { count: 0, rows: [] };
  let librarySelected: string | undefined;
  let initialLibrarySelection = true;
  let librarySelection = 0;
  let libraryRequest = 0;
  let libraryWorking: 'refresh' | 'write' | 'load' | undefined;
  let libraryRefreshOutcome = '';
  let refreshNeeded = false;
  const rowSignatures = new WeakMap<HTMLElement, string | undefined>();
  let candidate: LibraryCandidate | undefined;
  let candidateRun: number | undefined;
  let dialogIntent:
    | {
        type: 'load' | 'rename' | 'replace' | 'delete' | 'repair';
        entry: LibraryEntry | LibraryProblem;
        candidate?: LibraryCandidate;
        generation: number;
        revision: number;
        run: number;
        selection: number;
        invoker: HTMLElement | null;
      }
    | undefined;
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
  const libraryStatus = (message: string): void => {
    if (alive) text('library-status', message);
  };
  const library = createLibrary({
    invalidated: () => {
      refreshNeeded = false;
      libraryRequest++;
      libraryWorking = undefined;
      if (replacement?.kind === 'library') cancelReplacement('the library connection changed.');
    },
    status: (message) => {
      if (!alive) return;
      cancelDialog('Library connection or operation changed.');
      libraryStatus(libraryRefreshOutcome ? `${libraryRefreshOutcome} ${message}` : message);
      updateCapture();
      drainRefresh();
    },
  });
  function updateCapture(): void {
    const eligible =
      alive &&
      !stopped &&
      acceptedObservationRun === runId &&
      selected !== null &&
      Number.isSafeInteger(observationTick) &&
      observationTick! >= 0;
    if (!eligible && document.activeElement === captureButton) {
      if (!get('organism-panel').hidden && get<HTMLDetailsElement>('specimen-details').open)
        get('specimen-details').querySelector('summary')!.focus();
      else get('organism-tab').focus();
    }
    if (captureButton.disabled === eligible) captureButton.disabled = !eligible;
    const busy = libraryBusy() || !!candidate || !!captureIntent;
    if (captureButton.getAttribute('aria-disabled') !== String(busy))
      captureButton.setAttribute('aria-disabled', String(busy));
    const message = eligible
      ? busy
        ? 'Library busy or an unsaved blueprint is pending. Capture is not started; playback is unchanged.'
        : 'Requests the complete current genotype at a worker response tick; the displayed observation may be earlier. No fitness or living identity is captured.'
      : 'Inspect an organism after the current world response to capture it.';
    if (captureStatus.textContent !== message) captureStatus.textContent = message;
  }
  function cancelDialog(message: string): void {
    if (!dialogIntent) return;
    const intent = dialogIntent;
    dialogIntent = undefined;
    clearTimeout(dialogTimer);
    get<HTMLDialogElement>('library-dialog').close();
    if (alive) {
      if (intent.invoker?.isConnected && !(intent.invoker as HTMLButtonElement).disabled)
        intent.invoker.focus();
      else get('library-heading').focus();
    }
    if (intent.type === 'load') cancelReplacement(message);
    libraryStatus(message);
    drainRefresh();
  }
  function cancelReplacement(message: string): void {
    const previous = replacement;
    replacement = undefined;
    replacementGeneration++;
    if (previous?.kind === 'library') {
      if (libraryWorking === 'load') {
        library.cancel();
        libraryRequest++;
        libraryWorking = undefined;
      }
      libraryStatus(`Load into designer cancelled: ${message}`);
    } else if (previous?.kind === 'file' && alive)
      text('designer-file-status', `Blueprint import cancelled: ${message}`);
    if (dialogIntent?.type === 'load') cancelDialog(message);
    if (blueprintReader && previous?.kind === 'file') {
      clearTimeout(fileTimer);
      blueprintReader.abort();
    }
  }
  function invalidateDesign(): void {
    touchAnchor = undefined;
    dirty = true;
    cancelReplacement('the design or world changed.');
    designRevision++;
  }
  function invalidateObservation(): void {
    clearPlacement();
    captureIntent = null;
    acceptedObservationRun = undefined;
    observationTick = undefined;
    cancelReplacement('the world changed.');
    cancelDialog('The world changed.');
    if (candidate && candidateRun !== undefined && libraryWorking !== 'write') {
      candidate = undefined;
      renderLibrary();
      libraryStatus('Unsaved capture cancelled: the world changed before storage admission.');
    }
    updateCapture();
  }
  function selectedEntry(): LibraryEntry | undefined {
    return librarySnapshot.rows.find(
      (row): row is LibraryEntry => row.kind === 'valid' && row.id === librarySelected,
    );
  }
  function libraryBusy(): boolean {
    return !!libraryWorking || library.busy || !!picker || !!blueprintReader || !!dialogIntent;
  }
  function drainRefresh(): void {
    if (alive && refreshNeeded && !libraryBusy()) void refreshLibrary();
  }
  function admitReplacement(kind: 'file' | 'library'): NonNullable<typeof replacement> | undefined {
    if (
      !alive ||
      picker ||
      (libraryWorking && libraryWorking !== 'load') ||
      (dialogIntent && dialogIntent.type !== 'load') ||
      candidate ||
      (blueprintReader && replacement?.kind !== 'file') ||
      (kind === 'library' && library.busy)
    ) {
      libraryStatus('Busy: replacement not started. No action was queued.');
      return;
    }
    cancelReplacement('superseded by a newer replacement intent.');
    if (blueprintReader || (kind === 'library' && library.busy)) {
      libraryStatus('Busy: the previous native owner has not settled. Replacement not started.');
      return;
    }
    replacement = {
      kind,
      generation: ++replacementGeneration,
      revision: designRevision,
      run: runId,
      selection: librarySelection,
    };
    return replacement;
  }
  function replacementCurrent(
    intent: NonNullable<typeof replacement>,
    generation = intent.generation,
  ): boolean {
    return (
      alive &&
      replacement === intent &&
      intent.generation === generation &&
      intent.generation === replacementGeneration &&
      intent.revision === designRevision &&
      intent.run === runId &&
      (intent.kind === 'file' || intent.selection === librarySelection)
    );
  }
  function publishDesign(
    value: LibraryCandidate['blueprint'],
    intent: NonNullable<typeof replacement>,
  ): void {
    if (!replacementCurrent(intent)) return;
    endStroke();
    replacement = undefined;
    blueprint = value.genome;
    blueprintName = value.name;
    blueprintDescription = value.description;
    designRevision++;
    editor();
    get<HTMLDetailsElement>('specimen-details').open = false;
    tab('organism');
    choose('pan');
  }
  function renderLibrary(): void {
    const list = get('library-rows');
    const existing = new Map(
      [...list.children].map((node) => [(node as HTMLElement).dataset.key!, node as HTMLElement]),
    );
    const keys = new Set(librarySnapshot.rows.map((row, index) => row.id ?? `problem-${index}`));
    for (const [key, item] of existing) {
      if (!keys.has(key)) {
        if (item.contains(document.activeElement)) get('library-heading').focus();
        item.remove();
        existing.delete(key);
      }
    }
    librarySnapshot.rows.forEach((row, index) => {
      const key = row.id ?? `problem-${index}`;
      let item = existing.get(key);
      existing.delete(key);
      if (!item) {
        item = document.createElement('li');
        item.dataset.key = key;
      }
      const signature = row.kind === 'valid' || row.kind === 'damaged' ? row.token : row.reason;
      if (rowSignatures.get(item) !== signature) {
        const button = item.querySelector('button') ?? document.createElement('button');
        button.replaceChildren();
        delete button.dataset.libraryId;
        delete button.dataset.repairId;
        button.disabled = false;
        if (row.kind === 'valid') {
          button.dataset.libraryId = row.id;
          button.innerHTML = genomeSvg(row.blueprint.genome);
          button.append(
            Object.assign(document.createElement('span'), { textContent: row.blueprint.name }),
          );
          button.append(
            Object.assign(document.createElement('small'), {
              textContent: `Local ID ${row.id}; ${row.blueprint.genome.cells.length} cells; revision ${row.revision}`,
            }),
          );
        } else {
          button.textContent = `${row.kind}: ${row.reason} ${row.id ?? `Slot ${index + 1}`}`;
          if (row.kind === 'damaged') {
            button.dataset.repairId = row.id;
            button.textContent += ' Remove damaged entry…';
          } else {
            if (document.activeElement === button) get('library-heading').focus();
            button.disabled = true;
          }
        }
        if (button.parentElement !== item) item.replaceChildren(button);
        rowSignatures.set(item, signature);
      }
      item
        .querySelector('button')!
        .setAttribute('aria-pressed', String(row.kind === 'valid' && row.id === librarySelected));
      if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
    });
    for (const node of existing.values()) node.remove();
    text(
      'library-count',
      `${librarySnapshot.count} / 100 physical entries${librarySnapshot.count > 100 ? '; overfull: first 100 only, mutations restricted' : ''}`,
    );
    const entry = selectedEntry();
    text(
      'library-selection',
      entry
        ? `${entry.blueprint.name} · ${entry.id} · ${entry.provenance?.captureTick === undefined ? 'No capture tick' : `Observed at tick ${entry.provenance.captureTick}`}${entry.provenance?.seed === undefined ? '' : `; seed ${entry.provenance.seed}`} · provenance, not fitness.`
        : 'No selected entry.',
    );
    for (const action of ['load', 'rename', 'duplicate', 'export', 'delete'])
      get<HTMLButtonElement>(`library-${action}`).disabled = !entry;
    renderCandidate();
    updateCapture();
  }
  function renderCandidate(): void {
    get('library-candidate').hidden = !candidate;
    text('library-candidate-name', candidate?.blueprint.name ?? '');
    get('library-candidate-preview').innerHTML = candidate
      ? genomeSvg(candidate.blueprint.genome)
      : '';
    get<HTMLButtonElement>('library-replace').disabled = !selectedEntry() || !candidate;
  }
  async function refreshLibrary(outcome = ''): Promise<void> {
    if (!alive || !get<HTMLDetailsElement>('local-library').open) return;
    if (libraryBusy()) {
      refreshNeeded = true;
      return;
    }
    refreshNeeded = false;
    libraryWorking = 'refresh';
    libraryRefreshOutcome = outcome;
    const request = ++libraryRequest,
      selection = librarySelection;
    libraryStatus(outcome || 'Reading local library…');
    try {
      const snapshot = await library.list();
      if (!alive || request !== libraryRequest) return;
      librarySnapshot = snapshot;
      if (selection === librarySelection && initialLibrarySelection)
        librarySelected = snapshot.rows.find((row) => row.kind === 'valid')?.id;
      initialLibrarySelection = false;
      if (!selectedEntry()) librarySelected = undefined;
      renderLibrary();
      libraryStatus(outcome || 'Library refreshed. Other tabs may change it.');
    } catch (error) {
      if (alive && request === libraryRequest)
        libraryStatus(
          `${outcome ? `${outcome} The committed outcome is unchanged; refresh failed. ` : ''}${libraryMessage(error)}`,
        );
    } finally {
      if (request === libraryRequest) {
        libraryWorking = undefined;
        libraryRefreshOutcome = '';
        updateCapture();
        drainRefresh();
      }
    }
  }
  function libraryMessage(error: unknown): string {
    return error instanceof LibraryError
      ? error.message
      : 'The local blueprint operation failed. The world and current design are unchanged.';
  }
  function stageCandidate(value: LibraryCandidate, observed = false): void {
    candidate = value;
    candidateRun = observed ? runId : undefined;
    get<HTMLDetailsElement>('local-library').open = true;
    renderLibrary();
  }
  async function writeLibrary(action: LibraryMutation): Promise<number | undefined> {
    if (!alive || libraryBusy()) {
      libraryStatus('Library busy. Action not started.');
      return;
    }
    libraryWorking = 'write';
    libraryRefreshOutcome = '';
    updateCapture();
    const focusOwner = document.activeElement;
    const request = ++libraryRequest;
    let followup = request;
    let selection = librarySelection;
    const valid = librarySnapshot.rows.filter((row): row is LibraryEntry => row.kind === 'valid');
    const deletedIndex =
      'entry' in action ? valid.findIndex((row) => row.id === action.entry.id) : -1;
    try {
      await library.open();
      if (!alive || request !== libraryRequest) return;
      if (candidateRun !== undefined && candidateRun !== runId) {
        candidate = undefined;
        candidateRun = undefined;
        renderLibrary();
        libraryStatus('Unsaved capture cancelled: the world changed before storage admission.');
        return;
      }
      const id = await library.mutate(action, (committed, expired) => {
        if (!alive) return;
        libraryRequest++;
        libraryWorking = undefined;
        refreshNeeded = false;
        libraryRefreshOutcome = '';
        if (
          committed &&
          (action.type === 'create' || action.type === 'replace') &&
          candidate === action.candidate
        ) {
          candidate = undefined;
          candidateRun = undefined;
          renderCandidate();
        }
        libraryStatus(
          committed
            ? `Native write committed${expired ? ' after the deadline' : ''}. The list is stale; Refresh explicitly.`
            : 'Native operation aborted; no write from it committed. The list is stale; Refresh explicitly.',
        );
        updateCapture();
      });
      if (!alive || request !== libraryRequest) return;
      if (selection === librarySelection) {
        initialLibrarySelection = false;
        librarySelected =
          action.type === 'delete'
            ? (valid[deletedIndex + 1] ?? valid[deletedIndex - 1])?.id
            : action.type === 'repair'
              ? librarySelected
              : id;
        selection = ++librarySelection;
      }
      if (action.type === 'create' || action.type === 'replace') {
        candidate = undefined;
        candidateRun = undefined;
      }
      libraryWorking = undefined;
      renderLibrary();
      const refresh = refreshLibrary('Write committed. Duplicate names are allowed.');
      followup = libraryRequest;
      await refresh;
      if (!alive || followup !== libraryRequest || selection !== librarySelection) return;
      if (
        (action.type === 'delete' || action.type === 'repair') &&
        (document.activeElement === focusOwner || document.activeElement === document.body)
      ) {
        const neighbor = [
          ...get('library-rows').querySelectorAll<HTMLButtonElement>('button'),
        ].find((button) => button.dataset.libraryId === librarySelected);
        (neighbor ?? get('library-heading')).focus();
      }
    } catch (error) {
      if (alive && request === libraryRequest) {
        libraryWorking = undefined;
        libraryStatus(libraryMessage(error));
        if (error instanceof LibraryError && error.code === 'conflict') {
          const refresh = refreshLibrary(`${error.message} `);
          followup = libraryRequest;
          await refresh;
        }
      }
    } finally {
      if (request === libraryRequest) {
        libraryWorking = undefined;
        updateCapture();
        drainRefresh();
      }
    }
    return alive && followup === libraryRequest && selection === librarySelection
      ? followup
      : undefined;
  }
  function showLibraryDialog(
    type: NonNullable<typeof dialogIntent>['type'],
    entry: LibraryEntry | LibraryProblem,
    intent?: NonNullable<typeof replacement>,
  ): void {
    if (dialogIntent || !alive) return;
    dialogIntent = {
      type,
      entry,
      candidate,
      generation: intent?.generation ?? replacementGeneration,
      revision: designRevision,
      run: runId,
      selection: librarySelection,
      invoker: document.activeElement as HTMLElement | null,
    };
    text(
      'library-dialog-title',
      type === 'load'
        ? 'Replace the current design?'
        : type === 'rename'
          ? 'Rename local entry'
          : type === 'repair'
            ? 'Remove damaged entry?'
            : type === 'delete'
              ? 'Delete local entry?'
              : 'Replace selected entry?',
    );
    text(
      'library-dialog-description',
      `${entry.kind === 'valid' ? entry.blueprint.name : 'Declared supported but damaged record'} · Local ID ${entry.id}. ${type === 'load' ? 'Current designer edits will be lost; the world will not change.' : type === 'rename' ? 'Names may repeat. The exact name is preserved.' : 'Existing bytes will be lost. This cannot be undone. Export valid entries first.'}${type === 'replace' ? ` Incoming: ${candidate!.blueprint.name}. Provenance will also be replaced.` : ''}`,
    );
    get('library-dialog-preview').innerHTML =
      type === 'replace' ? genomeSvg(candidate!.blueprint.genome) : '';
    get('library-rename-label').hidden = type !== 'rename';
    get<HTMLInputElement>('library-rename-name').hidden = type !== 'rename';
    get<HTMLInputElement>('library-rename-name').value =
      entry.kind === 'valid' ? entry.blueprint.name : '';
    text('library-dialog-status', '');
    get<HTMLDialogElement>('library-dialog').showModal();
    get('library-cancel').focus();
    dialogTimer = setTimeout(
      () => cancelDialog('Confirmation expired; start a new action.'),
      60000,
    );
    updateCapture();
  }
  async function loadLibraryEntry(): Promise<void> {
    const entry = selectedEntry();
    if (!entry) return;
    const intent = admitReplacement('library');
    if (!intent) return;
    libraryWorking = 'load';
    const request = ++libraryRequest;
    try {
      const current = await library.read(entry);
      if (!replacementCurrent(intent)) return;
      libraryWorking = undefined;
      showLibraryDialog('load', current, intent);
    } catch (error) {
      if (replacementCurrent(intent)) {
        cancelReplacement('the entry could not be read.');
        libraryStatus(libraryMessage(error));
      }
    } finally {
      if (request === libraryRequest) {
        libraryWorking = undefined;
        drainRefresh();
      }
    }
  }
  async function confirmLibrary(): Promise<void> {
    const intent = dialogIntent;
    if (!intent) return;
    let request: number | undefined;
    dialogIntent = undefined;
    clearTimeout(dialogTimer);
    get<HTMLDialogElement>('library-dialog').close();
    if (intent.type === 'load') {
      const owner = replacement?.kind === 'library' ? replacement : undefined;
      if (!owner || !replacementCurrent(owner, intent.generation)) return;
      libraryWorking = 'load';
      request = ++libraryRequest;
      try {
        const current = await library.read(intent.entry as LibraryEntry);
        if (replacementCurrent(owner)) {
          publishDesign(current.blueprint, owner);
          libraryStatus(
            'Blueprint loaded into the designer. Place it explicitly to create a fresh organism.',
          );
        }
      } catch (error) {
        if (replacementCurrent(owner)) {
          cancelReplacement('final read failed.');
          libraryStatus(libraryMessage(error));
        }
      } finally {
        if (request === libraryRequest) {
          libraryWorking = undefined;
          drainRefresh();
        }
      }
    } else if (intent.type === 'repair')
      request = await writeLibrary({ type: 'repair', entry: intent.entry as LibraryProblem });
    else if (intent.type === 'replace')
      request = await writeLibrary({
        type: 'replace',
        entry: intent.entry as LibraryEntry,
        candidate: intent.candidate!,
      });
    else if (intent.type === 'rename')
      request = await writeLibrary({
        type: 'rename',
        entry: intent.entry as LibraryEntry,
        name: get<HTMLInputElement>('library-rename-name').value,
      });
    else request = await writeLibrary({ type: 'delete', entry: intent.entry as LibraryEntry });
    if (!alive || request !== libraryRequest) return;
    if (!dialogIntent && document.activeElement === document.body) get('library-heading').focus();
    updateCapture();
  }
  function exportLibrary(value: LibraryCandidate): void {
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    clearTimeout(exportTimer);
    const anchor = document.createElement('a');
    try {
      exportUrl = URL.createObjectURL(
        new Blob([serializeBlueprint(value.blueprint)], { type: 'application/json' }),
      );
      anchor.href = exportUrl;
      anchor.download = 'evolab-blueprint.json';
      document.body.append(anchor);
      anchor.click();
      libraryStatus(
        'Exported the last loaded blueprint revision. Local ID and provenance are not in the file.',
      );
    } catch {
      libraryStatus('Could not download this blueprint. Try again.');
    } finally {
      anchor.remove();
      exportTimer = setTimeout(() => {
        if (exportUrl) URL.revokeObjectURL(exportUrl);
        exportUrl = undefined;
      }, 1000);
    }
  }
  let captureSequence = 0;
  let captureIntent: {
    id: number;
    action: 'copy' | 'export' | 'library';
    source: 'organism' | 'lineage';
    sourceId: number;
    selectedId: number | null;
    revision: number;
    replacementGeneration: number;
    run: number;
  } | null = null;
  function requestCapture(
    action: 'copy' | 'export' | 'library',
    source: 'organism' | 'lineage',
    sourceId: number,
  ): void {
    if (captureIntent || hasOwner('capture-design') || lifecycleBusy() || stopped) {
      if (action === 'library')
        libraryStatus('Capture unavailable or busy. No playback action was taken.');
      else notice('Design capture busy; wait for its acknowledgement.');
      return;
    }
    captureSequence = increment(captureSequence);
    if (action === 'copy') cancelReplacement('superseded by a newer full design capture.');
    const intent = {
      id: captureSequence,
      action,
      source,
      sourceId,
      selectedId: selected?.id ?? null,
      revision: designRevision,
      replacementGeneration,
      run: runId,
    };
    captureIntent = intent;
    if (!send({ type: 'capture-design', source, sourceId, captureId: intent.id }))
      captureIntent = null;
    updateCapture();
  }
  function completeCapture(data: Extract<WorkerResponse, { type: 'design-captured' }>): void {
    const intent = captureIntent;
    if (!intent || intent.id !== data.captureId) return;
    captureIntent = null;
    if (
      !alive ||
      intent.run !== runId ||
      intent.revision !== designRevision ||
      intent.replacementGeneration !== replacementGeneration ||
      intent.selectedId !== (selected?.id ?? null) ||
      intent.source !== data.source ||
      intent.sourceId !== data.sourceId
    ) {
      if (intent.action === 'library')
        libraryStatus('Capture cancelled: the selection, designer or world changed.');
      else notice('Design capture cancelled: the selection, designer or world changed.');
      updateCapture();
      return;
    }
    if (!integer(data.completedTick, 0, 1e9) || !validGenome(data.genome))
      throw new Error('Invalid full design capture.');
    if (intent.action === 'library') {
      if (libraryBusy() || candidate) {
        libraryStatus('Capture unavailable or busy. Existing candidate preserved.');
        return;
      }
      try {
        serializeBlueprint({
          name: speciesName(data.genome),
          description: '',
          genome: data.genome,
        });
        const value = libraryCandidate(data.genome, speciesName(data.genome), '', {
          captureTick: data.completedTick,
          seed: data.seed,
        });
        stageCandidate(value, true);
        void writeLibrary({ type: 'create', candidate: value });
      } catch (error) {
        libraryStatus(libraryMessage(error));
      }
    } else if (intent.action === 'copy') {
      // copyDesign validates and detaches the full blueprint before replacing the design.
      if (!copyDesign(data.genome)) return;
      tab('organism');
      notice(
        `Anatomy copied in full at worker tick ${data.completedTick}. Edit it, then place it in the world.`,
      );
    } else exportBlueprint(data.genome, speciesName(data.genome), '');
    updateCapture();
  }
  type TargetTicket = { wireId: number | null };
  type Entry = {
    ticket: number;
    payload: CommandPayload;
    generation: number;
    reserved: boolean;
    terrainRevision?: number;
    echo?: Record<string, unknown>;
    targetTicket?: TargetTicket;
    cancelTicket?: TargetTicket;
    checkpoint?: boolean | 'comparison';
  };
  type Posted = Omit<Entry, 'payload'> & {
    type: CommandPayload['type'];
    commandId: number;
    runId: number;
    strokeId?: number;
    format?: MeasurementFormat;
    placement?: boolean;
  };
  const pending: Entry[] = [];
  const pendingSettings: Partial<Record<keyof Settings, { ticket: number; value: number }>> = {};
  let posted: Posted | null = null,
    ticket = 0,
    wireId = 0,
    generation = 0;
  let rejectedTicket = -1;
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
    enabled: renderHabitat,
    visible:
      document.visibilityState !== 'hidden' &&
      canvas.getBoundingClientRect().width > 0 &&
      canvas.getBoundingClientRect().height > 0,
  };
  let acknowledgedView: DisplayView = { ...desiredView },
    viewIntent: DisplayView | null = null;
  get<HTMLInputElement>('render-habitat').checked = renderHabitat;
  let heldDisplay: { runId: number; sequence: number; viewEpoch: number } | null = null;
  let pendingFrame: Extract<WorkerResponse, { type: 'frame' }> | null = null;
  let displayedRevision = -1,
    displayedEpoch = -1,
    displayedSelected = 0;
  let worldRequest = 0,
    reading = false;
  let pendingSpeed: { ticket: number; value: number } | null = null,
    pendingExtinction: { ticket: number; value: boolean } | null = null;
  let waitingFile: {
    file: File;
    request: number;
    generation: number;
    run: number;
    terrainRevision: number;
  } | null = null;
  let strokeId = 0,
    terminated = false;
  let closeLease: { strokeId: number; beginPosted: boolean; posted: boolean } | null = null;
  let localStroke: {
    id: number;
    tool: StrokeTool;
    radius: number;
    count: number;
    brush?: RefugeBrush;
  } | null = null;
  let ownerPointer: number | null = null;
  let availabilityState = -1;
  type Download = { url: string; timer?: ReturnType<typeof setTimeout> };
  const downloads: Partial<Record<'save' | 'export-measurements', Download>> = {};
  const lifecycleBusy = (): boolean =>
    posted?.type === 'start' ||
    posted?.type === 'load' ||
    pending.some((entry) => entry.payload.type === 'start' || entry.payload.type === 'load');
  const manualCount = (): number =>
    pending.filter((entry) =>
      [
        'begin-stroke',
        'paint',
        'settings',
        'shock',
        'clear-walls',
        'regenerate-walls',
        'refuge-mode',
        'paint-refuge',
        'clear-refuges',
      ].includes(entry.payload.type),
    ).length +
    Number(
      !!posted &&
        [
          'begin-stroke',
          'paint',
          'settings',
          'shock',
          'clear-walls',
          'regenerate-walls',
          'refuge-mode',
          'paint-refuge',
          'clear-refuges',
        ].includes(posted.type),
    );
  const hasOwner = (type: CommandPayload['type']): boolean =>
    posted?.type === type || pending.some((entry) => entry.payload.type === type);
  function availability(): void {
    const unavailable = terminated || stopped || lifecycleBusy(),
      exportBlocked =
        unavailable || hasOwner('export-measurements') || !!downloads['export-measurements'],
      saveBlocked = unavailable || hasOwner('save') || !!downloads.save,
      state = Number(exportBlocked) + Number(saveBlocked) * 2;
    const manualBlocked = unavailable || manualCount() >= MANUAL_CAPACITY;
    for (const action of ['clear-walls', 'regenerate-walls', 'refuge-enabled', 'clear-refuges']) {
      const control = get<HTMLButtonElement | HTMLInputElement>(action);
      if (control.disabled !== manualBlocked) control.disabled = manualBlocked;
    }
    for (const button of refugeButtons) {
      const disabled = manualBlocked || !confirmedRefuges.enabled;
      if (button.disabled !== disabled) button.disabled = disabled;
    }
    text(
      'refuge-pending',
      hasOwner('refuge-mode') || hasOwner('clear-refuges') || hasOwner('paint-refuge')
        ? 'Pending worker confirmation; earlier admitted dabs may still complete.'
        : '',
    );
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
  function terminate(): void {
    if (!terminated) {
      worker.terminate();
      terminated = true;
    }
    clearDownload('save');
    clearDownload('export-measurements');
    closeLease = localStroke = null;
    ownerPointer = null;
    dragging = false;
    if (alive) availability();
  }
  function postInternal(data: Record<string, unknown>): void {
    if (terminated) return;
    try {
      worker.postMessage(data);
    } catch {
      terminate();
      stop();
      notice('The worker connection failed. Reload the page to restart.');
    }
  }
  function postTracked(
    type: CommandPayload['type'],
    payload: Record<string, unknown> = {},
  ): boolean {
    return send({ type, ...payload });
  }
  function endStroke(): void {
    dragging = false;
    ownerPointer = null;
    localStroke = null;
    const lease = closeLease;
    if (!lease || lease.posted) return;
    lease.posted = true;
    if (!send({ type: 'end-stroke', strokeId: lease.strokeId })) {
      terminate();
      stop();
    }
  }
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
    postInternal({
      type: 'flow-ack',
      channel: 'display',
      runId: token.runId,
      sequence: token.sequence,
    });
  }
  function pump(): void {
    // Only proven nonposts continue here. The admitted queue is bounded to
    // 32 intents; a rejected action is retired, never put back or retried.
    for (let remaining = 33; remaining > 0; remaining--) if (!postNext()) return;
  }
  function postNext(): boolean {
    if (!alive || terminated || posted) return false;
    const previousRun = runId,
      previousEstablished = establishedRun;
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
      postInternal({ type: 'display-view', view, runId, commandId: wireId });
      return false;
    }
    const entry = pending.shift();
    if (!entry) {
      releaseDiscard();
      return false;
    }
    let payload = entry.payload;
    if (payload.type === 'cancel-target' && entry.cancelTicket) {
      payload.targetId = entry.cancelTicket.wireId!;
    }
    wireId = increment(wireId);
    if (entry.targetTicket) entry.targetTicket.wireId = wireId;
    if (payload.type === 'start' || payload.type === 'load') {
      invalidateObservation();
      runId = increment(runId);
      stopped = false;
      establishedRun = null;
      pendingFrame = null;
      telemetry.update({ status: 'pending', commandId: wireId });
      if (payload.type === 'start') {
        payload.display = { ...desiredView };
        if (viewIntent?.epoch === desiredView.epoch) viewIntent = null;
      }
      text('run-state', 'LOADING');
    }
    if (payload.type === 'begin-stroke' && closeLease?.strokeId === payload.strokeId)
      closeLease.beginPosted = true;
    posted = {
      ...('strokeId' in payload ? { strokeId: payload.strokeId } : {}),
      ...('format' in payload ? { format: payload.format } : {}),
      type: payload.type,
      placement: payload.type === 'paint' && payload.tool === 'plant',
      ticket: entry.ticket,
      checkpoint: entry.checkpoint,
      generation: entry.generation,
      reserved: entry.reserved,
      commandId: wireId,
      runId,
      targetTicket: entry.targetTicket,
      cancelTicket: entry.cancelTicket,
      terrainRevision: entry.terrainRevision,
      echo: commandEcho(payload),
    };
    availability();
    try {
      const previousSave = downloads.save,
        previousExport = downloads['export-measurements'];
      worker.postMessage({ ...payload, runId, commandId: wireId });
      if (payload.type === 'start' || payload.type === 'load') {
        if (previousSave) clearDownload('save', previousSave);
        if (previousExport) clearDownload('export-measurements', previousExport);
      }
    } catch (error) {
      rejectedTicket = entry.ticket;
      if (error instanceof DOMException && error.name === 'DataCloneError') {
        posted = null;
        if (payload.type === 'capture-design') {
          captureIntent = null;
          updateCapture();
        }
        runId = previousRun;
        establishedRun =
          previousEstablished ?? (latestState && acceptedRun === previousRun ? previousRun : null);
        for (const key of ['mutation', 'nutrients', 'climate'] as const)
          if (pendingSettings[key]?.ticket === entry.ticket) {
            delete pendingSettings[key];
            delete settingsEdits[key];
          }
        if (pendingSpeed?.ticket === entry.ticket) pendingSpeed = null;
        if (pendingExtinction?.ticket === entry.ticket) pendingExtinction = null;
        if (entry.targetTicket) {
          // A dependent Cancel has no worker target to cancel. Independent
          // later actions retain their original FIFO positions and payloads.
          for (let index = pending.length - 1; index >= 0; index--)
            if (pending[index].cancelTicket === entry.targetTicket) pending.splice(index, 1);
          if (targetTicket === entry.targetTicket) {
            targetTicket = undefined;
            targetTransition = '';
            text('target-status', '');
          }
        }
        if (payload.type === 'begin-stroke') {
          for (let index = pending.length - 1; index >= 0; index--) {
            const queued = pending[index].payload;
            if ('strokeId' in queued && queued.strokeId === payload.strokeId)
              pending.splice(index, 1);
          }
          closeLease = null;
          localStroke = null;
          ownerPointer = null;
          dragging = false;
        }
        if (latestState && establishedRun === runId) {
          accept(latestState);
          renderObservation(latestState.world, latestState.selected, true);
          renderSettings(latestState.settings);
          renderPlayback(latestState.playback);
          get<HTMLSelectElement>('speed').value = String(pendingSpeed?.value ?? latestState.speed);
        }
        // A posted begin owns a real worker stroke. If its close cannot post,
        // termination remains the only honest release of that reservation.
        if (payload.type === 'end-stroke') {
          terminate();
          stop();
        }
        availability();
        if (entry.checkpoint)
          captureFailed(entry.checkpoint, 'Complete Save could not be posted. Retry explicitly.');
        notice('Could not post this action. No automatic retry was queued.');
        return true;
      } else {
        terminate();
        stop();
      }
      if (entry.checkpoint)
        captureFailed(entry.checkpoint, 'Complete Save could not be posted. Retry explicitly.');
      notice('Could not post this action. No automatic retry was queued.');
    }
    return false;
  }
  function send(
    data: any,
    capturedTerrainRevision = terrainRevision,
    checkpoint: boolean | 'comparison' = false,
  ): boolean {
    if (
      !alive ||
      terminated ||
      (stopped && data.type !== 'start' && data.type !== 'load' && data.type !== 'end-stroke')
    )
      return false;
    if (
      (data.type === 'save' || data.type === 'export-measurements') &&
      (hasOwner(data.type) || downloads[data.type as 'save' | 'export-measurements'])
    ) {
      notice('Worker capacity busy; wait for the earlier download.');
      return false;
    }
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
          : payload.type !== 'end-stroke' &&
            pending.filter((entry) => !entry.reserved).length -
              superseded.length +
              Number(
                !!closeLease && !pending.some((entry) => entry.payload.type === 'end-stroke'),
              ) >=
              30)
      ) {
        dragging = false;
        notice('Controls busy; wait for acknowledgement.');
        return false;
      }
      for (const entry of superseded) pending.splice(pending.indexOf(entry), 1);
      ticket = increment(ticket);
      const entry: Entry = {
        ticket,
        payload,
        generation,
        reserved,
        terrainRevision: capturedTerrainRevision,
        checkpoint,
      };
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
      availability();
      pump();
      return rejectedTicket !== entry.ticket;
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
  function changeView(
    enabled = desiredView.enabled,
    visible = desiredView.visible,
    lineage = desiredView.lineage === true,
  ): void {
    if (
      !alive ||
      (enabled === desiredView.enabled &&
        visible === desiredView.visible &&
        lineage === (desiredView.lineage === true))
    )
      return;
    desiredView = {
      epoch: increment(desiredView.epoch),
      enabled,
      visible,
      ...(lineage ? { lineage: true as const } : {}),
    };
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
  function renderSettings(next: Settings, replaceDraft = true): void {
    const lifecycle = posted?.type === 'start' || posted?.type === 'load';
    const replaceDraftSeed = lifecycle
      ? replaceDraft && posted?.terrainRevision === terrainRevision
      : next.seed !== confirmedSettings.seed;
    confirmedSettings = { ...next };
    settingsEdits = {};
    for (const key of ['mutation', 'nutrients', 'climate'] as const)
      if (pendingSettings[key]) settingsEdits[key] = pendingSettings[key]!.value;
    settings = { ...next, ...settingsEdits };
    for (const id of ['seed', 'mutation', 'nutrients', 'climate'] as const) {
      const control = get<HTMLInputElement>(id);
      if ((id !== 'seed' || replaceDraftSeed) && control.value !== String(settings[id]))
        control.value = String(settings[id]);
    }
    text('mutation-value', `${Math.round(settings.mutation * 100)}%`);
    text('climate-value', `${Math.round(settings.climate * 100)}%`);
    text('nutrients-value', `${settings.nutrients}%`);
    text('world-label', `WORLD ${String(settings.seed).padStart(4, '0')}`);
    renderTerrain();
  }
  function readTerrain(): TerrainRecipe | null {
    const follows = get<HTMLInputElement>('terrain-follow').checked,
      input = get<HTMLInputElement>('terrain-seed'),
      recipe = {
        version: 1,
        preset: get<HTMLSelectElement>('terrain-preset').value,
        seed: follows ? null : Number(input.value),
      };
    return (follows || input.checkValidity()) && validTerrain(recipe) ? recipe : null;
  }
  let previewKey = '';
  function renderTerrain(): void {
    const recipe = readTerrain(),
      worldSeed = Number(get<HTMLInputElement>('seed').value);
    get('terrain-seed-label').hidden = get<HTMLInputElement>('terrain-follow').checked;
    text(
      'terrain-committed',
      `Wall recipe · ${TERRAIN_LABELS[committedTerrain.preset]} · terrain seed ${resolvedTerrainSeed(committedTerrain, confirmedSettings.seed)} · world seed ${confirmedSettings.seed} · generator ${committedTerrain.version}; saved/edited cells are authoritative.`,
    );
    if (
      !recipe ||
      !get<HTMLInputElement>('seed').checkValidity() ||
      !integer(worldSeed, 0, 4294967295)
    ) {
      text(
        'terrain-preview-caption',
        'Reset preview unavailable: choose whole-number seeds from 0 to 4294967295.',
      );
      text('terrain-draft-status', 'Invalid draft; no wall action submitted.');
      return;
    }
    draftTerrain = { ...recipe };
    text(
      'terrain-preview-caption',
      `Reset preview · ${TERRAIN_LABELS[recipe.preset]} · terrain seed ${resolvedTerrainSeed(recipe, worldSeed)} (${recipe.seed === null ? 'world seed' : 'independent seed'}) · generator ${recipe.version}`,
    );
    text(
      'terrain-draft-status',
      sameTerrain(recipe, committedTerrain)
        ? 'Draft matches the committed recipe, not necessarily the live cells.'
        : 'Unapplied draft; use Regenerate walls or confirm a reset to commit.',
    );
    const key = JSON.stringify([recipe, worldSeed]);
    if (key === previewKey) return;
    previewKey = key;
    const preview = get<HTMLCanvasElement>('terrain-preview'),
      context = preview.getContext('2d')!;
    const walls = generateTerrain(recipe, worldSeed);
    context.fillStyle = COLORS[0];
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = COLORS[2];
    for (let cell = 0; cell < walls.length; cell++)
      if (walls[cell]) context.fillRect(cell % WIDTH, Math.floor(cell / WIDTH), 1, 1);
  }
  function installTerrain(recipe: TerrainRecipe, revision: number): void {
    committedTerrain = { ...recipe };
    if (terrainRevision === revision) {
      draftTerrain = { ...recipe };
      get<HTMLSelectElement>('terrain-preset').value = recipe.preset;
      get<HTMLInputElement>('terrain-follow').checked = recipe.seed === null;
      get<HTMLInputElement>('terrain-seed').value = String(recipe.seed ?? confirmedSettings.seed);
    }
    renderTerrain();
  }
  function cancelReset(focus = true): void {
    resetPayload = null;
    const dialog = get<HTMLDialogElement>('reset-dialog');
    if (!dialog.open) return;
    dialog.close();
    if (focus) get('reset').focus();
  }
  function stop(): void {
    comparisons.invalidate();
    checkpoints.invalidate();
    stopped = true;
    invalidateObservation();
    paused = true;
    clearDownload('save');
    clearDownload('export-measurements');
    const retainedClose = closeLease?.beginPosted
      ? pending.find((entry) => entry.payload.type === 'end-stroke')
      : undefined;
    pending.length = 0;
    if (retainedClose) pending.push(retainedClose);
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
    availability();
  }
  const tab = (name: string): void => {
    if (name !== 'organism') {
      cancelDialog('Confirmation cancelled: the library is no longer visible.');
      if (replacement?.kind === 'library') cancelReplacement('the library is no longer visible.');
    }
    root
      .querySelectorAll<HTMLButtonElement>('[data-tab]')
      .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    get('ecosystem-panel').hidden = name !== 'ecosystem';
    get('organism-panel').hidden = name !== 'organism';
    if (name === 'ecosystem') lineageView.reveal();
  };
  function choose(next: Tool): void {
    endStroke();
    if (refugeTool(next) && !confirmedRefuges.enabled) {
      notice('Enable painted temperature refuges before painting.');
      return;
    }
    if (next === 'plant' && !validGenome(blueprint)) {
      notice('Draw 1–16 connected cells before placing an organism.');
      tab('organism');
      return;
    }
    clearPlacement();
    tool = next;
    if (tool === 'plant') dirty = true;
    get('cancel-placement').hidden = tool !== 'plant';
    root
      .querySelectorAll<HTMLButtonElement>('button[data-tool]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    canvas.dataset.tool = tool;
    get<HTMLInputElement>('refuge-intensity').disabled = tool === 'erase-temperature';
    if (tool === 'plant') tab('organism');
    const painting = ['food', 'wall', 'erase'].includes(tool) || refugeTool(tool);
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
        plant:
          'Preview, then click to place. Touch: tap an anchor, then tap it again. Escape cancels.',
        warm: 'Add warmth with each admitted dab.',
        cool: 'Subtract warmth with each admitted dab.',
        'erase-temperature': 'Erase painted temperature only.',
      }[tool],
    );
  }
  function editor(): void {
    dirty = true;
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
    text('behavior-status', behaviorStatus(blueprint));
    text(
      'design-note',
      validGenome(blueprint)
        ? `${blueprint.cells.length} connected cells. Ready to place.`
        : 'Use 1–16 cells, connected edge to edge.',
    );
  }
  function transform(action: 'rotate' | 'mirror'): void {
    try {
      const next = transformDesign(blueprint, action);
      endStroke();
      invalidateDesign();
      blueprint = next;
      editor();
    } catch {
      notice('Draw 1–16 connected cells before transforming a design.');
    }
  }
  get('rotate-design').addEventListener('click', () => transform('rotate'));
  get('mirror-design').addEventListener('click', () => transform('mirror'));
  get('cancel-placement').addEventListener('click', () => choose('pan'));
  function copyDesign(genome: Genome): boolean {
    let copied: Genome;
    try {
      copied = cloneGenome(genome);
      serializeBlueprint({ name: speciesName(genome), description: '', genome: copied });
    } catch (error) {
      notice((error as Error).message);
      return false;
    }
    endStroke();
    invalidateDesign();
    blueprint = copied;
    blueprintName = speciesName(genome);
    blueprintDescription = '';
    editor();
    get<HTMLDetailsElement>('specimen-details').open = false;
    return true;
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
  function reset(initial = false): void {
    if (!alive || lifecycleBusy()) {
      notice('World replacement capacity busy; wait for acknowledgement.');
      return;
    }
    const seed = Number(get<HTMLInputElement>('seed').value),
      next = { ...settings, seed };
    if (!get<HTMLInputElement>('seed').checkValidity() || !validSettings(next)) {
      notice('Choose a whole-number seed from 0 to 4294967295.');
      return;
    }
    const terrain = readTerrain();
    if (!terrain) {
      notice('Choose a valid wall recipe and whole-number terrain seed.');
      return;
    }
    if (initial) {
      replaceWorld('start', { settings: next, terrain });
      return;
    }
    resetPayload = {
      settings: structuredClone(next),
      terrain: { ...terrain },
      run: runId,
      revision: terrainRevision,
      refugeReset: 'off-empty',
    };
    text(
      'reset-payload',
      `World seed ${seed} · ${TERRAIN_LABELS[terrain.preset]} · terrain seed ${resolvedTerrainSeed(terrain, seed)} · generator ${terrain.version}. This displayed payload is frozen; later draft edits require reopening.`,
    );
    get<HTMLDialogElement>('reset-dialog').showModal();
    get('cancel-reset').focus();
  }
  function replaceWorld(
    operation: 'start',
    data: { settings: Settings; terrain: TerrainRecipe },
    revision = terrainRevision,
  ): void {
    cancelReset(false);
    checkpoints.invalidate();
    comparisons.invalidate();
    invalidateObservation();
    const payload = captureCommand({ type: operation, ...data, display: desiredView }, settings);
    try {
      generation = increment(generation);
    } catch {
      notice('Session counter exhausted. Restart the worker.');
      return;
    }
    worldRequest++;
    waitingFile = null;
    blueprintRequest++;
    if (closeLease?.beginPosted) endStroke();
    else {
      closeLease = null;
      localStroke = null;
      ownerPointer = null;
      dragging = false;
    }
    const retainedClose = pending.find((entry) => entry.payload.type === 'end-stroke');
    pending.length = 0;
    if (retainedClose) pending.push(retainedClose);
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
    send(payload, revision);
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
      captureIntent = null;
      updateCapture();
      get<HTMLDetailsElement>('specimen-details').open = true;
      send({ type: 'inspect', ...p });
      tab('organism');
    } else if (tool !== 'pan') {
      if (refugeTool(tool)) {
        const stroke = localStroke!;
        if (
          stroke.count >= STROKE_COMMAND_CAPACITY ||
          !postTracked('paint-refuge', { ...stroke.brush, ...p, strokeId: stroke.id })
        ) {
          endStroke();
          notice(
            'Partial temperature stroke stopped. Earlier admitted dabs may still complete; start a fresh gesture.',
          );
        } else {
          stroke.count++;
          if (stroke.count === STROKE_COMMAND_CAPACITY) endStroke();
        }
        return;
      }
      if (!validGenome(blueprint)) {
        notice('Draw 1–16 connected cells before painting.');
        return;
      }
      const genome = cloneGenome(blueprint);
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
      (['food', 'wall', 'erase'].includes(tool) || refugeTool(tool)) &&
      (closeLease ||
        manualCount() > MANUAL_CAPACITY - 2 ||
        pending.filter((entry) => !entry.reserved).length > 27 ||
        wireId > Number.MAX_SAFE_INTEGER - 3 ||
        strokeId === Number.MAX_SAFE_INTEGER)
    ) {
      notice('Brush capacity busy. A fresh pointer press is required after earlier work drains.');
      return;
    }
    if (refugeTool(tool) && !confirmedRefuges.enabled) {
      notice('Painted temperature refuges are disabled.');
      return;
    }
    if (['food', 'wall', 'erase'].includes(tool) || refugeTool(tool)) {
      const id = ++strokeId;
      closeLease = { strokeId: id, beginPosted: false, posted: false };
      const frozenBrush = refugeTool(tool)
        ? {
            rulesVersion: 1 as const,
            tool,
            radius: brush,
            units: tool === 'warm' ? refugeIntensity : tool === 'cool' ? -refugeIntensity : 0,
          }
        : undefined;
      localStroke = { id, tool: tool as StrokeTool, radius: brush, count: 0, brush: frozenBrush };
      if (!postTracked('begin-stroke', { strokeId: id, tool, radius: brush, ...frozenBrush })) {
        if (closeLease?.beginPosted) endStroke();
        else closeLease = null;
        localStroke = null;
        return;
      }
    }
    ownerPointer = event.pointerId;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    hover = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    dirty = true;
    if (tool === 'plant' && event.pointerType !== 'touch') touchAnchor = undefined;
    if (tool === 'plant' && event.pointerType === 'touch') {
      const anchor = point(canvas, camera, hover.x, hover.y);
      if (!anchor) return;
      if (!touchAnchor || anchor.x !== touchAnchor.x || anchor.y !== touchAnchor.y) {
        touchAnchor = anchor;
        return;
      }
      touchAnchor = undefined;
    }
    act(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (ownerPointer !== null && event.pointerId !== ownerPointer) return;
    if (tool === 'plant') {
      if (event.pointerType !== 'touch') touchAnchor = undefined;
      const rect = canvas.getBoundingClientRect();
      hover = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      dirty = true;
    }
    if (!dragging || event.pointerId !== ownerPointer) return;
    if (tool === 'pan') {
      camera.x += event.clientX - lastX;
      camera.y += event.clientY - lastY;
      dirty = true;
    } else if (tool !== 'inspect' && tool !== 'plant') act(event);
    lastX = event.clientX;
    lastY = event.clientY;
  });
  canvas.addEventListener('pointerleave', () => {
    if (!touchAnchor) clearPlacement();
  });
  const release = (event: Event): void => {
    if ('pointerId' in event && event.pointerId !== ownerPointer) return;
    if (event.type === 'blur' || event.type === 'pointercancel') clearPlacement();
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
  canvas.addEventListener('dblclick', () => {
    if (tool !== 'plant') fit();
  });
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
  get('refuge-enabled').addEventListener('change', () => {
    const enabled = get<HTMLInputElement>('refuge-enabled').checked;
    get<HTMLInputElement>('refuge-enabled').checked = confirmedRefuges.enabled;
    endStroke();
    postTracked('refuge-mode', { rulesVersion: 1, enabled });
  });
  get('clear-refuges').addEventListener('click', () => {
    endStroke();
    postTracked('clear-refuges', { rulesVersion: 1 });
  });
  get('refuge-intensity').addEventListener('input', () => {
    endStroke();
    const value = Number(get<HTMLInputElement>('refuge-intensity').value);
    if (!integer(value, 1, 32)) {
      notice('Choose a whole-number temperature intensity from 1 to 32.');
      return;
    }
    refugeIntensity = value;
    text('refuge-intensity-value', `${value} units`);
  });
  for (const id of ['mutation', 'nutrients', 'climate'] as const)
    get(id).addEventListener('input', () => {
      const value = Number(get<HTMLInputElement>(id).value);
      endStroke();
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
    endStroke();
    brush = Number(get<HTMLInputElement>('brush').value);
    text('brush-value', `${brush} cells`);
  });
  get('preference').addEventListener('input', () => {
    endStroke();
    invalidateDesign();
    blueprint.preference = Number(get<HTMLInputElement>('preference').value);
    text('preference-value', `${Math.round(blueprint.preference * 40)}°`);
  });
  get('reset').addEventListener('click', () => reset());
  get('cancel-reset').addEventListener('click', () => cancelReset());
  get('reset-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    cancelReset();
  });
  get('confirm-reset').addEventListener('click', () => {
    const pending = resetPayload;
    if (!pending || pending.run !== runId) return;
    cancelReset();
    replaceWorld(
      'start',
      { settings: pending.settings, terrain: pending.terrain },
      pending.revision,
    );
  });
  for (const id of ['terrain-preset', 'terrain-follow', 'terrain-seed', 'seed'])
    get(id).addEventListener(
      id === 'terrain-preset' || id === 'terrain-follow' ? 'change' : 'input',
      () => {
        if (!alive) return;
        terrainRevision++;
        renderTerrain();
      },
    );
  get('clear-walls').addEventListener('click', () => {
    endStroke();
    postTracked('clear-walls', { action: 'clear' });
  });
  get('regenerate-walls').addEventListener('click', () => {
    const recipe = readTerrain();
    if (!recipe) {
      notice('Choose a valid wall recipe and whole-number terrain seed.');
      return;
    }
    const resolvedSeed = resolvedTerrainSeed(recipe, confirmedSettings.seed);
    endStroke();
    postTracked('regenerate-walls', { action: 'regenerate', recipe: { ...recipe }, resolvedSeed });
  });
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
    invalidateDesign();
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
    invalidateDesign();
    blueprint = founder(0);
    blueprintName = BLUEPRINT_DEFAULT_NAME;
    blueprintDescription = '';
    editor();
  });
  get('blueprint-name').addEventListener('input', () => {
    invalidateDesign();
    blueprintName = get<HTMLInputElement>('blueprint-name').value;
  });
  get('blueprint-description').addEventListener('input', () => {
    invalidateDesign();
    blueprintDescription = get<HTMLTextAreaElement>('blueprint-description').value;
  });
  get('export-blueprint').addEventListener('click', () =>
    exportBlueprint(blueprint, blueprintName, blueprintDescription),
  );
  const blueprintInput = get<HTMLInputElement>('blueprint-file');
  const libraryInput = get<HTMLInputElement>('library-file');
  const cleanups: (() => void)[] = [];
  function listen(target: EventTarget, type: string, callback: EventListener): void {
    target.addEventListener(type, callback);
    cleanups.push(() => target.removeEventListener(type, callback));
  }
  function beginPicker(input: HTMLInputElement, designer: boolean): void {
    if (
      picker ||
      (blueprintReader && (!designer || replacement?.kind !== 'file')) ||
      candidate ||
      (libraryWorking && libraryWorking !== 'load') ||
      (dialogIntent && dialogIntent.type !== 'load')
    ) {
      libraryStatus('Busy: file picker not opened.');
      return;
    }
    const intent = designer ? admitReplacement('file') : undefined;
    if ((designer && !intent) || (!designer && libraryBusy())) return;
    const generation = ++blueprintRequest;
    input.value = '';
    picker = { input, generation, expired: false };
    fileTimer = setTimeout(() => {
      if (picker?.generation === generation) {
        picker.expired = true;
        cancelReplacement('file picker expired.');
        libraryStatus('File picker expired. Close it before opening another picker.');
      }
    }, 60000);
    input.click();
  }
  function pickerCancelled(input: HTMLInputElement): void {
    if (picker && picker.input !== input) return;
    clearTimeout(fileTimer);
    picker = undefined;
    blueprintRequest++;
    if (input === blueprintInput) cancelReplacement('file selection cancelled.');
    input.value = '';
    updateCapture();
    drainRefresh();
  }
  function readBlueprint(input: HTMLInputElement, designer: boolean): void {
    const choice = picker;
    if (choice && choice.input !== input) return;
    if (choice) {
      picker = undefined;
      clearTimeout(fileTimer);
      if (choice.expired || !alive) {
        input.value = '';
        return;
      }
    }
    const file = input.files?.[0];
    if (!file) {
      if (choice) pickerCancelled(input);
      return;
    }
    let intent = designer ? (choice ? replacement : admitReplacement('file')) : undefined;
    if ((designer && !intent) || (!designer && (libraryBusy() || candidate))) {
      libraryStatus('Busy: blueprint read not started.');
      return;
    }
    const request = ++blueprintRequest,
      worldRun = runId;
    let publishable = true;
    const current = (): boolean =>
      publishable &&
      alive &&
      request === blueprintRequest &&
      worldRun === runId &&
      (!designer || (!!intent && replacementCurrent(intent)));
    const failed = (message: string): void => {
      if (!current()) return;
      publishable = false;
      if (designer) {
        text('designer-file-status', message);
        notice(message);
        replacement = undefined;
      } else libraryStatus(message);
    };
    if (file.size > BLUEPRINT_MAX_BYTES) {
      failed('Blueprint files must be 16 KiB or smaller.');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    blueprintReader = reader;
    fileTimer = setTimeout(() => {
      failed('Blueprint read timed out. The native reader must settle before another read.');
      reader.abort();
    }, 10000);
    reader.onload = () => {
      if (!current()) return;
      try {
        const imported = parseBlueprint(reader.result as string);
        if (designer) {
          publishDesign(imported, intent!);
          text('designer-file-status', 'Blueprint loaded into designer.');
          notice('Blueprint loaded into the designer. Place it explicitly to add an organism.');
        } else {
          stageCandidate({ blueprint: imported });
          libraryStatus(
            'Imported an unsaved blueprint. Add as new, or explicitly replace the selected ID.',
          );
        }
        publishable = false;
      } catch (error) {
        failed((error as Error).message);
      }
    };
    reader.onerror = () => failed('Could not read this blueprint. Choose a readable JSON file.');
    reader.onabort = () => {
      if (current()) failed('Blueprint read cancelled.');
    };
    reader.onloadend = () => {
      publishable = false;
      if (blueprintReader === reader) {
        blueprintReader = undefined;
        clearTimeout(fileTimer);
      }
      reader.onload = reader.onerror = reader.onabort = reader.onloadend = null;
      if (alive && request === blueprintRequest) input.value = '';
      if (alive) {
        updateCapture();
        drainRefresh();
      }
    };
    try {
      reader.readAsText(file);
    } catch {
      failed('Could not read this blueprint. Choose a readable JSON file.');
      reader.dispatchEvent(new ProgressEvent('loadend'));
    }
  }
  listen(get('import-blueprint'), 'click', () => beginPicker(blueprintInput, true));
  listen(blueprintInput, 'cancel', () => pickerCancelled(blueprintInput));
  listen(blueprintInput, 'change', () => readBlueprint(blueprintInput, true));
  listen(get('library-import'), 'click', () => beginPicker(libraryInput, false));
  listen(libraryInput, 'cancel', () => pickerCancelled(libraryInput));
  listen(libraryInput, 'change', () => readBlueprint(libraryInput, false));
  listen(get('local-library'), 'toggle', () => {
    if (get<HTMLDetailsElement>('local-library').open) void refreshLibrary();
    else {
      cancelDialog('Confirmation cancelled: library closed.');
      cancelReplacement('library closed.');
    }
  });
  listen(get('library-refresh'), 'click', () => {
    void refreshLibrary();
  });
  listen(get('library-save'), 'click', () => {
    if (libraryBusy() || candidate) {
      libraryStatus('Busy: save not started. Discard or save the current candidate first.');
      return;
    }
    try {
      stageCandidate(libraryCandidate(blueprint, blueprintName, blueprintDescription));
      void writeLibrary({ type: 'create', candidate: candidate! });
    } catch (error) {
      libraryStatus(libraryMessage(error));
    }
  });
  listen(captureButton, 'click', () => {
    if (captureButton.disabled || libraryBusy() || candidate) {
      libraryStatus('Capture unavailable or busy. No playback action was taken.');
      return;
    }
    requestCapture('library', 'organism', selected!.id);
  });
  listen(get('library-add'), 'click', () => {
    if (candidate) void writeLibrary({ type: 'create', candidate });
  });
  listen(get('library-discard'), 'click', () => {
    if (libraryBusy()) return;
    candidate = undefined;
    candidateRun = undefined;
    renderLibrary();
    libraryStatus('Blueprint candidate copy discarded. Stored entries are unchanged.');
  });
  listen(get('library-export-candidate'), 'click', () => {
    if (candidate) exportLibrary(candidate);
  });
  listen(get('library-export'), 'click', () => {
    const entry = selectedEntry();
    if (entry) exportLibrary(entry);
  });
  listen(get('library-load'), 'click', () => {
    void loadLibraryEntry();
  });
  listen(get('library-duplicate'), 'click', () => {
    const entry = selectedEntry();
    if (entry) void writeLibrary({ type: 'duplicate', entry });
  });
  for (const type of ['rename', 'replace', 'delete'] as const)
    listen(get(`library-${type}`), 'click', () => {
      const entry = selectedEntry();
      if (entry && !libraryBusy() && (type !== 'replace' || candidate))
        showLibraryDialog(type, entry);
    });
  listen(get('library-rows'), 'click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.libraryId) {
      cancelDialog('Selection changed.');
      cancelReplacement('library selection changed.');
      initialLibrarySelection = false;
      librarySelected = button.dataset.libraryId;
      librarySelection++;
      renderLibrary();
    } else if (button.dataset.repairId && !libraryBusy()) {
      const entry = librarySnapshot.rows.find(
        (row) => row.kind === 'damaged' && row.id === button.dataset.repairId,
      );
      if (entry) showLibraryDialog('repair', entry);
    }
  });
  listen(get('library-cancel'), 'click', () => cancelDialog('Confirmation cancelled.'));
  listen(get('library-dialog'), 'cancel', (event) => {
    event.preventDefault();
    cancelDialog('Confirmation cancelled.');
  });
  listen(get('library-confirm'), 'click', () => {
    void confirmLibrary();
  });
  const focusRefresh = (): void => {
    if (get<HTMLDetailsElement>('local-library').open) void refreshLibrary();
  };
  listen(window, 'focus', focusRefresh);
  listen(document, 'visibilitychange', () => {
    if (document.hidden) {
      cancelDialog('Confirmation cancelled: page hidden.');
      cancelReplacement('page hidden.');
    } else focusRefresh();
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
      requestCapture('copy', 'organism', selected.id);
    }
    if ((event.target as HTMLElement).closest('#export-organism-blueprint') && selected)
      requestCapture('export', 'organism', selected.id);
  });
  get('help').addEventListener('click', () => get<HTMLDialogElement>('help-dialog').showModal());
  get('close-help').addEventListener('click', () => get<HTMLDialogElement>('help-dialog').close());
  function captureFailed(target: boolean | 'comparison', message: string): void {
    if (target === 'comparison') comparisons.failed(message);
    else checkpoints.failed(message);
  }
  const comparisons = mountComparisons(root, {
    context: () => `${generation}:${runId}:${worldRequest}`,
    capture: () => {
      if (lifecycleBusy() || hasOwner('save') || downloads.save) return false;
      return send({ type: 'save' }, terrainRevision, 'comparison');
    },
  });
  const checkpoints = mountCheckpoints(root, {
    context: () => `${generation}:${runId}:${worldRequest}`,
    capture: () => {
      if (lifecycleBusy() || hasOwner('save') || downloads.save) return false;
      return send({ type: 'save' }, terrainRevision, true);
    },
    restore: (content) => {
      if (lifecycleBusy()) return false;
      cancelReset(false);
      invalidateCandidate();
      endStroke();
      return send({ type: 'load', text: content });
    },
  });
  get('save').addEventListener('click', () => send({ type: 'save' }));
  for (const format of ['csv', 'json'] as const)
    get('measurements-' + format).addEventListener('click', () =>
      send({ type: 'export-measurements', format }),
    );
  const worldInput = get<HTMLInputElement>('file');
  function invalidateCandidate(): void {
    checkpoints.invalidate();
    comparisons.invalidate();
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
      if (current()) {
        comparisons.invalidate();
        if (lifecycleBusy())
          notice('World replacement capacity busy; choose the file again after acknowledgement.');
        else {
          endStroke();
          send({ type: 'load', text: content }, request.terrainRevision);
        }
      }
    } catch (error) {
      if (current()) {
        comparisons.invalidate();
        notice(error instanceof Error ? error.message : 'Could not read this world.');
      }
    } finally {
      reading = false;
      if (request.request === worldRequest) worldInput.value = '';
      if (alive) void readWorld();
    }
  }
  get('load').addEventListener('click', () => {
    cancelReset(false);
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
    waitingFile = { file, request: worldRequest, generation, run: runId, terrainRevision };
    if (reading)
      notice('World read still outstanding; only the latest waiting selection is retained.');
    void readWorld();
  });
  const keyboard = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && tool === 'plant' && !root.querySelector('dialog[open]')) {
      event.preventDefault();
      choose('pan');
      return;
    }
    if (
      (event.target instanceof HTMLElement &&
        event.target.closest(
          'input,select,textarea,button,summary,[contenteditable="true"],dialog',
        )) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      get<HTMLDialogElement>('help-dialog').open ||
      get<HTMLDialogElement>('reset-dialog').open
    )
      return;
    const key = event.key.toLowerCase();
    if ((key === 'r' || key === 'm') && !event.repeat) {
      event.preventDefault();
      transform(key === 'r' ? 'rotate' : 'mirror');
    }
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
  function installRefuges(summary: RefugeSummary): void {
    confirmedRefuges = { ...summary };
    const control = get<HTMLInputElement>('refuge-enabled');
    if (control.checked !== summary.enabled) control.checked = summary.enabled;
    text(
      'refuge-summary',
      `${summary.enabled ? (summary.nonzeroCells ? 'Enabled · painted' : 'Enabled · empty') : summary.nonzeroCells ? 'Disabled · stored paint' : 'Disabled · empty'} · ${summary.nonzeroCells}/4096 nonzero cells · offsets ${summary.minimumUnits}..${summary.maximumUnits} units · rules 1`,
    );
    availability();
  }
  function renderObservation(
    next: WorldPresentation,
    selection: Organism | null,
    displayOnly = false,
  ): void {
    const previousSelection = selected?.id;
    const previousPopulation = latestState?.world.stats.population;
    selected = selection;
    if (!stopped) acceptedObservationRun = runId;
    observationTick = next.stats.tick;
    updateCapture();
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
          requestCapture('copy', 'lineage', species.id);
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
  const lineageView = createLineageView(root, () => {
    dirty = true;
  });
  let displayedLineage: WorldPresentation['lineage'];
  let displayedLineageReplacement = 0;
  get('lineage-explorer').addEventListener('toggle', () => {
    if (get<HTMLDetailsElement>('lineage-explorer').open) {
      changeView(desiredView.enabled, desiredView.visible, true);
      lineageView.reveal();
    }
  });
  function accept(
    observation: ControlState,
    source?: TelemetrySnapshot,
    replaceDraft = true,
  ): void {
    if (stopped || establishedRun !== runId) return;
    const differentRun = acceptedRun !== runId;
    if (differentRun) {
      acceptedRun = runId;
      latestTelemetry = null;
    }
    if (!latestState || differentRun || observation.revision > latestState.revision) {
      if (!differentRun && latestState && observation.replacementId !== latestState.replacementId)
        return;
      if (observation.world.lineage)
        lineageView.update(
          observation.world.lineage,
          observation.world.stats.tick,
          observation.replacementId,
        );
      renderObservation(
        observation.world,
        observation.selected,
        differentRun || observation.playback.paused,
      );
      latestState = observation;
      installRefuges(observation.world.thermalRefuges);
      const recipeRevision =
        replaceDraft && posted && ['start', 'load', 'regenerate-walls'].includes(posted.type)
          ? (posted.terrainRevision ?? -1)
          : -1;
      installTerrain(observation.world.terrain, recipeRevision);
      renderSettings(observation.settings, replaceDraft);
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
  function download(
    data: Extract<WorkerResponse, { type: 'saved' | 'measurement-exported' }>,
  ): void {
    const operation = data.type === 'saved' ? 'save' : 'export-measurements';
    if (
      typeof data.text !== 'string' ||
      data.text.length > WORLD_MAX_BYTES ||
      !integer(data.completedTick, 0, 1e9) ||
      !integer(data.seed, 0, 4294967295) ||
      !integer(data.byteLength, 0, WORLD_MAX_BYTES) ||
      new TextEncoder().encode(data.text).byteLength !== data.byteLength
    )
      throw new Error('Invalid completed download payload; no download created.');
    const format = data.type === 'saved' ? 'json' : data.format;
    const anchor = document.createElement('a');
    let lease: Download | undefined,
      dispatched = false;
    try {
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
          ? 'evolab-world-' + data.seed + '.json'
          : 'evolab-measurements-' + data.seed + '-tick-' + data.completedTick + '.' + format;
      document.body.append(anchor);
      anchor.click();
      const owned = lease;
      lease.timer = setTimeout(() => clearDownload(operation, owned), 1000);
      dispatched = true;
    } finally {
      anchor.remove();
      if (!dispatched && lease) clearDownload(operation, lease);
    }
  }
  worker.onmessage = ({ data: raw }) => {
    if (!alive || !raw || typeof raw !== 'object') return;
    const data = raw as WorkerResponse;
    if (data.type === 'progress') {
      if (!integer(data.sequence, 1, Number.MAX_SAFE_INTEGER)) return;
      if (data.runId === runId && establishedRun === runId && !stopped)
        accept(data.state, data.telemetry);
      if (data.sequence <= progressWatermark) return;
      progressWatermark = data.sequence;
      postInternal({
        type: 'flow-ack',
        channel: 'progress',
        runId: data.runId,
        sequence: data.sequence,
      });
      pump();
      return;
    }
    if (data.type === 'frame') {
      if (!integer(data.sequence, 1, Number.MAX_SAFE_INTEGER)) return;
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
      ('requestId' in data && data.requestId !== undefined) ||
      data.operation !== completion.type ||
      Object.entries(completion.echo ?? {}).some(
        ([key, value]) =>
          JSON.stringify((data as unknown as Record<string, unknown>)[key]) !==
          JSON.stringify(value),
      ) ||
      ('format' in data ? data.format : undefined) !== completion.format ||
      ('strokeId' in data ? data.strokeId : undefined) !== completion.strokeId ||
      !(
        data.type === 'error' ||
        data.type ===
          (completion.type === 'save'
            ? 'saved'
            : completion.type === 'capture-design'
              ? 'design-captured'
              : completion.type === 'export-measurements'
                ? 'measurement-exported'
                : [
                      'begin-stroke',
                      'end-stroke',
                      'paint',
                      'settings',
                      'shock',
                      'clear-walls',
                      'regenerate-walls',
                      'refuge-mode',
                      'paint-refuge',
                      'clear-refuges',
                    ].includes(completion.type)
                  ? 'manual-result'
                  : completion.type === 'load'
                    ? 'loaded'
                    : 'control')
      )
    ) {
      if (
        data.type === 'error' &&
        data.fatal &&
        data.runId === runId &&
        data.commandId === undefined &&
        data.operation === undefined &&
        !('requestId' in data && data.requestId !== undefined)
      ) {
        stop();
        notice(data.message);
      }
      return;
    }
    if (completion.generation !== generation && data.runId === runId && !stopped) {
      const retained = data.type === 'error' ? data.recovery?.state : data.state;
      const source =
        data.type === 'error'
          ? data.recovery?.telemetry
          : 'telemetry' in data
            ? data.telemetry
            : undefined;
      if (retained && (!latestState || retained.revision > latestState.revision)) {
        latestState = retained;
        acceptedRun = runId;
        if (source) latestTelemetry = { ...source, runId, replacementId: retained.replacementId };
      }
    }
    const captureAction = completion.type === 'capture-design' ? captureIntent?.action : undefined;
    const current = completion.generation === generation && data.runId === runId && !stopped;
    try {
      if (current) {
        if (data.type === 'error' || (data.type === 'manual-result' && data.status === 'rejected'))
          rejectedTicket = completion.ticket;
        if (completion.targetTicket === targetTicket) targetTicket = undefined;
        for (const key of ['mutation', 'nutrients', 'climate'] as const)
          if (pendingSettings[key] && pendingSettings[key]!.ticket <= completion.ticket) {
            delete pendingSettings[key];
            delete settingsEdits[key];
          }
        if (pendingSpeed && pendingSpeed.ticket <= completion.ticket) pendingSpeed = null;
        if (pendingExtinction && pendingExtinction.ticket <= completion.ticket)
          pendingExtinction = null;
        if (
          data.type === 'error' &&
          (typeof data.message !== 'string' || data.message.length > 512)
        )
          throw new Error('Invalid worker error payload.');
        if (
          data.type === 'manual-result' &&
          (!['applied', 'no-op', 'rejected'].includes(data.status) ||
            !integer(data.completedTick, 0, 1e9) ||
            (data.rowSequence !== null && !integer(data.rowSequence, 1, Number.MAX_SAFE_INTEGER)))
        )
          throw new Error('Invalid manual completion payload.');
        const observation = data.type === 'error' ? data.recovery?.state : data.state;
        if (
          observation &&
          (completion.type === 'start' || completion.type === 'load') &&
          (!validSettings(observation.settings) || !integer(observation.world?.stats?.tick, 0, 1e9))
        )
          throw new Error('Invalid lifecycle terminal.');
        const source =
          data.type === 'error'
            ? data.recovery?.telemetry
            : data.type === 'saved' ||
                data.type === 'measurement-exported' ||
                data.type === 'design-captured'
              ? undefined
              : data.telemetry;
        if (data.type === 'error' && data.fatal) {
          stop();
          establishedRun = null;
        } else if (observation) {
          if (
            (completion.type === 'start' &&
              (data.type === 'control' || (data.type === 'error' && data.recovery))) ||
            (completion.type === 'load' &&
              (data.type === 'loaded' ||
                (data.type === 'error' && data.code === 'load-failed' && data.recovery)))
          ) {
            establishedRun = runId;
            stopped = false;
            if (data.type !== 'error') {
              updates = 0;
            }
          }
          if (establishedRun === runId) {
            if (observation.display.epoch >= acknowledgedView.epoch)
              acknowledgedView = { ...observation.display };
            if (acknowledgedView.epoch === desiredView.epoch) text('render-pending', '');
            accept(
              observation,
              source,
              data.type !== 'error' &&
                !(data.type === 'manual-result' && data.status === 'rejected'),
            );
            if (
              (data.type === 'error' ||
                (data.type === 'manual-result' && data.status === 'rejected')) &&
              completion.type === 'settings'
            )
              renderSettings(observation.settings);
          }
        } else if (completion.type === 'load' || completion.type === 'start') {
          stop();
          telemetry.update({ status: 'unavailable' });
        }
        if (data.type === 'design-captured') completeCapture(data);
        if (data.type === 'manual-result' && completion.placement && data.status === 'applied')
          notice('Organism placed. Playback is unchanged.');
        if (data.type === 'error') {
          if (completion.type === 'capture-design') {
            captureIntent = null;
            updateCapture();
            if (captureAction === 'library') libraryStatus(data.message);
          }
          if (completion.type === 'run-to') {
            if (!targetTicket) text('target-status', data.message);
          } else notice(data.message);
        } else if (data.type === 'loaded')
          notice('World restored. Playback follows Pause on extinction. Imported painted field.');
        else if (
          data.type === 'manual-result' &&
          ['clear-walls', 'regenerate-walls'].includes(completion.type) &&
          data.status !== 'rejected'
        ) {
          if (!validTerrain(data.terrain)) throw new Error('Invalid completed wall recipe.');
          if (
            completion.echo?.recipe &&
            !sameTerrain(data.terrain, completion.echo.recipe as TerrainRecipe)
          )
            throw new Error('Completed wall recipe differs from the submitted recipe.');
          notice(
            data.status === 'no-op'
              ? 'Walls unchanged; no manual entry recorded.'
              : 'Wall action applied. Living cells protected; food handling recorded in manual history.',
          );
        } else if (
          data.type === 'manual-result' &&
          ['refuge-mode', 'paint-refuge', 'clear-refuges'].includes(completion.type) &&
          data.status !== 'rejected'
        )
          notice(
            data.status === 'no-op'
              ? 'Painted temperature unchanged; no manual entry recorded.'
              : 'Painted temperature action applied; consequences begin on the next ecological tick.',
          );
        else if (data.type === 'manual-result' && data.status === 'rejected')
          notice('Worker rejected this manual action; no successful effect recorded.');
      }
      if (completion.checkpoint) {
        if (data.type === 'saved' && current) {
          if (completion.checkpoint === 'comparison')
            comparisons.saved(data.text, data.completedTick);
          else checkpoints.saved(data.text);
        } else
          captureFailed(
            completion.checkpoint,
            data.type === 'error'
              ? data.message
              : 'Checkpoint capture cancelled: the world changed.',
          );
      } else if (data.type === 'saved' || (data.type === 'measurement-exported' && current)) {
        try {
          download(data);
          if (current)
            notice(
              data.type === 'saved'
                ? 'World saved, including every organism and its ancestry.'
                : 'Download requested: retained observations as of completed tick ' +
                    data.completedTick +
                    '.',
            );
        } catch {
          if (current) notice('Could not download this world. Try saving again.');
        }
      }
    } catch (error) {
      rejectedTicket = completion.ticket;
      if (completion.type === 'capture-design') {
        const action = captureAction;
        captureIntent = null;
        updateCapture();
        if (action === 'library')
          libraryStatus(
            error instanceof Error ? error.message : 'Could not capture the complete design.',
          );
      }
      if (current && completion.type === 'settings' && latestState)
        renderSettings(latestState.settings);
      if (current)
        notice(
          error instanceof Error ? error.message.slice(0, 512) : 'Could not complete this action.',
        );
    } finally {
      if (completion.type === 'end-stroke' && closeLease?.strokeId === completion.strokeId)
        closeLease = null;
      posted = null;
      availability();
      pump();
      releaseDiscard();
    }
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
        displayedLineage = pendingFrame.state.world.lineage;
        displayedLineageReplacement = pendingFrame.state.replacementId;
        pendingFrame = null;
      }
      const anchor =
        tool === 'plant'
          ? (touchAnchor ?? (hover ? point(canvas, camera, hover.x, hover.y) : null))
          : null;
      const ghost =
        anchor && validGenome(blueprint)
          ? placementGhost(frame!, blueprint, anchor.x, anchor.y)
          : undefined;
      text(
        'placement-feedback',
        tool !== 'plant'
          ? ''
          : !ghost
            ? 'Move over the habitat to preview placement.'
            : `${ghost.blocked ? 'Blocked' : 'Valid'} in displayed tick ${frame!.stats.tick} at ${anchor!.x}, ${anchor!.y}. Worker rechecks on placement.${touchAnchor ? ' Tap this anchor again to place.' : ''}`,
      );
      draw(
        canvas,
        buffer,
        frame!,
        camera,
        thermal,
        displayedSelected,
        ghost,
        displayedLineage
          ? lineageView.highlighted(displayedLineage, displayedLineageReplacement)
          : undefined,
      );
      dirty = false;
      freshness();
      if (consumed) {
        const token = consumed;
        heldDisplay = null;
        displayWatermark = token.sequence;
        postInternal({
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
  renderTerrain();
  reset(true);
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
    cancelReset(false);
    captureIntent = null;
    acceptedObservationRun = undefined;
    observationTick = undefined;
    cancelReplacement('view disposed.');
    cancelDialog('View disposed.');
    libraryRequest++;
    clearTimeout(fileTimer);
    clearTimeout(dialogTimer);
    clearTimeout(exportTimer);
    blueprintReader?.abort();
    library.dispose();
    checkpoints.dispose();
    comparisons.dispose();
    for (const cleanup of cleanups) cleanup();
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    candidate = undefined;
    librarySnapshot = { count: 0, rows: [] };
    telemetry.dispose();
    lineageView.dispose();
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
