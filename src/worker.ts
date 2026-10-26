import { Ecosystem } from './ecosystem';
import {
  WIDTH,
  HEIGHT,
  WORLD_MAX_BYTES,
  validSettings,
  validGenome,
  integer,
  index,
  observedSettings,
  observedOrganism,
  type Settings,
  type Speed,
  type DisplayView,
  type TargetRun,
  type TickRate,
  type ControlState,
  type TelemetrySnapshot,
  type ExtinctionSummary,
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
    runId = 0,
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
  const next = (value: number): number => {
    if (value >= Number.MAX_SAFE_INTEGER)
      throw new Error('Session counter exhausted. Restart the worker.');
    return value + 1;
  };
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
    return { revision, tick: world!.tick, telemetry: world!.telemetrySnapshot() };
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
    scope.postMessage({
      type: 'progress',
      runId,
      sequence: progressSequence,
      state: state(),
      ...(forced || (telemetryDirty && now() - telemetryAt >= 250)
        ? { telemetry: telemetry() }
        : {}),
    });
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
    scope.postMessage({
      type: 'error',
      runId: responseRun,
      ...(responseCommand === undefined ? {} : { commandId: responseCommand }),
      code,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      ...(fatal
        ? { fatal: true as const }
        : world && !failed && responseRun === runId
          ? { recovery: { state: state(), telemetry: telemetry() } }
          : {}),
    });
  }
  function queue(): void {
    if (alive && world && !paused && !failed && !queued) {
      queued = true;
      defer(tick, target?.status === 'running' ? 0 : 40);
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
      !integer(data.runId, 1, Number.MAX_SAFE_INTEGER) ||
      !integer(data.commandId, 1, Number.MAX_SAFE_INTEGER) ||
      typeof data.type !== 'string'
    )
      return;
    if (data.commandId <= commandId) return;
    const replacement = data.type === 'start' || data.type === 'load';
    if (replacement ? data.runId <= runId : data.runId !== runId) {
      report('Command belongs to an inactive world.', 'stale-run', data.runId, data.commandId);
      return;
    }
    commandId = data.commandId;
    if (failed && !replacement) {
      report('The ecosystem worker is stopped.', 'invalid-command', runId, commandId);
      return;
    }
    let errorCode: Extract<WorkerResponse, { type: 'error' }>['code'] = 'invalid-command';
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
        target = null;
        displayDirty = interactive = settled = false;
        changed();
        resetRate();
        settle();
        scope.postMessage({
          type: 'control',
          runId,
          commandId,
          state: state(),
          telemetry: telemetry(),
        });
      } else if (data.type === 'load') {
        if (typeof data.text !== 'string') throw new Error('Invalid world text.');
        runId = data.runId;
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
        scope.postMessage({
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
          case 'step':
            if (!paused) throw new Error('Pause before stepping.');
            world.step();
            reconcile(world.organisms.size);
            interactive = view.visible;
            exactTelemetry = true;
            break;
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
          case 'settings': {
            const patch = data.settings;
            if (
              !patch ||
              typeof patch !== 'object' ||
              Object.keys(patch).some(
                (key) => !['mutation', 'nutrients', 'climate'].includes(key),
              ) ||
              !validSettings({ ...world.settings, ...patch })
            )
              throw new Error('Invalid live settings.');
            Object.assign(world.settings, patch);
            interactive = paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'inspect':
            if (!coordinates(data)) throw new Error('Invalid inspection coordinates.');
            selected = world.occupied[index(data.x, data.y)];
            interactive = paused && view.visible;
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
            const population = world.organisms.size;
            world.paint(data.tool, data.x, data.y, data.radius, data.genome);
            reconcile(population);
            interactive = paused && view.visible;
            exactTelemetry = paused;
            break;
          }
          case 'shock':
            if (data.kind !== 'cold' && data.kind !== 'heat')
              throw new Error('Invalid climate event.');
            world.shock(data.kind);
            interactive = paused && view.visible;
            exactTelemetry = paused;
            break;
          case 'snapshot':
            if (typeof data.display !== 'boolean') throw new Error('Invalid snapshot request.');
            mutation = false;
            interactive ||= data.display && view.visible;
            exactTelemetry = true;
            break;
          case 'save': {
            errorCode = 'save-failed';
            const text = JSON.stringify(world.save());
            if (new TextEncoder().encode(text).byteLength > WORLD_MAX_BYTES)
              throw new Error('World file exceeds 2.5 MB. Nothing was downloaded.');
            scope.postMessage({ type: 'saved', runId, commandId, state: state(), text });
            return;
          }
          default:
            throw new Error('Unknown ecosystem command.');
        }
        if (mutation) changed();
        if (interactive) displayDirty = true;
        scope.postMessage({
          type: 'control',
          runId,
          commandId,
          state: state(),
          ...(exactTelemetry ? { telemetry: telemetry() } : {}),
        });
      }
      publishDisplay();
      publishProgress();
      queue();
    } catch (error) {
      report(error, errorCode, data.runId, data.commandId);
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
