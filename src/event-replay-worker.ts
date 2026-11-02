import { Ecosystem } from './ecosystem';
import { integer, WORLD_VERSION } from './model';
import { completeCheckpoint } from './event-journal';
import {
  EVENT_RULES,
  REPLAY_RULES,
  REPLAY_WINDOW,
  type EventReplay,
  type ReplayResponse,
} from './event-model';

export interface ReplayScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (data: ReplayResponse) => void;
}
export function startReplayWorker(
  scope: ReplayScope,
  defer: (callback: () => void) => unknown = (callback) => setTimeout(callback, 0),
  cancel: (handle: any) => void = clearTimeout,
  now: () => number = () => performance.now(),
) {
  let world: Ecosystem | undefined;
  let evidence: EventReplay;
  let target = 0;
  let observation: Extract<ReplayResponse, { type: 'complete' }>;
  let alive = true,
    pending = false;
  let scheduled: unknown;
  const dispose = (): void => {
    alive = false;
    cancel(scheduled);
    world = undefined;
    scope.onmessage = null;
  };
  const fail = (error: unknown): void => {
    dispose();
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Exact event replay failed.',
    });
  };
  const sample = (): void => {
    if (world!.tick === target)
      observation = {
        type: 'complete',
        tick: target,
        population: world!.organisms.size,
        verified: true,
        cells: world!.display(world!.presentation()).cells,
      };
  };
  const tick = (): void => {
    if (!alive || !world) return;
    try {
      const began = now();
      for (let count = 0; count < 12 && world.tick < evidence.endpointTick; count++) {
        world.step();
        sample();
        if (now() - began >= 8) break;
      }
      if (world.tick === evidence.endpointTick) {
        if (completeCheckpoint(world) !== evidence.endpoint)
          throw new Error(
            'Replay endpoint differs from the original complete save. Exact replay unavailable.',
          );
        dispose();
        scope.postMessage(observation);
      } else {
        if (!pending) {
          pending = true;
          scope.postMessage({
            type: 'progress',
            tick: world.tick,
            endpointTick: evidence.endpointTick,
          });
        }
        scheduled = defer(tick);
      }
    } catch (error) {
      fail(error);
    }
  };
  scope.onmessage = ({ data }) => {
    if (!alive || !data) return;
    if (data.type === 'cancel') dispose();
    else if (data.type === 'ack') pending = false;
    else if (data.type === 'start' && !world) {
      try {
        evidence = data.evidence;
        target = data.tick;
        if (
          !evidence ||
          evidence.rules !== REPLAY_RULES ||
          evidence.eventRules !== EVENT_RULES ||
          evidence.worldVersion !== WORLD_VERSION ||
          !integer(evidence.boundary, 1, Number.MAX_SAFE_INTEGER) ||
          !Array.isArray(evidence.interventions) ||
          evidence.interventions.length ||
          !integer(evidence.sourceTick, 0, 1e9) ||
          !integer(
            evidence.endpointTick,
            evidence.sourceTick,
            Math.min(1e9, evidence.sourceTick + REPLAY_WINDOW),
          ) ||
          !integer(target, evidence.sourceTick, evidence.endpointTick)
        )
          throw new Error(
            'Unsupported or incomplete event replay rules/window/intervention evidence.',
          );
        world = Ecosystem.load(evidence.checkpoint);
        const endpoint = Ecosystem.load(evidence.endpoint);
        if (world.tick !== evidence.sourceTick || endpoint.tick !== evidence.endpointTick)
          throw new Error('Replay checkpoint ticks do not match their metadata.');
        sample();
        scheduled = defer(tick);
      } catch (error) {
        fail(error);
      }
    }
  };
  return dispose;
}
if (typeof self !== 'undefined' && typeof document === 'undefined')
  startReplayWorker(self as unknown as ReplayScope);
