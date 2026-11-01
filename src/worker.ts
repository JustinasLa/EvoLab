import { shadeTool, validShadeBrush } from './shade';
import { Ecosystem } from './ecosystem';
import { EventRecorder } from './event-journal';
import { DEFAULT_TERRAIN, resolvedTerrainSeed, validTerrain } from './terrain';
import { serializeMeasurements } from './measurement-export';
import { refugeTool, validRefugeBrush, refugeSummary } from './refuges';
import {
  WIDTH,
  commandEcho,
  HEIGHT,
  WORLD_MAX_BYTES,
  STROKE_COMMAND_CAPACITY,
  validSettings,
  knownSettings,
  validGenome,
  integer,
  index,
  observedSettings,
  observedOrganism,
  nextSessionId,
  type Settings,
  type Speed,
  type DisplayView,
  type TargetRun,
  type TickRate,
  type ControlState,
  type WorldPresentation,
  type TelemetrySnapshot,
  type ExtinctionSummary,
  type PaintTool,
  type ManualOperation,
  type WorkerResponse,
  type StrokeTool,
  type RefugeBrush,
  type ShadeBrush,
} from './model';

export interface Scope {
  postMessage: (data: WorkerResponse, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
}
export function startWorker(
  scope: Scope,
  defer: (callback: () => void, delay: number) => unknown = (callback, delay) =>
    setTimeout(callback, delay),
  now: () => number = () => performance.now(),
): () => void {
  let world: Ecosystem | undefined;
  let events: EventRecorder | undefined;
  let alive = true,
    paused = false,
    queued = false,
    failed = false;
  let speed: Speed = 4,
    runId = -1,
    selected = 0,
    commandId = 0,
    replacementId = 0,
    revision = 0;
  let pauseOnExtinction = true,
    extinction: ExtinctionSummary | null = null;
  let target: TargetRun | null = null;
  let view: DisplayView = { epoch: 0, enabled: true, visible: true };
  let progressOwner: { runId: number; sequence: number } | null = null;
  let displayOwner: { runId: number; sequence: number } | null = null;
  let progressSequence = 0,
    displaySequence = 0;
  let progressDirty = false,
    telemetryDirty = false,
    displayDirty = false;
  let forceProgress = false,
    settled = false,
    interactive = false;
  let progressAt = -Infinity,
    telemetryAt = -Infinity,
    displayAt = -Infinity;
  let endpoints: { time: number; ticks: number }[] = [],
    completedTicks = 0;
  let gap: TickRate | null = null;
  let activeCommand: any;
  let stroke: {
    id: number;
    tool: StrokeTool;
    brush?: RefugeBrush | ShadeBrush;
    radius: number;
    sequence: number | null;
    count: number;
  } | null = null;
  const next = nextSessionId;
  const context = (): 'visible' | 'hidden' => (view.visible ? 'visible' : 'hidden');
  function resetRate(): void {
    endpoints = paused || failed ? [] : [{ time: now(), ticks: completedTicks }];
    gap = null;
  }
  function measure(): void {
    const time = now(),
      last = endpoints.at(-1);
    if (!Number.isFinite(time) || !last || time <= last.time) {
      endpoints = Number.isFinite(time) ? [{ time, ticks: completedTicks }] : [];
      gap = null;
      return;
    }
    const elapsed = time - last.time,
      count = completedTicks - last.ticks;
    if (elapsed > 2000) {
      gap = {
        value: (count * 1000) / elapsed,
        elapsedMs: elapsed,
        completedTicks: count,
        context: context(),
        status: 'timing-gap',
      };
      endpoints = [{ time, ticks: completedTicks }];
      return;
    }
    gap = null;
    if (endpoints.length > 1 && Math.floor(time / 100) === Math.floor(last.time / 100))
      endpoints[endpoints.length - 1] = { time, ticks: completedTicks };
    else endpoints.push({ time, ticks: completedTicks });
    while (endpoints.length > 2 && endpoints[1].time < time - 5000) endpoints.shift();
    while (endpoints.length > 52) endpoints.shift();
  }
  function rate(): TickRate {
    const first = endpoints[0],
      last = endpoints.at(-1);
    const elapsedMs = first && last ? last.time - first.time : 0;
    const count = first && last ? last.ticks - first.ticks : 0;
    if (paused || failed)
      return { value: null, elapsedMs: 0, completedTicks: 0, context: context(), status: 'paused' };
    if (gap) return { ...gap };
    return {
      value: elapsedMs >= 1000 ? (count * 1000) / elapsedMs : null,
      elapsedMs,
      completedTicks: count,
      context: context(),
      status: elapsedMs >= 1000 ? 'measured' : 'warming',
    };
  }
  let cachedPresentation: WorldPresentation | undefined;
  let cachedRevision = -1,
    cachedSelection = -1;
  function state(): ControlState {
    if (!cachedPresentation || cachedRevision !== revision || cachedSelection !== selected) {
      cachedPresentation = world!.presentation(selected, view.lineage === true);
      if (view.roles) cachedPresentation.roles = world!.roleSnapshot();
      cachedRevision = revision;
      cachedSelection = selected;
    }
    const organism = world!.organisms.get(selected);
    return {
      ...(events ? { journal: events.snapshot() } : {}),
      replacementId,
      revision,
      world: structuredClone(cachedPresentation),
      selected: organism ? observedOrganism(organism) : null,
      perception: world!.perception(),
      settings: observedSettings(world!.settings),
      speed,
      playback: {
        paused,
        pauseOnExtinction,
        extinction: extinction ? { tick: extinction.tick, cause: extinction.cause } : null,
      },
      target: target ? { ...target } : null,
      display: { ...view },
      rate: rate(),
    };
  }
  function telemetry(): TelemetrySnapshot {
    telemetryDirty = false;
    telemetryAt = now();
    return {
      revision,
      tick: world!.tick,
      telemetry: world!.telemetrySnapshot(),
      interventions: world!.interventionSnapshot(),
    };
  }
  function changed(): void {
    revision = next(revision);
    progressDirty = telemetryDirty = displayDirty = true;
  }
  function settle(): void {
    settled = true;
    forceProgress = progressDirty = true;
  }
  function publishProgress(): void {
    if (!alive || !world || failed || progressOwner || !progressDirty) return;
    if (!forceProgress && now() - progressAt < 100) return;
    const forced = forceProgress;
    progressDirty = forceProgress = false;
    progressAt = now();
    progressSequence = next(progressSequence);
    progressOwner = { runId, sequence: progressSequence };
    try {
      scope.postMessage({
        type: 'progress',
        runId,
        sequence: progressSequence,
        state: state(),
        ...(forced || (telemetryDirty && now() - telemetryAt >= 250)
          ? { telemetry: telemetry() }
          : {}),
      });
    } catch (error) {
      progressOwner = null;
      progressDirty = true;
      throw error;
    }
  }
  function publishDisplay(): void {
    if (!alive || !world || failed || displayOwner || !view.visible || !displayDirty) return;
    if (!interactive && (!view.enabled || (!settled && now() - displayAt < 40))) return;
    displayDirty = settled = interactive = false;
    displayAt = now();
    const observation = state(),
      frame = world.display(observation.world);
    displaySequence = next(displaySequence);
    displayOwner = { runId, sequence: displaySequence };
    try {
      scope.postMessage(
        {
          type: 'frame',
          runId,
          sequence: displaySequence,
          viewEpoch: view.epoch,
          state: observation,
          frame,
          selectedId: observation.selected?.id ?? 0,
        },
        [
          frame.cells.buffer,
          frame.ids.buffer,
          frame.thermalRefuges.units.buffer,
          frame.shadeHabitats.units.buffer,
        ],
      );
    } catch (error) {
      displayOwner = null;
      displayDirty = true;
      throw error;
    }
  }
  function reconcile(previousPopulation: number): void {
    if (world!.organisms.size) extinction = null;
    else {
      if (previousPopulation && world!.lastDeath) extinction = { ...world!.lastDeath };
      if (pauseOnExtinction) paused = true;
    }
    if (target && (target.status === 'running' || target.status === 'suspended')) {
      if (world!.tick >= target.targetTick) {
        target.status = world!.tick === target.targetTick ? 'reached' : 'cancelled';
        target.stoppedTick = world!.tick;
        paused = true;
      } else if (!world!.organisms.size && pauseOnExtinction) {
        target.status = 'extinct';
        target.stoppedTick = world!.tick;
        paused = true;
      }
    }
    if (paused) {
      resetRate();
      settle();
    }
  }
  function report(
    error: unknown,
    code: Extract<WorkerResponse, { type: 'error' }>['code'],
    responseRun = runId,
    responseCommand?: number,
  ): void {
    const fatal = code === 'fatal';
    cachedPresentation = undefined;
    if (fatal) {
      paused = failed = true;
      if (target?.status === 'running' || target?.status === 'suspended') {
        target.status = 'cancelled';
        target.stoppedTick = world?.tick ?? null;
      }
      resetRate();
    }
    try {
      scope.postMessage({
        type: 'error',
        runId: responseRun,
        ...(responseCommand === undefined ? {} : { commandId: responseCommand }),
        ...(responseCommand !== undefined && activeCommand?.commandId === responseCommand
          ? {
              operation: activeCommand.type,
              ...commandEcho(activeCommand),
              ...(activeCommand.format === undefined ? {} : { format: activeCommand.format }),
              ...(activeCommand.strokeId === undefined ? {} : { strokeId: activeCommand.strokeId }),
            }
          : {}),
        code,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
        ...(fatal
          ? { fatal: true as const }
          : world && !failed && responseRun === runId
            ? { recovery: { state: state(), telemetry: telemetry() } }
            : {}),
      });
    } catch (failure) {
      if (fatal) throw failure;
      report(failure, 'fatal', responseRun, responseCommand);
    }
  }
  function queue(): void {
    if (alive && world && !paused && !failed && !queued) {
      queued = true;
      try {
        defer(tick, target?.status === 'running' ? 0 : 40);
      } catch (error) {
        queued = false;
        throw error;
      }
    }
  }
  function tick(): void {
    queued = false;
    if (!alive || !world || paused || failed) return;
    try {
      reconcile(world.organisms.size);
      if (paused) {
        publishProgress();
        publishDisplay();
        return;
      }
      const began = now();
      for (let count = 0; count < speed; count++) {
        const population = world.organisms.size;
        world.step();
        events?.observe(world);
        completedTicks = next(completedTicks);
        changed();
        reconcile(population);
        if (paused || (target?.status === 'running' && now() - began >= 8)) break;
      }
      if (!paused) measure();
      publishProgress();
      publishDisplay();
      queue();
    } catch (error) {
      report(error, 'fatal');
    }
  }
  function validView(value: any): value is DisplayView {
    return (
      value &&
      integer(value.epoch, 0, Number.MAX_SAFE_INTEGER) &&
      typeof value.enabled === 'boolean' &&
      typeof value.visible === 'boolean' &&
      (value.lineage === undefined || value.lineage === true) &&
      (value.roles === undefined || value.roles === true)
    );
  }
  const coordinates = (value: any): boolean =>
    integer(value.x, 0, WIDTH - 1) && integer(value.y, 0, HEIGHT - 1);
  scope.onmessage = ({ data }) => {
    if (!alive || !data || typeof data !== 'object') return;
    if (data.type === 'flow-ack') {
      const owner =
        data.channel === 'display'
          ? displayOwner
          : data.channel === 'progress'
            ? progressOwner
            : null;
      if (!owner || data.runId !== owner.runId || data.sequence !== owner.sequence) return;
      try {
        if (data.channel === 'display') {
          displayOwner = null;
          publishDisplay();
        } else {
          progressOwner = null;
          publishProgress();
        }
      } catch (error) {
        report(error, 'fatal');
      }
      return;
    }
    if (
      !integer(data.runId, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(data.commandId, 1, Number.MAX_SAFE_INTEGER) ||
      data.requestId !== undefined ||
      typeof data.type !== 'string'
    )
      return;
    if (data.commandId <= commandId) return;
    activeCommand = data;
    commandId = data.commandId;
    const replacement = data.type === 'start' || data.type === 'load';
    if (replacement ? data.runId <= runId : data.runId !== runId) {
      report('Command belongs to an inactive world.', 'stale-run', data.runId, data.commandId);
      return;
    }
    if (
      failed &&
      !replacement &&
      !['save', 'export-measurements', 'snapshot', 'inspect', 'end-stroke'].includes(data.type)
    ) {
      report('The ecosystem worker is stopped.', 'invalid-command', runId, commandId);
      return;
    }
    let errorCode: Extract<WorkerResponse, { type: 'error' }>['code'] = 'invalid-command';
    let completed = false,
      effectApplied = false;
    const complete = (response: WorkerResponse): void => {
      scope.postMessage({
        ...commandEcho(data),
        ...response,
        operation: data.type,
      } as WorkerResponse);
      completed = true;
    };
    let manualResult:
      | {
          status: 'applied' | 'no-op' | 'rejected';
          rowSequence: number | null;
          terrain?: typeof DEFAULT_TERRAIN;
          nonzeroCells?: number;
          changedCells?: number;
          saturatedCells?: number;
          detail?: import('./model').TerrainDetail;
        }
      | undefined;
    try {
      if (data.type === 'start') {
        if (
          !validSettings(data.settings) ||
          !validView(data.display) ||
          data.display.epoch < view.epoch
        )
          throw new Error('Invalid ecosystem settings or display view.');
        const terrain = data.terrain === undefined ? DEFAULT_TERRAIN : data.terrain;
        if (!validTerrain(terrain)) throw new Error('Invalid wall recipe.');
        const candidate = new Ecosystem(observedSettings(data.settings), true, { terrain });
        world = candidate;
        events = undefined;
        runId = data.runId;
        replacementId = commandId;
        view = {
          epoch: data.display.epoch,
          enabled: data.display.enabled,
          visible: data.display.visible,
          ...(data.display.lineage ? { lineage: true as const } : {}),
          ...(data.display.roles ? { roles: true as const } : {}),
        };
        if (view.roles) world.observeRoles();
        paused = failed = false;
        selected = 0;
        extinction = null;
        stroke = null;
        target = null;
        displayDirty = interactive = settled = false;
        changed();
        resetRate();
        settle();
        effectApplied = true;
        complete({
          type: 'control',
          runId,
          commandId,
          state: state(),
          telemetry: telemetry(),
        });
      } else if (data.type === 'load') {
        events = undefined;
        if (typeof data.text !== 'string') throw new Error('Invalid world text.');
        runId = data.runId;
        failed = false;
        stroke = null;
        displayDirty = interactive = settled = false;
        resetRate();
        let restored: Ecosystem;
        try {
          restored = Ecosystem.load(data.text);
        } catch (error) {
          if (world && !failed) {
            displayDirty = true;
            settle();
          }
          report(error, 'load-failed', runId, commandId);
          publishDisplay();
          publishProgress();
          return;
        }
        world = restored;
        if (view.roles) world.observeRoles();
        replacementId = commandId;
        failed = paused = false;
        selected = 0;
        target = null;
        extinction = world.organisms.size ? null : { tick: world.tick, cause: 'empty-import' };
        changed();
        reconcile(world.organisms.size);
        resetRate();
        settle();
        effectApplied = true;
        complete({
          type: 'loaded',
          runId,
          commandId,
          state: state(),
          telemetry: telemetry(),
        });
      } else {
        if (!world) throw new Error('No active ecosystem.');
        const priorInteractive = interactive;
        let mutation = true,
          exactTelemetry = false;
        switch (data.type) {
          case 'event-recording':
            if (typeof data.enabled !== 'boolean') throw new Error('Invalid event recording mode.');
            events = data.enabled ? new EventRecorder(world) : undefined;
            break;
          case 'event-replay':
            if (!events || !integer(data.eventId, 1, Number.MAX_SAFE_INTEGER))
              throw new Error('No recorded event is available.');
            complete({
              type: 'event-evidence',
              operation: 'event-replay',
              runId,
              commandId,
              state: state(),
              evidence: events.replay(data.eventId),
            });
            return;
          case 'pause':
            paused = true;
            if (target?.status === 'running') {
              target.status = 'suspended';
              target.stoppedTick = world.tick;
            }
            resetRate();
            settle();
            exactTelemetry = true;
            break;
          case 'resume':
            paused = false;
            if (target?.status === 'suspended') {
              target.status = 'running';
              target.stoppedTick = null;
            }
            reconcile(world.organisms.size);
            resetRate();
            break;
          case 'step': {
            if (!paused) throw new Error('Pause before stepping.');
            const population = world.organisms.size;
            errorCode = 'fatal';
            world.step();
            events?.observe(world);
            reconcile(population);
            interactive = view.visible;
            exactTelemetry = true;
            break;
          }
          case 'run-to':
            errorCode = 'invalid-target';
            if (!integer(data.targetTick, 0, 1e9))
              throw new Error('Choose an absolute whole tick from 0 to 1000000000.');
            if (target?.status === 'running' || target?.status === 'suspended') {
              errorCode = 'target-busy';
              throw new Error('Cancel the active target before starting another.');
            }
            if (data.targetTick < world.tick)
              throw new Error('That absolute tick has already passed.');
            target = {
              id: commandId,
              fromTick: world.tick,
              targetTick: data.targetTick,
              status: 'running',
              stoppedTick: null,
            };
            paused = false;
            reconcile(world.organisms.size);
            resetRate();
            exactTelemetry = true;
            break;
          case 'cancel-target':
            errorCode = 'invalid-target';
            if (
              !integer(data.targetId, 1, Number.MAX_SAFE_INTEGER) ||
              !target ||
              target.id !== data.targetId ||
              (target.status !== 'running' && target.status !== 'suspended')
            )
              throw new Error('This target is no longer active.');
            target.status = 'cancelled';
            target.stoppedTick = world.tick;
            paused = true;
            resetRate();
            settle();
            exactTelemetry = true;
            break;
          case 'speed':
            if (![1, 4, 12].includes(data.value)) throw new Error('Invalid speed.');
            speed = data.value;
            resetRate();
            break;
          case 'pause-on-extinction':
            if (typeof data.value !== 'boolean') throw new Error('Invalid extinction preference.');
            pauseOnExtinction = data.value;
            reconcile(world.organisms.size);
            exactTelemetry = paused;
            break;
          case 'display-view':
            if (!validView(data.view) || data.view.epoch <= view.epoch)
              throw new Error('Invalid or obsolete display view.');
            view = {
              epoch: data.view.epoch,
              enabled: data.view.enabled,
              visible: data.view.visible,
              ...(data.view.lineage ? { lineage: true as const } : {}),
              ...(data.view.roles ? { roles: true as const } : {}),
            };
            if (view.roles) world.observeRoles();
            if (!view.visible) interactive = false;
            resetRate();
            settled = true;
            exactTelemetry = true;
            break;
          case 'begin-stroke':
            if (stroke) throw new Error('A brush stroke is already open.');
            if (
              !integer(data.strokeId, 1, Number.MAX_SAFE_INTEGER) ||
              (!['food', 'wall', 'erase'].includes(data.tool) &&
                !validRefugeBrush(data) &&
                !validShadeBrush(data)) ||
              (refugeTool(data.tool) && !world.thermalRefuges.enabled) ||
              (shadeTool(data.tool) && !world.shadeHabitats.enabled) ||
              !integer(data.radius, 0, 8)
            )
              throw new Error('Invalid brush stroke.');
            stroke = {
              id: data.strokeId,
              tool: data.tool,
              radius: data.radius,
              sequence: null,
              count: 0,
              ...(refugeTool(data.tool) || shadeTool(data.tool)
                ? {
                    brush: {
                      rulesVersion: 1 as const,
                      tool: data.tool,
                      radius: data.radius,
                      units: data.units,
                    },
                  }
                : {}),
            };
            manualResult = { status: 'no-op', rowSequence: null };
            mutation = false;
            break;
          case 'end-stroke':
            if (!integer(data.strokeId, 1, Number.MAX_SAFE_INTEGER))
              throw new Error('Invalid stroke closure.');
            manualResult = {
              status: stroke?.id === data.strokeId ? 'applied' : 'no-op',
              rowSequence: null,
            };
            if (stroke?.id === data.strokeId) stroke = null;
            mutation = false;
            break;
          case 'mutation-policy': {
            stroke = null;
            const sequence = world.changeMutationPolicy(data.policy);
            manualResult = {
              status: sequence === null ? 'no-op' : 'applied',
              rowSequence: sequence,
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'settings': {
            stroke = null;
            const sequence = world.changeSettings(data.settings);
            manualResult = {
              status: sequence === null ? 'no-op' : 'applied',
              rowSequence: sequence,
              ...(data.type === 'refuge-mode'
                ? { nonzeroCells: world.thermalRefuges.nonzeroCells }
                : {}),
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'clear-walls':
          case 'regenerate-walls': {
            stroke = null;
            const action = data.type === 'clear-walls' ? 'clear' : 'regenerate';
            if (
              data.action !== action ||
              (action === 'clear'
                ? data.recipe !== undefined || data.resolvedSeed !== undefined
                : !validTerrain(data.recipe) ||
                  data.resolvedSeed !== resolvedTerrainSeed(data.recipe, world.settings.seed))
            )
              throw new Error('Invalid wall action payload or resolved terrain seed.');
            const outcome = world.changeTerrain(
              action,
              action === 'regenerate' ? data.recipe : undefined,
            );
            manualResult = {
              status: outcome.rowSequence === null ? 'no-op' : 'applied',
              rowSequence: outcome.rowSequence,
              ...(data.type === 'clear-walls' || data.type === 'regenerate-walls'
                ? {
                    terrain: { ...world.terrain },
                    detail: (outcome as { detail: import('./model').TerrainDetail }).detail,
                  }
                : {}),
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'refuge-mode': {
            stroke = null;
            if (data.rulesVersion !== 1 || typeof data.enabled !== 'boolean')
              throw new Error('Invalid painted temperature mode payload.');
            const sequence = world.changeRefugeMode(data.enabled);
            manualResult = {
              status: sequence === null ? 'no-op' : 'applied',
              rowSequence: sequence,
              ...(data.type === 'refuge-mode'
                ? { nonzeroCells: world.thermalRefuges.nonzeroCells }
                : {}),
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'clear-refuges': {
            stroke = null;
            if (data.rulesVersion !== 1)
              throw new Error('Invalid painted temperature clear payload.');
            const outcome = world.clearRefuges();
            manualResult = {
              status: outcome.rowSequence === null ? 'no-op' : 'applied',
              ...outcome,
              rowSequence: outcome.rowSequence,
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'paint-refuge': {
            if (!validRefugeBrush(data) || !coordinates(data))
              throw new Error('Invalid painted temperature payload.');
            if (
              !stroke ||
              stroke.id !== data.strokeId ||
              !stroke.brush ||
              stroke.tool !== data.tool ||
              stroke.radius !== data.radius ||
              stroke.brush.units !== data.units ||
              stroke.count >= STROKE_COMMAND_CAPACITY
            )
              throw new Error('Rejected closed or exhausted temperature stroke.');
            const outcome = world.paintRefuge(
              stroke.brush as RefugeBrush,
              data.x,
              data.y,
              stroke.sequence,
            );
            stroke.count++;
            if (outcome.rowSequence !== null) stroke.sequence = outcome.rowSequence;
            manualResult = {
              status: outcome.rowSequence === null ? 'no-op' : 'applied',
              ...outcome,
              rowSequence: outcome.rowSequence,
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'shade-mode': {
            stroke = null;
            if (data.rulesVersion !== 1 || typeof data.enabled !== 'boolean')
              throw new Error('Invalid painted shade mode payload.');
            const sequence = world.changeShadeMode(data.enabled);
            manualResult = {
              status: sequence === null ? 'no-op' : 'applied',
              rowSequence: sequence,
              ...(data.type === 'shade-mode'
                ? { nonzeroCells: world.shadeHabitats.nonzeroCells }
                : {}),
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'clear-shade': {
            stroke = null;
            if (data.rulesVersion !== 1) throw new Error('Invalid painted shade clear payload.');
            const outcome = world.clearShade();
            manualResult = {
              status: outcome.rowSequence === null ? 'no-op' : 'applied',
              ...outcome,
              rowSequence: outcome.rowSequence,
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'paint-shade': {
            if (!validShadeBrush(data as unknown) || !coordinates(data))
              throw new Error('Invalid painted shade payload.');
            if (
              !stroke ||
              stroke.id !== data.strokeId ||
              !stroke.brush ||
              stroke.tool !== data.tool ||
              stroke.radius !== data.radius ||
              stroke.brush.units !== data.units ||
              stroke.count >= STROKE_COMMAND_CAPACITY
            )
              throw new Error('Rejected closed or exhausted shade stroke.');
            const outcome = world.paintShade(
              stroke.brush as ShadeBrush,
              data.x,
              data.y,
              stroke.sequence,
            );
            stroke.count++;
            if (outcome.rowSequence !== null) stroke.sequence = outcome.rowSequence;
            manualResult = {
              status: outcome.rowSequence === null ? 'no-op' : 'applied',
              ...outcome,
              rowSequence: outcome.rowSequence,
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'inspect':
            if (!coordinates(data)) throw new Error('Invalid inspection coordinates.');
            selected = world.occupied[index(data.x, data.y)];
            world.selectPerception(selected);
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          case 'paint': {
            if (
              !coordinates(data) ||
              !integer(data.radius, 0, 8) ||
              !['food', 'wall', 'erase', 'plant'].includes(data.tool) ||
              !validGenome(data.genome)
            )
              throw new Error('Invalid paint command.');
            if (data.tool === 'plant') stroke = null;
            else if (
              !stroke ||
              stroke.id !== data.strokeId ||
              stroke.tool !== data.tool ||
              stroke.radius !== data.radius ||
              stroke.count >= STROKE_COMMAND_CAPACITY
            )
              throw new Error('Rejected closed or exhausted brush stroke.');
            world.requireInterventionCapacity(data.tool !== 'plant' && stroke!.sequence !== null);
            if (stroke) stroke.count++;
            const population = world.organisms.size;
            const outcome = world.paint(data.tool, data.x, data.y, data.radius, data.genome);
            if (data.tool === 'plant' && !outcome.placement)
              throw new Error(
                'Placement blocked by a wall, organism or population limit. Nothing was placed; choose another position.',
              );
            let sequence: number | null = null;
            if (outcome.placement)
              sequence = world.appendIntervention({ kind: 'placement', detail: outcome.placement });
            else if (stroke) {
              sequence = world.recordPaint(
                outcome,
                stroke.tool as PaintTool,
                stroke.radius,
                data.x,
                data.y,
                stroke.sequence,
              );
              stroke.sequence = sequence;
              if (!outcome.changedBrushCells && !outcome.removedOrganisms) sequence = null;
            }
            reconcile(population);
            manualResult = {
              status: sequence === null ? 'no-op' : 'applied',
              rowSequence: sequence,
              ...(data.type === 'refuge-mode'
                ? { nonzeroCells: world.thermalRefuges.nonzeroCells }
                : {}),
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'shock': {
            stroke = null;
            if (!['cold', 'heat'].includes(data.kind) || world.tick + 900 > 1e9)
              throw new Error('Invalid climate shock.');
            const before = { offset: world.eventOffset, until: world.eventUntil };
            world.requireInterventionCapacity();
            world.shock(data.kind);
            const after = { offset: world.eventOffset, until: world.eventUntil };
            const sequence =
              before.offset !== after.offset || before.until !== after.until
                ? world.appendIntervention({
                    kind: 'shock',
                    detail: { kind: data.kind, before, after },
                  })
                : null;
            manualResult = {
              status: sequence === null ? 'no-op' : 'applied',
              rowSequence: sequence,
              ...(data.type === 'refuge-mode'
                ? { nonzeroCells: world.thermalRefuges.nonzeroCells }
                : {}),
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'snapshot':
            if (typeof data.display !== 'boolean') throw new Error('Invalid snapshot request.');
            mutation = false;
            interactive ||= data.display && view.visible;
            exactTelemetry = true;
            break;
          case 'capture-design': {
            if (
              !['organism', 'lineage'].includes(data.source) ||
              !integer(data.sourceId, 1, 1e9) ||
              !integer(data.captureId, 1, Number.MAX_SAFE_INTEGER)
            )
              throw new Error('Invalid design capture source.');
            const organism =
              data.source === 'organism'
                ? world.organisms.get(data.sourceId)
                : [...world.organisms.values()].find((value) => value.species === data.sourceId);
            if (!organism)
              throw new Error(
                'The design source is no longer alive. Choose a current organism or common body.',
              );
            complete({
              type: 'design-captured',
              operation: 'capture-design',
              runId,
              commandId,
              captureId: data.captureId,
              source: data.source,
              sourceId: data.sourceId,
              genome: structuredClone(organism.genome),
              completedTick: world.tick,
              seed: world.settings.seed,
              state: state(),
            });
            return;
          }
          case 'save': {
            errorCode = 'save-failed';
            const text = JSON.stringify(world.save()),
              byteLength = new TextEncoder().encode(text).byteLength;
            if (byteLength > WORLD_MAX_BYTES)
              throw new Error('World file exceeds 2.5 MB. Nothing was downloaded.');
            complete({
              type: 'saved',
              runId,
              commandId,
              state: state(),
              text,
              byteLength,
              completedTick: world.tick,
              seed: world.settings.seed,
            });
            return;
          }
          case 'export-measurements': {
            const source = world.measurements(stroke?.sequence ?? null);
            const payload = serializeMeasurements(source, data.format);
            complete({
              type: 'measurement-exported',
              operation: 'export-measurements',
              runId,
              commandId,
              state: state(),
              completedTick: source.snapshot.completedTick,
              seed: source.snapshot.seed,
              format: data.format,
              ...payload,
            });
            return;
          }
          default:
            throw new Error('Unknown ecosystem command.');
        }
        effectApplied = true;
        if (data.type !== 'step' && mutation && data.type !== 'event-recording')
          events?.observe(world, true);
        if (manualResult?.status === 'no-op') {
          mutation = false;
          interactive = priorInteractive;
          exactTelemetry = false;
        }
        if (mutation) changed();
        if (interactive) displayDirty = true;
        const observation = state();
        const history = exactTelemetry ? { telemetry: telemetry() } : {};
        if (manualResult)
          complete({
            type: 'manual-result',
            operation: data.type as ManualOperation,
            runId,
            commandId,
            state: observation,
            ...history,
            ...manualResult,
            completedTick: world.tick,
            ...(data.strokeId === undefined ? {} : { strokeId: data.strokeId }),
          });
        else complete({ type: 'control', runId, commandId, state: observation, ...history });
      }
      publishDisplay();
      publishProgress();
      queue();
    } catch (error) {
      if (completed || effectApplied)
        report(
          new Error(
            'The action completed, but publishing or scheduling failed. World preserved; import a world or reseed to recover. ' +
              (error instanceof Error ? error.message : String(error)),
          ),
          'fatal',
        );
      else {
        if (world) events?.observe(world, true);
        if (data.type === 'start' && world) {
          runId = data.runId;
          stroke = null;
          failed = false;
        }
        report(error, errorCode, data.runId, data.commandId);
      }
    }
  };
  return () => {
    alive = false;
    scope.onmessage = null;
    world = undefined;
    events = undefined;
    target = null;
    progressOwner = displayOwner = null;
    endpoints = [];
    progressDirty = telemetryDirty = displayDirty = forceProgress = settled = interactive = false;
  };
}
if (typeof self !== 'undefined' && typeof document === 'undefined')
  startWorker(self as unknown as Scope);
