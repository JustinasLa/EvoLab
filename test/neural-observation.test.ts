import { describe, expect, it, vi } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, index, type Genome } from '../src/model';
import * as neural from '../src/neural';
import { NEURAL_HISTORY_LIMIT } from '../src/neural-observation';

function scene(action = 1, motor = true) {
  const controller = neural.newController();
  controller.weights[0] = 2;
  controller.weights[6] = -2;
  controller.biases[4 + action] = 1;
  const genome: Genome = {
    ...founder(0),
    cells: [
      { x: 0, y: 0, type: 8 },
      { x: 0, y: 1, type: 3 },
      { x: 1, y: 1, type: motor ? 5 : 4 },
    ],
    tempo: 2,
    controller,
  };
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, mutation: 0, nutrients: 0 }, false);
  const organism = world.spawn(genome, 60, 60, undefined, undefined, 0)!;
  organism.age = 1;
  organism.energy = 30;
  return { world, organism };
}
const latest = (world: Ecosystem) => world.neuralObservation()!.decisions.at(-1)!;

describe('session neural observation', () => {
  it('records the actual single evaluation, sight, action and incurred subtractions', () => {
    const { world, organism } = scene();
    world.food[index(60, 58)] = 1;
    world.selectNeural(organism.id, true);
    const evaluate = vi.spyOn(neural, 'neuralAction');
    world.step();
    expect(evaluate).toHaveBeenCalledTimes(1);
    evaluate.mockRestore();
    const decision = latest(world);
    expect(decision.inputs).toEqual([0.8, 0, 0, 0, 1, 0]);
    expect(decision.hidden).toEqual([1, -1, 0, 0]);
    expect(decision.outputs).toEqual([0, 1, 0, 0]);
    expect(decision).toMatchObject({
      tick: 1,
      action: 'forward',
      result: 'accepted',
      before: { x: 60, y: 60, rotation: 0 },
      after: { x: 60, y: 59, rotation: 0 },
      outcome: { throughTick: 1, boundary: 'completed-tick', mouthsGained: 0, lastMealTick: null },
    });
    expect(decision.rays[0]).toMatchObject({
      eye: 0,
      origin: index(60, 60),
      cells: [index(60, 59), index(60, 58)],
      stop: 'food',
    });
    expect(decision.evaluationCost).toBeCloseTo(0.02, 14);
    expect(decision.actionCost).toBeCloseTo(0.03, 14);
    expect(decision.before.energy - decision.evaluationCost - decision.actionCost).toBe(
      decision.after.energy,
    );
    expect(decision.outcome.energy).toBe(organism.energy);
    const detached = world.neuralObservation()!;
    detached.controller!.weights[0] = 99;
    detached.decisions[0].inputs[0] = 99;
    detached.decisions[0].rays[0].cells.length = 0;
    expect(latest(world)).toEqual(decision);
    expect(world.neuralObservation()!.controller!.weights[0]).toBe(2);
  });

  it.each([
    [0, true, false, 'rest'],
    [1, false, false, 'no-motor'],
    [1, true, true, 'blocked'],
    [2, true, false, 'accepted'],
    [3, true, false, 'accepted'],
  ] as const)('observes action %s with motor %s and obstacle %s', (action, motor, wall, result) => {
    const { world, organism } = scene(action, motor);
    if (wall) world.walls[index(60, 59)] = 1;
    world.selectNeural(organism.id, true);
    world.step();
    expect(latest(world).result).toBe(result);
    expect(latest(world).actionCost > 0).toBe(action !== 0 && motor);
    expect(latest(world).rays[0].stop).toBe(wall ? 'wall' : 'range');
    world.step();
    expect(latest(world).tick).toBe(1);
    world.step();
    expect(latest(world).inputs[5]).toBe(wall ? 1 : 0);
  });

  it('links measured subsequent meals to an explicit observation window, not a reward', () => {
    const { world, organism } = scene(0);
    world.selectNeural(organism.id, true);
    world.food[index(59, 61)] = 1;
    world.step();
    expect(latest(world).outcome.mouthsGained).toBe(0);
    world.food[index(59, 61)] = 1;
    world.step();
    expect(latest(world).outcome.mouthsGained).toBeCloseTo(2.2);
    world.food[index(59, 61)] = 1;
    world.step();
    const [previous, current] = world.neuralObservation()!.decisions;
    expect(previous.outcome).toMatchObject({
      throughTick: 3,
      boundary: 'before-next-evaluation',
      lastMealTick: 3,
    });
    expect(previous.outcome.mouthsGained).toBeCloseTo(4.4);
    expect(current.outcome.mouthsGained).toBe(0);
  });

  it('bounds history and discloses unavailable, pruned, death and new selection ownership', () => {
    const { world, organism } = scene(0);
    expect(world.neuralObservation()).toBeNull();
    world.selectNeural(0, true);
    expect(world.neuralObservation()!.status).toBe('no-selection');
    const other = world.spawn(founder(0), 100, 100)!;
    world.selectNeural(other.id, true);
    expect(world.neuralObservation()!.status).toBe('non-neural');
    world.selectNeural(organism.id, true);
    expect(world.neuralObservation()!.status).toBe('awaiting-evaluation');
    for (let tick = 0; tick < 30; tick++) world.step();
    expect(world.neuralObservation()).toMatchObject({ status: 'observed', pruned: true });
    expect(world.neuralObservation()!.decisions).toHaveLength(NEURAL_HISTORY_LIMIT);
    expect(latest(world).tick).toBe(29);
    const snapshot = world.neuralObservation();
    world.selectNeural(organism.id, true);
    expect(world.neuralObservation()).toEqual(snapshot);
    world.kill(organism, 'manual');
    expect(world.neuralObservation()!.status).toBe('dead');
    expect(latest(world).outcome.boundary).toBe('death');
    world.step();
    expect(latest(world).outcome.throughTick).toBe(30);
    world.selectNeural(other.id, true);
    expect(world.neuralObservation()!.decisions).toEqual([]);
    world.selectNeural(other.id, false);
    expect(world.neuralObservation()).toBeNull();
  });

  it('preserves complete saves, RNG, evaluation counts and continued ecology with capture churn', () => {
    const { world, organism } = scene();
    const control = Ecosystem.load(JSON.stringify(world.save()));
    const evaluate = vi.spyOn(neural, 'neuralAction');
    for (let tick = 0; tick < 48; tick++) {
      world.selectNeural(tick % 7 === 0 ? 0 : organism.id, tick % 11 !== 0);
      world.step();
      const observedEvaluations = evaluate.mock.calls.length;
      evaluate.mockClear();
      world.neuralObservation();
      world.presentation(organism.id);
      expect(evaluate).not.toHaveBeenCalled();
      control.step();
      expect(evaluate).toHaveBeenCalledTimes(observedEvaluations);
      evaluate.mockClear();
      expect(world.save()).toEqual(control.save());
    }
    evaluate.mockRestore();
    const restored = Ecosystem.load(JSON.stringify(world.save()));
    expect(restored.neuralObservation()).toBeNull();
    restored.step();
    control.step();
    expect(restored.save()).toEqual(control.save());
  });

  it('caps maximum anatomy rays, history and serialized observation size without recording opaque data', () => {
    const { world, organism } = scene(0);
    world.kill(organism, 'manual');
    const cells = Array.from({ length: 16 }, (_, offset) => ({
      x: offset % 4,
      y: Math.floor(offset / 4),
      type: 8 as const,
    }));
    const selected = world.spawn(
      { ...founder(0), cells, tempo: 2, controller: neural.newController() },
      100,
      100,
    )!;
    selected.energy = 100;
    world.selectNeural(selected.id, true);
    for (let tick = 0; tick < 30; tick++) world.step();
    const observation = world.neuralObservation()!;
    expect(observation.decisions).toHaveLength(12);
    expect(observation.pruned).toBe(true);
    for (const decision of observation.decisions) {
      expect(decision.rays).toHaveLength(16);
      expect(decision.rays.every((ray) => ray.cells.length <= 5)).toBe(true);
      expect(decision.inputs).toHaveLength(6);
      expect(decision.hidden).toHaveLength(4);
      expect(decision.outputs).toHaveLength(4);
    }
    expect(new TextEncoder().encode(JSON.stringify(observation)).byteLength).toBeLessThan(65536);
  });

  it('retains the actual terminal evaluation and death boundary without extending its outcome window', () => {
    const { world, organism } = scene();
    organism.energy = 0.03;
    const control = Ecosystem.load(JSON.stringify(world.save()));
    world.selectNeural(organism.id, true);
    world.step();
    control.step();
    expect(world.organisms.has(organism.id)).toBe(false);
    expect(world.neuralObservation()!.status).toBe('dead');
    expect(latest(world).outcome).toMatchObject({ throughTick: 1, boundary: 'death' });
    expect(latest(world).evaluationCost).toBeGreaterThan(0);
    expect(latest(world).actionCost).toBeGreaterThan(0);
    expect(world.save()).toEqual(control.save());
    world.step();
    expect(latest(world).outcome.throughTick).toBe(1);
  });
});
