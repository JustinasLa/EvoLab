import { roleScene } from './fixtures/roles';
import { historicalArchive } from './fixtures/telemetry';
import { newController } from '../src/neural';
import { weightedMutation } from '../src/mutation';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { startWorker, type Scope } from '../src/worker';
import { Ecosystem } from '../src/ecosystem';
import {
  baselineFixtures,
  syntheticHistoricalWorld,
  restoreHistoricalWorld,
  restoreHistoricalOrganism,
  storedSensoryGenome,
} from './fixtures/sensory-legacy';
import {
  legacyV3,
  legacyV4,
  legacyV5,
  legacyV6,
  legacyV7,
  legacyV8,
  legacyV9,
} from './fixtures/telemetry';
import { DEFAULT_TERRAIN } from '../src/terrain';
import { readFileSync } from 'node:fs';
import { world9Text, projectWorld9 } from './fixtures/shade';
import { acceptedReference, fixtureText, predecessor, identicalRecords } from './fixtures/refuges';
import {
  observerWorld,
  extendedObserverWorld,
  withoutObserverExtensions,
} from './fixtures/observers';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import {
  contradictoryPruning,
  impossibleReadmission,
  omittedNewestAdmission,
  sameTickLineages,
  falsePruningClaim,
  reversedPrunedParent,
  reversedReadmittedParent,
  omittedRelatedChild,
  missingFinalExtinction,
  extinctionOccupancyContradiction,
} from './fixtures/lineage';
import {
  DEFAULTS,
  observedOrganism,
  observedGenome,
  observedSettings,
  nextSessionId,
  WIDTH,
  WORLD_MAX_BYTES,
  WORLD_VERSION,
  STROKE_COMMAND_CAPACITY,
  founder,
  index,
  type WorldFile,
  type WorldFileV5,
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
it('nutrient reset opt-in retains exact step, transfer ownership, yields and corrupt-load recovery', () => {
  const harness = workerHarness();
  harness.send({ type: 'start', settings: DEFAULTS, nutrientCycle: true });
  harness.send({ type: 'pause' });
  const initial = harness.save();
  expect(initial.nutrientCycle).not.toBeNull();
  const reference = Ecosystem.load(JSON.stringify(initial));
  const display = harness.frame();
  expect(display.nutrientCycle!.minerals.length).toBe(WIDTH * 156);
  display.nutrientCycle!.minerals.fill(0);
  expect(harness.save()).toEqual(initial);
  harness.send({ type: 'step' });
  reference.step();
  expect(harness.save()).toEqual(reference.save());
  expect(harness.state().playback.paused).toBe(true);
  expect(harness.state().world.nutrientCycle.total).toBe(149760);
  const corrupted = harness.save();
  corrupted.nutrientCycle!.minerals[0]++;
  expect(harness.load(corrupted, 2).type).toBe('error');
  expect(harness.save()).toEqual(reference.save());
  harness.send({ type: 'step', runId: 1 });
  expect(harness.save()).toEqual(reference.save());
  expect(
    harness.send({ type: 'start', settings: DEFAULTS, nutrientCycle: 'yes', runId: 3 }).type,
  ).toBe('error');
  expect(harness.save()).toEqual(reference.save());
  harness.send({ type: 'resume' });
  harness.advance();
  expect(harness.save().tick).toBeGreaterThan(reference.tick);
  expect(harness.tasks.length).toBeGreaterThan(0);
  harness.dispose();
});
it('observes roles only after subscription and preserves exact pause, step, load recovery and yields', () => {
  const harness = workerHarness();
  const { world } = roleScene();
  harness.load(world.save());
  harness.send({ type: 'pause', value: true });
  expect(harness.state().world.roles).toBeUndefined();
  const initial = harness.save();
  const view = { epoch: 1, enabled: false, visible: true, roles: true };
  harness.send({ type: 'display-view', view });
  expect(harness.state().world.roles).toMatchObject({ originTick: 0, tick: 0, lineages: [] });
  expect(harness.save()).toEqual(initial);
  harness.send({ type: 'step' });
  world.step();
  expect(harness.save()).toEqual(world.save());
  const roles = harness.state().world.roles;
  expect(roles.lineages).toHaveLength(2);
  expect(roles.edges).toHaveLength(1);
  harness.send({ type: 'display-view', view: { ...view, epoch: 2, roles: false } });
  expect(harness.last('error').message).toContain('Invalid or obsolete display view');
  harness.send({ type: 'load', runId: 2, text: '{}' });
  expect(harness.state().world.roles).toEqual(roles);
  expect(harness.save()).toEqual(world.save());
  harness.send({ type: 'display-view', runId: 1, view: { ...view, epoch: 2 } });
  expect(harness.state().world.roles).toEqual(roles);
  while (harness.tasks.length) harness.advance();
  harness.load(world.save(), 3);
  expect(harness.state().world.roles).toMatchObject({
    originTick: 1,
    fromTick: 1,
    tick: 1,
    lineages: [],
    edges: [],
  });
  harness.send({ type: 'speed', value: 12 });
  harness.send({ type: 'resume' });
  harness.advance();
  for (let tick = 0; tick < 12; tick++) world.step();
  expect(harness.save()).toEqual(world.save());
  expect(harness.tasks.length).toBeGreaterThan(0);
  harness.send({ type: 'pause', value: true });
  harness.send({ type: 'start', runId: 4, settings: DEFAULTS, display: { ...view, epoch: 3 } });
  expect(harness.state().world.roles).toMatchObject({ originTick: 0, tick: 0, lineages: [] });
  harness.dispose();
});

function sender(scope: Scope) {
  let posting = 0,
    runId = 0,
    stroke = 0,
    active = 0;
  function raw(data: any): void {
    if (data.type === 'start' || data.type === 'load') runId = data.runId;
    scope.onmessage!({
      data: {
        ...(data.type === 'start' ? { display: { epoch: 0, enabled: true, visible: true } } : {}),
        ...(data.type === 'snapshot' ? { display: true } : {}),
        runId,
        ...data,
        commandId: ++posting,
      },
    } as MessageEvent);
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
function workerHarness(autoAckOrStart: boolean | typeof startWorker = true) {
  const autoAck = typeof autoAckOrStart === 'boolean' ? autoAckOrStart : true;
  const startFunction = typeof autoAckOrStart === 'function' ? autoAckOrStart : startWorker;
  const tasks: (() => void)[] = [],
    messages: any[] = [],
    seenTransfers = new WeakSet<object>(),
    transferStats = { batches: 0, buffers: 0, duplicates: 0, detached: 0 };
  let responseCount = 0,
    commandId = 0,
    runId = 0,
    time = 0;
  let observation: any, source: any, terminal: any;
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
      if ('state' in response) observation = response.state;
      if ('telemetry' in response) source = response.telemetry;
      if (response.type === 'error' && response.recovery) {
        observation = response.recovery.state;
        source = response.recovery.telemetry;
      }
      if ('commandId' in response) terminal = response;
      if (autoAck && (response.type === 'frame' || response.type === 'progress'))
        scope.onmessage!({
          data: {
            type: 'flow-ack',
            runId: response.runId,
            sequence: response.sequence,
            channel: response.type === 'frame' ? 'display' : 'progress',
          },
        } as MessageEvent);
    },
  };
  const dispose = startFunction(
    scope,
    (callback) => tasks.push(callback),
    () => time,
  );
  let automaticStroke = 0;
  const send = (data: any): any => {
    if (data.type === 'paint' && data.tool !== 'plant' && data.strokeId === undefined) {
      const strokeId = ++automaticStroke;
      send({ type: 'begin-stroke', strokeId, tool: data.tool, radius: data.radius });
      const response = send({ ...data, strokeId });
      send({ type: 'end-stroke', strokeId });
      return response;
    }
    if (data.runId !== undefined && (data.type === 'load' || data.type === 'start'))
      runId = data.runId;
    const payload = {
      ...(data.type === 'start' ? { display: { epoch: 0, enabled: true, visible: true } } : {}),
      ...(data.type === 'snapshot' ? { display: true } : {}),
      ...data,
      runId: data.runId ?? runId,
      commandId: ++commandId,
    };
    terminal = undefined;
    scope.onmessage!({ data: structuredClone(payload) } as MessageEvent);
    return terminal;
  };
  const last = (type = 'frame') => messages.filter((message) => message.type === type).at(-1);
  const saveText = (): string => send({ type: 'save' }).text;
  const save = (): WorldFile => JSON.parse(saveText());
  const advance = (elapsed = 40) => {
    time += elapsed;
    tasks.shift()!();
  };
  const load = (file: WorldFile, runId = 1) =>
    send({ type: 'load', runId, text: JSON.stringify(file) });
  const frame = (): Frame => {
    send({ type: 'snapshot', display: true });
    return {
      ...last('frame').frame,
      telemetry: source.telemetry,
      interventions: source.interventions,
    };
  };
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
    state: () => observation,
    source: () => source,
    dispose,
    setTime: (value: number) => {
      time = value;
    },
    elapse: (elapsed: number) => {
      time += elapsed;
    },
    get responseCount() {
      return responseCount;
    },
  };
}
describe('frozen raw boundary admission and recovery', () => {
  it.each(['known-climate-overflow', 'known-energy-negative-overflow'])(
    'rejects original raw %s before replacement and preserves independent exact Step',
    (name) => {
      const text = fixtureText(`capture-boundaries-attempt2/inputs/${name}.json`);
      expect(text).toContain(name === 'known-climate-overflow' ? '1e999' : '-1e999');
      expect(() => acceptedReference(text)).toThrow();
      const original = fixtureText('capture-direct/inputs/direct-organism-prototype-v6.json'),
        reference = acceptedReference(original),
        harness = workerHarness();
      harness.send({ type: 'load', runId: 1, text: original });
      harness.send({ type: 'pause' });
      harness.send({ type: 'inspect', x: 120, y: 78 });
      const before = harness.saveText(),
        queued = harness.tasks.length,
        count = harness.responseCount;
      identicalRecords(
        harness.last().state.selected,
        observedOrganism(Ecosystem.load(JSON.stringify(reference.save())).save().organisms[0]),
      );
      harness.send({ type: 'load', runId: 2, text });
      expect(harness.responseCount).toBe(count + 3);
      const error = harness.last('error');
      expect(error).toMatchObject({
        runId: 2,
        operation: 'load',
        recovery: { state: { playback: { paused: true } } },
      });
      expect(error).not.toHaveProperty('fatal');
      expect(harness.tasks).toHaveLength(queued);
      identicalRecords(
        error.recovery.state.selected,
        observedOrganism(Ecosystem.load(JSON.stringify(reference.save())).save().organisms[0]),
      );
      identicalRecords(error.recovery.state.settings, observedSettings(reference.save().settings));
      expect(harness.saveText()).toBe(before);
      expect(predecessor(harness.save())).toEqual(JSON.parse(JSON.stringify(reference.save())));
      harness.send({ type: 'step' });
      reference.step();
      expect(predecessor(harness.save())).toEqual(JSON.parse(JSON.stringify(reference.save())));
      identicalRecords(
        harness.last().state.selected,
        observedOrganism(Ecosystem.load(JSON.stringify(reference.save())).save().organisms[0]),
      );
    },
  );
  for (const location of ['settings', 'organism', 'genome', 'cell'])
    for (const family of ['overflow', 'signed', 'prototype'])
      it(`retains native structured-clone ${location} ${family} descriptors and detached ownership`, () => {
        const text = fixtureText(`capture-direct/inputs/direct-${location}-${family}-v6.json`),
          reference = acceptedReference(text),
          harness = workerHarness();
        harness.send({ type: 'load', runId: 1, text });
        harness.send({ type: 'pause' });
        harness.send({ type: 'inspect', x: 120, y: 78 });
        const settings = harness.last('loaded').state.settings,
          selected = harness.last().state.selected;
        // Lifecycle settings intentionally expose only the four known UI fields.
        const { seed, mutation, nutrients, climate } = reference.save().settings;
        identicalRecords(settings, { seed, mutation, nutrients, climate });
        identicalRecords(
          selected,
          observedOrganism(Ecosystem.load(JSON.stringify(reference.save())).save().organisms[0]),
        );
        for (const record of [settings, selected, selected.genome, selected.genome.cells[0]])
          Object.defineProperty(record, '__proto__', {
            value: { changed: true },
            configurable: true,
          });
        harness.send({ type: 'snapshot' });
        identicalRecords(
          harness.last().state.selected,
          observedOrganism(Ecosystem.load(JSON.stringify(reference.save())).save().organisms[0]),
        );
        expect(predecessor(harness.save())).toEqual({
          ...JSON.parse(JSON.stringify(reference.save())),
          organisms:
            location === 'genome' || location === 'cell'
              ? reference.save().organisms
              : JSON.parse(JSON.stringify(reference.save())).organisms,
        });
        harness.send({ type: 'step' });
        reference.step();
        identicalRecords(
          harness.last().state.selected,
          observedOrganism(Ecosystem.load(JSON.stringify(reference.save())).save().organisms[0]),
        );
        expect(predecessor(harness.save())).toEqual({
          ...JSON.parse(JSON.stringify(reference.save())),
          organisms:
            location === 'genome' || location === 'cell'
              ? reference.save().organisms
              : JSON.parse(JSON.stringify(reference.save())).organisms,
        });
      });
});

