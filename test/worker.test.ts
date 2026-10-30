import { afterEach, describe, it, expect, vi } from 'vitest';
import { startWorker, type Scope } from '../src/worker';
import { Ecosystem } from '../src/ecosystem';
import { legacyV3, legacyV4 } from './fixtures/telemetry';
import {
  baselineFixtures,
  syntheticHistoricalWorld,
  restoreHistoricalWorld,
  storedSensoryGenome,
} from './fixtures/sensory-legacy';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import {
  DEFAULTS,
  WIDTH,
  WORLD_MAX_BYTES,
  STROKE_COMMAND_CAPACITY,
  founder,
  index,
  type WorldFile,
  type Genome,
  type Frame,
} from '../src/model';

const mouth: Genome = {
  behavior: { version: 1 as const, mode: 'legacy' as const },
  cells: [{ x: 0, y: 0, type: 3 }],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 2,
};
function sender(scope: Scope) {
  let posting = 0,
    runId = 0,
    stroke = 0,
    active = 0;
  const manual = ['begin-stroke', 'end-stroke', 'paint', 'settings', 'shock'];
  function raw(data: any): void {
    const tracked = [...manual, 'start', 'load', 'save', 'export-measurements'].includes(data.type);
    if (data.type === 'start' || data.type === 'load') runId = data.runId;
    const message = tracked
      ? { runId, ...data, [manual.includes(data.type) ? 'commandId' : 'requestId']: ++posting }
      : data;
    scope.onmessage!({ data: message } as MessageEvent);
  }
  return (data: any): void => {
    if (data.type === 'paint' && ['food', 'wall', 'erase'].includes(data.tool)) {
      if (active) raw({ type: 'end-stroke', strokeId: active });
      active = ++stroke;
      raw({ type: 'begin-stroke', tool: data.tool, radius: data.radius, strokeId: active });
      raw({ ...data, strokeId: active });
    } else {
      if (active && ['start', 'load', 'settings', 'shock', 'paint'].includes(data.type)) {
        raw({ type: 'end-stroke', strokeId: active });
        active = 0;
      }
      raw(data);
    }
  };
}
function manualPaint(
  world: Ecosystem,
  tool: 'food' | 'wall' | 'erase' | 'plant',
  x: number,
  y: number,
  radius: number,
  genome: Genome,
): void {
  const outcome = world.paint(tool, x, y, radius, genome);
  if (outcome.placement) world.appendIntervention({ kind: 'placement', detail: outcome.placement });
  else if (tool !== 'plant') world.recordPaint(outcome, tool, radius, x, y, null);
}
function terminalWorld(offset = 1, energy = 5, atTick = 71): WorldFile {
  const world = new Ecosystem({ ...DEFAULTS, seed: 87, climate: 0, nutrients: 0 }, false);
  const organism = world.spawn(mouth, 40, 40)!;
  organism.energy = 10;
  for (let tick = 0; tick < atTick; tick++) world.step();
  organism.age = 976 - offset;
  organism.energy = energy;
  world.births = 9;
  world.deaths = 4;
  world.food[index(5, 5)] = 1;
  world.walls[index(6, 6)] = 1;
  return world.save();
}
function workerHarness(startFunction = startWorker) {
  const tasks: (() => void)[] = [],
    messages: any[] = [],
    seenTransfers = new WeakSet<object>(),
    transferStats = { batches: 0, buffers: 0, duplicates: 0, detached: 0 };
  let responseCount = 0;
  const scope: Scope = {
    onmessage: null,
    postMessage(data, transfer = []) {
      if (transfer.length) transferStats.batches++;
      for (const buffer of transfer) {
        transferStats.buffers++;
        if (seenTransfers.has(buffer)) transferStats.duplicates++;
        seenTransfers.add(buffer);
      }
      const response = structuredClone(data, { transfer });
      for (const buffer of transfer)
        if ((buffer as ArrayBuffer).byteLength === 0) transferStats.detached++;
      responseCount++;
      const previous = messages.findIndex((message) => message.type === data.type);
      if (previous >= 0) messages.splice(previous, 1);
      messages.push(response);
    },
  };
  startFunction(scope, (callback) => tasks.push(callback));
  const post = sender(scope);
  const send = (data: any) => {
    post(data);
    return messages.at(-1);
  };
  const last = (type = 'frame') => messages.filter((message) => message.type === type).at(-1);
  const saveText = (): string => send({ type: 'save' }).text;
  const save = (): WorldFile => JSON.parse(saveText());
  const advance = () => tasks.shift()!();
  const load = (file: WorldFile, runId = 1) =>
    send({ type: 'load', runId, text: JSON.stringify(file) });
  const frame = (): Frame => send({ type: 'snapshot' }).frame;
  return {
    scope,
    tasks,
    messages,
    transferStats,
    send,
    last,
    saveText,
    save,
    advance,
    load,
    frame,
    get responseCount() {
      return responseCount;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('correlated manual/export worker protocol', () => {
  it.each(['selected', 'recovery'])(
    'detaches full passive inherited payload in %s native responses',
    (boundary) => {
      const world = new Ecosystem(DEFAULTS, false),
        source = storedSensoryGenome();
      world.spawn(source, 30, 30);
      const original = structuredClone(source),
        harness = workerHarness();
      harness.load(world.save());
      harness.send({ type: 'pause' });
      harness.send({ type: 'inspect', x: 30, y: 30 });
      if (boundary === 'recovery') harness.send({ type: 'load', runId: 2, text: '{' });
      const response = boundary === 'selected' ? harness.last() : harness.last('error').recovery;
      expect(response.selected.genome).toEqual(original);
      response.selected.genome.behavior.reactions.food = 'ignore';
      response.selected.genome.legacyExtensions[0][1].at(-1)[1] = 'response-only';
      expect(harness.save().organisms[0].genome).toEqual(original);
      source.cells[0].legacyExtensions = [['source', [['null']]]];
      source.legacyExtensions = [['changed', [['boolean', false]]]];
      expect(harness.frame().stats.top[0].genome).toEqual(original);
      expect(harness.save().organisms[0].genome).toEqual(original);
    },
  );
  function protocol(startFunction = startWorker) {
    const harness = workerHarness(startFunction);
    let posting = 0;
    const raw = (data: any) => harness.scope.onmessage!({ data } as MessageEvent);
    const post = (type: string, payload: object = {}, runId = 1) => {
      const data = {
        type,
        runId,
        ...payload,
        [['begin-stroke', 'paint', 'end-stroke', 'settings', 'shock'].includes(type)
          ? 'commandId'
          : 'requestId']: ++posting,
      };
      raw(data);
      return data;
    };
    return { ...harness, post, raw };
  }
  it.each([
    ...['initial-start', 'start', 'load', 'settings', 'paint', 'shock'].flatMap((operation) =>
      ['frame-build', 'frame-publication'].flatMap((fault) =>
        (operation === 'initial-start' ? [false] : [false, true]).map((pending) => [
          operation,
          fault,
          pending,
        ]),
      ),
    ),
    ...['initial-start', 'start', 'load'].map((operation) => [operation, 'scheduling', false]),
  ])(
    'settles %s once before an independent stopped %s failure with pending callback %s and explicit retained-world recovery',
    (operation, fault, pending) => {
      let failSchedule = false,
        armed = false,
        terminals = 0,
        independentFailures = 0;
      const harness = protocol((scope, defer) =>
        startWorker(scope, (callback, delay) => {
          if (failSchedule) {
            failSchedule = false;
            throw new Error('injected post-success scheduling failure');
          }
          return defer!(callback, delay);
        }),
      );
      if (operation !== 'initial-start') {
        harness.post('start', { settings: DEFAULTS });
        harness.raw({ type: 'pause' });
        if (!pending) harness.advance();
        expect(harness.tasks).toHaveLength(pending ? 1 : 0);
      }
      const reference = new Ecosystem(),
        actualOperation = operation === 'initial-start' ? 'start' : operation,
        targetRun = ['start', 'load'].includes(operation) ? 2 : 1,
        publish = harness.scope.postMessage,
        originalFrame = Ecosystem.prototype.frame;
      vi.spyOn(Ecosystem.prototype, 'frame').mockImplementation(function (this: Ecosystem) {
        if (armed && fault === 'frame-build') {
          armed = false;
          throw new Error('injected post-success frame construction failure');
        }
        return originalFrame.call(this);
      });
      harness.scope.postMessage = (data, transfer) => {
        if (data.operation === actualOperation) {
          terminals++;
          expect(data.type).not.toBe('error');
          armed = true;
          if (fault === 'scheduling') failSchedule = true;
        }
        if (data.type === 'frame' && armed && fault === 'frame-publication') {
          armed = false;
          throw new Error('injected post-success frame publication failure');
        }
        if (data.type === 'error' && data.fatal && !data.operation) independentFailures++;
        publish(data, transfer);
      };
      if (actualOperation === 'start') harness.post('start', { settings: DEFAULTS }, targetRun);
      else if (operation === 'load')
        harness.post('load', { text: JSON.stringify(reference.save()) }, targetRun);
      else if (operation === 'settings') {
        harness.post('settings', { settings: { nutrients: 7 } });
        reference.changeSettings({ nutrients: 7 });
      } else if (operation === 'shock') {
        harness.post('shock', { kind: 'heat' });
        const before = { offset: reference.eventOffset, until: reference.eventUntil };
        reference.shock('heat');
        reference.appendIntervention({
          kind: 'shock',
          detail: {
            kind: 'heat',
            before,
            after: { offset: reference.eventOffset, until: reference.eventUntil },
          },
        });
      } else {
        harness.post('begin-stroke', { strokeId: 1, tool: 'food', radius: 0 });
        harness.post('paint', {
          strokeId: 1,
          tool: 'food',
          x: 1,
          y: 1,
          radius: 0,
          genome: founder(0),
        });
        manualPaint(reference, 'food', 1, 1, 0, founder(0));
      }
      expect(terminals).toBe(1);
      expect(independentFailures).toBe(1);
      expect(harness.last('error')).toMatchObject({ type: 'error', runId: targetRun, fatal: true });
      expect(harness.last('error').message).toContain('The action completed');
      expect(harness.last('error')).not.toHaveProperty('requestId');
      expect(harness.last('error')).not.toHaveProperty('commandId');
      expect(harness.last('error')).not.toHaveProperty('operation');
      expect(harness.tasks).toHaveLength(pending ? 1 : 0);
      if (pending) harness.advance();
      expect(harness.tasks).toHaveLength(0);
      harness.post('save', {}, targetRun);
      expect(JSON.parse(harness.last('saved').text)).toEqual(reference.save());
      harness.scope.postMessage = publish;
      armed = false;
      harness.post('load', { text: '{}' }, targetRun + 1);
      expect(harness.last('error')).toMatchObject({
        operation: 'load',
        recovery: { playback: { paused: true } },
      });
      expect(harness.tasks).toHaveLength(0);
      harness.raw({ type: 'resume' });
      expect(harness.tasks).toHaveLength(1);
      harness.advance();
      for (let tick = 0; tick < 4; tick++) reference.step();
      harness.post('save', {}, targetRun + 1);
      expect(JSON.parse(harness.last('saved').text)).toEqual(reference.save());
      expect(harness.tasks).toHaveLength(1);
    },
  );
  it('encodes a complete Save only once and reports its exact byte length without changing state', () => {
    const harness = protocol();
    harness.post('start', { settings: DEFAULTS });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    harness.post('save');
    expect(encode).toHaveBeenCalledTimes(1);
    const saved = harness.last('saved');
    expect(saved.byteLength).toBe(new TextEncoder().encode(saved.text).byteLength);
    expect(saved.text).toBe(JSON.stringify(new Ecosystem().save()));
  });
  it('uses a lifetime watermark, exact owner headers and one bounded error terminal, including absent and stale worlds', () => {
    const harness = protocol();
    harness.raw(null);
    harness.raw({ type: 'start', runId: 1, requestId: 0, settings: DEFAULTS });
    harness.raw({ type: 'start', runId: 1, requestId: 1, commandId: 1, settings: DEFAULTS });
    expect(harness.messages).toHaveLength(0);
    harness.post('save');
    expect(harness.last('error')).toMatchObject({ operation: 'save', requestId: 1, runId: 1 });
    const started = harness.post('start', { settings: DEFAULTS });
    const responseCount = harness.responseCount;
    harness.raw(started);
    harness.raw({ ...started, runId: 2 });
    expect(harness.responseCount).toBe(responseCount);
    harness.post('save', {}, 0);
    expect(harness.last('error')).toMatchObject({ operation: 'save', requestId: 3, runId: 0 });
    harness.post('export-measurements', { format: 'json' });
    expect(harness.last('measurement-exported')).toMatchObject({ requestId: 4, runId: 1 });
    harness.post('start', { settings: DEFAULTS }, 2);
    const capture = vi.spyOn(Ecosystem.prototype, 'measurements');
    harness.raw({ type: 'export-measurements', runId: 2, requestId: 4, format: 'csv' });
    expect(capture).not.toHaveBeenCalled();
    harness.post('export-measurements', { format: 'csv' }, 2);
    expect(capture).toHaveBeenCalledTimes(1);
    capture.mockImplementationOnce(() => {
      throw new Error('x'.repeat(1000));
    });
    harness.post('export-measurements', { format: 'json' }, 2);
    expect(harness.last('error')).toMatchObject({
      operation: 'export-measurements',
      format: 'json',
      requestId: 7,
      runId: 2,
    });
    expect(harness.last('error').message.length).toBe(512);
    harness.post('export-measurements', { format: 'json' }, 2);
    expect(harness.last('measurement-exported').requestId).toBe(8);
    vi.spyOn(Ecosystem.prototype, 'frame').mockImplementationOnce(() => {
      throw new Error('injected snapshot failure');
    });
    harness.raw({ type: 'snapshot' });
    expect(harness.last('error')).toEqual({
      type: 'error',
      runId: 2,
      message: 'injected snapshot failure',
    });
    harness.post('save', {}, 2);
    const beforeFailure = harness.last('saved').text;
    harness.post('start', { settings: { ...DEFAULTS, nutrients: -1 } }, 3);
    expect(harness.last('error')).toMatchObject({
      operation: 'start',
      runId: 3,
      recovery: { settings: DEFAULTS },
    });
    harness.post('save', {}, 3);
    expect(harness.last('saved').text).toBe(beforeFailure);
    vi.mocked(Ecosystem.prototype.frame).mockImplementationOnce(() => {
      throw new Error('injected recovery failure');
    });
    harness.post('start', { settings: { ...DEFAULTS, nutrients: -1 } }, 4);
    expect(harness.last('error')).toMatchObject({
      operation: 'start',
      runId: 4,
      fatal: true,
      message: 'injected recovery failure',
    });
  });
  it('coalesces only real applied portions, preserves mid-stroke reads and rejects mismatched/closed commands', () => {
    const harness = protocol();
    harness.post('start', { settings: DEFAULTS });
    harness.raw({ type: 'pause' });
    harness.post('begin-stroke', { strokeId: 1, tool: 'food', radius: 0 });
    harness.post('begin-stroke', { strokeId: 2, tool: 'food', radius: 0 });
    expect(harness.last('error').operation).toBe('begin-stroke');
    const paint = (x: number, strokeId = 1) =>
      harness.post('paint', { strokeId, tool: 'food', radius: 0, x, y: 1, genome: founder(0) });
    paint(1, 2);
    expect(harness.last('error').operation).toBe('paint');
    paint(1);
    expect(harness.last('manual-result')).toMatchObject({ status: 'applied', rowSequence: 1 });
    harness.post('save');
    const before = harness.last('saved').text;
    for (const format of ['csv', 'json']) harness.post('export-measurements', { format });
    expect(JSON.parse(harness.last('measurement-exported').text).snapshot.openStrokeSequence).toBe(
      1,
    );
    harness.raw({ type: 'inspect', x: 1, y: 1 });
    harness.raw({ type: 'snapshot' });
    harness.post('save');
    expect(harness.last('saved').text).toBe(before);
    paint(1);
    expect(harness.last('manual-result')).toMatchObject({ status: 'no-op', rowSequence: null });
    harness.raw({ type: 'step' });
    paint(2);
    harness.post('end-stroke', { strokeId: 2 });
    expect(harness.last('manual-result')).toMatchObject({ status: 'no-op', strokeId: 2 });
    paint(3);
    harness.post('end-stroke', { strokeId: 1 });
    expect(harness.last('manual-result')).toMatchObject({ status: 'applied', strokeId: 1 });
    paint(4);
    expect(harness.last('error').operation).toBe('paint');
    harness.post('save');
    const saved = JSON.parse(harness.last('saved').text) as WorldFile;
    expect(saved.interventions.entries).toEqual([
      {
        sequence: 1,
        origin: 'manual',
        kind: 'paint',
        firstTick: 0,
        lastTick: 1,
        detail: {
          tool: 'food',
          radius: 0,
          first: { x: 1, y: 1 },
          last: { x: 3, y: 1 },
          successfulCommands: 3,
          changedBrushCells: 3,
          removedOrganisms: 0,
        },
      },
    ]);
    expect(Ecosystem.load(harness.last('saved').text).save()).toEqual(saved);
    harness.post('shock', { kind: 'heat' });
    harness.post('shock', { kind: 'heat' });
    expect(harness.last('manual-result')).toMatchObject({ status: 'no-op', rowSequence: null });
  });
  it('fault-injects a four-command worker ceiling; native browser evidence separately executes the actual4096 limit', async () => {
    expect(STROKE_COMMAND_CAPACITY).toBe(4096);
    vi.resetModules();
    vi.doMock('../src/model', async (original) => ({
      ...(await original<object>()),
      STROKE_COMMAND_CAPACITY: 4,
    }));
    const { startWorker: boundedStart } = await import('../src/worker');
    vi.doUnmock('../src/model');
    const harness = protocol(boundedStart);
    const receive = harness.scope.postMessage;
    harness.scope.postMessage = (data, transfer) => {
      if (data.type !== 'frame') receive(data, transfer);
    };
    harness.post('start', { settings: DEFAULTS });
    harness.raw({ type: 'pause' });
    harness.post('begin-stroke', { strokeId: 1, tool: 'food', radius: 0 });
    for (let command = 0; command < 4; command++)
      harness.post('paint', {
        strokeId: 1,
        tool: 'food',
        radius: 0,
        x: 1,
        y: 1,
        genome: founder(0),
      });
    harness.post('paint', { strokeId: 1, tool: 'food', radius: 0, x: 2, y: 1, genome: founder(0) });
    expect(harness.last('error').message).toContain('exhausted');
    harness.post('end-stroke', { strokeId: 1 });
    harness.post('save');
    const saved = JSON.parse(harness.last('saved').text) as WorldFile;
    expect(saved.tick).toBe(0);
    expect(saved.interventions.entries).toHaveLength(1);
    expect(saved.interventions.entries[0]).toMatchObject({
      detail: {
        successfulCommands: 1,
        changedBrushCells: 1,
        first: { x: 1, y: 1 },
        last: { x: 1, y: 1 },
      },
    });
    expect(saved.food).not.toContain(242);
    expect(harness.messages.length).toBeLessThanOrEqual(6);
  });
  it('returns explicit invalid-payload errors and logs only actual placement/settings/shock success', () => {
    const harness = protocol();
    harness.post('start', { settings: DEFAULTS });
    harness.raw({ type: 'pause' });
    for (const tool of ['unknown', 'food']) {
      harness.post('paint', { tool, x: -1, y: 1, radius: 0, genome: founder(0), strokeId: 1 });
      expect(harness.last('error').operation).toBe('paint');
    }
    harness.post('settings', { settings: null });
    expect(harness.last('error').operation).toBe('settings');
    harness.post('paint', { tool: 'plant', x: 1, y: 1, radius: 0, genome: founder(0) });
    expect(harness.last('manual-result')).toMatchObject({ status: 'applied', rowSequence: 1 });
    harness.post('paint', { tool: 'plant', x: 1, y: 1, radius: 0, genome: founder(0) });
    expect(harness.last('manual-result')).toMatchObject({ status: 'no-op', rowSequence: null });
    harness.post('settings', { settings: { nutrients: 7 } });
    expect(harness.last('manual-result')).toMatchObject({ status: 'applied', rowSequence: 2 });
    harness.post('shock', { kind: 'cold' });
    expect(harness.last('manual-result')).toMatchObject({ status: 'applied', rowSequence: 3 });
    harness.post('save');
    expect(
      JSON.parse(harness.last('saved').text).interventions.entries.map((entry: any) => entry.kind),
    ).toEqual(['placement', 'settings', 'shock']);
  });
});
describe('worker control and persistence', () => {
  it('rejects oversized outbound UTF-8 saves nonfatally without download, truncation or scheduling changes', () => {
    const original = JSON.parse(baselineFixtures['telemetry-populated-tick25-world2.json']);
    const file = {
      ...original,
      organisms: original.organisms.map((organism: object) => ({
        ...organism,
        retainedExtension: '',
      })),
    };
    file.organisms[0].retainedExtension = 'x'.repeat(WORLD_MAX_BYTES - JSON.stringify(file).length);
    const text = JSON.stringify(file);
    expect(new TextEncoder().encode(text).byteLength).toBe(WORLD_MAX_BYTES);
    const harness = workerHarness();
    harness.send({ type: 'load', text, runId: 1 });
    harness.send({ type: 'pause' });
    const before = harness.frame(),
      queued = harness.tasks.length,
      savedCount = harness.messages.filter((message) => message.type === 'saved').length;
    const result = harness.send({ type: 'save' });
    expect(result).toMatchObject({
      type: 'error',
      runId: 1,
      message: 'World file exceeds 2.5 MB. World preserved; no download created.',
    });
    expect(result).not.toHaveProperty('fatal');
    expect(result).not.toHaveProperty('recovery');
    expect(harness.messages.filter((message) => message.type === 'saved')).toHaveLength(savedCount);
    expect(harness.frame()).toEqual(before);
    expect(harness.tasks).toHaveLength(queued);
    harness.send({ type: 'step' });
    expect(harness.frame().stats.tick).toBe(before.stats.tick + 1);
  });
  it('keeps boundary extinction pending through blueprint revival and exact paused continuation', () => {
    const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false),
      genome = { ...founder(0), cells: [{ x: 0, y: 0, type: 7 as const }] };
    reference.spawn(genome, 40, 40);
    for (let tick = 0; tick < 90; tick++) reference.step();
    const harness = workerHarness();
    harness.load(reference.save(), 10);
    harness.send({ type: 'pause' });
    harness.advance();
    harness.send({ type: 'paint', tool: 'erase', x: 40, y: 40, radius: 0, genome });
    manualPaint(reference, 'erase', 40, 40, 0, genome);
    const extinct = harness.saveText();
    expect(extinct).toBe(JSON.stringify(reference.save()));
    expect(harness.last().playback).toEqual({
      paused: true,
      pauseOnExtinction: true,
      extinction: { tick: 90, cause: 'manual' },
    });
    expect(harness.last().frame.telemetry.samples.at(-1)).toMatchObject({
      tick: 90,
      population: 1,
    });
    expect(reference.save().telemetry.pending.deaths.manual).toBe(1);
    harness.send({ type: 'inspect', x: 40, y: 40 });
    harness.frame();
    harness.send({ type: 'resume' });
    expect(harness.tasks).toHaveLength(0);
    expect(harness.saveText()).toBe(extinct);
    const blueprint = parseBlueprint(
      serializeBlueprint({ name: 'Revival', description: '', genome }),
    );
    harness.send({
      type: 'paint',
      tool: 'plant',
      x: 80,
      y: 80,
      radius: 0,
      genome: blueprint.genome,
    });
    manualPaint(reference, 'plant', 80, 80, 0, blueprint.genome);
    expect(harness.last().playback).toEqual({
      paused: true,
      pauseOnExtinction: true,
      extinction: null,
    });
    expect(harness.saveText()).toBe(JSON.stringify(reference.save()));
    for (let tick = 91; tick <= 120; tick++) {
      harness.send({ type: 'step' });
      reference.step();
      expect(harness.saveText()).toBe(JSON.stringify(reference.save()));
      expect(harness.tasks).toHaveLength(0);
    }
    expect(harness.last().frame.telemetry.samples.at(-1)).toMatchObject({
      tick: 120,
      population: 1,
      deaths: { manual: 1 },
      births: 0,
    });
    expect(harness.last().playback.paused).toBe(true);
  });

  it('retains recorded telemetry through blueprint placement and exact save/load continuation', () => {
    const reference = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false),
      genome = { ...founder(0), cells: [{ x: 0, y: 0, type: 7 as const }] };
    reference.spawn(genome, 20, 20);
    reference.spawn(genome, 40, 40);
    for (let tick = 0; tick < 65; tick++) reference.step();
    reference.paint('erase', 20, 20, 0, genome);
    const harness = workerHarness();
    harness.send({ type: 'load', runId: 10, text: JSON.stringify(reference.save()) });
    harness.send({ type: 'pause' });
    harness.tasks.shift()!();
    const before = harness.save(),
      blueprint = parseBlueprint(
        serializeBlueprint({ name: 'Retained history', description: '', genome }),
      );
    expect(before.telemetry.samples.map((sample) => sample.tick)).toEqual([30, 60]);
    expect(before.telemetry.pending.deaths.manual).toBe(1);
    expect(before.telemetry.pending.energy.upkeepSpent).toBeGreaterThan(0);
    expect(harness.save()).toEqual(before);
    harness.send({
      type: 'paint',
      tool: 'plant',
      x: 80,
      y: 80,
      radius: 0,
      genome: blueprint.genome,
    });
    manualPaint(reference, 'plant', 80, 80, 0, blueprint.genome);
    const placed = harness.save();
    expect(placed).toEqual(reference.save());
    expect(placed.tick).toBe(before.tick);
    expect(placed.births).toBe(before.births);
    expect(placed.telemetry).toEqual(before.telemetry);
    expect(placed.organisms).toHaveLength(before.organisms.length + 1);
    expect(harness.tasks).toHaveLength(0);
    harness.send({ type: 'load', runId: 11, text: JSON.stringify(placed) });
    harness.send({ type: 'pause' });
    harness.tasks.shift()!();
    expect(harness.save()).toEqual(placed);
    for (let tick = 66; tick <= 95; tick++) {
      harness.send({ type: 'step' });
      reference.step();
      expect(harness.frame().stats.tick).toBe(tick);
      expect(harness.save()).toEqual(reference.save());
      expect(harness.tasks).toHaveLength(0);
    }
    expect(harness.frame().telemetry.samples.map((sample) => sample.tick)).toEqual([30, 60, 90]);
    expect(harness.frame().telemetry.samples.at(-1)!.births).toBe(0);
    expect(harness.frame().telemetry.samples.at(-1)!.deaths.manual).toBe(1);
  });
  it('plants a decoded blueprint only on explicit command while paused and steps exactly once', () => {
    const tasks: (() => void)[] = [],
      scope: Scope = { postMessage: vi.fn(), onmessage: null };
    startWorker(scope, (callback) => tasks.push(callback));
    const send = sender(scope);
    const last = () => vi.mocked(scope.postMessage).mock.calls.at(-1)![0];
    send({ type: 'start', settings: DEFAULTS, runId: 10 });
    send({ type: 'pause' });
    tasks.shift()!();
    send({ type: 'save' });
    const before = last().text;
    const genome = {
      behavior: { version: 1 as const, mode: 'legacy' as const },
      ...founder(2),
      cells: [
        { x: 0, y: 0, type: 3 as const },
        { x: 1, y: 0, type: 4 as const },
        { x: 2, y: 0, type: 5 as const },
        { x: 0, y: 1, type: 6 as const },
        { x: 1, y: 1, type: 7 as const },
        { x: 2, y: 1, type: 8 as const },
      ],
      preference: 0.123456789,
      tolerance: 0.456789,
      tempo: 11,
    };
    const blueprint = parseBlueprint(
      serializeBlueprint({ name: 'Shared genome', description: '', genome }),
    );
    send({ type: 'save' });
    expect(last().text).toBe(before);
    send({ type: 'paint', tool: 'plant', x: 20, y: 20, radius: 0, genome: blueprint.genome });
    expect(last().runId).toBe(10);
    expect(last().frame.stats.tick).toBe(0);
    send({ type: 'inspect', x: 20, y: 20 });
    expect(last().selected).toMatchObject({
      id: 2,
      species: JSON.parse(before).nextSpecies,
      age: 0,
      generation: 0,
      children: 0,
      ancestry: [],
      energy: 14,
      genome,
    });
    blueprint.genome.cells[0].type = 8;
    expect(last().selected.genome).toEqual(genome);
    send({
      type: 'paint',
      tool: 'plant',
      x: 60,
      y: 60,
      radius: 0,
      genome: { ...genome, tempo: 0 },
    });
    send({ type: 'save' });
    expect(JSON.parse(last().text).organisms).toHaveLength(2);
    send({ type: 'step' });
    expect(last().frame.stats.tick).toBe(1);
    expect(tasks).toHaveLength(0);
    send({ type: 'snapshot' });
    expect(last().frame.stats.tick).toBe(1);
    expect(tasks).toHaveLength(0);
  });
  it.each([1, 4, 12])(
    'collects tick-aligned history across actual yielding %ix batches',
    (speed) => {
      const harness = workerHarness(),
        reference = new Ecosystem();
      harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
      harness.send({ type: 'speed', value: speed });
      harness.send({ type: 'resume' });
      harness.send({ type: 'resume' });
      expect(harness.tasks).toHaveLength(1);
      expect(harness.frame().telemetry.samples).toEqual([]);
      for (let batch = 1; batch <= 120 / speed; batch++) {
        harness.tasks.shift()!();
        const emitted = harness.messages.at(-1);
        expect(emitted).toMatchObject({ type: 'frame', runId: 1 });
        expect(emitted.frame.stats.tick).toBe(batch * speed);
        for (let tick = 0; tick < speed; tick++) reference.step();
        expect(harness.tasks).toHaveLength(1);
        const before = harness.saveText(),
          expected = reference.save();
        expect(before).toBe(JSON.stringify(expected));
        const samples = emitted.frame.telemetry.samples;
        expect(samples.map((sample) => sample.tick)).toEqual(
          Array.from({ length: Math.floor((batch * speed) / 30) }, (_, index) => (index + 1) * 30),
        );
        harness.send({ type: 'inspect', x: WIDTH / 2, y: 78 });
        harness.frame();
        for (const format of ['json', 'csv']) {
          harness.send({ type: 'export-measurements', format });
          const exported = harness.last('measurement-exported');
          expect(exported).toMatchObject({
            operation: 'export-measurements',
            runId: 1,
            format,
            completedTick: batch * speed,
            seed: DEFAULTS.seed,
          });
          expect(new TextEncoder().encode(exported.text).byteLength).toBe(exported.byteLength);
          if (format === 'json') {
            const measurement = JSON.parse(exported.text);
            expect(measurement.telemetry).toEqual(expected.telemetry);
            expect(measurement.interventions).toEqual(expected.interventions);
            expect(measurement.snapshot.completedTick).toBe(expected.tick);
            expect(measurement.snapshot.settings).toEqual(expected.settings);
          }
        }
        expect(harness.saveText()).toBe(before);
        expect(harness.messages).toHaveLength(5);
        expect(harness.messages.filter((message) => message.type === 'frame')).toHaveLength(1);
      }
      harness.send({ type: 'pause' });
      harness.tasks.shift()!();
      expect(harness.tasks).toHaveLength(0);
    },
  );

  it('keeps paused edits and boundary steps real, restores pending state, and fails loads atomically under the incoming run ID', () => {
    const world = new Ecosystem();
    for (let tick = 0; tick < 29; tick++) world.step();
    const harness = workerHarness();
    harness.send({ type: 'pause-on-extinction', runId: 0, value: false });
    harness.send({ type: 'load', runId: 5, text: JSON.stringify(world.save()) });
    harness.send({ type: 'pause' });
    harness.tasks.shift()!();
    expect(harness.frame().telemetry.samples).toEqual([]);
    harness.send({ type: 'inspect', x: 120, y: 78 });
    expect(harness.messages.at(-1).selected.id).toBe(1);
    harness.send({ type: 'step' });
    expect(harness.frame().stats.tick).toBe(30);
    const history = harness.frame().telemetry.samples;
    expect(history.map((sample) => sample.tick)).toEqual([30]);
    harness.send({ type: 'paint', tool: 'erase', x: 120, y: 78, radius: 0, genome: founder(0) });
    harness.send({ type: 'settings', settings: { nutrients: 0 } });
    harness.send({ type: 'shock', kind: 'heat' });
    harness.frame();
    harness.frame();
    expect(harness.frame().telemetry.samples).toEqual(history);
    expect(harness.frame().telemetry.pending).toMatchObject({
      fromTick: 30,
      deaths: { manual: 1 },
    });
    harness.send({ type: 'paint', tool: 'plant', x: 40, y: 40, radius: 0, genome: founder(0) });
    harness.send({ type: 'inspect', x: 40, y: 40 });
    const before = harness.save(),
      selected = harness.messages.filter((message) => message.type === 'frame').at(-1).selected;
    for (const corrupt of [
      (file: any) => {
        file.telemetry.intervalTicks = 12;
      },
      (file: any) => {
        file.telemetry.samples[0].energy.upkeepSpent = -1;
      },
      (file: any) => {
        file.telemetry.pending.deaths.manual = 2;
      },
    ]) {
      const invalid = structuredClone(before);
      corrupt(invalid);
      const error = harness.send({ type: 'load', runId: 6, text: JSON.stringify(invalid) });
      expect(error).toMatchObject({ type: 'error', runId: 6 });
      const recovered = harness.send({ type: 'snapshot' });
      expect(recovered.runId).toBe(6);
      expect(recovered.selected).toEqual(selected);
      expect(harness.save()).toEqual(before);
      expect(harness.tasks).toHaveLength(0);
    }
    harness.send({ type: 'step' });
    expect(harness.frame().stats.tick).toBe(31);
    expect(harness.frame().telemetry.samples).toEqual(history);
    const pending = harness.save();
    harness.send({ type: 'load', runId: 7, text: JSON.stringify(pending) });
    expect(harness.frame().telemetry).toEqual(pending.telemetry);
    const reference = Ecosystem.load(JSON.stringify(pending));
    harness.send({ type: 'speed', value: 12 });
    for (let batch = 0; batch < 10; batch++) {
      harness.tasks.shift()!();
      for (let tick = 0; tick < 12; tick++) reference.step();
    }
    expect(harness.save()).toEqual(reference.save());
  });

  it.each([0.12, 0.6])(
    'observes real endpoint colonies at tolerance %s inside 12-tick batches and continues through JSON',
    (tolerance) => {
      for (const population of [31, 100, 1600]) {
        const reference = new Ecosystem(
          { ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 },
          false,
        );
        for (let position = 0; position < population; position++)
          reference.spawn(
            {
              behavior: { version: 1 as const, mode: 'legacy' as const },
              cells: [{ x: 0, y: 0, type: 7 }],
              preference: 0.5,
              tolerance,
              tempo: 2,
            },
            position % WIDTH,
            Math.floor(position / WIDTH),
          );
        for (let tick = 0; tick < 24; tick++) reference.step();
        const harness = workerHarness();
        harness.send({ type: 'load', runId: 1, text: JSON.stringify(reference.save()) });
        harness.send({ type: 'speed', value: 12 });
        expect(harness.frame().telemetry.samples).toEqual([]);
        harness.tasks.shift()!();
        for (let tick = 0; tick < 6; tick++) reference.step();
        const first = reference.save().telemetry.samples[0];
        expect(first).toMatchObject({
          tick: 30,
          population,
          meanPreference: 0.5,
          meanTolerance: tolerance,
        });
        for (let tick = 0; tick < 6; tick++) reference.step();
        expect(harness.save()).toEqual(reference.save());
        expect(harness.frame().telemetry.samples[0]).toEqual(first);
        expect(harness.frame().telemetry.pending.fromTick).toBe(30);
        const midpoint = harness.save();
        harness.send({ type: 'load', runId: 2, text: JSON.stringify(midpoint) });
        expect(harness.save()).toEqual(midpoint);
        for (let batch = 0; batch < 5; batch++) {
          harness.tasks.shift()!();
          for (let tick = 0; tick < 12; tick++) reference.step();
          expect(harness.save()).toEqual(reference.save());
        }
        expect(harness.frame().stats.tick).toBe(96);
        expect(harness.frame().telemetry.samples.at(-1)).toMatchObject({
          tick: 90,
          population,
          meanTolerance: tolerance,
        });
        for (let batch = 0; batch < 9; batch++) {
          harness.tasks.shift()!();
          harness.send({ type: 'inspect', x: 0, y: 0 });
          harness.frame();
          for (let tick = 0; tick < 12; tick++) reference.step();
        }
        expect(harness.save()).toEqual(reference.save());
        const invalid = harness.save();
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, tolerance, false);
        view.setBigUint64(0, view.getBigUint64(0, false) + (tolerance === 0.12 ? -1n : 1n), false);
        invalid.telemetry.samples[0].meanTolerance = view.getFloat64(0, false);
        expect(
          harness.send({ type: 'load', runId: 3, text: JSON.stringify(invalid) }),
        ).toMatchObject({ type: 'error', runId: 3 });
        expect(harness.save()).toEqual(reference.save());
      }
    },
    30000,
  );

  it('restores and transports a complete wrapped history without synthetic read/edit samples', () => {
    const world = new Ecosystem(DEFAULTS, false);
    for (let tick = 0; tick < 5430; tick++) world.step();
    const harness = workerHarness();
    harness.send({ type: 'pause-on-extinction', runId: 0, value: false });
    harness.send({ type: 'load', runId: 1, text: JSON.stringify(world.save()) });
    harness.send({ type: 'pause' });
    harness.tasks.shift()!();
    expect(harness.frame().telemetry.samples).toHaveLength(180);
    expect(harness.frame().telemetry.samples[0].tick).toBe(60);
    harness.send({ type: 'paint', tool: 'food', x: 30, y: 30, radius: 0, genome: founder(0) });
    const before = harness.save().telemetry;
    harness.send({ type: 'inspect', x: 30, y: 30 });
    harness.frame();
    expect(harness.save().telemetry).toEqual(before);
    harness.send({ type: 'resume' });
    harness.send({ type: 'speed', value: 12 });
    for (let batch = 0; batch < 3; batch++) harness.tasks.shift()!();
    expect(harness.frame().telemetry.samples).toHaveLength(180);
    expect(harness.frame().telemetry.samples[0].tick).toBe(90);
    expect(harness.frame().telemetry.samples.at(-1)!.tick).toBe(5460);
    expect(harness.frame().telemetry.pending.fromTick).toBe(5460);
  });

  it('uses one yielding loop, obeys pause and speed, and processes edits while paused', () => {
    const tasks: (() => void)[] = [],
      scope: Scope = { postMessage: vi.fn(), onmessage: null };
    startWorker(scope, (cb) => tasks.push(cb));
    const send = sender(scope),
      last = () => vi.mocked(scope.postMessage).mock.calls.at(-1)![0];
    send({ type: 'snapshot' });
    send({ type: 'resume' });
    tasks.shift()!();
    expect(last()).toMatchObject({ type: 'playback', playback: { pauseOnExtinction: true } });
    send({ type: 'start', settings: {}, runId: 1 });
    expect(last().type).toBe('error');
    send({ type: 'start', settings: DEFAULTS, runId: 1 });
    expect(last().frame.stats).toMatchObject({
      tick: 0,
      population: 1,
      births: 0,
      species: 1,
      food: 0,
    });
    send({ type: 'resume' });
    expect(tasks).toHaveLength(1);
    send({ type: 'pause' });
    tasks.shift()!();
    expect(tasks).toHaveLength(0);
    send({ type: 'speed', value: 12 });
    send({ type: 'speed', value: 999 });
    send({ type: 'resume' });
    tasks.shift()!();
    expect(last().frame.stats.tick).toBe(12);
    send({ type: 'pause' });
    send({ type: 'step' });
    expect(last().frame.stats.tick).toBe(13);
    send({ type: 'settings', settings: { nutrients: 10 } });
    send({ type: 'settings', settings: { nutrients: -1 } });
    const beforeBloom = vi.mocked(scope.postMessage).mock.calls.length;
    send({ type: 'shock', kind: 'bloom' });
    expect(scope.postMessage).toHaveBeenCalledTimes(beforeBloom + 1);
    expect(last()).toMatchObject({ type: 'error', operation: 'shock' });
    send({ type: 'paint', tool: 'food', x: 20, y: 20, radius: 2, genome: founder(0) });
    send({ type: 'paint', tool: 'plant', x: 40, y: 40, radius: 0, genome: founder(0) });
    send({ type: 'inspect', x: 40, y: 40 });
    expect(last().selected).not.toBeNull();
    send({ type: 'shock', kind: 'cold' });
    expect(last().frame.stats.event).toContain('Cold snap');
    send({ type: 'save' });
    const save = last().text;
    expect(JSON.parse(save).settings.nutrients).toBe(10);
    send({ type: 'load', text: save, runId: 2 });
    expect(last().runId).toBe(2);
    expect(last().frame.stats.tick).toBe(13);
    send({ type: 'load', text: '{}', runId: 3 });
    expect(last().type).toBe('error');
    expect(last().runId).toBe(3);
    send({ type: 'snapshot' });
    expect(last().frame.stats.tick).toBe(13);
    const savedPopulation = JSON.parse(save).organisms.length;
    expect(savedPopulation).toBeGreaterThan(1);
    expect(last().frame.stats.population).toBe(savedPopulation);
    send({ type: 'start', settings: { ...DEFAULTS, seed: 123 }, runId: 4 });
    expect(last().runId).toBe(4);
    expect(last().frame.stats).toMatchObject({ tick: 0, population: 1, births: 0, species: 1 });
    send({ type: 'unknown' });
  });
  it('reports failed ticks and reads without duplicating evaluation', () => {
    vi.useFakeTimers();
    const scope: Scope = { postMessage: vi.fn(), onmessage: null };
    startWorker(scope);
    const send = sender(scope);
    send({ type: 'start', settings: DEFAULTS, runId: 4 });
    const step = vi.spyOn(Ecosystem.prototype, 'step').mockImplementation(() => {
      throw new Error('Failed tick');
    });
    vi.runAllTimers();
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed tick', fatal: true }),
    );
    step.mockImplementation(() => {
      throw 'failed';
    });
    send({ type: 'resume' });
    vi.runAllTimers();
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'failed' }),
    );
    vi.spyOn(Ecosystem, 'load').mockImplementation(() => {
      throw 'unreadable';
    });
    send({ type: 'load', text: 'x', runId: 5 });
    expect(vi.mocked(scope.postMessage).mock.calls.at(-1)![0]).toMatchObject({
      message: 'unreadable',
      recovery: { playback: { paused: true } },
    });
  });
  it('boots automatically in a worker context', async () => {
    vi.stubGlobal('document', undefined);
    const scope = { postMessage: vi.fn(), onmessage: null };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('../src/worker');
    expect(scope.onmessage).toBeTypeOf('function');
  });
});

