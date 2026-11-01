import { afterEach, expect, it, vi } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { EventRecorder, completeCheckpoint } from '../src/event-journal';
import { startReplayWorker, type ReplayScope } from '../src/event-replay-worker';
import { startWorker, type Scope } from '../src/worker';
import { DEFAULTS, WORLD_MAX_BYTES, founder } from '../src/model';
import {
  EVENT_CAPACITY,
  REPLAY_CAPACITY,
  REPLAY_WINDOW,
  type EventReplay,
  type ReplayResponse,
} from '../src/event-model';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const world = new Ecosystem(
    { ...DEFAULTS, seed: 42, mutation: 0, nutrients: 0, climate: 0 },
    false,
  );
  const organism = world.spawn({ ...founder(0), cells: [{ x: 0, y: 0, type: 7 }] }, 40, 40)!;
  organism.energy = 0.001;
  return world;
}
function receipt(ticks = 31) {
  const world = fixture();
  const recorder = new EventRecorder(world);
  world.step();
  recorder.observe(world);
  const evidence = recorder.replay(recorder.snapshot().events.at(-1)!.id);
  for (let tick = 1; tick < ticks; tick++) world.step();
  evidence.endpointTick = world.tick;
  evidence.endpoint = completeCheckpoint(world);
  return evidence;
}
function replay(evidence = receipt(), target = evidence.endpointTick, now = () => 0) {
  const tasks: (() => void)[] = [],
    messages: ReplayResponse[] = [];
  const scope: ReplayScope = { onmessage: null, postMessage: (data) => messages.push(data) };
  const cancel = vi.fn();
  const dispose = startReplayWorker(scope, (callback) => tasks.push(callback), cancel, now);
  const handler = scope.onmessage!;
  const send = (data: any) => handler({ data } as MessageEvent);
  send({ type: 'start', evidence, tick: target });
  return { tasks, messages, dispose, send, scope, cancel };
}

it('records only observed finite traits, terminal lineages and threshold drops without changing a complete save', () => {
  const world = fixture(),
    original = completeCheckpoint(world);
  const recorder = new EventRecorder(world);
  expect(completeCheckpoint(world)).toBe(original);
  expect(recorder.snapshot().events.map((event) => event.kind)).toEqual([
    'first-trait',
    'first-trait',
  ]);
  world.step();
  recorder.observe(world);
  expect(recorder.snapshot().events.at(-1)).toMatchObject({
    kind: 'lineage-extinction',
    tick: 1,
    replay: true,
  });
  const evidence = recorder.replay(3);
  expect(evidence.checkpoint).toBe(original);
  expect(evidence.endpoint).toBe(completeCheckpoint(world));
  expect(evidence.interventions).toEqual([]);
  const isolated = replay(evidence, 0);
  isolated.tasks.shift()!();
  expect(isolated.messages.at(-1)).toMatchObject({
    type: 'complete',
    tick: 0,
    population: 1,
    verified: true,
  });
  const before = completeCheckpoint(world);
  for (let count = 0; count < 10; count++) world.spawn(founder(0), 10 + count * 10, 20);
  recorder.observe(world, true);
  for (const organism of [...world.organisms.values()].slice(0, 4)) world.kill(organism, 'manual');
  recorder.observe(world, true);
  expect(
    recorder.snapshot().events.filter((event) => event.kind === 'population-drop'),
  ).toHaveLength(0);
  for (const organism of [...world.organisms.values()].slice(0, 5)) world.kill(organism, 'manual');
  recorder.observe(world, true);
  expect(recorder.snapshot().events.at(-1)).toMatchObject({ kind: 'population-drop', tick: 1 });
  const manual = recorder.replay(recorder.snapshot().events.at(-1)!.id);
  expect(manual.checkpoint).toBe(manual.endpoint);
  expect(manual.checkpoint).not.toBe(before);
  const isolatedManual = replay(manual);
  isolatedManual.tasks.shift()!();
  expect(isolatedManual.messages.at(-1)).toMatchObject({ type: 'complete' });
});

