import { Ecosystem } from './ecosystem';
import { DEFAULT_TERRAIN, resolvedTerrainSeed, validTerrain } from './terrain';
import { serializeMeasurements } from './measurement-export';
import { refugeTool, validRefugeBrush, refugeSummary } from './refuges';
import {
  WORLD_MAX_BYTES,
  STROKE_COMMAND_CAPACITY,
  validSettings,
  knownSettings,
  validGenome,
  integer,
  index,
  type Settings,
  type PlaybackState,
  type ExtinctionSummary,
  type LoadFailureResponse,
  type PaintTool,
  type StrokeTool,
  type RefugeBrush,
} from './model';

export interface Scope {
  postMessage: (data: any, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
}
export function startWorker(
  scope: Scope,
  defer: (callback: () => void, delay: number) => unknown = (callback, delay) =>
    setTimeout(callback, delay),
): void {
  let world: Ecosystem | undefined,
    paused = false,
    queued = false,
    speed = 4,
    runId = 0,
    selected = 0;
  let pauseOnExtinction = true,
    extinction: ExtinctionSummary | null = null;
  let postingWatermark = 0,
    refugeModeId = 0;
  let stroke: {
    id: number;
    tool: StrokeTool;
    brush?: RefugeBrush;
    radius: number;
    sequence: number | null;
    count: number;
  } | null = null;
  const tracked = new Set([
    'start',
    'load',
    'save',
    'export-measurements',
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
  ]);
  const manual = new Set([
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
  ]);
  const errorText = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).slice(0, 512);
  const playback = (): PlaybackState => ({
    paused,
    pauseOnExtinction,
    extinction: extinction ? { ...extinction } : null,
  });
  const acknowledge = (): void =>
    scope.postMessage({ type: 'playback', runId, playback: playback() });
  function reconcile(previousPopulation: number): void {
    if (!world) return;
    if (world.organisms.size) extinction = null;
    else {
      if (previousPopulation && world.lastDeath) extinction = { ...world.lastDeath };
      if (pauseOnExtinction) paused = true;
    }
  }
  function report(error: unknown, fatal = false): void {
    scope.postMessage({
      type: 'error',
      runId,
      message: errorText(error),
      ...(fatal ? { fatal: true } : {}),
    });
  }
  function send(): void {
    if (!world) return;
    const frame = world.frame();
    scope.postMessage(
      {
        type: 'frame',
        runId,
        refugeModeId,
        frame,
        selected: world.organisms.get(selected) ?? null,
        playback: playback(),
      },
      [frame.cells.buffer, frame.ids.buffer, frame.thermalRefuges.units.buffer],
    );
  }
  function queue(): void {
    if (!queued) {
      queued = true;
      try {
        defer(tick, 40);
      } catch (error) {
        queued = false;
        throw error;
      }
    }
  }
  function tick(): void {
    queued = false;
    if (!world || paused) return;
    try {
      reconcile(world.organisms.size);
      if (paused) return;
      for (let step = 0; step < speed; step++) {
        const population = world.organisms.size;
        world.step();
        reconcile(population);
        if (paused) break;
      }
      send();
      if (!paused) queue();
    } catch (error) {
      paused = true;
      report(error, true);
    }
  }
  scope.onmessage = ({ data }) => {
    if (!data || typeof data !== 'object') return;
    const correlated = tracked.has(data.type),
      isManual = manual.has(data.type),
      id = isManual ? data.commandId : data.requestId,
      strokeOwned =
        data.type === 'begin-stroke' ||
        data.type === 'end-stroke' ||
        data.type === 'paint-refuge' ||
        (data.type === 'paint' && data.tool !== 'plant');
    const owner = {
      operation: data.type,
      runId: data.runId,
      ...(isManual ? { commandId: id } : { requestId: id }),
      ...(data.type === 'export-measurements' ? { format: data.format } : {}),
      ...(strokeOwned ? { strokeId: data.strokeId } : {}),
      ...((data.type === 'paint-refuge' || data.type === 'begin-stroke') && validRefugeBrush(data)
        ? {
            rulesVersion: 1,
            tool: data.tool,
            radius: data.radius,
            units: data.units,
            ...(data.type === 'paint-refuge' && integer(data.x, 0, 239) && integer(data.y, 0, 155)
              ? { x: data.x, y: data.y }
              : {}),
          }
        : {}),
      ...((data.type === 'refuge-mode' || data.type === 'clear-refuges') && data.rulesVersion === 1
        ? { rulesVersion: 1 }
        : {}),
      ...(data.type === 'refuge-mode' && typeof data.enabled === 'boolean'
        ? { enabled: data.enabled }
        : {}),
      ...(data.type === 'clear-walls' ? { action: 'clear' } : {}),
      ...(data.type === 'regenerate-walls'
        ? {
            action: 'regenerate',
            ...(validTerrain(data.recipe) ? { recipe: { ...data.recipe } } : {}),
            ...(integer(data.resolvedSeed, 0, 4294967295)
              ? { resolvedSeed: data.resolvedSeed }
              : {}),
          }
        : {}),
    };
    if (correlated) {
      if (
        !integer(id, 1, Number.MAX_SAFE_INTEGER) ||
        !integer(data.runId, 0, Number.MAX_SAFE_INTEGER) ||
        (isManual ? data.requestId !== undefined : data.commandId !== undefined) ||
        (strokeOwned && !integer(data.strokeId, 1, Number.MAX_SAFE_INTEGER)) ||
        (data.type === 'export-measurements' && !['csv', 'json'].includes(data.format)) ||
        id <= postingWatermark
      )
        return;
      postingWatermark = id;
    }
    let settled = false,
      terrainApplied = false;
    const complete = (response: any): void => {
      scope.postMessage(response);
      settled = true;
    };
    const result = (
      status: 'applied' | 'no-op' | 'rejected',
      rowSequence: number | null = null,
      extra: Record<string, unknown> = {},
    ): void =>
      complete({
        type: 'manual-result',
        ...owner,
        status,
        completedTick: world!.tick,
        rowSequence,
        ...extra,
      });
    try {
      if (
        correlated &&
        data.type !== 'start' &&
        data.type !== 'load' &&
        (!world || data.runId !== runId)
      )
        throw new Error('Rejected obsolete ecosystem request.');
      if (data.type === 'start') {
        if (!validSettings(data.settings)) throw new Error('Invalid ecosystem settings.');
        const terrain = data.terrain === undefined ? DEFAULT_TERRAIN : data.terrain;
        if (!validTerrain(terrain)) throw new Error('Invalid wall recipe.');
        world = new Ecosystem(data.settings, true, { terrain });
        refugeModeId = id;
        runId = data.runId;
        paused = false;
        selected = 0;
        extinction = null;
        stroke = null;
        complete({
          type: 'started',
          ...owner,
          completedTick: world.tick,
          seed: world.settings.seed,
          settings: knownSettings(world.settings),
          terrain: { ...world.terrain },
          thermalRefuges: refugeSummary(world.thermalRefuges),
          playback: playback(),
        });
        send();
        queue();
      } else if (data.type === 'load') {
        runId = data.runId;
        stroke = null;
        let restored: Ecosystem;
        try {
          restored = Ecosystem.load(data.text);
        } catch (error) {
          if (!world) scope.postMessage({ type: 'error', ...owner, message: errorText(error) });
          else {
            try {
              const frame = world.frame();
              const response: LoadFailureResponse = {
                type: 'error',
                runId,
                operation: 'load',
                requestId: id,
                message: errorText(error),
                recovery: {
                  frame,
                  selected: world.organisms.get(selected) ?? null,
                  settings: knownSettings(world.settings),
                  playback: playback(),
                },
              };
              scope.postMessage(response, [
                frame.cells.buffer,
                frame.ids.buffer,
                frame.thermalRefuges.units.buffer,
              ]);
            } catch (failure) {
              paused = true;
              scope.postMessage({
                type: 'error',
                ...owner,
                message: errorText(failure),
                fatal: true,
              });
            }
          }
          return;
        }
        world = restored;
        refugeModeId = id;
        paused = false;
        selected = 0;
        extinction = world.organisms.size ? null : { tick: world.tick, cause: 'empty-import' };
        reconcile(world.organisms.size);
        complete({
          type: 'loaded',
          ...owner,
          completedTick: world.tick,
          seed: world.settings.seed,
          settings: knownSettings(world.settings),
          terrain: { ...world.terrain },
          ...(JSON.parse(data.text).version < 6 ? { terrainMigration: true } : {}),
          thermalRefuges: refugeSummary(world.thermalRefuges),
          refugeMigration: JSON.parse(data.text).version < 7,
          playback: playback(),
        });
        send();
        if (!paused) queue();
      } else if (data.type === 'pause') {
        paused = true;
        acknowledge();
      } else if (data.type === 'resume') {
        paused = false;
        reconcile(world?.organisms.size ?? 0);
        acknowledge();
        if (!paused) queue();
      } else if (data.type === 'pause-on-extinction') {
        if (data.runId !== runId || typeof data.value !== 'boolean') return;
        pauseOnExtinction = data.value;
        reconcile(world?.organisms.size ?? 0);
        acknowledge();
      } else if (data.type === 'speed') {
        if ([1, 4, 12].includes(data.value)) speed = data.value;
      } else if (data.type === 'begin-stroke' && world) {
        if (
          stroke ||
          (!['food', 'wall', 'erase'].includes(data.tool) && !validRefugeBrush(data)) ||
          !integer(data.radius, 0, 8) ||
          (refugeTool(data.tool) && !world.thermalRefuges.enabled)
        )
          throw new Error('Invalid or overlapping brush stroke.');
        stroke = {
          id: data.strokeId,
          tool: data.tool,
          radius: data.radius,
          sequence: null,
          count: 0,
          ...(refugeTool(data.tool)
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
        result('applied');
      } else if (data.type === 'end-stroke' && world) {
        const matched = stroke?.id === data.strokeId;
        if (matched) stroke = null;
        result(matched ? 'applied' : 'no-op');
      } else if (data.type === 'refuge-mode' && world) {
        stroke = null;
        if (data.rulesVersion !== 1 || typeof data.enabled !== 'boolean')
          throw new Error('Invalid painted temperature mode payload.');
        const sequence = world.changeRefugeMode(data.enabled);
        refugeModeId = id;
        terrainApplied = sequence !== null;
        result(sequence === null ? 'no-op' : 'applied', sequence, {
          nonzeroCells: world.thermalRefuges.nonzeroCells,
        });
        send();
      } else if (data.type === 'clear-refuges' && world) {
        stroke = null;
        if (data.rulesVersion !== 1) throw new Error('Invalid painted temperature clear payload.');
        const outcome = world.clearRefuges();
        terrainApplied = outcome.rowSequence !== null;
        result(terrainApplied ? 'applied' : 'no-op', outcome.rowSequence, outcome);
        send();
      } else if (data.type === 'paint-refuge' && world) {
        if (!validRefugeBrush(data) || !integer(data.x, 0, 239) || !integer(data.y, 0, 155))
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
        const outcome = world.paintRefuge(stroke.brush, data.x, data.y, stroke.sequence);
        stroke.count++;
        if (outcome.rowSequence !== null) stroke.sequence = outcome.rowSequence;
        terrainApplied = outcome.rowSequence !== null;
        result(terrainApplied ? 'applied' : 'no-op', outcome.rowSequence, outcome);
        if (terrainApplied) send();
      } else if (data.type === 'settings' && world) {
        stroke = null;
        if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))
          throw new Error('Invalid manual settings patch.');
        const sequence = world.changeSettings(data.settings);
        result(sequence === null ? 'no-op' : 'applied', sequence);
        if (sequence !== null) send();
      } else if ((data.type === 'clear-walls' || data.type === 'regenerate-walls') && world) {
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
        terrainApplied = outcome.rowSequence !== null;
        result(terrainApplied ? 'applied' : 'no-op', outcome.rowSequence, {
          detail: outcome.detail,
          terrain: { ...world.terrain },
        });
        send();
      } else if (data.type === 'paint' && world) {
        if (
          !['food', 'wall', 'erase', 'plant'].includes(data.tool) ||
          !integer(data.x, 0, 239) ||
          !integer(data.y, 0, 155) ||
          !integer(data.radius, 0, 8) ||
          !validGenome(data.genome)
        )
          throw new Error('Invalid manual paint command.');
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
          const previous = stroke.sequence;
          sequence = world.recordPaint(
            outcome,
            stroke.tool as PaintTool,
            stroke.radius,
            data.x,
            data.y,
            previous,
          );
          stroke.sequence = sequence;
          if (!outcome.changedBrushCells && !outcome.removedOrganisms) sequence = null;
        }
        reconcile(population);
        result(sequence === null ? 'no-op' : 'applied', sequence);
        send();
      } else if (data.type === 'inspect' && world) {
        selected = world.occupied[index(data.x, data.y)];
        send();
      } else if (data.type === 'shock' && world) {
        stroke = null;
        if (!['cold', 'heat'].includes(data.kind) || world.tick + 900 > 1e9)
          throw new Error('Invalid climate shock.');
        const before = { offset: world.eventOffset, until: world.eventUntil };
        world.requireInterventionCapacity();
        world.shock(data.kind);
        const after = { offset: world.eventOffset, until: world.eventUntil },
          changed = before.offset !== after.offset || before.until !== after.until;
        const sequence = changed
          ? world.appendIntervention({ kind: 'shock', detail: { kind: data.kind, before, after } })
          : null;
        result(sequence === null ? 'no-op' : 'applied', sequence);
        send();
      } else if (data.type === 'save' && world) {
        const text = JSON.stringify(world.save()),
          byteLength = new TextEncoder().encode(text).byteLength;
        if (byteLength > WORLD_MAX_BYTES)
          throw new Error('World file exceeds 2.5 MB. World preserved; no download created.');
        complete({
          type: 'saved',
          ...owner,
          completedTick: world.tick,
          seed: world.settings.seed,
          byteLength,
          text,
        });
      } else if (data.type === 'export-measurements' && world) {
        const source = world.measurements(stroke?.sequence ?? null),
          payload = serializeMeasurements(source, data.format);
        complete({
          type: 'measurement-exported',
          ...owner,
          completedTick: source.snapshot.completedTick,
          seed: source.snapshot.seed,
          ...payload,
        });
      } else if (data.type === 'step' && world && paused) {
        const population = world.organisms.size;
        world.step();
        reconcile(population);
        send();
      } else if (data.type === 'snapshot') send();
    } catch (error) {
      if (settled || terrainApplied) {
        paused = true;
        report(
          new Error(
            `The action completed, but publishing or scheduling failed. World preserved; import a world or reseed to recover. ${errorText(error)}`,
          ),
          true,
        );
      } else if (correlated && data.type === 'start' && world) {
        runId = data.runId;
        stroke = null;
        try {
          const frame = world.frame();
          scope.postMessage(
            {
              type: 'error',
              ...owner,
              message: errorText(error),
              recovery: {
                frame,
                selected: world.organisms.get(selected) ?? null,
                settings: knownSettings(world.settings),
                playback: playback(),
              },
            },
            [frame.cells.buffer, frame.ids.buffer, frame.thermalRefuges.units.buffer],
          );
        } catch (failure) {
          paused = true;
          scope.postMessage({ type: 'error', ...owner, message: errorText(failure), fatal: true });
        }
      } else if (correlated)
        scope.postMessage({ type: 'error', ...owner, message: errorText(error) });
      else report(error);
    }
  };
}
if (typeof document === 'undefined' && typeof self !== 'undefined')
  startWorker(self as unknown as Scope);