describe('authoritative extinction playback', () => {
  for (const speed of [1, 4, 12]) {
    for (let offset = 1; offset <= speed; offset++) {
      it(`stops at extinct tick ${offset} of a ${speed}-tick batch by default`, () => {
        const harness = workerHarness();
        const file = terminalWorld(offset);
        harness.send({ type: 'speed', value: speed });
        harness.load(file);
        expect(harness.last().playback).toEqual({
          paused: false,
          pauseOnExtinction: true,
          extinction: null,
        });
        harness.advance();
        const expected = Ecosystem.load(JSON.stringify(file));
        for (let step = 0; step < offset; step++) expected.step();
        expect(harness.last()).toMatchObject({
          frame: { stats: { tick: file.tick + offset, population: 0 } },
          playback: {
            paused: true,
            pauseOnExtinction: true,
            extinction: { tick: file.tick + offset, cause: 'age' },
          },
          selected: null,
        });
        expect(harness.tasks).toHaveLength(0);
        expect(harness.save()).toEqual(expected.save());

        const unguarded = workerHarness();
        unguarded.send({ type: 'pause-on-extinction', runId: 0, value: false });
        unguarded.send({ type: 'speed', value: speed });
        unguarded.load(file);
        unguarded.advance();
        expect(unguarded.last().frame.stats.tick).toBe(file.tick + speed);
        expect(unguarded.last().playback).toEqual({
          paused: false,
          pauseOnExtinction: false,
          extinction: { tick: file.tick + offset, cause: 'age' },
        });
        expect(unguarded.tasks).toHaveLength(1);
        for (let step = offset; step < speed; step++) harness.send({ type: 'step' });
        expect(harness.save()).toEqual(unguarded.save());
        unguarded.advance();
        expect(unguarded.last().playback.extinction.tick).toBe(file.tick + offset);
        expect(unguarded.last().frame.stats.population).toBe(0);
      });
    }
    it(`stops at real energy exhaustion in a ${speed}-tick batch`, () => {
      const harness = workerHarness();
      harness.send({ type: 'speed', value: speed });
      harness.load(terminalWorld(30, 0.001));
      harness.advance();
      expect(harness.last()).toMatchObject({
        frame: { stats: { tick: 72, population: 0 } },
        playback: { paused: true, extinction: { tick: 72, cause: 'energy' } },
      });
      expect(harness.tasks).toHaveLength(0);
    });
  }

  it.each([true, false])(
    'retains session preference %s across reseed, loads and failures',
    (preference) => {
      const harness = workerHarness();
      harness.send({ type: 'start', runId: 1, settings: DEFAULTS });
      harness.send({ type: 'pause-on-extinction', runId: 1, value: preference });
      harness.send({ type: 'start', runId: 2, settings: { ...DEFAULTS, seed: 123 } });
      expect(harness.last().playback).toEqual({
        paused: false,
        pauseOnExtinction: preference,
        extinction: null,
      });
      expect(harness.tasks).toHaveLength(1);
      harness.load(terminalWorld(), 3);
      const empty = terminalWorld();
      empty.organisms = [];
      harness.load(empty, 4);
      expect(harness.last('loaded').playback).toEqual({
        paused: preference,
        pauseOnExtinction: preference,
        extinction: { tick: 71, cause: 'empty-import' },
      });
      expect(harness.last().frame.stats.tick).toBe(71);
      const saved = harness.save();
      expect(saved).toEqual(Ecosystem.load(JSON.stringify(empty)).save());
      harness.send({ type: 'load', runId: 5, text: '{}' });
      expect(harness.last('error').recovery.playback).toEqual(harness.last().playback);
      expect(harness.save()).toEqual(saved);
      harness.advance();
      expect(harness.save().tick).toBe(preference ? 71 : 75);
      expect(harness.tasks).toHaveLength(preference ? 0 : 1);
      harness.load(terminalWorld(12), 6);
      expect(harness.last().playback).toEqual({
        paused: false,
        pauseOnExtinction: preference,
        extinction: null,
      });
      harness.send({ type: 'start', runId: 7, settings: DEFAULTS });
      harness.advance();
      expect(harness.last()).toMatchObject({
        runId: 7,
        frame: { stats: { tick: 4, population: 1 } },
        playback: { extinction: null, pauseOnExtinction: preference },
      });
      const fresh = workerHarness();
      fresh.send({ type: 'start', runId: 1, settings: DEFAULTS });
      expect(fresh.last().playback.pauseOnExtinction).toBe(true);
    },
  );

  it.each([true, false])(
    'loads an empty world before advancement with preference %s and no pending loop',
    (preference) => {
      const harness = workerHarness();
      if (!preference) harness.send({ type: 'pause-on-extinction', runId: 0, value: false });
      const empty = terminalWorld();
      empty.organisms = [];
      harness.load(empty);
      expect(harness.save()).toEqual(Ecosystem.load(JSON.stringify(empty)).save());
      expect(harness.last().playback.extinction).toEqual({ tick: 71, cause: 'empty-import' });
      expect(harness.tasks).toHaveLength(preference ? 0 : 1);
    },
  );

  it.each([true, false])(
    'manual last erasure pauses at its command tick, with prior pause %s',
    (alreadyPaused) => {
      for (const preference of [true, false]) {
        const harness = workerHarness();
        harness.load(terminalWorld(20));
        if (!preference) harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
        if (alreadyPaused) harness.send({ type: 'pause' });
        harness.send({ type: 'paint', tool: 'erase', x: 40, y: 40, radius: 0, genome: mouth });
        expect(harness.last()).toMatchObject({
          frame: { stats: { tick: 71, population: 0, deaths: 5 } },
          playback: {
            paused: preference || alreadyPaused,
            extinction: { tick: 71, cause: 'manual' },
          },
        });
        const saved = harness.save();
        expect(saved.food).toEqual([index(5, 5)]);
        expect(saved.walls).toEqual([index(6, 6)]);
        harness.advance();
        expect(harness.save().tick).toBe(preference || alreadyPaused ? 71 : 75);
      }
    },
  );

  it('keeps paused editing, inspection, saving, exact Step and intentional placement usable', () => {
    const harness = workerHarness();
    harness.load(terminalWorld());
    harness.send({ type: 'pause' });
    harness.send({ type: 'inspect', x: 40, y: 40 });
    expect(harness.last().selected.id).toBe(1);
    harness.send({ type: 'step' });
    expect(harness.last().playback.extinction).toEqual({ tick: 72, cause: 'age' });
    expect(harness.last().selected).toBeNull();
    harness.send({ type: 'step' });
    expect(harness.last().frame.stats.tick).toBe(73);
    expect(harness.last().playback).toMatchObject({ paused: true, extinction: { tick: 72 } });
    for (let attempt = 0; attempt < 3; attempt++) {
      harness.send({ type: 'resume' });
      harness.send({ type: 'speed', value: 12 });
      expect(harness.last('playback').playback.paused).toBe(true);
      expect(harness.tasks).toHaveLength(1);
    }
    harness.advance();
    expect(harness.tasks).toHaveLength(0);
    const before = harness.save();
    harness.send({ type: 'inspect', x: 40, y: 40 });
    harness.send({ type: 'paint', tool: 'plant', x: 6, y: 6, radius: 0, genome: mouth });
    expect(harness.last().playback.extinction).toEqual({ tick: 72, cause: 'age' });
    const afterBlocked = harness.save();
    harness.send({ type: 'paint', tool: 'wall', x: 9, y: 9, radius: 0, genome: mouth });
    harness.send({ type: 'paint', tool: 'food', x: 8, y: 8, radius: 0, genome: mouth });
    harness.send({ type: 'shock', kind: 'heat' });
    harness.send({ type: 'settings', settings: { nutrients: 7 } });
    expect(harness.save()).toMatchObject({
      tick: before.tick,
      random: afterBlocked.random,
      births: before.births,
      deaths: before.deaths,
      settings: { nutrients: 7 },
      eventOffset: 0.32,
    });
    expect(harness.save()).not.toHaveProperty('pauseOnExtinction');
    expect(harness.save()).not.toHaveProperty('extinction');
    expect(harness.save()).not.toHaveProperty('lastDeath');
    harness.send({ type: 'paint', tool: 'plant', x: 60, y: 60, radius: 0, genome: mouth });
    expect(harness.last().playback).toEqual({
      paused: true,
      pauseOnExtinction: true,
      extinction: null,
    });
    expect(harness.last().frame.stats.population).toBe(1);
    expect(harness.tasks).toHaveLength(0);
    harness.send({ type: 'resume' });
    harness.send({ type: 'resume' });
    expect(harness.tasks).toHaveLength(1);
    harness.advance();
    expect(harness.last().frame.stats.tick).toBe(85);
  });

  it('toggles only valid current-run booleans and requires a separate Resume after disabling', () => {
    const harness = workerHarness();
    harness.load(terminalWorld());
    for (const value of ['true', 1, null, undefined, {}, []]) {
      const count = harness.responseCount;
      harness.send({ type: 'pause-on-extinction', runId: 1, value });
      expect(harness.responseCount).toBe(count);
    }
    harness.send({ type: 'pause-on-extinction', runId: 0, value: false });
    expect(harness.last().playback.pauseOnExtinction).toBe(true);
    harness.send({ type: 'pause-on-extinction', runId: 1, value: true });
    expect(harness.last('playback').playback.paused).toBe(false);
    harness.advance();
    const before = harness.save();
    for (let repeat = 0; repeat < 2; repeat++)
      harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
    expect(harness.last('playback').playback).toMatchObject({
      paused: true,
      pauseOnExtinction: false,
    });
    expect(harness.tasks).toHaveLength(0);
    expect(harness.save()).toEqual(before);
    harness.send({ type: 'resume' });
    harness.advance();
    expect(harness.last().frame.stats.tick).toBe(76);
    harness.send({ type: 'pause-on-extinction', runId: 1, value: true });
    expect(harness.last('playback').playback).toEqual({
      paused: true,
      pauseOnExtinction: true,
      extinction: { tick: 72, cause: 'age' },
    });
    const enabled = harness.save();
    harness.advance();
    expect(harness.save()).toEqual(enabled);
    expect(harness.tasks).toHaveLength(0);
  });

  it.each([true, false])(
    'keeps exact empty Step paused with preference %s without replacing the extinction record',
    (preference) => {
      const harness = workerHarness();
      const empty = terminalWorld();
      empty.organisms = [];
      harness.load(empty);
      if (!preference) harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
      const before = harness.save();
      harness.send({ type: 'step' });
      const expected = Ecosystem.load(JSON.stringify(before));
      expected.step();
      expect(harness.save()).toEqual(expected.save());
      expect(harness.last().playback).toEqual({
        paused: true,
        pauseOnExtinction: preference,
        extinction: { tick: before.tick, cause: 'empty-import' },
      });
      expect(harness.tasks).toHaveLength(0);
    },
  );
});

