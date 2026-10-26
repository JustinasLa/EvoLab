import { Ecosystem } from './ecosystem';
import {
  WORLD_MAX_BYTES,
  validSettings,
  validGenome,
  integer,
  index,
  type Settings,
  type PlaybackState,
  type ExtinctionSummary,
  type LoadFailureResponse,
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
      message: error instanceof Error ? error.message : String(error),
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
        frame,
        selected: world.organisms.get(selected) ?? null,
        playback: playback(),
      },
      [frame.cells.buffer, frame.ids.buffer],
    );
  }
  function queue(): void {
    if (!queued) {
      queued = true;
      defer(tick, 40);
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
    try {
      if (data.type === 'start') {
        if (!validSettings(data.settings)) throw new Error('Invalid ecosystem settings.');
        world = new Ecosystem(data.settings);
        runId = data.runId;
        paused = false;
        selected = 0;
        extinction = null;
        send();
        queue();
      } else if (data.type === 'load') {
        runId = data.runId;
        let restored: Ecosystem;
        try {
          restored = Ecosystem.load(data.text);
        } catch (error) {
          if (!world) report(error);
          else {
            try {
              const frame = world.frame();
              const response: LoadFailureResponse = {
                type: 'error',
                runId,
                message: error instanceof Error ? error.message : String(error),
                recovery: {
                  frame,
                  selected: world.organisms.get(selected) ?? null,
                  settings: { ...world.settings },
                  playback: playback(),
                },
              };
              scope.postMessage(response, [frame.cells.buffer, frame.ids.buffer]);
            } catch (failure) {
              paused = true;
              report(failure, true);
            }
          }
          return;
        }
        world = restored;
        paused = false;
        selected = 0;
        extinction = world.organisms.size ? null : { tick: world.tick, cause: 'empty-import' };
        reconcile(world.organisms.size);
        scope.postMessage({
          type: 'loaded',
          runId,
          settings: world.settings,
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
      } else if (data.type === 'settings' && world) {
        const next: Settings = { ...world.settings, ...data.settings };
        if (validSettings(next)) world.settings = next;
      } else if (
        data.type === 'paint' &&
        world &&
        ['food', 'wall', 'erase', 'plant'].includes(data.tool) &&
        integer(data.x, 0, 239) &&
        integer(data.y, 0, 155) &&
        integer(data.radius, 0, 8) &&
        validGenome(data.genome)
      ) {
        const population = world.organisms.size;
        world.paint(data.tool, data.x, data.y, data.radius, data.genome);
        reconcile(population);
        send();
      } else if (data.type === 'inspect' && world) {
        selected = world.occupied[index(data.x, data.y)];
        send();
      } else if (data.type === 'shock' && world && ['cold', 'heat'].includes(data.kind)) {
        world.shock(data.kind);
        send();
      } else if (data.type === 'save' && world) {
        const text = JSON.stringify(world.save());
        if (new TextEncoder().encode(text).byteLength > WORLD_MAX_BYTES)
          throw new Error('World file exceeds 2.5 MB. World preserved; no download created.');
        scope.postMessage({ type: 'saved', runId, text });
      } else if (data.type === 'step' && world && paused) {
        const population = world.organisms.size;
        world.step();
        reconcile(population);
        send();
      } else if (data.type === 'snapshot') send();
    } catch (error) {
      report(error);
    }
  };
}
if (typeof document === 'undefined' && typeof self !== 'undefined')
  startWorker(self as unknown as Scope);
