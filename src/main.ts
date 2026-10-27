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
  type Frame,
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
  createLibrary,
  libraryCandidate,
  projectGenome,
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

export function mount(root: HTMLElement, worker: Worker): () => void {
  root.innerHTML = markup;
  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const captureButton = document.createElement('button');
  captureButton.id = 'capture-selected';
  captureButton.textContent = 'Capture selected organism';
  captureButton.disabled = true;
  const captureStatus = document.createElement('p');
  captureStatus.id = 'capture-status';
  captureStatus.className = 'muted';
  captureStatus.textContent = 'Inspect an organism to capture its last received genotype.';
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
  let blueprintName = BLUEPRINT_DEFAULT_NAME,
    blueprintDescription = '',
    designRevision = 0,
    blueprintRequest = 0;
  let acceptedObservationRun: number | undefined;
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
    get(id).textContent = value;
  };
  const notice = (message: string): void => text('notice', message);
  const send = (data: object): void => worker.postMessage(data);
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
      Number.isSafeInteger(frame?.stats.tick) &&
      frame!.stats.tick >= 0;
    if (!eligible && document.activeElement === captureButton) {
      if (!get('organism-panel').hidden && get<HTMLDetailsElement>('specimen-details').open)
        get('specimen-details').querySelector('summary')!.focus();
      else get('organism-tab').focus();
    }
    captureButton.disabled = !eligible;
    const busy = libraryBusy() || !!candidate;
    captureButton.setAttribute('aria-disabled', String(busy));
    captureStatus.textContent = eligible
      ? busy
        ? 'Library busy or an unsaved blueprint is pending. Capture is not started; playback is unchanged.'
        : 'Captures the last received genotype and observation tick, not fitness or living identity.'
      : 'Inspect an organism after the current world response to capture it.';
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
    cancelReplacement('the design or world changed.');
    designRevision++;
  }
  function invalidateObservation(): void {
    acceptedObservationRun = undefined;
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
    get('library-candidate').hidden = !candidate;
    text('library-candidate-name', candidate?.blueprint.name ?? '');
    get('library-candidate-preview').innerHTML = candidate
      ? genomeSvg(candidate.blueprint.genome)
      : '';
    get<HTMLButtonElement>('library-replace').disabled = !entry || !candidate;
    updateCapture();
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
      if (selection === librarySelection && librarySelected === undefined)
        librarySelected = snapshot.rows.find((row) => row.kind === 'valid')?.id;
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
      const id = await library.mutate(action);
      if (!alive || request !== libraryRequest) return;
      if (selection === librarySelection) {
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
    invalidateObservation();
    paused = true;
    text('pause', '▶ Resume');
    get<HTMLButtonElement>('step').disabled = true;
    text('run-state', 'STOPPED');
    root.classList.add('paused');
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
    invalidateDesign();
    blueprint = projectGenome(genome);
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
    settings = next;
    settingsEdits = {};
    invalidateObservation();
    runId++;
    telemetry.reset();
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
    invalidateDesign();
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
    const current = (): boolean =>
      alive &&
      request === blueprintRequest &&
      worldRun === runId &&
      (!designer || (!!intent && replacementCurrent(intent)));
    const failed = (message: string): void => {
      if (!current()) return;
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
      if (current()) cancelReplacement('read timed out.');
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
      } catch (error) {
        failed((error as Error).message);
      }
    };
    reader.onerror = () => failed('Could not read this blueprint. Choose a readable JSON file.');
    reader.onabort = () => {
      if (current()) failed('Blueprint read cancelled.');
    };
    reader.onloadend = () => {
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
    try {
      stageCandidate(
        libraryCandidate(selected!.genome, speciesName(selected!.genome), '', {
          captureTick: frame!.stats.tick,
        }),
        true,
      );
      void writeLibrary({ type: 'create', candidate: candidate! });
    } catch (error) {
      libraryStatus(libraryMessage(error));
    }
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
      copyDesign(selected.genome);
      notice('Anatomy copied. Edit it, then place it in the world.');
    }
    if ((event.target as HTMLElement).closest('#export-organism-blueprint') && selected)
      exportBlueprint(selected.genome, speciesName(selected.genome), '');
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
      if (file.size > WORLD_MAX_BYTES) throw new Error('World file exceeds 2.5 MB.');
      const text = await file.text();
      if (alive) {
        settingsEdits = {};
        invalidateObservation();
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
      (event.target instanceof HTMLElement &&
        !!event.target.closest('#local-library, #library-dialog, #capture-selected')) ||
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
    if (!stopped) acceptedObservationRun = runId;
    updateCapture();
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
      telemetry.reset();
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
    acceptedObservationRun = undefined;
    cancelReplacement('view disposed.');
    cancelDialog('View disposed.');
    libraryRequest++;
    clearTimeout(fileTimer);
    clearTimeout(dialogTimer);
    clearTimeout(exportTimer);
    blueprintReader?.abort();
    library.dispose();
    for (const cleanup of cleanups) cleanup();
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    candidate = undefined;
    librarySnapshot = { count: 0, rows: [] };
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