describe('integrated extinction and telemetry', () => {
  for (const speed of [1, 4, 12]) {
    for (const atTick of [89, 90]) {
      for (const cause of ['age', 'energy'] as const) {
        it(`completes ${cause} accounting at tick ${atTick + 1} before stopping a ${speed}-tick batch`, () => {
          const harness = workerHarness();
          const file = terminalWorld(cause === 'age' ? 1 : 30, cause === 'age' ? 5 : 0.001, atTick);
          const reference = Ecosystem.load(JSON.stringify(file));
          harness.send({ type: 'speed', value: speed });
          harness.load(file);
          harness.advance();
          reference.step();
          const terminal = harness.save();
          expect(terminal).toEqual(reference.save());
          expect(harness.last('frame').playback).toEqual({
            paused: true,
            pauseOnExtinction: true,
            extinction: { tick: atTick + 1, cause },
          });
          expect(harness.tasks).toHaveLength(0);
          if (atTick === 89) {
            expect(terminal.telemetry.samples.at(-1)).toMatchObject({
              tick: 90,
              population: 0,
              cellCounts: [0, 0, 0, 0, 0, 0],
              meanPreference: null,
              meanTolerance: null,
              deaths: {
                age: cause === 'age' ? 1 : 0,
                energy: cause === 'energy' ? 1 : 0,
                manual: 0,
              },
            });
            expect(terminal.telemetry.pending.deaths).toEqual({ age: 0, energy: 0, manual: 0 });
          } else {
            expect(terminal.telemetry.samples).toEqual(file.telemetry.samples);
            expect(terminal.telemetry.samples.at(-1)).toMatchObject({ tick: 90, population: 1 });
            expect(terminal.telemetry.pending.deaths[cause]).toBe(1);
          }
          expect(terminal.telemetry.pending.fromTick).toBe(90);
          harness.send({ type: 'load', runId: 2, text: '{}' });
          expect(harness.last('error').recovery.frame.telemetry).toEqual(terminal.telemetry);
          expect(harness.save()).toEqual(terminal);
          expect(harness.tasks).toHaveLength(0);
          const unguarded = workerHarness();
          unguarded.send({ type: 'pause-on-extinction', runId: 0, value: false });
          unguarded.send({ type: 'speed', value: speed });
          unguarded.load(file);
          unguarded.advance();
          for (let tick = 1; tick < speed; tick++) harness.send({ type: 'step' });
          expect(harness.save()).toEqual(unguarded.save());
          expect(unguarded.last('frame').playback.extinction).toEqual({ tick: atTick + 1, cause });
          expect(unguarded.tasks).toHaveLength(1);
        });
      }
    }
  }

  it('keeps same-boundary manual erasure pending through failed load, placement and exact continuation', () => {
    const harness = workerHarness();
    const file = terminalWorld(30, 5, 90);
    harness.load(file);
    harness.send({ type: 'paint', tool: 'erase', x: 40, y: 40, radius: 0, genome: mouth });
    const erased = harness.save();
    expect(erased.tick).toBe(90);
    expect(erased.telemetry.samples).toEqual(file.telemetry.samples);
    expect(erased.telemetry.samples.at(-1)).toMatchObject({ tick: 90, population: 1 });
    expect(erased.telemetry.pending).toMatchObject({ fromTick: 90, deaths: { manual: 1 } });
    expect(harness.last('frame').playback.extinction).toEqual({ tick: 90, cause: 'manual' });
    harness.advance();
    expect(harness.tasks).toHaveLength(0);
    harness.send({ type: 'load', runId: 2, text: '{}' });
    expect(harness.last('error').recovery.frame.telemetry).toEqual(erased.telemetry);
    expect(harness.save()).toEqual(erased);
    harness.send({ type: 'pause-on-extinction', runId: 2, value: false });
    expect(harness.tasks).toHaveLength(0);
    harness.send({ type: 'paint', tool: 'plant', x: 40, y: 40, radius: 0, genome: mouth });
    expect(harness.last('frame').playback).toEqual({
      paused: true,
      pauseOnExtinction: false,
      extinction: null,
    });
    const placed = harness.save();
    expect(placed.telemetry).toEqual(erased.telemetry);
    expect(placed.births).toBe(erased.births);
    const reference = Ecosystem.load(JSON.stringify(placed));
    for (let tick = 0; tick < 30; tick++) {
      harness.send({ type: 'step' });
      reference.step();
    }
    expect(harness.save()).toEqual(reference.save());
    expect(harness.save().telemetry.samples.at(-1)).toMatchObject({
      tick: 120,
      deaths: { manual: 1 },
    });
    expect(harness.tasks).toHaveLength(0);
  });

  it.each([2, 3, 4, 5, 6])(
    'migrates/restores v%i then preserves terminal and pending history through an empty save continuation',
    (version) => {
      const harness = workerHarness();
      const current = terminalWorld(1, 5, 89);
      const historical = syntheticHistoricalWorld(current);
      const { telemetry: _telemetry, interventions: _interventions, ...legacy } = historical;
      const file =
        version === 2
          ? { ...legacy, version: 2 as const }
          : version === 3
            ? legacyV3(current)
            : version === 4
              ? legacyV4(current)
              : version === 5
                ? historical
                : current;
      expect(file.version).toBe(version);
      if (file.version === 2) expect(file).not.toHaveProperty('telemetry');
      else {
        expect(file.telemetry.version).toBe(version === 3 ? 1 : 2);
        expect(file.telemetry.samples.map((sample) => sample.tick)).toEqual([30, 60]);
        expect(file.telemetry.pending.energy.upkeepSpent).toBeGreaterThan(0);
        if (file.version === 3) {
          expect(file.telemetry).not.toHaveProperty('adaptationOriginTick');
          for (const sample of file.telemetry.samples)
            expect(sample).not.toHaveProperty('adaptation');
        }
      }
      harness.send({ type: 'load', runId: 1, text: JSON.stringify(file) });
      const reference = Ecosystem.load(JSON.stringify(file));
      const imported = harness.save();
      expect(imported).toEqual(reference.save());
      expect(imported.telemetry.originTick).toBe(version === 2 ? 89 : 0);
      expect(imported.telemetry.adaptationOriginTick).toBe(version >= 4 ? 0 : 89);
      if (file.version === 3)
        expect(imported.telemetry).toEqual({
          ...file.telemetry,
          version: 2,
          adaptationOriginTick: file.tick,
          samples: file.telemetry.samples.map((sample) => ({ ...sample, adaptation: null })),
        });
      if (file.version >= 4) {
        expect(file.version === 6 ? imported : restoreHistoricalWorld(imported)).toEqual(
          file.version >= 5
            ? file
            : {
                ...file,
                version: 5,
                interventions: {
                  version: 1,
                  originTick: file.tick,
                  originKind: 'legacy-import',
                  originSettings: { ...file.settings },
                  prefixSettings: { ...file.settings },
                  totalEntries: 0,
                  evictedThroughTick: null,
                  entries: [],
                },
              },
        );
        expect(file.telemetry.adaptationOriginTick).toBe(0);
        for (const sample of file.telemetry.samples) expect(sample.adaptation).not.toBeNull();
      }
      harness.advance();
      reference.step();
      const terminal = harness.save();
      expect(terminal.version).toBe(6);
      expect(terminal.telemetry.version).toBe(2);
      expect(terminal.telemetry.samples.at(-1)).toMatchObject({
        fromTick: version === 2 ? 89 : 60,
        tick: 90,
        population: 0,
        deaths: { age: 1 },
        adaptation: { preferenceBins: Array(10).fill(0), stressedOrganisms: 0 },
      });
      expect(terminal.telemetry.samples.slice(0, imported.telemetry.samples.length)).toEqual(
        imported.telemetry.samples,
      );
      const terminalText = harness.saveText();
      harness.load(terminal, 2);
      expect(harness.saveText()).toBe(terminalText);
      expect(harness.last('frame').playback.extinction).toEqual({
        tick: 90,
        cause: 'empty-import',
      });
      expect(harness.tasks).toHaveLength(0);
      for (let tick = 0; tick < 105; tick++) {
        harness.send({ type: 'step' });
        reference.step();
      }
      expect(harness.save()).toEqual(reference.save());
      expect(harness.save().telemetry.samples.map((sample) => sample.tick)).toEqual(
        version === 2 ? [90, 120, 150, 180] : [30, 60, 90, 120, 150, 180],
      );
      expect(harness.save().telemetry.adaptationOriginTick).toBe(version >= 4 ? 0 : 89);
      expect(harness.last('frame').playback.paused).toBe(true);
    },
  );
});