it('bounds event/checkpoint retention, rolls the replay window and exposes missing evidence', () => {
  const world = fixture(),
    recorder = new EventRecorder(world);
  const first = recorder.snapshot().events[0].id;
  for (let count = 0; count < 50; count++) {
    const organism = world.spawn(founder(0), 90, 90)!;
    recorder.observe(world, true);
    world.kill(organism, 'manual');
    recorder.observe(world, true);
  }
  const snapshot = recorder.snapshot();
  expect(snapshot.events).toHaveLength(EVENT_CAPACITY);
  expect(snapshot.evicted).toBeGreaterThan(0);
  expect(snapshot.evidenceEvicted).toBeGreaterThan(REPLAY_CAPACITY);
  expect(() => recorder.replay(first)).toThrow('evicted');
  expect(snapshot.events.filter((event) => event.replay)).toHaveLength(REPLAY_CAPACITY);
  for (let count = 0; count <= REPLAY_WINDOW; count++) {
    world.step();
    recorder.observe(world);
  }
  const organism = world.spawn(founder(0), 90, 90)!;
  recorder.observe(world, true);
  world.kill(organism, 'manual');
  recorder.observe(world, true);
  expect(recorder.replay(recorder.snapshot().events.at(-1)!.id).sourceTick).toBe(world.tick);
});

it('discloses oversized captures, recovers, and bounds bytes even below the checkpoint count cap', () => {
  const world = fixture();
  const save = world.save.bind(world);
  const oversized = vi
    .spyOn(world, 'save')
    .mockImplementation(() => ({ ...save(), extension: 'x'.repeat(WORLD_MAX_BYTES) }) as any);
  const recorder = new EventRecorder(world);
  expect(recorder.snapshot().problem).toContain('2.5 MB');
  expect(() => recorder.replay(1)).toThrow('evicted');
  oversized.mockRestore();
  recorder.observe(world, true);
  expect(recorder.snapshot().problem).toBe('');
  vi.spyOn(world, 'save').mockImplementation(
    () => ({ ...save(), extension: 'x'.repeat(2_000_000) }) as any,
  );
  for (let count = 0; count < 4; count++) {
    const organism = world.spawn(founder(0), 80, 80)!;
    recorder.observe(world, true);
    world.kill(organism, 'manual');
    recorder.observe(world, true);
  }
  expect(recorder.snapshot().evidenceEvicted).toBeGreaterThan(0);
  expect(recorder.snapshot().events.filter((event) => event.replay).length).toBeLessThan(4);
});

it('yields bounded replay batches, coalesces progress and verifies the original complete endpoint before seeking', () => {
  const evidence = receipt(40),
    test = replay(evidence, 12);
  test.send(null);
  test.send({ type: 'start', evidence: {}, tick: 0 });
  test.tasks.shift()!();
  test.tasks.shift()!();
  expect(test.messages).toEqual([{ type: 'progress', tick: 12, endpointTick: 40 }]);
  test.send({ type: 'ack' });
  test.tasks.shift()!();
  test.tasks.shift()!();
  expect(test.messages.at(-1)).toMatchObject({ type: 'complete', tick: 12, population: 0 });
  expect(test.scope.onmessage).toBeNull();
  expect(test.cancel).toHaveBeenCalledTimes(1);
  let time = 0;
  const budgeted = replay(evidence, 0, () => (time += 9));
  budgeted.tasks.shift()!();
  expect(budgeted.messages[0]).toEqual({ type: 'progress', tick: 1, endpointTick: 40 });
  budgeted.send({ type: 'cancel' });
  budgeted.send({ type: 'ack' });
  budgeted.tasks.shift()!();
  expect(budgeted.messages).toHaveLength(1);
});

it('rejects malformed metadata, invalid worlds, tick mismatches and dishonest endpoints', () => {
  for (const patch of [
    { rules: 'future' },
    { eventRules: 2 },
    { interventions: [{}] },
    { endpointTick: 121 },
    { checkpoint: '{}' },
    { sourceTick: 1 },
  ]) {
    const test = replay({ ...receipt(), ...patch } as EventReplay);
    expect(test.messages.at(-1)?.type).toBe('error');
  }
  const evidence = receipt();
  const endpoint = Ecosystem.load(evidence.endpoint);
  endpoint.shock('heat');
  evidence.endpoint = completeCheckpoint(endpoint);
  const test = replay(evidence);
  while (test.tasks.length) test.tasks.shift()!();
  expect(test.messages.at(-1)).toMatchObject({
    type: 'error',
    message: expect.stringContaining('differs'),
  });
  const scope: ReplayScope = { onmessage: null, postMessage: vi.fn() };
  startReplayWorker(scope, () => {
    throw 'scheduler failed';
  });
  scope.onmessage!({ data: { type: 'start', evidence: receipt(), tick: 0 } } as MessageEvent);
  expect(scope.postMessage).toHaveBeenCalledWith({
    type: 'error',
    message: 'Exact event replay failed.',
  });
});

