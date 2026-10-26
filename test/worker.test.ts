import { afterEach, describe, it, expect, vi } from 'vitest';
import { startWorker, type Scope } from '../src/worker';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, index, type WorldFile, type Genome } from '../src/model';

const mouth: Genome = {
  cells: [{ x: 0, y: 0, type: 3 }],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 2,
};
function terminalWorld(offset = 1, energy = 5): WorldFile {
  const world = new Ecosystem({ ...DEFAULTS, seed: 87, climate: 0, nutrients: 0 }, false);
  const organism = world.spawn(mouth, 40, 40)!;
  organism.age = 976 - offset;
  organism.energy = energy;
  world.tick = 71;
  world.births = 9;
  world.deaths = 4;
  world.food[index(5, 5)] = 1;
  world.walls[index(6, 6)] = 1;
  return world.save();
}
function workerHarness() {
  const tasks: (() => void)[] = [],
    messages: any[] = [],
    transfers: Transferable[][] = [];
  const scope: Scope = {
    onmessage: null,
    postMessage(data, transfer = []) {
      transfers.push(transfer);
      messages.push(structuredClone(data, { transfer }));
    },
  };
  startWorker(scope, (callback) => tasks.push(callback));
  const send = (data: any) => scope.onmessage!({ data } as MessageEvent);
  const last = (type = 'frame') => messages.filter((message) => message.type === type).at(-1);
  const save = (): WorldFile => {
    send({ type: 'save' });
    return JSON.parse(last('saved').text);
  };
  const advance = () => tasks.shift()!();
  const load = (file: WorldFile, runId = 1) =>
    send({ type: 'load', runId, text: JSON.stringify(file) });
  return { scope, tasks, messages, transfers, send, last, save, advance, load };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('worker control and persistence', () => {
  it('uses one yielding loop, obeys pause and speed, and processes edits while paused', () => {
    const tasks: (() => void)[] = [],
      scope: Scope = { postMessage: vi.fn(), onmessage: null };
    startWorker(scope, (cb) => tasks.push(cb));
    const send = (data: any) => scope.onmessage!({ data } as MessageEvent),
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
    expect(scope.postMessage).toHaveBeenCalledTimes(beforeBloom);
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
    const send = (data: any) => scope.onmessage!({ data } as MessageEvent);
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
            extinction: { tick: 71, cause: 'manual-erasure' },
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
      const count = harness.messages.length;
      harness.send({ type: 'pause-on-extinction', runId: 1, value });
      expect(harness.messages).toHaveLength(count);
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
    const count = harness.messages.length;
    harness.send({ type: 'load', runId: 2, text: '{}' });
    expect(harness.messages).toHaveLength(count + 1);
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
    const transferred = harness.transfers.filter((buffers) => buffers.length);
    expect(new Set(transferred.flat()).size).toBe(transferred.length * 2);
    for (const buffer of transferred.flat()) expect((buffer as ArrayBuffer).byteLength).toBe(0);
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
      const count = harness.messages.length;
      harness.send({ type: 'load', runId: ++runId, text });
      expect(harness.messages).toHaveLength(count + 1);
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