describe('failed-load retained-world recovery', () => {
  it('recovers a held terminal frame immediately under the adopted ID without mutation or scheduling', () => {
    const frameSpy = vi.spyOn(Ecosystem.prototype, 'frame');
    const harness = workerHarness();
    harness.load(terminalWorld());
    harness.send({ type: 'inspect', x: 40, y: 40 });
    harness.advance();
    const retained = frameSpy.mock.contexts.at(-1)!;
    const record = structuredClone(retained.lastDeath);
    const before = harness.save();
    const held = harness.last();
    const count = harness.responseCount;
    harness.send({ type: 'load', runId: 2, text: '{}' });
    expect(harness.responseCount).toBe(count + 1);
    const recovery = harness.last('error');
    expect(recovery).toMatchObject({
      type: 'error',
      runId: 2,
      recovery: {
        frame: { stats: { tick: 72, population: 0 } },
        selected: null,
        settings: before.settings,
        playback: { paused: true, pauseOnExtinction: true, extinction: { tick: 72, cause: 'age' } },
      },
    });
    expect(recovery).not.toHaveProperty('fatal');
    expect(recovery.recovery.frame).toEqual(held.frame);
    expect(frameSpy.mock.contexts.at(-1)).toBe(retained);
    expect(retained.lastDeath).toEqual(record);
    expect(retained.save()).toEqual(before);
    expect(harness.tasks).toHaveLength(0);
    for (let repeat = 0; repeat < 2; repeat++)
      harness.send({ type: 'load', runId: 3 + repeat, text: 'not json' });
    expect(harness.transferStats.batches).toBeGreaterThan(0);
    expect(harness.transferStats.buffers).toBe(harness.transferStats.batches * 2);
    expect(harness.transferStats.duplicates).toBe(0);
    expect(harness.transferStats.detached).toBe(harness.transferStats.buffers);
    expect(harness.save()).toEqual(before);
    harness.load(terminalWorld(12), 5);
    expect(harness.last().playback.extinction).toBeNull();
    expect(harness.tasks).toHaveLength(1);
  });

  it.each(['selected-pause', 'off-paused', 'enable-empty', 'off-running'])(
    'recovers delayed %s controls with the retained mode and selection',
    (scenario) => {
      const harness = workerHarness();
      harness.load(terminalWorld());
      harness.send({ type: 'inspect', x: 40, y: 40 });
      if (scenario === 'selected-pause') {
        harness.send({ type: 'pause' });
        harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
      } else if (scenario === 'off-paused') {
        harness.advance();
        harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
      } else if (scenario === 'enable-empty') {
        harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
        harness.advance();
        harness.send({ type: 'pause-on-extinction', runId: 1, value: true });
      } else harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
      const actual = harness.last('playback').playback;
      const before = harness.save();
      const pending = harness.tasks.length;
      harness.send({ type: 'load', runId: 2, text: '{}' });
      const error = harness.last('error');
      expect(error.recovery.playback).toEqual(actual);
      expect(error.recovery.selected?.id ?? null).toBe(before.organisms[0]?.id ?? null);
      expect(error.recovery.settings).toEqual(before.settings);
      expect(error.recovery.frame.stats).toMatchObject({
        tick: before.tick,
        population: before.organisms.length,
      });
      expect(harness.tasks).toHaveLength(pending);
      expect(harness.save()).toEqual(before);
      if (actual.paused && pending) {
        harness.advance();
        expect(harness.tasks).toHaveLength(0);
        expect(harness.save()).toEqual(before);
      }
    },
  );

  it('fully validates malformed, oversized, unsupported and late-invalid candidates before replacement', () => {
    const harness = workerHarness();
    harness.load(terminalWorld(12));
    harness.send({ type: 'pause' });
    harness.send({ type: 'inspect', x: 40, y: 40 });
    const before = harness.save();
    const collision = structuredClone(before);
    collision.organisms.push({ ...collision.organisms[0], id: collision.nextId++ });
    const invalidLast = structuredClone(collision);
    invalidLast.organisms.at(-1)!.genome = {
      ...mouth,
      cells: [
        { x: 0, y: 0, type: 3 },
        { x: 3, y: 0, type: 4 },
      ],
    };
    const invalidTerrain = { ...before, walls: [-1] };
    let runId = 1;
    for (const text of [
      '{',
      'x'.repeat(2500001),
      JSON.stringify({ ...before, version: 99 }),
      JSON.stringify(collision),
      JSON.stringify(invalidLast),
      JSON.stringify(invalidTerrain),
    ]) {
      const count = harness.responseCount;
      harness.send({ type: 'load', runId: ++runId, text });
      expect(harness.responseCount).toBe(count + 1);
      expect(harness.last('error')).toMatchObject({
        runId,
        recovery: {
          selected: before.organisms[0],
          playback: { paused: true, pauseOnExtinction: true, extinction: null },
        },
      });
      expect(harness.save()).toEqual(before);
      expect(harness.tasks).toHaveLength(1);
    }
  });

  it('reports no-world failures honestly and distinguishes fatal recovery construction/transport failures', () => {
    const harness = workerHarness();
    harness.send({ type: 'load', runId: 1, text: '{}' });
    expect(harness.last('error')).toMatchObject({ runId: 1, type: 'error' });
    expect(harness.last('error')).not.toHaveProperty('recovery');
    expect(harness.tasks).toHaveLength(0);
    harness.load(terminalWorld(), 2);
    const frameSpy = vi.spyOn(Ecosystem.prototype, 'frame').mockImplementation(() => {
      throw new Error('Frame failed');
    });
    harness.send({ type: 'load', runId: 3, text: '{}' });
    expect(harness.last('error')).toMatchObject({ fatal: true, message: 'Frame failed', runId: 3 });
    frameSpy.mockRestore();
    const post = harness.scope.postMessage;
    harness.scope.postMessage = (data, transfer) => {
      if (data.recovery) throw new Error('Transfer failed');
      post(data, transfer);
    };
    harness.send({ type: 'load', runId: 4, text: '{}' });
    expect(harness.last('error')).toMatchObject({
      fatal: true,
      message: 'Transfer failed',
      runId: 4,
    });
  });
});