it('boots the native replay worker entrypoint and default scheduler', async () => {
  const evidence = receipt();
  vi.useFakeTimers();
  const scope: ReplayScope = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  vi.stubGlobal('document', undefined);
  vi.resetModules();
  await import('../src/event-replay-worker');
  scope.onmessage!({ data: { type: 'start', evidence, tick: 1 } } as MessageEvent);
  vi.runAllTimers();
  expect(scope.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'complete', tick: 1 }),
  );
});

it('records in the authoritative worker without RNG changes and clears on rejected import', () => {
  const messages: any[] = [],
    tasks: (() => void)[] = [];
  const scope: Scope = { onmessage: null, postMessage: (data) => messages.push(data) };
  const dispose = startWorker(
    scope,
    (callback) => tasks.push(callback),
    () => 0,
  );
  let commandId = 0;
  const send = (data: any) =>
    scope.onmessage!({ data: { runId: 0, commandId: ++commandId, ...data } } as MessageEvent);
  send({ type: 'load', text: completeCheckpoint(fixture()) });
  send({ type: 'pause' });
  send({ type: 'save' });
  const original = messages.at(-1).text;
  send({ type: 'event-replay', eventId: 1 });
  expect(messages.at(-1).type).toBe('error');
  send({ type: 'event-recording', enabled: 'yes' });
  expect(messages.at(-1).type).toBe('error');
  send({ type: 'event-recording', enabled: true });
  expect(messages.at(-1).state.journal.originTick).toBe(0);
  send({ type: 'save' });
  expect(messages.at(-1).text).toBe(original);
  send({ type: 'step' });
  send({ type: 'event-replay', eventId: 3 });
  expect(messages.at(-1).evidence.endpointTick).toBe(1);
  send({ type: 'event-replay', eventId: 100 });
  expect(messages.at(-1).type).toBe('error');
  send({ type: 'shock', kind: 'heat' });
  send({ type: 'event-recording', enabled: false });
  expect(messages.at(-1).state.journal).toBeUndefined();
  send({ type: 'event-recording', enabled: true });
  send({ type: 'pause-on-extinction', value: false });
  send({ type: 'resume' });
  tasks.shift()!();
  send({ type: 'load', runId: 1, text: '{}' });
  expect(
    messages.findLast((message) => message.type === 'error').recovery.state.journal,
  ).toBeUndefined();
  dispose();
});

it('replays the exact ordered effects of edits from a fresh sealed boundary, including rejected placement RNG', () => {
  const world = fixture();
  const organism = [...world.organisms.values()][0];
  organism.energy = 10;
  organism.age = 900;
  const messages: any[] = [];
  const scope: Scope = { onmessage: null, postMessage: (data) => messages.push(data) };
  const dispose = startWorker(
    scope,
    () => 0,
    () => 0,
  );
  let commandId = 0;
  const send = (data: any) =>
    scope.onmessage!({ data: { runId: 0, commandId: ++commandId, ...data } } as MessageEvent);
  send({ type: 'load', text: completeCheckpoint(world) });
  send({ type: 'pause' });
  send({ type: 'event-recording', enabled: true });
  send({ type: 'step' });
  send({ type: 'settings', settings: { nutrients: 0.02 } });
  send({ type: 'shock', kind: 'heat' });
  send({ type: 'paint', tool: 'plant', x: 40, y: 40, radius: 0, genome: founder(0) });
  expect(messages.at(-1)).toMatchObject({
    type: 'error',
    message: expect.stringContaining('Placement blocked'),
  });
  send({ type: 'begin-stroke', strokeId: 1, tool: 'food', radius: 0 });
  send({ type: 'paint', strokeId: 1, tool: 'food', x: 5, y: 5, radius: 0, genome: founder(0) });
  send({ type: 'end-stroke', strokeId: 1 });
  send({ type: 'save' });
  const boundary = messages.at(-1).text;
  for (let tick = 1; tick < 76; tick++) send({ type: 'step' });
  send({ type: 'save' });
  const originalEndpoint = messages.at(-1).text;
  send({ type: 'event-replay', eventId: 3 });
  const evidence = messages.at(-1).evidence;
  expect(evidence.checkpoint).toBe(boundary);
  expect(evidence.endpoint).toBe(originalEndpoint);
  expect(evidence.sourceTick).toBe(1);
  const isolated = replay(evidence, 40);
  while (isolated.tasks.length) isolated.tasks.shift()!();
  expect(isolated.messages.at(-1)).toMatchObject({ type: 'complete', tick: 40, verified: true });
  dispose();
});
