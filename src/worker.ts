import { Ecosystem } from './ecosystem';
import { serializeMeasurements } from './measurement-export';
import {
  WIDTH,
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
  type TelemetrySnapshot,
  type ExtinctionSummary,
  type PaintTool,
  type ManualOperation,
  type WorkerResponse,
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
    tool: PaintTool;
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
  function state(): ControlState {
    const organism = world!.organisms.get(selected);
    return {
      replacementId,
      revision,
      world: world!.presentation(),
      selected: organism ? observedOrganism(organism) : null,
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
        [frame.cells.buffer, frame.ids.buffer],
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
      typeof value.visible === 'boolean'
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
    let completed = false;
    const complete = (response: WorkerResponse): void => {
      scope.postMessage({ ...response, operation: data.type } as WorkerResponse);
      completed = true;
    };
    let manualResult:
      { status: 'applied' | 'no-op' | 'rejected'; rowSequence: number | null } | undefined;
    try {
      if (data.type === 'start') {
        if (
          !validSettings(data.settings) ||
          !validView(data.display) ||
          data.display.epoch < view.epoch
        )
          throw new Error('Invalid ecosystem settings or display view.');
        const candidate = new Ecosystem(observedSettings(data.settings));
        world = candidate;
        runId = data.runId;
        replacementId = commandId;
        view = {
          epoch: data.display.epoch,
          enabled: data.display.enabled,
          visible: data.display.visible,
        };
        paused = failed = false;
        selected = 0;
        extinction = null;
        stroke = null;
        target = null;
        displayDirty = interactive = settled = false;
        changed();
        resetRate();
        settle();
        complete({
          type: 'control',
          runId,
          commandId,
          state: state(),
          telemetry: telemetry(),
        });
      } else if (data.type === 'load') {
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
        replacementId = commandId;
        failed = paused = false;
        selected = 0;
        target = null;
        extinction = world.organisms.size ? null : { tick: world.tick, cause: 'empty-import' };
        changed();
        reconcile(world.organisms.size);
        resetRate();
        settle();
        complete({
          type: 'loaded',
          runId,
          commandId,
          state: state(),
          telemetry: telemetry(),
        });
      } else {
        if (!world) throw new Error('No active ecosystem.');
        let mutation = true,
          exactTelemetry = false;
        switch (data.type) {
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
            };
            if (!view.visible) interactive = false;
            resetRate();
            settled = true;
            exactTelemetry = true;
            break;
          case 'begin-stroke':
            if (stroke) throw new Error('A brush stroke is already open.');
            if (
              !integer(data.strokeId, 1, Number.MAX_SAFE_INTEGER) ||
              !['food', 'wall', 'erase'].includes(data.tool) ||
              !integer(data.radius, 0, 8)
            )
              throw new Error('Invalid brush stroke.');
            stroke = {
              id: data.strokeId,
              tool: data.tool,
              radius: data.radius,
              sequence: null,
              count: 0,
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
          case 'settings': {
            stroke = null;
            const patch = data.settings;
            if (
              !patch ||
              typeof patch !== 'object' ||
              Array.isArray(patch) ||
              Object.keys(patch).some(
                (key) => !['mutation', 'nutrients', 'climate'].includes(key),
              ) ||
              !validSettings({ ...world.settings, ...patch })
            )
              throw new Error('Invalid live settings.');
            const changes: Partial<
              Record<'mutation' | 'nutrients' | 'climate', { before: number; after: number }>
            > = {};
            for (const key of ['mutation', 'nutrients', 'climate'] as const)
              if (patch[key] !== undefined && patch[key] !== world.settings[key])
                changes[key] = { before: world.settings[key], after: patch[key] };
            let sequence: number | null = null;
            if (Object.keys(changes).length) {
              world.requireInterventionCapacity();
              Object.assign(world.settings, patch);
              sequence = world.appendIntervention({ kind: 'settings', detail: { changes } });
            }
            manualResult = {
              status: sequence === null ? 'no-op' : 'applied',
              rowSequence: sequence,
            };
            interactive ||= paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'inspect':
            if (!coordinates(data)) throw new Error('Invalid inspection coordinates.');
            selected = world.occupied[index(data.x, data.y)];
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
            let sequence: number | null = null;
            if (outcome.placement)
              sequence = world.appendIntervention({ kind: 'placement', detail: outcome.placement });
            else if (stroke) {
              sequence = world.recordPaint(
                outcome,
                stroke.tool,
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
      if (completed)
        report(
          new Error(
            'The action completed, but publishing or scheduling failed. World preserved; import a world or reseed to recover. ' +
              (error instanceof Error ? error.message : String(error)),
          ),
          'fatal',
        );
      else {
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
    target = null;
    progressOwner = displayOwner = null;
    endpoints = [];
    progressDirty = telemetryDirty = displayDirty = forceProgress = settled = interactive = false;
  };
}
if (typeof self !== 'undefined' && typeof document === 'undefined')
  startWorker(self as unknown as Scope);
