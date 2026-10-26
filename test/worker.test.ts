import { afterEach, describe, it, expect, vi } from 'vitest';
import { startWorker, type Scope } from '../src/worker';
import { Ecosystem } from '../src/ecosystem';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { DEFAULTS, WIDTH, founder, type WorldFile, type Frame } from '../src/model';
function workerHarness() {
  const tasks: (() => void)[] = [],
    messages: any[] = [],
    scope: Scope = {
      postMessage: (message) => {
        const previous = messages.findIndex((response) => response.type === message.type);
        if (previous >= 0) messages.splice(previous, 1);
        messages.push(structuredClone(message));
      },
      onmessage: null,
    };
  startWorker(scope, (callback) => tasks.push(callback));
  const send = (data: object) => {
      scope.onmessage!({ data } as MessageEvent);
      return messages.at(-1);
    },
    saveText = (): string => send({ type: 'save' }).text,
    save = (): WorldFile => JSON.parse(saveText()),
    frame = (): Frame => send({ type: 'snapshot' }).frame;
  return { tasks, messages, send, saveText, save, frame };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('worker control and persistence', () => {
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
    reference.paint('plant', 80, 80, 0, blueprint.genome);
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
    const send = (data: object) => scope.onmessage!({ data } as MessageEvent);
    const last = () => vi.mocked(scope.postMessage).mock.calls.at(-1)![0];
    send({ type: 'start', settings: DEFAULTS, runId: 10 });
    send({ type: 'pause' });
    tasks.shift()!();
    send({ type: 'save' });
    const before = last().text;
    const genome = {
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
        const before = harness.saveText();
        expect(before).toBe(JSON.stringify(reference.save()));
        const samples = emitted.frame.telemetry.samples;
        expect(samples.map((sample) => sample.tick)).toEqual(
          Array.from({ length: Math.floor((batch * speed) / 30) }, (_, index) => (index + 1) * 30),
        );
        harness.send({ type: 'inspect', x: WIDTH / 2, y: 78 });
        harness.frame();
        expect(harness.saveText()).toBe(before);
        expect(harness.messages).toHaveLength(2);
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
            { cells: [{ x: 0, y: 0, type: 7 }], preference: 0.5, tolerance, tempo: 2 },
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
    const send = (data: any) => scope.onmessage!({ data } as MessageEvent),
      last = () => vi.mocked(scope.postMessage).mock.calls.at(-1)![0];
    send({ type: 'snapshot' });
    send({ type: 'resume' });
    tasks.shift()!();
    expect(scope.postMessage).not.toHaveBeenCalled();
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
    expect(scope.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'unreadable' }),
    );
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