describe('terrain worker ownership, literal migration and nonfatal size preservation', () => {
  it.each([1, 4, 12])(
    'keeps wall operations, paused Step and running callbacks exact at speed %i',
    (speed) => {
      const harness = workerHarness(),
        reference = new Ecosystem();
      harness.load(reference.save());
      harness.send({ type: 'speed', value: speed });
      harness.send({ type: 'pause' });
      harness.send({ type: 'inspect', x: 120, y: 78 });
      const queued = harness.tasks.length;
      for (const action of ['clear', 'regenerate'] as const) {
        const type = action === 'clear' ? 'clear-walls' : 'regenerate-walls';
        const recipe = { version: 1 as const, preset: 'chambered-refuges' as const, seed: 0 };
        const expected = reference.changeTerrain(action, recipe);
        harness.send({
          type,
          action,
          ...(action === 'regenerate' ? { recipe, resolvedSeed: 0 } : {}),
        });
        expect(harness.last('manual-result')).toMatchObject({
          operation: type,
          action,
          status: 'applied',
          rowSequence: expected.rowSequence,
          detail: expected.detail,
          terrain: reference.terrain,
        });
        expect(harness.save()).toEqual(reference.save());
        expect(harness.tasks).toHaveLength(queued);
        expect(harness.last().state.selected.id).toBe(1);
        expect(harness.last().state.playback.paused).toBe(true);
      }
      harness.send({
        type: 'regenerate-walls',
        action: 'regenerate',
        recipe: reference.terrain,
        resolvedSeed: 0,
      });
      expect(harness.last('manual-result')).toMatchObject({ status: 'no-op', rowSequence: null });
      harness.send({ type: 'step' });
      reference.step();
      expect(harness.save()).toEqual(reference.save());
      harness.send({ type: 'resume' });
      harness.advance();
      for (let step = 0; step < speed; step++) reference.step();
      harness.send({ type: 'pause' });
      expect(harness.save()).toEqual(reference.save());
      expect(harness.tasks).toHaveLength(1);
    },
  );
  it('rejects malformed wall payloads, duplicate/out-of-order IDs, wrong runs and a delayed closed stroke without mutation', () => {
    const harness = workerHarness();
    harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
    harness.send({ type: 'pause' });
    const before = harness.save();
    for (const payload of [
      { type: 'clear-walls', action: 'regenerate' },
      { type: 'clear-walls', action: 'clear', recipe: DEFAULT_TERRAIN },
      {
        type: 'regenerate-walls',
        action: 'regenerate',
        recipe: { ...DEFAULT_TERRAIN, seed: -1 },
        resolvedSeed: 42,
      },
      { type: 'regenerate-walls', action: 'regenerate', recipe: DEFAULT_TERRAIN, resolvedSeed: 41 },
      { type: 'regenerate-walls', action: 'clear', recipe: DEFAULT_TERRAIN, resolvedSeed: 42 },
    ]) {
      harness.send(payload);
      expect(harness.last('error').message).toContain('Invalid wall');
      expect(harness.save()).toEqual(before);
    }
    const raw = (data: any) => harness.scope.onmessage!({ data } as MessageEvent);
    const command = {
      type: 'regenerate-walls',
      action: 'regenerate',
      recipe: DEFAULT_TERRAIN,
      resolvedSeed: 42,
      runId: 1,
      commandId: 1000,
    };
    raw({ ...command, requestId: 1 });
    expect(harness.save()).toEqual(before);
    const beforeFrame = harness.frame();
    raw({ ...command, runId: 0 });
    expect(harness.last('error')).toMatchObject({
      action: 'regenerate',
      recipe: DEFAULT_TERRAIN,
      resolvedSeed: 42,
    });
    raw(command);
    expect(harness.frame()).toEqual(beforeFrame);
    raw({ ...command, commandId: 999 });
    expect(harness.frame()).toEqual(beforeFrame);
    raw({ type: 'begin-stroke', commandId: 1001, runId: 1, strokeId: 1, tool: 'food', radius: 0 });
    raw({ type: 'clear-walls', action: 'clear', commandId: 1002, runId: 1 });
    const cleared = harness.last('manual-result');
    expect(cleared).toMatchObject({ operation: 'clear-walls', action: 'clear', status: 'applied' });
    raw({
      type: 'paint',
      commandId: 1003,
      runId: 1,
      strokeId: 1,
      tool: 'food',
      x: 1,
      y: 1,
      radius: 0,
      genome: founder(0),
    });
    expect(harness.last('error').message).toContain('closed');
    raw({
      type: 'start',
      commandId: 1004,
      display: { epoch: 0, enabled: true, visible: true },
      runId: 2,
      settings: DEFAULTS,
      terrain: { ...DEFAULT_TERRAIN, version: 99 },
    });
    expect(harness.last('error').recovery.state.world.terrain).toEqual(DEFAULT_TERRAIN);
    expect(harness.last('error').recovery.state.playback.paused).toBe(true);
    raw({ type: 'save', commandId: 1005, runId: 2 });
    const reference = new Ecosystem();
    reference.changeTerrain('clear');
    expect(JSON.parse(harness.last('saved').text)).toEqual(reference.save());
  });
  it('retains complete opaque world5 values through successor reload and cap-size failure without changing complete state or callback ownership', () => {
    const original = JSON.parse(readFileSync('test/fixtures/terrain/legacy5-opaque.json', 'utf8'));
    const harness = workerHarness();
    harness.send({ type: 'load', text: JSON.stringify(original), runId: 1 });
    expect(harness.last('loaded')).toMatchObject({
      state: { world: { terrain: DEFAULT_TERRAIN }, playback: { paused: false } },
    });
    harness.send({ type: 'pause' });
    const reference = Ecosystem.load(JSON.stringify(original));
    expect(harness.save()).toEqual(reference.save());
    const saved = harness.save();
    harness.load(saved, 2);
    harness.send({ type: 'pause' });
    harness.send({ type: 'step' });
    reference.step();
    expect(harness.save()).toEqual(reference.save());
    const capped = structuredClone(original);
    capped.organisms[0].padding = '';
    capped.organisms[0].padding = 'x'.repeat(
      WORLD_MAX_BYTES - Buffer.byteLength(JSON.stringify(capped)),
    );
    let active: Ecosystem;
    const originalFrame = Ecosystem.prototype.display;
    vi.spyOn(Ecosystem.prototype, 'display').mockImplementation(function (this: Ecosystem) {
      active = this;
      return originalFrame.call(this, this.presentation());
    });
    harness.send({ type: 'load', runId: 3, text: JSON.stringify(capped) });
    harness.send({ type: 'pause' });
    harness.send({ type: 'inspect', x: 120, y: 78 });
    const before = active!.save(),
      frame = harness.last(),
      callbacks = [...harness.tasks];
    harness.send({ type: 'save' });
    expect(harness.last('error')).toMatchObject({ operation: 'save', runId: 3 });
    expect(harness.last('error')).not.toHaveProperty('fatal');
    expect(active!.save()).toEqual(before);
    expect(harness.tasks).toEqual(callbacks);
    expect(harness.last()).toEqual(frame);
    const migrated = Ecosystem.load(JSON.stringify(capped));
    migrated.step();
    harness.send({ type: 'step' });
    expect(active!.save()).toEqual(migrated.save());
    expect(harness.last().state.selected).toEqual(observedOrganism(migrated.save().organisms[0]));
  });
});
describe('painted temperature native protocol', () => {
  function thermalHarness() {
    const harness = workerHarness();
    let commandId = 0;
    const send = (type: string, payload: object = {}, runId = 1) => {
      const manual = [
        'refuge-mode',
        'paint-refuge',
        'clear-refuges',
        'begin-stroke',
        'end-stroke',
      ].includes(type);
      const message = {
        type,
        runId,
        ...payload,
        commandId: ++commandId,
        ...(type === 'start' ? { display: { epoch: 0, enabled: true, visible: true } } : {}),
      };
      harness.scope.onmessage!({ data: message } as MessageEvent);
      return message;
    };
    const save = () => {
      send('save');
      return JSON.parse(harness.last('saved').text) as WorldFile;
    };
    send('start', { settings: DEFAULTS });
    send('pause');
    return { ...harness, send, save };
  }
  const brush = { rulesVersion: 1 as const, tool: 'warm' as const, radius: 1, units: 4 };
  it.each([1, 4, 12])(
    'keeps paused edits, exact Step and one running callback at cadence %i',
    (speed) => {
      const harness = thermalHarness(),
        reference = new Ecosystem();
      harness.send('speed', { value: speed });
      harness.send('refuge-mode', { rulesVersion: 1, enabled: true });
      reference.changeRefugeMode(true);
      harness.send('begin-stroke', { ...brush, strokeId: 8 });
      const command = harness.send('paint-refuge', { ...brush, strokeId: 8, x: 0, y: 0 });
      const outcome = reference.paintRefuge(brush, 0, 0);
      expect(harness.last('manual-result')).toMatchObject({
        ...command,
        type: 'manual-result',
        status: 'applied',
        ...outcome,
      });
      expect(harness.save()).toEqual(reference.save());
      expect(Object.prototype.toString.call(harness.last().frame.thermalRefuges.units)).toBe(
        '[object Int8Array]',
      );
      harness.send('end-stroke', { strokeId: 8 });
      harness.send('step');
      reference.step();
      expect(harness.save()).toEqual(reference.save());
      harness.send('resume');
      harness.advance();
      advanceReference(reference, speed);
      harness.send('pause');
      expect(harness.save()).toEqual(reference.save());
      expect(harness.tasks).toHaveLength(1);
      harness.send('refuge-mode', { rulesVersion: 1, enabled: false });
      reference.changeRefugeMode(false);
      harness.send('clear-refuges', { rulesVersion: 1 });
      reference.clearRefuges();
      expect(harness.save()).toEqual(reference.save());
      expect(harness.transferStats.buffers).toBe(harness.transferStats.batches * 4);
      expect(harness.transferStats.duplicates).toBe(0);
    },
  );
  function advanceReference(world: Ecosystem, ticks: number) {
    for (let tick = 0; tick < ticks; tick++) world.step();
  }
  it('rejects malformed, mismatched, stale, duplicate and closed commands with exact echoes and no changes', () => {
    const harness = thermalHarness();
    const before = harness.save();
    harness.send('paint-refuge', { ...brush, strokeId: 8, x: 0, y: 0 });
    expect(harness.last('error').message).toContain('closed');
    expect(harness.save()).toEqual(before);
    harness.send('refuge-mode', { rulesVersion: 2, enabled: true });
    expect(harness.last('error').operation).toBe('refuge-mode');
    harness.send('clear-refuges', { rulesVersion: 2 });
    expect(harness.last('error').operation).toBe('clear-refuges');
    harness.send('refuge-mode', { rulesVersion: 1, enabled: true });
    harness.send('begin-stroke', { ...brush, strokeId: 8 });
    for (const payload of [
      { ...brush, units: 8 },
      { ...brush, tool: 'cool', units: -4 },
      { ...brush, radius: 0 },
      { ...brush, rulesVersion: 2 },
      { ...brush, x: 240 },
    ]) {
      const state = harness.save();
      harness.send('paint-refuge', { x: 0, y: 0, strokeId: 8, ...payload });
      expect(harness.last('error').operation).toBe('paint-refuge');
      expect(harness.save()).toEqual(state);
    }
    const command = harness.send('paint-refuge', { ...brush, strokeId: 8, x: 0, y: 0 });
    const applied = harness.save();
    harness.scope.onmessage!({ data: command } as MessageEvent);
    expect(harness.save()).toEqual(applied);
    harness.send('paint-refuge', { ...brush, strokeId: 8, x: 0, y: 0 }, 0);
    expect(harness.save()).toEqual(applied);
    harness.send('refuge-mode', { rulesVersion: 1, enabled: false });
    const disabled = harness.save();
    harness.send('paint-refuge', { ...brush, strokeId: 8, x: 0, y: 0 });
    expect(harness.save()).toEqual(disabled);
  });
  it('counts all 4096 valid dabs including saturation no-ops and reserves no row for the 4097th rejection', () => {
    const harness = thermalHarness();
    harness.send('refuge-mode', { rulesVersion: 1, enabled: true });
    const config = { ...brush, radius: 0, units: 32, strokeId: 9 };
    harness.send('begin-stroke', config);
    for (let dab = 0; dab < 4096; dab++) harness.send('paint-refuge', { ...config, x: 0, y: 0 });
    expect(harness.last('manual-result')).toMatchObject({
      status: 'no-op',
      rowSequence: null,
      nonzeroCells: 1,
    });
    const before = harness.save();
    harness.send('paint-refuge', { ...config, x: 1, y: 0 });
    expect(harness.last('error').message).toContain('exhausted');
    expect(harness.save()).toEqual(before);
    expect(before.interventions.entries.at(-1)).toMatchObject({
      detail: { successfulCommands: 1, changedBrushCells: 1 },
    });
  });
  it.each(['refuge-mode', 'paint-refuge', 'clear-refuges'])(
    'reports truthful applied-before-terminal-publication failure for %s',
    (operation) => {
      const harness = thermalHarness(),
        reference = new Ecosystem();
      if (operation !== 'refuge-mode') {
        harness.send('refuge-mode', { rulesVersion: 1, enabled: true });
        reference.changeRefugeMode(true);
      }
      if (operation === 'clear-refuges') {
        harness.send('begin-stroke', { ...brush, strokeId: 8 });
        harness.send('paint-refuge', { ...brush, strokeId: 8, x: 0, y: 0 });
        reference.paintRefuge(brush, 0, 0);
      }
      if (operation === 'paint-refuge') harness.send('begin-stroke', { ...brush, strokeId: 8 });
      const publish = harness.scope.postMessage;
      let thrown = false;
      harness.scope.postMessage = (data, transfer) => {
        if (!thrown && data.operation === operation) {
          thrown = true;
          throw new Error('terminal publication failed');
        }
        publish(data, transfer);
      };
      if (operation === 'refuge-mode') {
        harness.send(operation, { rulesVersion: 1, enabled: true });
        reference.changeRefugeMode(true);
      } else if (operation === 'paint-refuge') {
        harness.send(operation, { ...brush, strokeId: 8, x: 0, y: 0 });
        reference.paintRefuge(brush, 0, 0);
      } else {
        harness.send(operation, { rulesVersion: 1 });
        reference.clearRefuges();
      }
      expect(harness.last('error')).toMatchObject({ fatal: true });
      expect(harness.last('error').message).toContain('The action completed');
      expect(harness.last('error')).not.toHaveProperty('operation');
      expect(harness.save()).toEqual(reference.save());
    },
  );
});
describe('painted shade native protocol', () => {
  function shadeHarness() {
    const harness = workerHarness();
    let commandId = 0;
    const send = (type: string, payload: object = {}, runId = 1) => {
      const manual = [
        'shade-mode',
        'paint-shade',
        'clear-shade',
        'begin-stroke',
        'end-stroke',
      ].includes(type);
      const message = {
        type,
        runId,
        ...payload,
        commandId: ++commandId,
        ...(type === 'start' ? { display: { epoch: 0, enabled: true, visible: true } } : {}),
      };
      harness.scope.onmessage!({ data: message } as MessageEvent);
      return message;
    };
    const save = () => {
      send('save');
      return JSON.parse(harness.last('saved').text) as WorldFile;
    };
    send('start', { settings: DEFAULTS });
    send('pause');
    return { ...harness, send, save };
  }
  const brush = { rulesVersion: 1 as const, tool: 'shade' as const, radius: 1, units: 4 };
  it.each([1, 4, 12])(
    'keeps paused edits, exact Step and one running callback at cadence %i',
    (speed) => {
      const harness = shadeHarness(),
        reference = new Ecosystem();
      harness.send('speed', { value: speed });
      harness.send('shade-mode', { rulesVersion: 1, enabled: true });
      reference.changeShadeMode(true);
      harness.send('begin-stroke', { ...brush, strokeId: 8 });
      const command = harness.send('paint-shade', { ...brush, strokeId: 8, x: 0, y: 0 });
      const outcome = reference.paintShade(brush, 0, 0);
      expect(harness.last('manual-result')).toMatchObject({
        ...command,
        type: 'manual-result',
        status: 'applied',
        ...outcome,
      });
      expect(harness.save()).toEqual(reference.save());
      expect(Object.prototype.toString.call(harness.last().frame.shadeHabitats.units)).toBe(
        '[object Uint8Array]',
      );
      harness.last().frame.shadeHabitats.units.fill(16);
      expect(harness.save()).toEqual(reference.save());
      harness.send('end-stroke', { strokeId: 8 });
      harness.send('step');
      reference.step();
      expect(harness.save()).toEqual(reference.save());
      harness.send('resume');
      harness.advance();
      advanceReference(reference, speed);
      harness.send('pause');
      expect(harness.save()).toEqual(reference.save());
      expect(harness.tasks).toHaveLength(1);
      harness.send('shade-mode', { rulesVersion: 1, enabled: false });
      reference.changeShadeMode(false);
      harness.send('clear-shade', { rulesVersion: 1 });
      reference.clearShade();
      expect(harness.save()).toEqual(reference.save());
      expect(harness.transferStats.buffers).toBe(harness.transferStats.batches * 4);
      expect(harness.transferStats.duplicates).toBe(0);
    },
  );
  function advanceReference(world: Ecosystem, ticks: number) {
    for (let tick = 0; tick < ticks; tick++) world.step();
  }
  it('rejects malformed, mismatched, stale, duplicate and closed commands with exact echoes and no changes', () => {
    const harness = shadeHarness();
    const before = harness.save();
    harness.send('paint-shade', { ...brush, strokeId: 8, x: 0, y: 0 });
    expect(harness.last('error').message).toContain('closed');
    expect(harness.save()).toEqual(before);
    harness.send('shade-mode', { rulesVersion: 2, enabled: true });
    expect(harness.last('error').operation).toBe('shade-mode');
    harness.send('clear-shade', { rulesVersion: 2 });
    expect(harness.last('error').operation).toBe('clear-shade');
    harness.send('shade-mode', { rulesVersion: 1, enabled: true });
    harness.send('begin-stroke', { ...brush, strokeId: 8 });
    for (const payload of [
      { ...brush, units: 8 },
      { ...brush, tool: 'lighten', units: -4 },
      { ...brush, radius: 0 },
      { ...brush, rulesVersion: 2 },
      { ...brush, x: 240 },
    ]) {
      const state = harness.save();
      harness.send('paint-shade', { x: 0, y: 0, strokeId: 8, ...payload });
      expect(harness.last('error').operation).toBe('paint-shade');
      expect(harness.save()).toEqual(state);
    }
    const command = harness.send('paint-shade', { ...brush, strokeId: 8, x: 0, y: 0 });
    const applied = harness.save();
    harness.scope.onmessage!({ data: command } as MessageEvent);
    expect(harness.save()).toEqual(applied);
    harness.send('paint-shade', { ...brush, strokeId: 8, x: 0, y: 0 }, 0);
    expect(harness.save()).toEqual(applied);
    harness.send('shade-mode', { rulesVersion: 1, enabled: false });
    const disabled = harness.save();
    harness.send('paint-shade', { ...brush, strokeId: 8, x: 0, y: 0 });
    expect(harness.save()).toEqual(disabled);
  });
  it('counts all 4096 valid dabs including saturation no-ops and reserves no row for the 4097th rejection', () => {
    const harness = shadeHarness();
    harness.send('shade-mode', { rulesVersion: 1, enabled: true });
    const config = { ...brush, radius: 0, units: 16, strokeId: 9 };
    harness.send('begin-stroke', config);
    for (let dab = 0; dab < 4096; dab++) harness.send('paint-shade', { ...config, x: 0, y: 0 });
    expect(harness.last('manual-result')).toMatchObject({
      status: 'no-op',
      rowSequence: null,
      nonzeroCells: 1,
    });
    const before = harness.save();
    harness.send('paint-shade', { ...config, x: 1, y: 0 });
    expect(harness.last('error').message).toContain('exhausted');
    expect(harness.save()).toEqual(before);
    expect(before.interventions.entries.at(-1)).toMatchObject({
      detail: { successfulCommands: 1, changedBrushCells: 1 },
    });
  });
  it.each(['shade-mode', 'paint-shade', 'clear-shade'])(
    'reports truthful applied-before-terminal-publication failure for %s',
    (operation) => {
      const harness = shadeHarness(),
        reference = new Ecosystem();
      if (operation !== 'shade-mode') {
        harness.send('shade-mode', { rulesVersion: 1, enabled: true });
        reference.changeShadeMode(true);
      }
      if (operation === 'clear-shade') {
        harness.send('begin-stroke', { ...brush, strokeId: 8 });
        harness.send('paint-shade', { ...brush, strokeId: 8, x: 0, y: 0 });
        reference.paintShade(brush, 0, 0);
      }
      if (operation === 'paint-shade') harness.send('begin-stroke', { ...brush, strokeId: 8 });
      const publish = harness.scope.postMessage;
      let thrown = false;
      harness.scope.postMessage = (data, transfer) => {
        if (!thrown && data.operation === operation) {
          thrown = true;
          throw new Error('terminal publication failed');
        }
        publish(data, transfer);
      };
      if (operation === 'shade-mode') {
        harness.send(operation, { rulesVersion: 1, enabled: true });
        reference.changeShadeMode(true);
      } else if (operation === 'paint-shade') {
        harness.send(operation, { ...brush, strokeId: 8, x: 0, y: 0 });
        reference.paintShade(brush, 0, 0);
      } else {
        harness.send(operation, { rulesVersion: 1 });
        reference.clearShade();
      }
      expect(harness.last('error')).toMatchObject({ fatal: true });
      expect(harness.last('error').message).toContain('The action completed');
      expect(harness.last('error')).not.toHaveProperty('operation');
      expect(harness.save()).toEqual(reference.save());
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('explicit full design capture over the bounded native protocol', () => {
  it.each(['organism', 'lineage'] as const)(
    'captures the complete detached %s genotype at the response tick without changing the whole world',
    (source) => {
      const original: any = legacyV7(new Ecosystem().save());
      original.organisms[0].genome.sensorMemo = {
        payload: 'native opaque capture',
        negativeZero: -0,
      };
      original.organisms[0].genome.cells[0].cellMemo = ['retained cell payload'];
      const reference = Ecosystem.load(JSON.stringify(original));
      const harness = workerHarness();
      harness.load(original);
      harness.send({ type: 'pause' });
      harness.send({ type: 'inspect', x: 120, y: 78 });
      const before = harness.saveText(),
        callbacks = [...harness.tasks];
      const selected = reference.save().organisms[0];
      const response = harness.send({
        type: 'capture-design',
        source,
        sourceId: source === 'organism' ? selected.id : selected.species,
        captureId: 17,
      });
      expect(response).toMatchObject({
        type: 'design-captured',
        operation: 'capture-design',
        source,
        captureId: 17,
        completedTick: reference.tick,
        seed: reference.settings.seed,
      });
      expect(response.genome).toEqual(selected.genome);
      expect(JSON.stringify(response.state)).not.toContain('native opaque capture');
      response.genome.cells[0].type = 8;
      const next = harness.send({
        type: 'capture-design',
        source,
        sourceId: source === 'organism' ? selected.id : selected.species,
        captureId: 18,
      });
      expect(next.genome).toEqual(selected.genome);
      expect(harness.saveText()).toBe(before);
      expect(harness.tasks).toEqual(callbacks);
      harness.send({ type: 'step' });
      reference.step();
      const stepped = harness.send({
        type: 'capture-design',
        source,
        sourceId: source === 'organism' ? selected.id : selected.species,
        captureId: 19,
      });
      expect(stepped.completedTick).toBe(reference.tick);
      expect(stepped.genome).toEqual(reference.save().organisms[0].genome);
      expect(harness.save()).toEqual(reference.save());
    },
  );
  it.each([
    { source: 'unknown', sourceId: 1, captureId: 1 },
    { source: 'organism', sourceId: 0, captureId: 1 },
    { source: 'organism', sourceId: 1, captureId: 0 },
    { source: 'organism', sourceId: 99999, captureId: 1 },
    { source: 'lineage', sourceId: 99999, captureId: 1 },
  ])('rejects invalid or vanished full-capture source %j without any world edit', (payload) => {
    const harness = workerHarness();
    harness.load(new Ecosystem().save());
    harness.send({ type: 'pause' });
    const before = harness.saveText(),
      tasks = [...harness.tasks];
    const response = harness.send({ type: 'capture-design', ...payload });
    expect(response).toMatchObject({
      type: 'error',
      operation: 'capture-design',
      code: 'invalid-command',
    });
    expect(response).not.toHaveProperty('fatal');
    expect(harness.saveText()).toBe(before);
    expect(harness.tasks).toEqual(tasks);
  });
});

describe('bounded long-run transport', () => {
  it('retains independent grid-free source credit while real history advances across multiple recording boundaries', () => {
    const display = vi.spyOn(Ecosystem.prototype, 'display');
    const harness = workerHarness(false);
    harness.send({
      type: 'start',
      settings: DEFAULTS,
      runId: 1,
      display: { epoch: 0, enabled: false, visible: true },
    });
    const owner = harness.last('progress'),
      source = harness.source();
    for (let batch = 0; batch < 20; batch++) harness.advance();
    expect(harness.save().tick).toBe(80);
    expect(harness.save().telemetry.samples.map((sample) => sample.tick)).toEqual([30, 60]);
    expect(harness.source()).toEqual(source);
    expect(source.tick).toBe(0);
    expect(display).not.toHaveBeenCalled();
    harness.scope.onmessage!({
      data: { type: 'flow-ack', channel: 'progress', runId: owner.runId, sequence: owner.sequence },
    } as MessageEvent);
    expect(harness.last('progress').state.world.stats.tick).toBe(80);
    expect(harness.source().tick).toBe(80);
    expect(harness.source().telemetry.samples.map((sample: any) => sample.tick)).toEqual([30, 60]);
    expect(harness.transferStats.batches).toBe(0);
    harness.send({ type: 'snapshot', display: false });
    expect(display).not.toHaveBeenCalled();
  });
  it('rejects malformed and duplicate envelopes, obsolete view epochs and obsolete world commands', () => {
    const harness = workerHarness();
    harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
    const before = harness.responseCount;
    harness.scope.onmessage!({ data: { type: 'pause', runId: 1 } } as MessageEvent);
    harness.scope.onmessage!({ data: { type: 'pause', runId: 1, commandId: 1 } } as MessageEvent);
    expect(harness.responseCount).toBe(before);
    expect(harness.send({ type: 'settings', runId: 0, settings: {} }).code).toBe('stale-run');
    expect(
      harness.send({ type: 'display-view', view: { epoch: 0, enabled: false, visible: true } })
        .code,
    ).toBe('invalid-command');
    expect(
      harness.send({ type: 'display-view', view: { epoch: 1, enabled: false, visible: 'yes' } })
        .code,
    ).toBe('invalid-command');
  });
  it('fails closed when a credited publication or active target tick throws', () => {
    const harness = workerHarness(false);
    harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
    const owner = harness.last('frame');
    harness.send({ type: 'pause' });
    const display = vi.spyOn(Ecosystem.prototype, 'display').mockImplementationOnce(() => {
      throw new Error('display failed');
    });
    harness.scope.onmessage!({
      data: { type: 'flow-ack', channel: 'display', runId: owner.runId, sequence: owner.sequence },
    } as MessageEvent);
    expect(harness.last('error')).toMatchObject({ fatal: true, message: 'display failed' });
    display.mockRestore();
    harness.send({ type: 'start', settings: DEFAULTS, runId: 2 });
    harness.send({ type: 'run-to', targetTick: 120 });
    const step = vi.spyOn(Ecosystem.prototype, 'step').mockImplementationOnce(() => {
      throw new Error('tick failed');
    });
    harness.advance();
    expect(harness.last('error')).toMatchObject({ fatal: true, message: 'tick failed' });
    step.mockRestore();
  });
  it('defensively settles before a scheduled batch when the real retained world is already empty', () => {
    let retained!: Ecosystem;
    const save = Ecosystem.prototype.save;
    vi.spyOn(Ecosystem.prototype, 'save').mockImplementation(function (this: Ecosystem) {
      retained = this;
      return save.call(this);
    });
    const harness = workerHarness();
    harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
    harness.save();
    retained.paint('erase', 120, 78, 2, founder(0));
    harness.advance();
    expect(harness.state().playback.paused).toBe(true);
    expect(harness.save().tick).toBe(0);
    expect(harness.tasks).toHaveLength(0);
  });
  it.each([1, 4, 12])(
    'reaches exactly 120 at speed %s with identical complete on/off saves at every batch',
    (speed) => {
      const enabled = workerHarness(),
        disabled = workerHarness();
      enabled.send({ type: 'start', settings: DEFAULTS, runId: 1 });
      disabled.send({
        type: 'start',
        settings: DEFAULTS,
        runId: 1,
        display: { epoch: 0, enabled: false, visible: true },
      });
      for (const harness of [enabled, disabled]) {
        harness.send({ type: 'speed', value: speed });
        harness.send({ type: 'run-to', targetTick: 120 });
      }
      expect(disabled.transferStats.batches).toBe(0);
      while (enabled.state().target.status === 'running') {
        expect(enabled.tasks).toHaveLength(1);
        enabled.advance();
        disabled.advance();
        expect(enabled.save()).toEqual(disabled.save());
      }
      expect(enabled.state().world.stats.tick).toBe(120);
      expect(enabled.state().target).toMatchObject({ status: 'reached', stoppedTick: 120 });
      expect(disabled.transferStats.batches).toBe(0);
      expect(enabled.tasks).toHaveLength(0);
      expect(disabled.tasks).toHaveLength(0);
    },
  );
  it('suspends, steps, resumes, cancels exact target identities and preserves a failed-load target', () => {
    const harness = workerHarness();
    harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
    harness.send({ type: 'run-to', targetTick: 20 });
    const first = harness.state().target.id;
    harness.advance();
    harness.send({ type: 'pause' });
    expect(harness.state().target.status).toBe('suspended');
    const before = harness.save();
    expect(harness.send({ type: 'run-to', targetTick: 50 }).code).toBe('target-busy');
    expect(harness.send({ type: 'cancel-target', targetId: first + 1 }).code).toBe(
      'invalid-target',
    );
    expect(harness.save()).toEqual(before);
    harness.send({ type: 'step' });
    expect(harness.state().world.stats.tick).toBe(before.tick + 1);
    harness.send({ type: 'load', runId: 2, text: '{}' });
    expect(harness.state().target).toMatchObject({ id: first, status: 'suspended' });
    harness.send({ type: 'resume' });
    expect(harness.state().target.status).toBe('running');
    harness.send({ type: 'cancel-target', targetId: first });
    expect(harness.state().target).toMatchObject({
      status: 'cancelled',
      stoppedTick: before.tick + 1,
    });
    expect(harness.state().playback.paused).toBe(true);
    harness.advance();
    expect(harness.tasks).toHaveLength(0);
    expect(harness.send({ type: 'cancel-target', targetId: first }).code).toBe('invalid-target');
    expect(harness.send({ type: 'run-to', targetTick: 0 }).code).toBe('invalid-target');
    expect(harness.send({ type: 'run-to', targetTick: NaN }).code).toBe('invalid-target');
    expect(harness.send({ type: 'cancel-target', targetId: 0 }).code).toBe('invalid-target');
    harness.send({ type: 'run-to', targetTick: before.tick + 1 });
    expect(harness.state().target.status).toBe('reached');
    harness.send({ type: 'start', settings: DEFAULTS, runId: 3 });
    expect(harness.state().target).toBeNull();
  });
  it.each([71, 72, 73])(
    'gives exact-target precedence at the genuine extinction boundary %s',
    (targetTick) => {
      const harness = workerHarness();
      harness.load(terminalWorld());
      harness.send({ type: 'run-to', targetTick });
      if (targetTick > 71) harness.advance();
      expect(harness.state().target.status).toBe(targetTick === 73 ? 'extinct' : 'reached');
      expect(harness.save().tick).toBe(Math.min(targetTick, 72));
      if (targetTick >= 72) expect(harness.save().organisms).toHaveLength(0);
    },
  );
  it.each(['pause', 'cancel-target', 'run-to'])(
    'publishes settled %s immediately with free credit at unchanged clock',
    (action) => {
      const harness = workerHarness();
      harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
      harness.send({ type: 'run-to', targetTick: 30 });
      const before = harness.transferStats.batches,
        sequence = harness.last('progress').sequence;
      harness.send({ type: action, targetId: harness.state().target.id, targetTick: 0 });
      if (action === 'run-to') {
        expect(harness.last('error').code).toBe('target-busy');
        return;
      }
      expect(harness.transferStats.batches).toBe(before + 1);
      expect(harness.last('progress').sequence).toBe(sequence + 1);
      expect(harness.last('frame').state.playback.paused).toBe(true);
    },
  );
  it.each(['valid', 'invalid', 'empty'])(
    'retains global owners across %s replacement until exact token release with no new tick/time/input',
    (candidate) => {
      const harness = workerHarness(false);
      harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
      const oldDisplay = harness.last('frame'),
        oldProgress = harness.last('progress');
      const empty = new Ecosystem(DEFAULTS, false).save();
      const text =
        candidate === 'invalid'
          ? '{}'
          : JSON.stringify(candidate === 'empty' ? empty : new Ecosystem().save());
      harness.send({ type: 'load', text, runId: 2 });
      harness.send({ type: 'pause' });
      expect(harness.transferStats.batches).toBe(1);
      const acknowledge = (channel: string, owner: any, sequence = owner.sequence) =>
        harness.scope.onmessage!({
          data: { type: 'flow-ack', channel, runId: owner.runId, sequence },
        } as MessageEvent);
      acknowledge('display', oldDisplay, oldDisplay.sequence + 1);
      acknowledge('unrecognized', oldProgress);
      expect(harness.transferStats.batches).toBe(1);
      acknowledge('display', oldDisplay);
      expect(harness.transferStats.batches).toBe(2);
      expect(harness.last('frame')).toMatchObject({
        runId: 2,
        state: { playback: { paused: true } },
      });
      acknowledge('progress', oldProgress);
      expect(harness.last('progress')).toMatchObject({
        runId: 2,
        state: { playback: { paused: true } },
        telemetry: { tick: 0 },
      });
      const newest = harness.last('frame').sequence;
      acknowledge('display', oldDisplay);
      expect(harness.last('frame').sequence).toBe(newest);
      expect(harness.save().tick).toBe(0);
    },
  );
  it('never constructs hidden/off grids automatically but explicitly refreshes visible paused edits and defers dirty demand behind credit', () => {
    const display = vi.spyOn(Ecosystem.prototype, 'display');
    const harness = workerHarness(false);
    harness.send({
      type: 'start',
      settings: DEFAULTS,
      runId: 1,
      display: { epoch: 0, enabled: false, visible: false },
    });
    for (let batch = 0; batch < 20; batch++) harness.advance();
    expect(display).not.toHaveBeenCalled();
    harness.send({ type: 'snapshot', display: true });
    expect(display).not.toHaveBeenCalled();
    harness.send({ type: 'pause' });
    harness.send({ type: 'display-view', view: { epoch: 1, enabled: false, visible: true } });
    expect(display).not.toHaveBeenCalled();
    harness.send({ type: 'step' });
    expect(display).toHaveBeenCalledTimes(1);
    const owner = harness.last('frame');
    harness.send({ type: 'inspect', x: 120, y: 78 });
    harness.send({ type: 'snapshot', display: true });
    expect(display).toHaveBeenCalledTimes(1);
    harness.scope.onmessage!({
      data: { type: 'flow-ack', channel: 'display', runId: owner.runId, sequence: owner.sequence },
    } as MessageEvent);
    expect(display).toHaveBeenCalledTimes(2);
    harness.send({ type: 'display-view', view: { epoch: 2, enabled: true, visible: false } });
    const nextOwner = harness.last('frame');
    harness.scope.onmessage!({
      data: {
        type: 'flow-ack',
        channel: 'display',
        runId: nextOwner.runId,
        sequence: nextOwner.sequence,
      },
    } as MessageEvent);
    expect(display).toHaveBeenCalledTimes(2);
    harness.send({ type: 'display-view', view: { epoch: 3, enabled: true, visible: true } });
    expect(display).toHaveBeenCalledTimes(3);
  });
  it.each(['settings', 'inspect', 'paint', 'shock'] as const)(
    'services a running off-mode Refresh synchronously after %s without losing held demand',
    (type) => {
      const display = vi.spyOn(Ecosystem.prototype, 'display'),
        harness = workerHarness(false);
      harness.send({
        type: 'start',
        settings: DEFAULTS,
        display: { epoch: 0, enabled: false, visible: true },
      });
      harness.advance();
      expect(display).not.toHaveBeenCalled();
      expect(harness.transferStats.buffers).toBe(0);
      harness.send({ type: 'snapshot', display: true });
      const owner = harness.last('frame');
      harness.send({ type: 'snapshot', display: true });
      const payloads = {
        settings: { settings: { mutation: 0.2 } },
        inspect: { x: 120, y: 78 },
        paint: { x: 10, y: 10, radius: 0, tool: 'food', genome: mouth },
        shock: { kind: 'heat' },
      };
      harness.send({ type, ...payloads[type] });
      const expected = Ecosystem.load(harness.saveText()),
        queued = harness.tasks[0],
        observation = structuredClone(harness.state());
      expect(observation.playback.paused).toBe(false);
      expect(harness.tasks).toHaveLength(1);
      expect(display).toHaveBeenCalledTimes(1);
      const acknowledge = (sequence: number, runId = owner.runId) =>
        harness.scope.onmessage!({
          data: { type: 'flow-ack', channel: 'display', runId, sequence },
        } as MessageEvent);
      acknowledge(owner.sequence + 1);
      acknowledge(owner.sequence, owner.runId + 1);
      expect(display).toHaveBeenCalledTimes(1);
      acknowledge(owner.sequence);
      expect(display).toHaveBeenCalledTimes(2);
      expect(harness.last('frame').state).toEqual(observation);
      const frame = harness.last('frame').frame,
        reference = expected.frame();
      expect({ ...frame, cells: [...frame.cells], ids: [...frame.ids] }).toEqual({
        cells: [...reference.cells],
        ids: [...reference.ids],
        stats: reference.stats,
        climate: reference.climate,
        offset: reference.offset,
        terrain: reference.terrain,
        shadeHabitats: {
          ...reference.shadeHabitats,
          units: frame.shadeHabitats.units.constructor.from(reference.shadeHabitats.units),
        },
        thermalRefuges: {
          ...reference.thermalRefuges,
          units: frame.thermalRefuges.units.constructor.from(reference.thermalRefuges.units),
        },
      });
      expect(harness.tasks).toEqual([queued]);
      expect(harness.saveText()).toBe(JSON.stringify(expected.save()));
      expect(harness.transferStats).toEqual({ batches: 2, buffers: 8, duplicates: 0, detached: 8 });
      acknowledge(owner.sequence);
      acknowledge(harness.last('frame').sequence);
      harness.advance();
      expect(harness.transferStats.buffers).toBe(8);
      expect(harness.tasks).toHaveLength(1);
    },
  );
  it('measures actual completions across a full monotonic gap, labels hidden context and resets after pause/visibility changes', () => {
    const harness = workerHarness();
    harness.send({
      type: 'start',
      settings: DEFAULTS,
      runId: 1,
      display: { epoch: 0, enabled: false, visible: true },
    });
    harness.send({ type: 'speed', value: 1 });
    for (let batch = 0; batch < 10; batch++) harness.advance(100);
    expect(harness.state().rate).toMatchObject({
      status: 'measured',
      value: 10,
      completedTicks: 10,
      elapsedMs: 1000,
    });
    harness.advance(3000);
    expect(harness.state().rate).toMatchObject({
      status: 'timing-gap',
      value: 1 / 3,
      completedTicks: 1,
      elapsedMs: 3000,
    });
    harness.send({ type: 'display-view', view: { epoch: 1, enabled: false, visible: false } });
    expect(harness.state().rate).toMatchObject({
      status: 'warming',
      context: 'hidden',
      value: null,
    });
    for (let batch = 0; batch < 60; batch++) harness.advance(100);
    expect(harness.state().rate).toMatchObject({
      status: 'measured',
      context: 'hidden',
      value: 10,
    });
    harness.send({ type: 'pause' });
    expect(harness.state().rate.status).toBe('paused');
    harness.send({ type: 'resume' });
    harness.advance(0);
    expect(harness.state().rate.value).toBeNull();
    harness.setTime(NaN);
    harness.advance(0);
    harness.setTime(0);
    harness.advance(0);
    harness.send({ type: 'snapshot', display: false });
    expect(harness.state().rate.status).toBe('warming');
    harness.dispose();
    const count = harness.responseCount;
    harness.advance();
    expect(harness.responseCount).toBe(count);
    expect(harness.tasks).toHaveLength(0);
  });
  it('bounds accelerated whole-tick batches by speed and the eight millisecond budget with only one callback', () => {
    const harness = workerHarness();
    const step = Ecosystem.prototype.step;
    vi.spyOn(Ecosystem.prototype, 'step').mockImplementation(function (this: Ecosystem) {
      step.call(this);
      harness.elapse(5);
    });
    harness.send({ type: 'start', settings: DEFAULTS, runId: 1 });
    harness.send({ type: 'speed', value: 12 });
    harness.send({ type: 'run-to', targetTick: 100 });
    for (let batch = 0; batch < 5; batch++) {
      expect(harness.tasks).toHaveLength(1);
      harness.advance(0);
      expect(harness.save().tick).toBe((batch + 1) * 2);
    }
    harness.send({ type: 'pause' });
    harness.advance();
    expect(harness.tasks).toHaveLength(0);
  });
  it('bounds maximal real-engine known-field controls and 180-sample telemetry without restricting full saves', () => {
    const file = observerWorld(1600, true),
      harness = workerHarness(),
      selected = file.organisms.at(-1)!;
    harness.send({
      type: 'start',
      settings: DEFAULTS,
      display: { epoch: 0, enabled: false, visible: true },
    });
    harness.load(file, 2);
    harness.send({ type: 'inspect', x: selected.x, y: selected.y });
    harness.send({ type: 'run-to', targetTick: 1_000_000_000 });
    harness.send({ type: 'pause' });
    const state = harness.state(),
      source = harness.source(),
      size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength,
      controlBytes = size(state),
      telemetryBytes = size(source);
    expect(state.world.stats.population).toBe(1600);
    expect(state.world.stats.top).toHaveLength(5);
    expect(state.world.stats.top.every((species: any) => species.genome.cells.length === 16)).toBe(
      true,
    );
    expect(state.selected.genome.cells).toHaveLength(16);
    expect(state.selected.ancestry).toHaveLength(8);
    expect(state.selected.age).toBe(100000);
    expect(state.target).toMatchObject({ status: 'suspended', targetTick: 1_000_000_000 });
    expect(source.telemetry.samples).toHaveLength(180);
    expect(source.interventions.entries).toHaveLength(128);
    for (const sample of source.telemetry.samples) {
      expect(sample.cellCounts).toHaveLength(6);
      expect(sample.adaptation.preferenceBins).toHaveLength(10);
      expect(Object.keys(sample.energy)).toHaveLength(9);
      expect(Object.keys(sample.deaths)).toHaveLength(3);
    }
    expect(controlBytes).toBeLessThanOrEqual(32 * 1024);
    expect(telemetryBytes).toBeLessThanOrEqual(256 * 1024);
    expect(harness.saveText()).toBe(JSON.stringify(file));
    process.stdout.write(
      'MAXIMAL_OBSERVER_BYTES ' +
        JSON.stringify({
          fixture:
            'Real 1600-organism/16-cell boundary expanded to 180 schema-valid sizing intervals, with upper-range counters/traits; not an uninterrupted ecological trajectory',
          population: 1600,
          top: 5,
          topCells: 16,
          selectedCells: 16,
          ancestry: 8,
          samples: 180,
          manualEntries: source.interventions.entries.length,
          controlBytes,
          telemetryBytes,
          completeSaveBytes: size(file),
          stateKeys: Object.keys(state),
          sampleKeys: Object.keys(source.telemetry.samples[0]),
        }) +
        '\n',
    );
  });
  it.each(
    ['settings', 'organism', 'genome', 'cell', 'all'].flatMap((surface) =>
      ([1, 4, 12] as const).flatMap((speed) =>
        // Keep every batch of the same 120-tick corpus while bounding each
        // case's full-payload serialization under the unchanged 5s deadline.
        // Twelve is a multiple of every supported speed.
        Array.from({ length: 10 }, (_, window) => ({
          surface,
          speed,
          from: window * 12,
          through: (window + 1) * 12,
        })),
      ),
    ),
  )(
    'preserves literal observer twins and full extension saves at $surface / speed $speed on every batch in $from–$through of 120 ticks',
    async ({ surface, speed, from, through }) => {
      const file = observerWorld(),
        extended = extendedObserverWorld(file, surface),
        reference = Ecosystem.load(JSON.stringify(file)),
        extendedReference = Ecosystem.load(JSON.stringify(extended)),
        plain = workerHarness(),
        extra = workerHarness(),
        selected = file.organisms.at(-1)!,
        surfaces = new Map<string, { bytes: number; sha256: string }>();
      let expectedSaves: [string, string] | undefined;
      const size = (text: string) => new TextEncoder().encode(text).byteLength,
        identical = (label: string, left: unknown, right: unknown) => {
          const text = JSON.stringify(right);
          expect(text).toBe(JSON.stringify(left));
          expect(text).not.toContain('observerExtension');
          surfaces.set(label, {
            bytes: size(text),
            sha256: createHash('sha256').update(text).digest('hex'),
          });
        },
        pair = (command: any) => {
          const first = plain.send(command),
            second = extra.send(command);
          if (command.type === 'save') {
            expect(first.byteLength).toBe(size(first.text));
            expect(second.byteLength).toBe(size(second.text));
            identical(
              'saved-state',
              { ...first, text: undefined, byteLength: undefined },
              { ...second, text: undefined, byteLength: undefined },
            );
            expect(first.text).toBe(expectedSaves?.[0] ?? JSON.stringify(reference.save()));
            expect(second.text).toBe(
              expectedSaves?.[1] ?? JSON.stringify(extendedReference.save()),
            );
          } else identical(first.type, first, second);
          return [first, second];
        },
        poison = (value: any): void => {
          if (!value || typeof value !== 'object') return;
          if (ArrayBuffer.isView(value)) {
            value.fill(9);
            return;
          }
          for (const [key, child] of Object.entries(value)) {
            if (child && typeof child === 'object') poison(child);
            else value[key] = typeof child === 'number' ? -777 : 'caller mutation';
          }
          if (Array.isArray(value)) value.push({ callerMutation: true });
        };
      const extendedBytes = size(JSON.stringify(extended));
      expect(extendedBytes).toBeLessThan(WORLD_MAX_BYTES);
      expect(extendedBytes - size(JSON.stringify(file))).toBeGreaterThanOrEqual(96 * 1024);
      pair({
        type: 'start',
        settings: DEFAULTS,
        display: { epoch: 0, enabled: false, visible: true },
      });
      const callerOwned = structuredClone(extended),
        initial = [plain.load(file, 2), extra.load(callerOwned, 2)];
      poison(callerOwned);
      identical('loaded', initial[0], initial[1]);
      pair({ type: 'pause' });
      pair({ type: 'inspect', x: selected.x, y: selected.y });
      const first = pair({ type: 'snapshot', display: true }),
        earlierFrame = extra.last('frame'),
        second = pair({ type: 'snapshot', display: true }),
        frame = extra.last('frame'),
        secondBytes = JSON.stringify(second[1]),
        frameBytes = JSON.stringify(frame);
      identical('frame', plain.last('frame'), frame);
      expect(first[1].state.selected.ancestry).not.toBe(second[1].state.selected.ancestry);
      expect(first[1].state.selected.genome.cells).not.toBe(second[1].state.selected.genome.cells);
      expect(first[1].state.world.stats.top[0].genome.cells).not.toBe(
        second[1].state.world.stats.top[0].genome.cells,
      );
      expect(first[1].telemetry.telemetry.samples[0].energy).not.toBe(
        second[1].telemetry.telemetry.samples[0].energy,
      );
      expect(first[1].telemetry.interventions.entries).not.toBe(
        second[1].telemetry.interventions.entries,
      );
      expect(first[1].telemetry.interventions.entries[0].detail).not.toBe(
        second[1].telemetry.interventions.entries[0].detail,
      );
      for (const format of ['json', 'csv']) {
        const exported = pair({ type: 'export-measurements', format });
        expect(exported[1].byteLength).toBe(size(exported[1].text));
        identical('measurement-' + format, exported[0], exported[1]);
      }
      poison(initial[1]);
      poison(first[1]);
      poison(earlierFrame);
      expect(JSON.stringify(second[1])).toBe(secondBytes);
      expect(JSON.stringify(frame)).toBe(frameBytes);
      pair({ type: 'save' });
      const direct = extendedReference.frame(),
        saved = JSON.stringify(extendedReference.save());
      poison(direct);
      expect(JSON.stringify(extendedReference.save())).toBe(saved);
      pair({ type: 'snapshot', display: true });
      identical('frame-after-mutation', plain.last('frame'), extra.last('frame'));
      pair({ type: 'settings', settings: { forbidden: 1 } });
      const recovery = extra.last('error');
      expect(recovery.code).toBe('invalid-command');
      identical('recovery', plain.last('error'), recovery);
      poison(recovery);
      pair({ type: 'save' });
      pair({ type: 'load', runId: 3, text: '{}' });
      expect(extra.last('error').code).toBe('load-failed');
      identical('load-recovery', plain.last('error'), extra.last('error'));
      poison(extra.last('error'));
      pair({ type: 'save' });
      pair({ type: 'speed', value: speed });
      pair({ type: 'resume' });
      for (let tick = 0; tick < through; tick += speed) {
        plain.advance();
        extra.advance();
        for (let step = 0; step < speed; step++) {
          reference.step();
          extendedReference.step();
        }
        if (tick + speed < from) continue;
        const plainExpected = reference.save(),
          extraExpected = extendedReference.save();
        expectedSaves = [JSON.stringify(plainExpected), JSON.stringify(extraExpected)];
        if (tick < from) {
          pair({ type: 'save' });
          continue;
        }
        const before = pair({ type: 'save' });
        pair({ type: 'inspect', x: selected.x, y: selected.y });
        pair({ type: 'snapshot', display: false });
        for (const format of ['json', 'csv']) {
          const exported = pair({ type: 'export-measurements', format });
          expect(exported[1].byteLength).toBe(size(exported[1].text));
          identical('measurement-' + format, exported[0], exported[1]);
        }
        identical('progress', plain.last('progress'), extra.last('progress'));
        const after = pair({ type: 'save' });
        expect(after[0].text).toBe(before[0].text);
        expect(after[1].text).toBe(before[1].text);
        expect(JSON.stringify(withoutObserverExtensions(extraExpected))).toBe(expectedSaves[0]);
        expect(plain.tasks).toHaveLength(1);
        expect(extra.tasks).toHaveLength(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      pair({ type: 'pause' });
      identical('terminal', plain.last('control'), extra.last('control'));
      const final = pair({ type: 'save' });
      expect(extra.transferStats).toEqual(plain.transferStats);
      expect(extra.transferStats.duplicates).toBe(0);
      expect(extra.transferStats.detached).toBe(extra.transferStats.buffers);
      process.stdout.write(
        'EXTENSION_OBSERVER_TWINS ' +
          JSON.stringify({
            surface,
            speed,
            trajectoryTicks: 120,
            prefixTicks: from,
            coveredThroughTick: through,
            observedBatches: (through - from) / speed,
            extendedBytes,
            plainSaveBytes: size(final[0].text),
            extendedSaveBytes: size(final[1].text),
            plainSaveSHA256: createHash('sha256').update(final[0].text).digest('hex'),
            extendedSaveSHA256: createHash('sha256').update(final[1].text).digest('hex'),
            surfaces: Object.fromEntries(surfaces),
            transferStats: extra.transferStats,
            mutation:
              'loaded/control/frame, selected ancestry/genome/cells, top genomes/cells, settings, every telemetry sample/pending ledger/count/bin, direct real-engine frame and recovery; later responses/saves/evolution unchanged',
          }) +
          '\n',
      );
      plain.dispose();
      extra.dispose();
    },
  );
  it('keeps the five ranked lineage projections detached even when every living organism has a distinct lineage', () => {
    const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0 }, false, {
      terrain: { version: 1, preset: 'open-field', seed: null },
    });
    for (let position = 0; position < 1600; position++)
      world.spawn(
        {
          cells: [{ x: 0, y: 0, type: 4 }],
          preference: 0.5,
          tolerance: 0.3,
          tempo: 2,
          behavior: { version: 1, mode: 'legacy' },
        },
        position % WIDTH,
        Math.floor(position / WIDTH),
      );
    const before = JSON.stringify(world.save());
    const frame = world.frame();
    expect(frame.stats.species).toBe(1600);
    expect(frame.stats.top.map((value) => [value.id, value.count])).toEqual([
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
    ]);
    for (const value of frame.stats.top) value.genome.cells[0].type = 8;
    expect(world.frame().stats.top.every((value) => value.genome.cells[0].type === 4)).toBe(true);
    expect(JSON.stringify(world.save())).toBe(before);
  });
  it('projects only recursively known detached observations while complete saves retain arbitrary validated extensions', () => {
    const file: any = new Ecosystem().save();
    file.settings.extension = 'settings-extension';
    file.organisms[0].extension = 'organism-extension';
    file.organisms[0].genome.legacyExtensions = [['extension', [['string', 'genome-extension']]]];
    file.organisms[0].genome.cells[0].legacyExtensions = [
      ['extension', [['string', 'cell-extension']]],
    ];
    const harness = workerHarness();
    harness.load(file);
    harness.send({ type: 'pause' });
    harness.send({ type: 'inspect', x: 120, y: 78 });
    const observation = harness.state(),
      source = harness.source();
    expect(JSON.stringify(observation)).not.toContain('-extension');
    expect(JSON.stringify(source)).not.toContain('-extension');
    expect(harness.save()).toEqual(file);
    observation.selected.genome.cells[0].type = 8;
    observation.world.stats.top[0].genome.cells[0].type = 8;
    observation.settings.seed = 987;
    source.telemetry.pending.energy.upkeepSpent = 123;
    expect(harness.save()).toEqual(file);
    harness.send({ type: 'settings', settings: { mutation: 0.2 } });
    expect((harness.save().settings as any).extension).toBe('settings-extension');
    expect(nextSessionId(4)).toBe(5);
    expect(() => nextSessionId(Number.MAX_SAFE_INTEGER)).toThrow();
  });
});
describe('correlated manual/export worker protocol', () => {
  it('rejects malformed open and close envelopes without ecological or log effects', () => {
    const harness = workerHarness();
    harness.send({ type: 'start', settings: DEFAULTS });
    harness.send({ type: 'pause' });
    const before = harness.saveText();
    for (const command of [
      { type: 'begin-stroke', strokeId: 0, tool: 'food', radius: 0 },
      { type: 'begin-stroke', strokeId: 1, tool: 'plant', radius: 0 },
      { type: 'begin-stroke', strokeId: 1, tool: 'food', radius: 9 },
      { type: 'end-stroke', strokeId: 0 },
    ]) {
      expect(harness.send(command)).toMatchObject({ type: 'error', operation: command.type });
      expect(harness.saveText()).toBe(before);
    }
  });
  it('does not leak a nonposted progress credit after a post-terminal publication failure and explicit recovery', () => {
    const harness = workerHarness(false),
      publish = harness.scope.postMessage;
    let fail = true;
    harness.scope.postMessage = (data, transfer) => {
      if (fail && data.type === 'progress') {
        fail = false;
        throw new Error('injected nonposted progress');
      }
      publish(data, transfer);
    };
    harness.send({
      type: 'start',
      settings: DEFAULTS,
      display: { epoch: 0, enabled: false, visible: true },
    });
    expect(harness.last('control')).toMatchObject({ commandId: 1, operation: 'start' });
    expect(harness.last('error')).toMatchObject({ fatal: true });
    expect(harness.last('error')).not.toHaveProperty('commandId');
    expect(harness.saveText()).toBe(JSON.stringify(new Ecosystem().save()));
    harness.send({ type: 'load', runId: 2, text: '{}' });
    expect(harness.last('progress')).toMatchObject({
      runId: 2,
      state: { playback: { paused: true } },
    });
    expect(harness.transferStats.buffers).toBe(0);
    expect(harness.tasks).toHaveLength(0);
    expect(harness.saveText()).toBe(JSON.stringify(new Ecosystem().save()));
  });
  it('retains an admitted historical opaque expansion when complete outbound Save exceeds 2.5 MB nonfatally', () => {
    let retained!: Ecosystem;
    const frame = Ecosystem.prototype.display;
    vi.spyOn(Ecosystem.prototype, 'display').mockImplementation(function (this: Ecosystem) {
      retained = this;
      return frame.call(this, this.presentation());
    });
    const original = JSON.parse(baselineFixtures['world5-extras.json']);
    original.organisms[0].genome.expanding = Array(300000).fill(null);
    const text = JSON.stringify(original);
    expect(new TextEncoder().encode(text).length).toBeLessThan(WORLD_MAX_BYTES);
    const harness = workerHarness();
    harness.send({ type: 'load', runId: 1, text });
    expect(harness.last('loaded')).toBeDefined();
    harness.send({ type: 'pause' });
    const before = JSON.stringify(retained.save()),
      genome = JSON.stringify(retained.save().organisms[0].genome);
    expect(new TextEncoder().encode(before).length).toBeGreaterThan(WORLD_MAX_BYTES);
    const error = harness.send({ type: 'save' });
    expect(error).toMatchObject({
      type: 'error',
      operation: 'save',
      message: expect.stringContaining('2.5 MB'),
    });
    expect(error).not.toHaveProperty('fatal');
    expect(JSON.stringify(retained.save())).toBe(before);
    harness.send({ type: 'step' });
    expect(retained.tick).toBe(original.tick + 1);
    expect(JSON.stringify(retained.save().organisms[0].genome)).toBe(genome);
    expect(harness.last().state.playback.paused).toBe(true);
  });
  it.each(['selected', 'recovery'])(
    'detaches bounded known behavior in %s observations and complete passive payload only through explicit native capture',
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
      const response =
        boundary === 'selected' ? harness.last().state : harness.last('error').recovery.state;
      expect(response.selected.genome).toEqual(observedGenome(original));
      expect(response.selected.genome).not.toHaveProperty('legacyExtensions');
      response.selected.genome.behavior.reactions.food = 'ignore';
      const captured = harness.send({
        type: 'capture-design',
        source: 'organism',
        sourceId: 1,
        captureId: 1,
      });
      expect(captured.genome).toEqual(original);
      captured.genome.legacyExtensions[0][1].at(-1)[1] = 'response-only';
      expect(harness.save().organisms[0].genome).toEqual(original);
      source.cells[0].legacyExtensions = [['source', [['null']]]];
      source.legacyExtensions = [['changed', [['boolean', false]]]];
      expect(harness.frame().stats.top[0].genome).toEqual(observedGenome(original));
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
        commandId: ++posting,
        ...(type === 'start' ? { display: { epoch: 0, enabled: true, visible: true } } : {}),
      };
      raw(data);
      return data;
    };
    return { ...harness, post, raw };
  }
  it.each([
    ...[
      'initial-start',
      'start',
      'load',
      'settings',
      'paint',
      'shock',
      'clear-walls',
      'regenerate-walls',
      'refuge-mode',
      'paint-refuge',
      'clear-refuges',
    ].flatMap((operation) =>
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
        harness.post('pause');
        if (!pending) harness.advance();
        expect(harness.tasks).toHaveLength(pending ? 1 : 0);
      }
      const reference = new Ecosystem(),
        actualOperation = operation === 'initial-start' ? 'start' : operation,
        targetRun = ['start', 'load'].includes(operation) ? 2 : 1,
        publish = harness.scope.postMessage,
        originalFrame = Ecosystem.prototype.display;
      if (operation === 'paint-refuge' || operation === 'clear-refuges') {
        harness.post('refuge-mode', { rulesVersion: 1, enabled: true });
        reference.changeRefugeMode(true);
        if (operation === 'clear-refuges') {
          harness.post('begin-stroke', {
            strokeId: 20,
            rulesVersion: 1,
            tool: 'warm',
            radius: 0,
            units: 4,
          });
          harness.post('paint-refuge', {
            strokeId: 20,
            rulesVersion: 1,
            tool: 'warm',
            radius: 0,
            units: 4,
            x: 1,
            y: 1,
          });
          reference.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 4 }, 1, 1);
        }
      }
      vi.spyOn(Ecosystem.prototype, 'display').mockImplementation(function (this: Ecosystem) {
        if (armed && fault === 'frame-build') {
          armed = false;
          throw new Error('injected post-success frame construction failure');
        }
        return originalFrame.call(this, this.presentation());
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
      } else if (operation === 'refuge-mode') {
        harness.post('refuge-mode', { rulesVersion: 1, enabled: true });
        reference.changeRefugeMode(true);
      } else if (operation === 'clear-refuges') {
        harness.post('clear-refuges', { rulesVersion: 1 });
        reference.clearRefuges();
      } else if (operation === 'paint-refuge') {
        const brush = { rulesVersion: 1 as const, tool: 'warm' as const, radius: 0, units: 4 };
        harness.post('begin-stroke', { ...brush, strokeId: 21 });
        harness.post('paint-refuge', { ...brush, strokeId: 21, x: 1, y: 1 });
        reference.paintRefuge(brush, 1, 1);
      } else if (operation === 'clear-walls' || operation === 'regenerate-walls') {
        const action = operation === 'clear-walls' ? 'clear' : 'regenerate';
        const recipe = { version: 1 as const, preset: 'chambered-refuges' as const, seed: 0 };
        harness.post(operation, {
          action,
          ...(action === 'regenerate' ? { recipe, resolvedSeed: 0 } : {}),
        });
        reference.changeTerrain(action, recipe);
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
        recovery: { state: { playback: { paused: true } } },
      });
      expect(harness.tasks).toHaveLength(0);
      harness.post('resume', {}, targetRun + 1);
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
    expect(harness.last('error')).toMatchObject({ operation: 'save', commandId: 1, runId: 1 });
    const started = harness.post('start', { settings: DEFAULTS });
    const responseCount = harness.responseCount;
    harness.raw(started);
    harness.raw({ ...started, runId: 2 });
    expect(harness.responseCount).toBe(responseCount);
    harness.post('save', {}, 0);
    expect(harness.last('error')).toMatchObject({ operation: 'save', commandId: 3, runId: 0 });
    harness.post('export-measurements', { format: 'json' });
    expect(harness.last('measurement-exported')).toMatchObject({ commandId: 4, runId: 1 });
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
      commandId: 7,
      runId: 2,
    });
    expect(harness.last('error').message.length).toBe(512);
    harness.post('export-measurements', { format: 'json' }, 2);
    expect(harness.last('measurement-exported').commandId).toBe(8);
    vi.spyOn(Ecosystem.prototype, 'display').mockImplementationOnce(() => {
      throw new Error('injected snapshot failure');
    });
    harness.post('snapshot', { display: true }, 2);
    expect(harness.last('control')).toMatchObject({ commandId: 9, operation: 'snapshot' });
    expect(harness.last('error')).toMatchObject({
      type: 'error',
      runId: 2,
      fatal: true,
    });
    expect(harness.last('error').message).toContain('injected snapshot failure');
    expect(harness.last('error')).not.toHaveProperty('commandId');
    harness.post('save', {}, 2);
    const beforeFailure = harness.last('saved').text;
    harness.post('start', { settings: { ...DEFAULTS, nutrients: -1 } }, 3);
    expect(harness.last('error')).toMatchObject({
      operation: 'start',
      runId: 3,
      recovery: { state: { settings: DEFAULTS } },
    });
    harness.post('save', {}, 3);
    expect(harness.last('saved').text).toBe(beforeFailure);
    vi.spyOn(Ecosystem.prototype, 'presentation').mockImplementationOnce(() => {
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
    harness.post('pause');
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
    harness.post('inspect', { x: 1, y: 1 });
    harness.post('snapshot', { display: true });
    harness.post('save');
    expect(harness.last('saved').text).toBe(before);
    paint(1);
    expect(harness.last('manual-result')).toMatchObject({ status: 'no-op', rowSequence: null });
    harness.post('step');
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
    harness.post('pause');
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
    harness.post('pause');
    for (const tool of ['unknown', 'food']) {
      harness.post('paint', { tool, x: -1, y: 1, radius: 0, genome: founder(0), strokeId: 1 });
      expect(harness.last('error').operation).toBe('paint');
    }
    harness.post('settings', { settings: null });
    expect(harness.last('error').operation).toBe('settings');
    harness.post('paint', { tool: 'plant', x: 1, y: 1, radius: 0, genome: founder(0) });
    expect(harness.last('manual-result')).toMatchObject({ status: 'applied', rowSequence: 1 });
    harness.post('paint', { tool: 'plant', x: 1, y: 1, radius: 0, genome: founder(0) });
    expect(harness.last('error')).toMatchObject({
      operation: 'paint',
      message:
        'Placement blocked by a wall, organism or population limit. Nothing was placed; choose another position.',
    });
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
  it('retains an exact cap-sized native9 import even when successor Save exceeds the unchanged cap', () => {
    let retained!: Ecosystem;
    const display = Ecosystem.prototype.display;
    vi.spyOn(Ecosystem.prototype, 'display').mockImplementation(function (this: Ecosystem) {
      retained = this;
      return display.call(this, this.presentation());
    });
    const original = JSON.parse(world9Text('native9-opaque-extinct'));
    original.settings.capExtension = '';
    original.settings.capExtension = 'x'.repeat(
      WORLD_MAX_BYTES - new TextEncoder().encode(JSON.stringify(original)).length,
    );
    const text = JSON.stringify(original);
    expect(new TextEncoder().encode(text).length).toBe(WORLD_MAX_BYTES);
    const harness = workerHarness();
    harness.send({ type: 'load', runId: 1, text });
    expect(harness.last('loaded')).toBeDefined();
    harness.send({ type: 'pause' });
    const before = retained.save(),
      queued = harness.tasks.length;
    expect(projectWorld9(before)).toEqual(original);
    expect(new TextEncoder().encode(JSON.stringify(before)).length).toBeGreaterThan(
      WORLD_MAX_BYTES,
    );
    const error = harness.send({ type: 'save' });
    expect(error).toMatchObject({
      type: 'error',
      operation: 'save',
      message: 'World file exceeds 2.5 MB. Nothing was downloaded.',
    });
    expect(error).not.toHaveProperty('fatal');
    expect(harness.last('saved')).toBeUndefined();
    expect(retained.save()).toEqual(before);
    expect(harness.tasks.length).toBe(queued);
    const control = Ecosystem.load(text);
    harness.send({ type: 'step' });
    control.step();
    expect(retained.save()).toEqual(control.save());
    expect((retained.settings as any).capExtension).toBe(original.settings.capExtension);
    expect(harness.last().state.playback.paused).toBe(true);
  });

  it('rejects the last shade tuple, native9 genome and extinct archive without partial installation or selection loss', () => {
    const harness = workerHarness();
    const initial = Ecosystem.load(world9Text('native9-opaque-extinct'));
    initial.changeShadeMode(true);
    initial.paintShade({ rulesVersion: 1, tool: 'shade', units: 16, radius: 1 }, 40, 40);
    harness.load(initial.save());
    harness.send({ type: 'pause' });
    harness.send({ type: 'inspect', x: 40, y: 40 });
    const text = harness.saveText(),
      before = JSON.parse(text),
      queued = harness.tasks.length;
    const finalTuple = structuredClone(before);
    finalTuple.shadeHabitats.cells.push([37439, 17]);
    const genome = JSON.parse(world9Text('native9-opaque-extinct'));
    genome.organisms.at(-1)!.genome.behavior.version = 2 as any;
    const archive = JSON.parse(world9Text('native9-opaque-extinct'));
    archive.lineageArchive.summaries.find(
      (row) => row.extinctTick !== null,
    )!.foundingGenome!.behavior.version = 2 as any;
    for (const [offset, candidate] of [finalTuple, genome, archive].entries()) {
      harness.send({ type: 'load', runId: offset + 2, text: JSON.stringify(candidate) });
      expect(harness.last('error')).toMatchObject({
        operation: 'load',
        recovery: {
          state: {
            selected: { id: before.organisms[0].id },
            settings: observedSettings(before.settings),
            playback: { paused: true },
          },
        },
      });
      expect(harness.saveText()).toBe(text);
      expect(harness.tasks.length).toBe(queued);
    }
    const control = Ecosystem.load(text);
    harness.send({ type: 'step', runId: 4 });
    control.step();
    expect(harness.save()).toEqual(control.save());
  });
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
      message: 'World file exceeds 2.5 MB. Nothing was downloaded.',
    });
    expect(result).not.toHaveProperty('fatal');
    expect(result.recovery.state.world.stats).toEqual(before.stats);
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
    expect(harness.state().playback).toEqual({
      paused: true,
      pauseOnExtinction: true,
      extinction: { tick: 90, cause: 'manual' },
    });
    expect(harness.source().telemetry.samples.at(-1)).toMatchObject({
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
    expect(harness.state().playback).toEqual({
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
    expect(harness.source().telemetry.samples.at(-1)).toMatchObject({
      tick: 120,
      population: 1,
      deaths: { manual: 1 },
      births: 0,
    });
    expect(harness.state().playback.paused).toBe(true);
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
    harness.advance();
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
    harness.advance();
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
    const harness = workerHarness(),
      { tasks, send, last } = harness;
    send({ type: 'start', settings: DEFAULTS, runId: 10 });
    send({ type: 'pause' });
    harness.advance();
    send({ type: 'save' });
    const before = last('saved').text;
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
    expect(last('saved').text).toBe(before);
    send({ type: 'paint', tool: 'plant', x: 20, y: 20, radius: 0, genome: blueprint.genome });
    expect(last().runId).toBe(10);
    expect(harness.state().world.stats.tick).toBe(0);
    send({ type: 'inspect', x: 20, y: 20 });
    expect(harness.state().selected).toMatchObject({
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
    expect(harness.state().selected.genome).toEqual(genome);
    send({
      type: 'paint',
      tool: 'plant',
      x: 60,
      y: 60,
      radius: 0,
      genome: { ...genome, tempo: 0 },
    });
    send({ type: 'save' });
    expect(JSON.parse(last('saved').text).organisms).toHaveLength(2);
    send({ type: 'step' });
    expect(harness.state().world.stats.tick).toBe(1);
    expect(tasks).toHaveLength(0);
    send({ type: 'snapshot' });
    expect(harness.state().world.stats.tick).toBe(1);
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
        harness.advance();
        const emitted = harness.last('frame');
        harness.send({ type: 'snapshot', display: false });
        expect(emitted).toMatchObject({ type: 'frame', runId: 1 });
        expect(emitted.frame.stats.tick).toBe(batch * speed);
        for (let tick = 0; tick < speed; tick++) reference.step();
        expect(harness.tasks).toHaveLength(1);
        const before = harness.saveText(),
          expected = reference.save();
        expect(before).toBe(JSON.stringify(expected));
        const samples = harness.source().telemetry.samples;
        expect(samples.map((sample) => sample.tick)).toEqual(
          Array.from({ length: Math.floor((batch * speed) / 30) }, (_, index) => (index + 1) * 30),
        );
        harness.send({ type: 'inspect', x: WIDTH / 2, y: 78 });
        harness.send({ type: 'snapshot', display: false });
        expect(harness.saveText()).toBe(before);

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
        expect(harness.messages.map((message) => message.type).sort()).toEqual([
          'control',
          'frame',
          'measurement-exported',
          'progress',
          'saved',
        ]);
        expect(harness.messages.filter((message) => message.type === 'frame')).toHaveLength(1);
      }
      harness.send({ type: 'pause' });
      harness.advance();
      expect(harness.tasks).toHaveLength(0);
    },
  );

  it('keeps paused edits and boundary steps real, restores pending state, and fails loads atomically under the incoming run ID', () => {
    const world = new Ecosystem();
    for (let tick = 0; tick < 29; tick++) world.step();
    const harness = workerHarness();
    harness.send({ type: 'start', settings: DEFAULTS, runId: 0 });
    harness.send({ type: 'pause-on-extinction', runId: 0, value: false });
    harness.send({ type: 'load', runId: 5, text: JSON.stringify(world.save()) });
    harness.send({ type: 'pause' });
    harness.advance();
    expect(harness.frame().telemetry.samples).toEqual([]);
    harness.send({ type: 'inspect', x: 120, y: 78 });
    expect(harness.state().selected.id).toBe(1);
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
      selected = harness.messages.filter((message) => message.type === 'frame').at(-1)
        .state.selected;
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
      expect(recovered.state.selected).toEqual(selected);
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
      harness.advance();
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
        harness.advance();
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
          harness.advance();
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
          harness.advance();
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
    harness.send({ type: 'start', settings: DEFAULTS, runId: 0 });
    harness.send({ type: 'pause-on-extinction', runId: 0, value: false });
    harness.send({ type: 'load', runId: 1, text: JSON.stringify(world.save()) });
    harness.send({ type: 'pause' });
    harness.advance();
    expect(harness.frame().telemetry.samples).toHaveLength(180);
    expect(harness.frame().telemetry.samples[0].tick).toBe(60);
    harness.send({ type: 'paint', tool: 'food', x: 30, y: 30, radius: 0, genome: founder(0) });
    const before = harness.save().telemetry;
    harness.send({ type: 'inspect', x: 30, y: 30 });
    harness.frame();
    expect(harness.save().telemetry).toEqual(before);
    harness.send({ type: 'resume' });
    harness.send({ type: 'speed', value: 12 });
    for (let batch = 0; batch < 3; batch++) harness.advance();
    expect(harness.frame().telemetry.samples).toHaveLength(180);
    expect(harness.frame().telemetry.samples[0].tick).toBe(90);
    expect(harness.frame().telemetry.samples.at(-1)!.tick).toBe(5460);
    expect(harness.frame().telemetry.pending.fromTick).toBe(5460);
  });

  it('uses one yielding loop, obeys pause and speed, and processes edits while paused', () => {
    const harness = workerHarness(),
      { tasks, send, last } = harness;
    send({ type: 'snapshot' });
    send({ type: 'resume' });
    expect(tasks).toHaveLength(0);
    send({ type: 'start', settings: {}, runId: 1 });
    expect(last('error').type).toBe('error');
    send({ type: 'start', settings: DEFAULTS, runId: 1 });
    expect(harness.state().world.stats).toMatchObject({
      tick: 0,
      population: 1,
      births: 0,
      species: 1,
      food: 0,
    });
    send({ type: 'resume' });
    expect(tasks).toHaveLength(1);
    send({ type: 'pause' });
    harness.advance();
    expect(tasks).toHaveLength(0);
    send({ type: 'speed', value: 12 });
    send({ type: 'speed', value: 999 });
    send({ type: 'resume' });
    harness.advance();
    expect(harness.state().world.stats.tick).toBe(12);
    send({ type: 'pause' });
    send({ type: 'step' });
    expect(harness.state().world.stats.tick).toBe(13);
    send({ type: 'settings', settings: { nutrients: 10 } });
    send({ type: 'settings', settings: { nutrients: -1 } });
    const beforeBloom = harness.responseCount;
    send({ type: 'shock', kind: 'bloom' });
    expect(harness.last('error')).toMatchObject({ code: 'invalid-command' });
    send({ type: 'paint', tool: 'food', x: 20, y: 20, radius: 2, genome: founder(0) });
    send({ type: 'paint', tool: 'plant', x: 40, y: 40, radius: 0, genome: founder(0) });
    send({ type: 'inspect', x: 40, y: 40 });
    expect(harness.state().selected).not.toBeNull();
    send({ type: 'shock', kind: 'cold' });
    expect(harness.state().world.stats.event).toContain('Cold snap');
    send({ type: 'save' });
    const save = last('saved').text;
    expect(JSON.parse(save).settings.nutrients).toBe(10);
    send({ type: 'load', text: save, runId: 2 });
    expect(last().runId).toBe(2);
    expect(harness.state().world.stats.tick).toBe(13);
    send({ type: 'load', text: '{}', runId: 3 });
    expect(last('error').type).toBe('error');
    expect(last().runId).toBe(3);
    send({ type: 'snapshot' });
    expect(harness.state().world.stats.tick).toBe(13);
    const savedPopulation = JSON.parse(save).organisms.length;
    expect(savedPopulation).toBeGreaterThan(1);
    expect(harness.state().world.stats.population).toBe(savedPopulation);
    send({ type: 'start', settings: { ...DEFAULTS, seed: 123 }, runId: 4 });
    expect(last().runId).toBe(4);
    expect(harness.state().world.stats).toMatchObject({
      tick: 0,
      population: 1,
      births: 0,
      species: 1,
    });
    send({ type: 'unknown' });
  });
  it('reports failed ticks and reads without duplicating evaluation', () => {
    vi.useFakeTimers();
    const scope: Scope = { postMessage: vi.fn(), onmessage: null };
    startWorker(scope);
    let commandId = 0,
      runId = 4;
    const send = (data: any) =>
      scope.onmessage!({
        data: {
          ...data,
          runId: data.runId ?? runId,
          commandId: ++commandId,
          ...(data.type === 'start' ? { display: { epoch: 0, enabled: true, visible: true } } : {}),
        },
      } as MessageEvent);
    send({ type: 'start', settings: DEFAULTS });
    const step = vi.spyOn(Ecosystem.prototype, 'step').mockImplementation(() => {
      throw new Error('Failed tick');
    });
    vi.runAllTimers();
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed tick', fatal: true }),
    );
    send({ type: 'resume' });
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'invalid-command' }),
    );
    step.mockImplementation(() => {
      throw 'failed';
    });
    send({ type: 'start', settings: DEFAULTS, runId: ++runId });
    vi.runAllTimers();
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'failed', fatal: true }),
    );
    vi.spyOn(Ecosystem, 'load').mockImplementation(() => {
      throw 'unreadable';
    });
    send({ type: 'load', text: 'x', runId: ++runId });
    expect(vi.mocked(scope.postMessage).mock.calls.at(-1)![0]).toMatchObject({
      message: 'unreadable',
    });
    expect(vi.mocked(scope.postMessage).mock.calls.at(-1)![0]).toMatchObject({
      recovery: { state: { playback: { paused: true } } },
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
        harness.send({ type: 'start', settings: DEFAULTS, runId: 0 });
        const file = terminalWorld(offset);
        harness.send({ type: 'speed', value: speed });
        harness.load(file);
        expect(harness.state().playback).toEqual({
          paused: false,
          pauseOnExtinction: true,
          extinction: null,
        });
        harness.advance();
        const expected = Ecosystem.load(JSON.stringify(file));
        for (let step = 0; step < offset; step++) expected.step();
        expect({ ...harness.last(), ...harness.last().state }).toMatchObject({
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
        unguarded.send({ type: 'start', settings: DEFAULTS, runId: 0 });
        unguarded.send({ type: 'pause-on-extinction', runId: 0, value: false });
        unguarded.send({ type: 'speed', value: speed });
        unguarded.load(file);
        unguarded.advance();
        expect(unguarded.last().frame.stats.tick).toBe(file.tick + speed);
        expect(unguarded.state().playback).toEqual({
          paused: false,
          pauseOnExtinction: false,
          extinction: { tick: file.tick + offset, cause: 'age' },
        });
        expect(unguarded.tasks).toHaveLength(1);
        for (let step = offset; step < speed; step++) harness.send({ type: 'step' });
        expect(harness.save()).toEqual(unguarded.save());
        unguarded.advance();
        expect(unguarded.state().playback.extinction.tick).toBe(file.tick + offset);
        expect(unguarded.last().frame.stats.population).toBe(0);
      });
    }
    it(`stops at real energy exhaustion in a ${speed}-tick batch`, () => {
      const harness = workerHarness();
      harness.send({ type: 'start', settings: DEFAULTS, runId: 0 });
      harness.send({ type: 'speed', value: speed });
      harness.load(terminalWorld(30, 0.001));
      harness.advance();
      expect({ ...harness.last(), ...harness.last().state }).toMatchObject({
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
      expect(harness.state().playback).toEqual({
        paused: false,
        pauseOnExtinction: preference,
        extinction: null,
      });
      expect(harness.tasks).toHaveLength(1);
      harness.load(terminalWorld(), 3);
      const empty = legacyV5(terminalWorld());
      empty.organisms = [];
      harness.load(empty, 4);
      expect(harness.last('loaded').state.playback).toEqual({
        paused: preference,
        pauseOnExtinction: preference,
        extinction: { tick: 71, cause: 'empty-import' },
      });
      expect(harness.last().frame.stats.tick).toBe(71);
      const saved = harness.save();
      expect(saved).toEqual(Ecosystem.load(JSON.stringify(empty)).save());
      harness.send({ type: 'load', runId: 5, text: '{}' });
      expect(harness.last('error').recovery.state.playback).toEqual(harness.state().playback);
      expect(harness.save()).toEqual(saved);
      harness.advance();
      expect(harness.save().tick).toBe(preference ? 71 : 75);
      expect(harness.tasks).toHaveLength(preference ? 0 : 1);
      harness.load(terminalWorld(12), 6);
      expect(harness.state().playback).toEqual({
        paused: false,
        pauseOnExtinction: preference,
        extinction: null,
      });
      harness.send({ type: 'start', runId: 7, settings: DEFAULTS });
      harness.advance();
      expect({ ...harness.last(), ...harness.last().state }).toMatchObject({
        runId: 7,
        frame: { stats: { tick: 4, population: 1 } },
        playback: { extinction: null, pauseOnExtinction: preference },
      });
      const fresh = workerHarness();
      fresh.send({ type: 'start', runId: 1, settings: DEFAULTS });
      expect(fresh.state().playback.pauseOnExtinction).toBe(true);
    },
  );

  it.each([true, false])(
    'loads an empty world before advancement with preference %s and no pending loop',
    (preference) => {
      const harness = workerHarness();
      if (!preference) harness.send({ type: 'start', settings: DEFAULTS, runId: 0 });
      if (!preference) harness.send({ type: 'pause-on-extinction', runId: 0, value: false });
      const empty = legacyV5(terminalWorld());
      empty.organisms = [];
      harness.load(empty);
      expect(harness.save()).toEqual(Ecosystem.load(JSON.stringify(empty)).save());
      expect(harness.state().playback.extinction).toEqual({ tick: 71, cause: 'empty-import' });
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
        harness.frame();
        expect({ ...harness.last(), ...harness.last().state }).toMatchObject({
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
    expect(harness.state().selected.id).toBe(1);
    harness.send({ type: 'step' });
    expect(harness.state().playback.extinction).toEqual({ tick: 72, cause: 'age' });
    expect(harness.state().selected).toBeNull();
    harness.send({ type: 'step' });
    expect(harness.last().frame.stats.tick).toBe(73);
    expect(harness.state().playback).toMatchObject({ paused: true, extinction: { tick: 72 } });
    for (let attempt = 0; attempt < 3; attempt++) {
      harness.send({ type: 'resume' });
      harness.send({ type: 'speed', value: 12 });
      expect(harness.last('control').state.playback.paused).toBe(true);
      expect(harness.tasks).toHaveLength(1);
    }
    harness.advance();
    expect(harness.tasks).toHaveLength(0);
    const before = harness.save();
    harness.send({ type: 'inspect', x: 40, y: 40 });
    harness.send({ type: 'paint', tool: 'plant', x: 6, y: 6, radius: 0, genome: mouth });
    expect(harness.state().playback.extinction).toEqual({ tick: 72, cause: 'age' });
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
    expect(harness.state().playback).toEqual({
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
      const count = harness.messages.filter((message) => message.type === 'error').length;
      harness.send({ type: 'pause-on-extinction', runId: 1, value });
      expect(harness.last('error')).toMatchObject({ code: 'invalid-command' });
    }
    harness.send({ type: 'pause-on-extinction', runId: 0, value: false });
    expect(harness.state().playback.pauseOnExtinction).toBe(true);
    harness.send({ type: 'pause-on-extinction', runId: 1, value: true });
    expect(harness.last('control').state.playback.paused).toBe(false);
    harness.advance();
    const before = harness.save();
    for (let repeat = 0; repeat < 2; repeat++)
      harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
    expect(harness.last('control').state.playback).toMatchObject({
      paused: true,
      pauseOnExtinction: false,
    });
    expect(harness.tasks).toHaveLength(0);
    expect(harness.save()).toEqual(before);
    harness.send({ type: 'resume' });
    harness.advance();
    expect(harness.last().frame.stats.tick).toBe(76);
    harness.send({ type: 'pause-on-extinction', runId: 1, value: true });
    expect(harness.last('control').state.playback).toEqual({
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
      const empty = legacyV5(terminalWorld());
      empty.organisms = [];
      harness.load(empty);
      if (!preference) harness.send({ type: 'pause-on-extinction', runId: 1, value: false });
      const before = harness.save();
      harness.send({ type: 'step' });
      const expected = Ecosystem.load(JSON.stringify(before));
      expected.step();
      expect(harness.save()).toEqual(expected.save());
      expect(harness.state().playback).toEqual({
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
          expect(harness.last('frame').state.playback).toEqual({
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
          expect(harness.last('error').recovery.telemetry.telemetry).toEqual(terminal.telemetry);
          expect(harness.save()).toEqual(terminal);
          expect(harness.tasks).toHaveLength(0);
          const unguarded = workerHarness();
          unguarded.send({ type: 'start', settings: DEFAULTS, runId: 0 });
          unguarded.send({ type: 'pause-on-extinction', runId: 0, value: false });
          unguarded.send({ type: 'speed', value: speed });
          unguarded.load(file);
          unguarded.advance();
          for (let tick = 1; tick < speed; tick++) harness.send({ type: 'step' });
          expect(harness.save()).toEqual(unguarded.save());
          expect(unguarded.last('frame').state.playback.extinction).toEqual({
            tick: atTick + 1,
            cause,
          });
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
    expect(harness.last('frame').state.playback.extinction).toEqual({ tick: 90, cause: 'manual' });
    harness.advance();
    expect(harness.tasks).toHaveLength(0);
    harness.send({ type: 'load', runId: 2, text: '{}' });
    expect(harness.last('error').recovery.telemetry.telemetry).toEqual(erased.telemetry);
    expect(harness.save()).toEqual(erased);
    harness.send({ type: 'pause-on-extinction', runId: 2, value: false });
    expect(harness.tasks).toHaveLength(0);
    harness.send({ type: 'paint', tool: 'plant', x: 40, y: 40, radius: 0, genome: mouth });
    expect(harness.last('frame').state.playback).toEqual({
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

  it.each([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])(
    'migrates/restores v%i then preserves terminal and pending history through an empty save continuation',
    (version) => {
      const harness = workerHarness();
      const current = terminalWorld(1, 5, 89);
      const {
        telemetry: _telemetry,
        lineageArchive: _lineageArchive,
        interventions: _interventions,
        terrain: _terrain,
        thermalRefuges: _thermalRefuges,
        ...legacy
      } = syntheticHistoricalWorld(current);
      const file =
        version === 2
          ? { ...legacy, version: 2 as const }
          : version === 3
            ? legacyV3(current)
            : version === 4
              ? legacyV4(current)
              : version === 5
                ? legacyV5(current)
                : version === 6
                  ? legacyV6(current)
                  : version === 7
                    ? legacyV7(current)
                    : version === 8
                      ? legacyV8(current)
                      : version === 9
                        ? legacyV9(current)
                        : version === 10
                          ? {
                              ...current,
                              version: 10 as const,
                              interventions: { ...current.interventions, version: 4 },
                            }
                          : version === 11
                            ? {
                                ...current,
                                version: 11 as const,
                                interventions: { ...current.interventions, version: 4 },
                              }
                            : version === 12
                              ? {
                                  ...current,
                                  version: 12 as const,
                                  interventions: { ...current.interventions, version: 4 },
                                }
                              : version === 13
                                ? { ...current, version: 13 as const }
                                : version === 14
                                  ? { ...current, version: 14 as const }
                                  : version === 15
                                    ? { ...current, version: 15 as const }
                                    : version === 16
                                      ? { ...current, version: 16 as const }
                                      : current;
      if (version >= 8 && version < 15 && 'lineageArchive' in file)
        file.lineageArchive = historicalArchive(file.lineageArchive);
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
        expect(imported).toEqual(
          file.version >= 10
            ? {
                ...file,
                version: WORLD_VERSION,
                nutrientCycle: null,
                lineageArchive: {
                  ...file.lineageArchive,
                  version: 2,
                  mutationOriginTick:
                    version >= 15 ? file.lineageArchive.mutationOriginTick : file.tick,
                },
                mutationPolicy: { version: 1, mode: 'legacy' },
                interventions: { ...file.interventions, version: 5 },
              }
            : file.version >= 5
              ? {
                  ...file,
                  version: WORLD_VERSION,
                  nutrientCycle: null,
                  mutationPolicy: { version: 1, mode: 'legacy' },
                  shadeHabitats: { version: 1, enabled: false, cells: [] },
                  organisms: imported.organisms,
                  lineageArchive: imported.lineageArchive,
                  terrain: file.version >= 6 ? file.terrain : { ...DEFAULT_TERRAIN },
                  thermalRefuges:
                    file.version >= 7
                      ? file.thermalRefuges
                      : { version: 1, enabled: false, cells: [] },
                  interventions: { ...file.interventions, version: 5 },
                }
              : {
                  ...file,
                  version: WORLD_VERSION,
                  nutrientCycle: null,
                  mutationPolicy: { version: 1, mode: 'legacy' },
                  shadeHabitats: { version: 1, enabled: false, cells: [] },
                  organisms: imported.organisms,
                  lineageArchive: imported.lineageArchive,
                  terrain: { ...DEFAULT_TERRAIN },
                  thermalRefuges: { version: 1, enabled: false, cells: [] },
                  interventions: {
                    version: 5,
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
      expect(terminal.version).toBe(17);
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
      expect(harness.last('frame').state.playback.extinction).toEqual({
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
      expect(harness.last('frame').state.playback.paused).toBe(true);
    },
  );
});

describe('failed-load retained-world recovery', () => {
  it('C16-R1 rejects both pruning provenance variants and same-tick FIFO inversion with complete save preservation', () => {
    const swapped = sameTickLineages().save();
    [swapped.lineageArchive.summaries[0], swapped.lineageArchive.summaries[1]] = [
      swapped.lineageArchive.summaries[1],
      swapped.lineageArchive.summaries[0],
    ];
    const harness = workerHarness();
    harness.load(terminalWorld(12));
    harness.send({ type: 'pause' });
    harness.advance(); // Settle the already queued callback while paused.
    harness.send({ type: 'inspect', x: 40, y: 40 });
    const before = harness.saveText(),
      control = Ecosystem.load(before);
    let runId = 1;
    for (const invalid of [
      contradictoryPruning(false),
      contradictoryPruning(true),
      swapped,
      omittedNewestAdmission(),
      impossibleReadmission(),
      falsePruningClaim(),
      reversedPrunedParent(),
      reversedReadmittedParent(),
      reversedReadmittedParent(true),
      omittedRelatedChild(),
      missingFinalExtinction(),
      extinctionOccupancyContradiction(),
    ]) {
      harness.send({ type: 'load', runId: ++runId, text: JSON.stringify(invalid) });
      expect(harness.last('error')).toMatchObject({
        runId,
        operation: 'load',
        message: 'Invalid ecosystem lineage archive.',
        recovery: {
          state: { selected: { id: control.save().organisms[0].id }, playback: { paused: true } },
        },
      });
      expect(harness.saveText()).toBe(before);
      expect(harness.tasks).toHaveLength(0);
    }
    harness.send({ type: 'step' });
    control.step();
    expect(harness.save()).toEqual(control.save());
  });
  it('rejects corrupt current archive atomically and keeps exact full-save recovery and future ordering', () => {
    const harness = workerHarness();
    harness.load(terminalWorld(12));
    harness.send({ type: 'pause' });
    harness.send({ type: 'inspect', x: 40, y: 40 });
    const before = harness.save(),
      text = harness.saveText();
    const invalid = structuredClone(before);
    invalid.lineageArchive.living[0].liveCount++;
    harness.send({ type: 'load', runId: 2, text: JSON.stringify(invalid) });
    expect(harness.last('error')).toMatchObject({
      runId: 2,
      operation: 'load',
      message: 'Invalid ecosystem lineage archive.',
      recovery: {
        state: {
          selected: { id: before.organisms[0].id },
          settings: before.settings,
          playback: { paused: true },
        },
      },
    });
    expect(harness.saveText()).toBe(text);
    const control = Ecosystem.load(text);
    harness.send({
      type: 'paint',
      runId: 1,
      tool: 'plant',
      x: 80,
      y: 80,
      radius: 0,
      genome: mouth,
    });
    expect(harness.last('error').code).toBe('stale-run');
    expect(harness.saveText()).toBe(text);
    harness.send({ type: 'step', runId: 2 });
    control.step();
    expect(harness.save()).toEqual(control.save());
    expect(harness.tasks).toHaveLength(1);
    harness.advance();
    expect(harness.tasks).toHaveLength(0);
    expect(harness.save()).toEqual(control.save());
  });
  it('recovers a held terminal frame immediately under the adopted ID without mutation or scheduling', () => {
    const frameSpy = vi.spyOn(Ecosystem.prototype, 'presentation');
    const harness = workerHarness();
    harness.load(terminalWorld());
    harness.send({ type: 'inspect', x: 40, y: 40 });
    harness.advance();
    const retained = frameSpy.mock.contexts.at(-1)!;
    const record = structuredClone(retained.lastDeath);
    const before = harness.save();
    const held = harness.last();
    const count = harness.messages.filter((message) => message.type === 'error').length;
    harness.send({ type: 'load', runId: 2, text: '{}' });
    expect(harness.messages.filter((message) => message.type === 'error')).toHaveLength(1);
    const recovery = harness.last('error');
    expect(recovery).toMatchObject({
      type: 'error',
      runId: 2,
      recovery: {
        state: {
          world: { stats: { tick: 72, population: 0 } },
          selected: null,
          settings: before.settings,
          playback: {
            paused: true,
            pauseOnExtinction: true,
            extinction: { tick: 72, cause: 'age' },
          },
        },
      },
    });
    expect(recovery).not.toHaveProperty('fatal');
    expect(recovery.recovery.state.world).toEqual({ ...held.state.world });
    expect(recovery.recovery).not.toHaveProperty('frame');
    expect(harness.last('frame').frame).toEqual(held.frame);
    expect(frameSpy.mock.contexts.at(-1)).toBe(retained);
    expect(retained.lastDeath).toEqual(record);
    expect(retained.save()).toEqual(before);
    expect(harness.tasks).toHaveLength(0);
    for (let repeat = 0; repeat < 2; repeat++)
      harness.send({ type: 'load', runId: 3 + repeat, text: 'not json' });
    expect(harness.transferStats.batches).toBeGreaterThan(0);
    expect(harness.transferStats.buffers).toBe(harness.transferStats.batches * 4);
    expect(harness.transferStats.duplicates).toBe(0);
    expect(harness.transferStats.detached).toBe(harness.transferStats.buffers);
    expect(harness.save()).toEqual(before);
    harness.load(terminalWorld(12), 5);
    expect(harness.state().playback.extinction).toBeNull();
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
      const actual = harness.last('control').state.playback;
      const before = harness.save();
      const pending = harness.tasks.length;
      harness.send({ type: 'load', runId: 2, text: '{}' });
      const error = harness.last('error');
      expect(error.recovery.state.playback).toEqual(actual);
      expect(error.recovery.state.selected?.id ?? null).toBe(before.organisms[0]?.id ?? null);
      expect(error.recovery.state.settings).toEqual(before.settings);
      expect(error.recovery.state.world.stats).toMatchObject({
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
      const count = harness.messages.filter((message) => message.type === 'error').length;
      harness.send({ type: 'load', runId: ++runId, text });
      expect(harness.messages.filter((message) => message.type === 'error')).toHaveLength(1);
      expect(harness.last('error')).toMatchObject({
        runId,
        recovery: {
          state: {
            selected: before.organisms[0],
            playback: { paused: true, pauseOnExtinction: true, extinction: null },
          },
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
    const frameSpy = vi.spyOn(Ecosystem.prototype, 'presentation').mockImplementation(() => {
      throw new Error('Frame failed');
    });
    harness.send({ type: 'load', runId: 3, text: '{}' });
    expect(harness.last('error')).toMatchObject({ fatal: true, message: 'Frame failed', runId: 3 });
    frameSpy.mockRestore();
    harness.load(terminalWorld(), 4);
    const post = harness.scope.postMessage;
    harness.scope.postMessage = (data, transfer) => {
      if (data.type === 'error' && data.recovery) throw new Error('Transfer failed');
      post(data, transfer);
    };
    harness.send({ type: 'load', runId: 5, text: '{}' });
    expect(harness.last('error')).toMatchObject({
      fatal: true,
      message: 'Transfer failed',
      runId: 5,
    });
  });
});

it('keeps neural organisms deterministic through yielding, paused edits, exact Step and stale-run rejection', () => {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0, mutation: 0 }, false);
  const genome = founder(0);
  genome.controller = newController();
  const organism = world.spawn(genome, 60, 60)!;
  const harness = workerHarness();
  harness.load(world.save());
  harness.send({ type: 'pause' });
  for (const speed of [1, 4, 12]) {
    harness.send({ type: 'speed', value: speed });
    harness.send({ type: 'step' });
    world.step();
    expect(harness.save()).toEqual(world.save());
  }
  harness.send({ type: 'paint', tool: 'food', radius: 0, x: 10, y: 10, genome });
  manualPaint(world, 'food', 10, 10, 0, genome);
  expect(harness.save()).toEqual(world.save());
  harness.send({ type: 'resume' });
  harness.send({ type: 'resume' });
  expect(harness.tasks).toHaveLength(1);
  harness.advance();
  const advanced = harness.save().tick;
  expect(advanced - world.tick).toBe(12);
  while (world.tick < advanced) world.step();
  expect(harness.save()).toEqual(world.save());
  expect(harness.tasks).toHaveLength(1);
  harness.send({ type: 'pause' });
  const retained = harness.saveText(),
    malformed = JSON.parse(retained);
  malformed.organisms[0].genome.controller.biases[7] = 100;
  harness.send({ type: 'load', runId: 2, text: JSON.stringify(malformed) });
  expect(harness.last('error').code).toBe('load-failed');
  expect(harness.saveText()).toBe(retained);
  harness.send({ type: 'step', runId: 1 });
  expect(harness.last('error').code).toBe('stale-run');
  expect(harness.saveText()).toBe(retained);
  harness.send({ type: 'step' });
  world.step();
  expect(harness.save()).toEqual(world.save());
  expect(
    harness.save().organisms.find((entry) => entry.id === organism.id)!.genome.controller,
  ).toEqual(genome.controller);
  harness.dispose();
});

it('keeps active worlds bounded by native yielding, exact Step, stale-run rejection and complete failure recovery', () => {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0, mutation: 0 }, false);
  const active: Genome = {
    ...mouth,
    cells: [
      { x: 0, y: 0, type: 8 },
      { x: 1, y: 0, type: 5 },
    ],
    behavior: {
      version: 2,
      mode: 'evolved',
      reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
    },
  };
  const placed = world.spawn(active, 60, 60)!;
  placed.age = 1;
  world.food[index(60, 57)] = 1;
  const extinct = world.spawn(active, 10, 10)!;
  world.kill(extinct, 'manual');
  const harness = workerHarness();
  harness.load(world.save());
  harness.send({ type: 'pause' });
  for (const speed of [1, 4, 12]) {
    harness.send({ type: 'speed', value: speed });
    harness.send({ type: 'step' });
    world.step();
    expect(harness.save()).toEqual(world.save());
  }
  const before = harness.saveText(),
    candidate = JSON.parse(before);
  // A complete retained founding genome is validated, including its last action.
  candidate.lineageArchive.summaries.at(-1).foundingGenome.behavior.reactions.dangerous = 'attack';
  harness.send({ type: 'load', runId: 2, text: JSON.stringify(candidate) });
  expect(harness.last('error').message).toContain('lineage archive');
  expect(harness.saveText()).toBe(before);
  harness.send({ type: 'step', runId: 1 });
  expect(harness.last('error').code).toBe('stale-run');
  expect(harness.saveText()).toBe(before);
  const retained = Ecosystem.load(before);
  harness.send({ type: 'step', runId: 2 });
  retained.step();
  expect(harness.save()).toEqual(retained.save());
  harness.send({ type: 'pause' });
  harness.send({ type: 'pause' });
  expect(harness.tasks.length).toBeLessThanOrEqual(1);
  harness.dispose();
});

describe('actual selected perception through the worker protocol', () => {
  it.each([1, 4, 12])(
    'keeps exact Pause/Step and bounded selection with rendering off at speed %s',
    (speed) => {
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0.4, climate: 0, nutrients: 0 }, false),
        source = {
          ...mouth,
          cells: [
            { x: 0, y: 0, type: 8 },
            { x: 1, y: 0, type: 5 },
          ],
          behavior: {
            version: 2,
            mode: 'evolved',
            reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
          },
        } as Genome;
      const mover = world.spawn(source, 60, 60)!;
      mover.age = 1;
      mover.direction = 0;
      world.food[index(60, 57)] = 1;
      const harness = workerHarness();
      harness.send({ type: 'load', runId: 1, text: JSON.stringify(world.save()) });
      harness.send({ type: 'pause' });
      harness.send({ type: 'speed', value: speed });
      harness.send({ type: 'display-view', view: { epoch: 1, enabled: false, visible: true } });
      harness.send({ type: 'inspect', x: 60, y: 60 });
      world.selectPerception(mover.id);
      expect(harness.state().perception).toBeNull();
      harness.send({ type: 'step' });
      world.step();
      expect(harness.save()).toEqual(world.save());
      expect(harness.state().perception).toEqual(world.perception());
      const trace = world.perception();
      harness.state().perception.rays[0].cells.length = 0;
      harness.send({ type: 'snapshot', display: false });
      expect(harness.state().perception).toEqual(trace);
      harness.send({ type: 'load', runId: 2, text: '{}' });
      expect(harness.state().perception).toEqual(trace);
      expect(harness.save()).toEqual(world.save());
      harness.send({ type: 'inspect', x: 100, y: 100 });
      expect(harness.state().perception).toBeNull();
      harness.send({ type: 'load', runId: 3, text: JSON.stringify(world.save()) });
      expect(harness.state().perception).toBeNull();
      harness.send({ type: 'inspect', runId: 2, x: mover.x, y: mover.y });
      expect(harness.state().perception).toBeNull();
      expect(harness.save()).toEqual(world.save());
      harness.dispose();
    },
  );
});
describe('worker mutation policy ownership', () => {
  it('applies, logs and validates policy commands while paused without extra ticks, then continues exactly', () => {
    const harness = workerHarness();
    harness.send({ type: 'start', settings: DEFAULTS });
    harness.send({ type: 'pause' });
    const before = harness.save(),
      policy = weightedMutation();
    policy.weights.reactions = 0;
    const receipt = harness.send({ type: 'mutation-policy', policy });
    expect(receipt.type).toBe('manual-result');
    expect(receipt.status).toBe('applied');
    expect(receipt.state.world.mutationPolicy).toEqual(policy);
    expect(receipt.state.world.stats.tick).toBe(before.tick);
    expect(receipt.state.playback.paused).toBe(true);
    receipt.state.world.mutationPolicy.weights.add = 19;
    expect(harness.save().mutationPolicy).toEqual(policy);
    const after = harness.save();
    expect(after.random).toBe(before.random);
    expect(after.organisms).toEqual(before.organisms);
    expect(harness.send({ type: 'mutation-policy', policy }).status).toBe('no-op');
    expect(harness.save()).toEqual(after);
    expect(
      harness.send({
        type: 'mutation-policy',
        policy: { version: 1, mode: 'weighted', weights: {} },
      }).type,
    ).toBe('error');
    expect(harness.save()).toEqual(after);
    const reference = Ecosystem.load(JSON.stringify(after));
    harness.send({ type: 'step' });
    reference.step();
    expect(harness.save()).toEqual(reference.save());
    harness.dispose();
  });
});
