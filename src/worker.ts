import { Ecosystem } from './ecosystem';
import { DEFAULTS, validSettings, validGenome, integer, index, type Settings } from './model';

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
  function send(): void {
    if (!world) return;
    const frame = world.frame();
    scope.postMessage(
      { type: 'frame', runId, frame, selected: world.organisms.get(selected) ?? null },
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
      for (let i = 0; i < speed; i++) world.step();
      send();
      queue();
    } catch (error) {
      paused = true;
      scope.postMessage({
        type: 'error',
        runId,
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      });
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
        send();
        queue();
      } else if (data.type === 'load') {
        runId = data.runId;
        const restored = Ecosystem.load(data.text);
        world = restored;
        paused = false;
        selected = 0;
        scope.postMessage({ type: 'loaded', runId, settings: world.settings });
        send();
        queue();
      } else if (data.type === 'pause') paused = true;
      else if (data.type === 'resume') {
        paused = false;
        queue();
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
        world.paint(data.tool, data.x, data.y, data.radius, data.genome);
        send();
      } else if (data.type === 'inspect' && world) {
        selected = world.occupied[index(data.x, data.y)];
        send();
      } else if (data.type === 'shock' && world && ['bloom', 'cold', 'heat'].includes(data.kind)) {
        world.shock(data.kind);
        send();
      } else if (data.type === 'save' && world)
        scope.postMessage({ type: 'saved', runId, text: JSON.stringify(world.save()) });
      else if (data.type === 'step' && world && paused) {
        world.step();
        send();
      } else if (data.type === 'snapshot') send();
    } catch (error) {
      scope.postMessage({
        type: 'error',
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
if (typeof document === 'undefined' && typeof self !== 'undefined')
  startWorker(self as unknown as Scope);
