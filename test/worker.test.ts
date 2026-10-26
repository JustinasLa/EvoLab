import { afterEach, describe, it, expect, vi } from 'vitest';
import { startWorker, type Scope } from '../src/worker';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder } from '../src/model';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('worker control and persistence', () => {
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
