import { describe, expect, it, vi } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, Random, clamp, founder, index, type Genome, type Organism } from '../src/model';
import * as neural from '../src/neural';
import {
  NEURAL_ACTIONS,
  NEURAL_ACTION_COST,
  NEURAL_COST,
  newController,
  sameController,
  type NeuralActivity,
  type NeuralController,
} from '../src/neural';
import {
  NEURAL_ABLATION_MAX_BYTES,
  NEURAL_MASK_LIMITS,
  NeuralAblationAdapter,
  NeuralAblationScope,
  neuralCharges,
  neuralConnection,
  parseNeuralAblation,
  readNeuralAblation,
  readNeuralMask,
  serializeNeuralAblation,
  type NeuralAblationRecipe,
  type NeuralMask,
  type NeuralMaskKind,
} from '../src/neural-ablation';
import { newSenses } from '../src/senses';

const KINDS = Object.keys(NEURAL_MASK_LIMITS) as NeuralMaskKind[];
const ALL_MASKS: NeuralMask[] = KINDS.flatMap((kind) =>
  Array.from({ length: NEURAL_MASK_LIMITS[kind] }, (_, index) => ({ kind, index })),
);
const recipe = (mask: NeuralMask = { kind: 'hidden', index: 0 }, organismId = 1) =>
  ({
    format: 'evolab-drift-neural-ablation',
    version: 1,
    controllerVersion: 1,
    target: { scope: 'organism', organismId },
    mask,
  }) as NeuralAblationRecipe;
const activity = (): NeuralActivity => ({ hidden: [], outputs: [] });
const plain = (values: number[]) => values.map((value) => value + 0);

/** Independent forward pass that skips masked terms instead of zeroing parameters. */
function reference(controller: NeuralController, inputs: number[], mask: NeuralMask | null) {
  const skip = (kind: NeuralMaskKind, offset: number) =>
    mask?.kind === kind && mask.index === offset;
  const hidden: number[] = [];
  for (let neuron = 0; neuron < 4; neuron++) {
    if (skip('hidden', neuron)) {
      hidden.push(0);
      continue;
    }
    let sum = controller.biases[neuron];
    for (let input = 0; input < 6; input++)
      if (!skip('input', input) && !skip('connection', neuron * 6 + input))
        sum += inputs[input] * controller.weights[neuron * 6 + input];
    hidden.push(clamp(sum, -1, 1));
  }
  const outputs: number[] = [];
  for (let output = 0; output < 4; output++) {
    let sum = controller.biases[4 + output];
    for (let neuron = 0; neuron < 4; neuron++)
      if (!skip('connection', 24 + output * 4 + neuron))
        sum += hidden[neuron] * controller.weights[24 + output * 4 + neuron];
    outputs.push(clamp(sum, -1, 1));
  }
  const best = Math.max(...outputs);
  return { hidden, outputs, action: NEURAL_ACTIONS[outputs.indexOf(best)] };
}

function randomController(random: Random, quantized: boolean): NeuralController {
  const value = () => {
    const roll = random.next();
    if (roll < 0.1) return -4;
    if (roll < 0.2) return 4;
    if (roll < 0.3) return 0;
    return quantized ? random.int(9) - 4 : random.next() * 8 - 4;
  };
  const controller = newController();
  controller.weights = controller.weights.map(value);
  controller.biases = controller.biases.map(value);
  return controller;
}
function randomInputs(random: Random): number[] {
  return Array.from({ length: 6 }, () => {
    const roll = random.next();
    return roll < 0.25 ? 0 : roll < 0.5 ? 1 : roll < 0.6 ? 0.5 : random.next();
  });
}

describe('neural ablation recipe', () => {
  it('accepts every in-range mask exactly once and round-trips strictly', () => {
    expect(ALL_MASKS).toHaveLength(6 + 40 + 4);
    for (const mask of ALL_MASKS) {
      const text = serializeNeuralAblation(recipe(mask, 7));
      expect(parseNeuralAblation(text)).toEqual(recipe(mask, 7));
      expect(readNeuralMask(mask)).toEqual(mask);
    }
    expect(JSON.parse(serializeNeuralAblation(recipe()))).toEqual(recipe());
  });

  it('rejects out-of-range indices at both bounds for every mask kind', () => {
    for (const kind of KINDS) {
      const limit = NEURAL_MASK_LIMITS[kind];
      for (const index of [-1, limit, limit + 1, 0.5, NaN, Infinity, '0', null])
        expect(() => readNeuralAblation(recipe({ kind, index } as NeuralMask))).toThrow(
          `Neural ${kind} mask index must be an integer from 0 to ${limit - 1}.`,
        );
    }
  });

  it('rejects malformed, multiple, output and unsupported masks and recipes', () => {
    const base = recipe();
    const cases: [unknown, string][] = [
      [null, 'must be an object'],
      [[base], 'must be an object'],
      [{ ...base, format: 'evolab-drift-experiment' }, 'Not a neural ablation recipe.'],
      [{ ...base, version: 2 }, 'Unsupported neural ablation recipe version.'],
      [{ ...base, version: '1' }, 'Unsupported neural ablation recipe version.'],
      [{ ...base, masks: [base.mask] }, 'exactly one neural mask'],
      [{ ...base, mask: [base.mask] }, 'exactly one neural mask'],
      [{ ...base, mask: [base.mask, base.mask] }, 'exactly one neural mask'],
      [{ ...base, genome: {} }, 'missing or unknown fields'],
      [{ format: base.format, version: 1, controllerVersion: 1, target: base.target }, 'missing'],
      [{ ...base, controllerVersion: 2 }, 'controller version 1'],
      [{ ...base, controllerVersion: 0 }, 'controller version 1'],
      [{ ...base, target: { scope: 'lineage', organismId: 1 } }, 'one selected organism ID'],
      [{ ...base, target: { scope: 'organism', organismId: 0 } }, 'one selected organism ID'],
      [{ ...base, target: { scope: 'organism', organismId: 1.5 } }, 'one selected organism ID'],
      [{ ...base, target: { scope: 'organism' } }, 'one selected organism ID'],
      [{ ...base, target: { scope: 'organism', organismId: 1, ids: [2] } }, 'organism ID'],
      [{ ...base, mask: { kind: 'output', index: 0 } }, 'input, connection or hidden-neuron'],
      [{ ...base, mask: { kind: 'bias', index: 0 } }, 'input, connection or hidden-neuron'],
      [{ ...base, mask: { kind: 'toString', index: 0 } }, 'input, connection or hidden-neuron'],
      [{ ...base, mask: { kind: 1, index: 0 } }, 'input, connection or hidden-neuron'],
      [{ ...base, mask: { kind: 'input' } }, 'input, connection or hidden-neuron'],
      [{ ...base, mask: { kind: 'input', index: 0, value: 1 } }, 'input, connection or hidden'],
      [{ ...base, mask: null }, 'input, connection or hidden-neuron'],
    ];
    for (const [value, message] of cases) expect(() => readNeuralAblation(value)).toThrow(message);
    expect(() => parseNeuralAblation('{')).toThrow('not valid JSON');
    expect(() => parseNeuralAblation(' '.repeat(NEURAL_ABLATION_MAX_BYTES + 1))).toThrow(
      'too large',
    );
    expect(() => serializeNeuralAblation({ ...base, version: 2 } as never)).toThrow();
  });

  it('names every controller-v1 connection by the weight layout neuralAction reads', () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < 40; offset++) {
      const connection = neuralConnection(offset);
      seen.add(JSON.stringify(connection));
      const controller = newController(),
        inputs = [0, 0, 0, 0, 0, 0],
        trace = activity();
      controller.weights[offset] = 1;
      if (connection.layer === 'input-hidden') {
        inputs[connection.input] = 1;
        neural.neuralAction(controller, inputs, trace);
        expect(trace.hidden).toEqual([0, 1, 2, 3].map((n) => (n === connection.hidden ? 1 : 0)));
      } else {
        controller.biases[connection.hidden] = 1;
        neural.neuralAction(controller, inputs, trace);
        expect(trace.outputs).toEqual([0, 1, 2, 3].map((o) => (o === connection.output ? 1 : 0)));
      }
    }
    expect(seen.size).toBe(40);
    expect(neuralConnection(5)).toEqual({ layer: 'input-hidden', hidden: 0, input: 5 });
    expect(neuralConnection(39)).toEqual({ layer: 'hidden-output', output: 3, hidden: 3 });
    for (const bad of [-1, 40, 2.5, NaN]) expect(() => neuralConnection(bad)).toThrow('range');
  });
});

describe('isolated masked inference', () => {
  it('zeroes one input before every hidden neuron reads it', () => {
    const controller = newController();
    controller.weights[2] = 1; // input 2 → hidden 0
    controller.weights[24 + 1 * 4 + 0] = 1; // hidden 0 → forward
    const inputs = [0, 0, 1, 0, 0, 0];
    expect(new NeuralAblationAdapter(controller, null).evaluate(inputs)).toBe('forward');
    const trace = activity();
    const masked = new NeuralAblationAdapter(controller, { kind: 'input', index: 2 });
    expect(masked.evaluate(inputs, trace)).toBe('rest');
    expect(plain(trace.hidden)).toEqual([0, 0, 0, 0]);
    expect(masked.controller).toEqual(controller);
    expect(inputs).toEqual([0, 0, 1, 0, 0, 0]);
    // Another input still drives the same neuron.
    controller.weights[3] = 1;
    expect(
      new NeuralAblationAdapter(controller, { kind: 'input', index: 2 }).evaluate([
        0, 0, 1, 1, 0, 0,
      ]),
    ).toBe('forward');
  });

  it('removes exactly one input-hidden or hidden-output contribution', () => {
    const controller = newController();
    controller.weights[0] = 1; // input 0 → hidden 0
    controller.weights[6] = 1; // input 0 → hidden 1
    controller.weights[24 + 2 * 4 + 0] = 0.6; // hidden 0 → left
    controller.weights[24 + 3 * 4 + 1] = 0.5; // hidden 1 → right
    const inputs = [1, 0, 0, 0, 0, 0];
    expect(new NeuralAblationAdapter(controller, null).evaluate(inputs)).toBe('left');
    const trace = activity();
    expect(
      new NeuralAblationAdapter(controller, { kind: 'connection', index: 0 }).evaluate(
        inputs,
        trace,
      ),
    ).toBe('right');
    expect(plain(trace.hidden)).toEqual([0, 1, 0, 0]);
    const output = activity();
    expect(
      new NeuralAblationAdapter(controller, { kind: 'connection', index: 32 }).evaluate(
        inputs,
        output,
      ),
    ).toBe('right');
    expect(plain(output.hidden)).toEqual([1, 1, 0, 0]);
    expect(plain(output.outputs)).toEqual([0, 0, 0, 0.5]);
  });

  it('forces a hidden activation to zero after activation, including its bias', () => {
    const controller = newController();
    controller.biases[3] = 4; // hidden 3 saturates from bias alone
    controller.weights[24 + 2 * 4 + 3] = 1; // hidden 3 → left
    const inputs = [0, 0, 0, 0, 0, 0];
    const intact = activity();
    expect(new NeuralAblationAdapter(controller, null).evaluate(inputs, intact)).toBe('left');
    expect(intact.hidden).toEqual([0, 0, 0, 1]);
    const trace = activity();
    const adapter = new NeuralAblationAdapter(controller, { kind: 'hidden', index: 3 });
    expect(adapter.evaluate(inputs, trace)).toBe('rest');
    expect(plain(trace.hidden)).toEqual([0, 0, 0, 0]);
    // Incoming input contributions are removed too, not only the bias.
    controller.biases[3] = -1;
    controller.weights[3 * 6 + 4] = 4;
    expect(new NeuralAblationAdapter(controller, null).evaluate([0, 0, 0, 0, 1, 0])).toBe('left');
    expect(
      new NeuralAblationAdapter(controller, { kind: 'hidden', index: 3 }).evaluate([
        0, 0, 0, 0, 1, 0,
      ]),
    ).toBe('rest');
    expect(controller.biases[3]).toBe(-1);
  });

  it('keeps clamping and first-maximum ties instead of a rest fallback', () => {
    const controller = newController();
    controller.biases.fill(-4, 4);
    expect(new NeuralAblationAdapter(controller, null).evaluate([0, 0, 0, 0, 0, 0])).toBe('rest');
    controller.biases[4] = -4;
    controller.biases[5] = 3;
    controller.biases[6] = 4;
    controller.biases[7] = 2;
    const trace = activity();
    // forward, left and right all clamp to 1; the first maximum (forward) wins.
    expect(new NeuralAblationAdapter(controller, null).evaluate([0, 0, 0, 0, 0, 0], trace)).toBe(
      'forward',
    );
    expect(trace.outputs).toEqual([-1, 1, 1, 1]);
    // An ablation that creates a tie resolves by the same order.
    const tie = newController();
    tie.biases[0] = 1; // hidden 0 saturates
    tie.biases[4] = 0.5; // rest bias
    tie.biases[5] = 0.5; // forward bias
    tie.weights[24 + 1 * 4 + 0] = 0.5; // hidden 0 → forward
    expect(new NeuralAblationAdapter(tie, null).evaluate([0, 0, 0, 0, 0, 0])).toBe('forward');
    expect(
      new NeuralAblationAdapter(tie, { kind: 'connection', index: 28 }).evaluate([
        0, 0, 0, 0, 0, 0,
      ]),
    ).toBe('rest');
  });

  it('matches an independent forward pass for every mask and neuralAction when unmasked', () => {
    const random = new Random(115);
    const mathRandom = vi.spyOn(Math, 'random');
    let ties = 0,
      changed = 0;
    for (let sample = 0; sample < 400; sample++) {
      const controller = randomController(random, sample % 2 === 0),
        inputs = randomInputs(random),
        copy = structuredClone(controller);
      const expected = activity(),
        actual = activity();
      const action = neural.neuralAction(controller, inputs, expected);
      expect(new NeuralAblationAdapter(controller, null).evaluate(inputs, actual)).toBe(action);
      expect(actual).toEqual(expected);
      const outputs = expected.outputs;
      if (outputs.filter((score) => score === Math.max(...outputs)).length > 1) ties++;
      for (const mask of ALL_MASKS) {
        const want = reference(controller, inputs, mask),
          trace = activity(),
          got = new NeuralAblationAdapter(controller, mask).evaluate(inputs, trace);
        expect(got).toBe(want.action);
        expect(plain(trace.hidden)).toEqual(plain(want.hidden));
        expect(plain(trace.outputs)).toEqual(plain(want.outputs));
        if (got !== action) changed++;
      }
      expect(sameController(controller, copy)).toBe(true);
      expect(reference(controller, inputs, null).action).toBe(action);
    }
    expect(ties).toBeGreaterThan(50);
    expect(changed).toBeGreaterThan(500);
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });

  it('rejects unsupported controllers, out-of-bounds inputs and malformed masks', () => {
    const sensory = newController(2);
    expect(() => new NeuralAblationAdapter(sensory, null)).toThrow('controller version 1');
    const recurrent = { ...newController(), version: 3 } as unknown as NeuralController;
    expect(() => new NeuralAblationAdapter(recurrent, null)).toThrow('controller version 1');
    const wide = newController();
    wide.weights[0] = 4.5;
    expect(() => new NeuralAblationAdapter(wide, null)).toThrow('controller version 1');
    const adapter = new NeuralAblationAdapter(newController(), null);
    for (const inputs of [
      [0, 0, 0, 0, 0],
      Array(10).fill(0),
      [0, 0, 0, 0, 0, NaN],
      [2, 0, 0, 0, 0, 0],
      [-0.1, 0, 0, 0, 0, 0],
    ])
      expect(() => adapter.evaluate(inputs)).toThrow('six finite values');
    expect(() => new NeuralAblationAdapter(newController(), { kind: 'hidden', index: 4 })).toThrow(
      'from 0 to 3',
    );
    expect(
      () => new NeuralAblationAdapter(newController(), { kind: 'output', index: 0 } as never),
    ).toThrow('hidden-neuron');
  });
});

describe('ablation costs in the real engine', () => {
  function scene(motor = true) {
    const controller = newController();
    controller.weights[0] = 2; // forward sight of food → hidden 0
    controller.weights[24 + 1 * 4 + 0] = 1; // hidden 0 → forward
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
    world.food[index(60, 58)] = 1;
    world.selectNeural(organism.id, true);
    return { world, organism };
  }
  const decide = (world: Ecosystem) => {
    world.step();
    return world.neuralObservation()!.decisions.at(-1)!;
  };

  it('charges masked and unmasked decisions by the same evaluation and action rules', () => {
    for (const motor of [true, false]) {
      const control = scene(motor),
        treatment = scene(motor),
        neutral = scene(motor);
      // Experiment-world fixture: the treatment target evaluates the masked copy.
      const mask = new NeuralAblationAdapter(control.organism.genome.controller!, {
        kind: 'hidden',
        index: 0,
      });
      treatment.organism.genome.controller = mask.controller;
      neutral.organism.genome.controller = new NeuralAblationAdapter(
        control.organism.genome.controller!,
        { kind: 'hidden', index: 2 },
      ).controller;
      const [a, b, c] = [decide(control.world), decide(treatment.world), decide(neutral.world)];
      expect(a.inputs).toEqual(b.inputs);
      expect(
        new NeuralAblationAdapter(control.organism.genome.controller!, null).evaluate(a.inputs),
      ).toBe(a.action);
      expect(mask.evaluate(b.inputs)).toBe(b.action);
      expect([a.action, b.action, c.action]).toEqual(['forward', 'rest', 'forward']);
      for (const decision of [a, b, c]) {
        const charges = neuralCharges(decision.action, motor);
        expect(decision.evaluationCost).toBeCloseTo(charges.evaluation, 14);
        expect(decision.actionCost).toBeCloseTo(charges.action, 14);
      }
      expect(c.after.energy).toBe(a.after.energy);
      expect(neuralCharges('rest', motor)).toEqual({ evaluation: NEURAL_COST, action: 0 });
      expect(neuralCharges('left', motor).action).toBe(motor ? NEURAL_ACTION_COST : 0);
    }
  });

  it('reproduces every live controller-v1 engine decision when unmasked', () => {
    const world = new Ecosystem({ ...DEFAULTS, seed: 115, climate: 0.4 }, false);
    const random = new Random(7);
    for (let n = 0; n < 24; n++) {
      const genome: Genome = {
        ...founder(0),
        cells: [
          { x: 0, y: 0, type: 8 },
          { x: 0, y: 1, type: 3 },
          { x: 1, y: 1, type: 5 },
        ],
        tempo: 2 + (n % 3),
        controller: randomController(random, n % 2 === 0),
      };
      world.spawn(genome, 8 + (n % 6) * 18, 10 + Math.floor(n / 6) * 24)!.energy = 20;
    }
    const calls: [NeuralController, number[], neural.NeuralAction][] = [];
    const original = neural.neuralAction;
    const spy = vi.spyOn(neural, 'neuralAction').mockImplementation((controller, inputs, trace) => {
      const action = original(controller, inputs, trace);
      calls.push([structuredClone(controller), [...inputs], action]);
      return action;
    });
    for (let tick = 0; tick < 60; tick++) world.step();
    spy.mockRestore();
    expect(calls.length).toBeGreaterThan(400);
    for (const [controller, inputs, action] of calls)
      expect(new NeuralAblationAdapter(controller, null).evaluate(inputs)).toBe(action);
    expect(new Set(calls.map((call) => call[2])).size).toBeGreaterThan(1);
  });
});

describe('target scope', () => {
  function organism(id: number, controller = newController()): Organism {
    return {
      id,
      species: 1,
      x: 0,
      y: 0,
      rotation: 0,
      direction: 0,
      age: 0,
      energy: 10,
      generation: 0,
      children: 0,
      ancestry: [],
      genome: { ...founder(0), controller },
    };
  }

  it('masks only the selected organism and labels its descendants', () => {
    const target = organism(5);
    target.genome.controller!.biases[0] = 2;
    const before = structuredClone(target.genome);
    const scope = new NeuralAblationScope(recipe({ kind: 'hidden', index: 0 }, 5), target);
    expect(scope.adapterFor(5)!.controller.biases[0]).toBe(0);
    expect(scope.adapterFor(5)!.controller).not.toBe(target.genome.controller);
    expect(scope.adapterFor(6)).toBeUndefined();
    expect(target.genome).toEqual(before);
    scope.birth(5, 9);
    scope.birth(9, 12);
    scope.birth(3, 13);
    scope.birth(5, 9);
    expect([scope.role(5), scope.role(9), scope.role(12), scope.role(13)]).toEqual([
      'target',
      'descendant',
      'descendant',
      'unrelated',
    ]);
    // Offspring inherit the unmasked genome controller and never get the mask.
    expect(scope.adapterFor(9)).toBeUndefined();
    scope.death(13, 20);
    scope.death(12, 21);
    expect(scope.summary()).toEqual({
      targetId: 5,
      status: 'active',
      endedTick: null,
      descendantsBorn: 2,
      descendantsDied: 1,
      livingDescendants: 1,
    });
  });

  it('ends the intervention at the target death while descendants stay measurable', () => {
    const scope = new NeuralAblationScope(recipe({ kind: 'input', index: 4 }, 2), organism(2));
    scope.birth(2, 3);
    scope.death(2, 40);
    scope.death(2, 41);
    expect(scope.adapterFor(2)).toBeUndefined();
    expect(scope.role(2)).toBe('target');
    scope.birth(3, 4);
    expect(scope.role(4)).toBe('descendant');
    expect(scope.summary()).toMatchObject({
      status: 'ended',
      endedTick: 40,
      descendantsBorn: 2,
      livingDescendants: 2,
    });
  });

  it('rejects mismatched, non-neural and unsupported targets', () => {
    expect(() => new NeuralAblationScope(recipe(undefined, 3), organism(4))).toThrow(
      'does not match',
    );
    const plainOrganism = organism(3);
    delete plainOrganism.genome.controller;
    expect(() => new NeuralAblationScope(recipe(undefined, 3), plainOrganism)).toThrow(
      'no controller',
    );
    const sensory = organism(3, newController(2));
    sensory.genome.senses = newSenses();
    expect(() => new NeuralAblationScope(recipe(undefined, 3), sensory)).toThrow(
      'controller version 1',
    );
    expect(
      () =>
        new NeuralAblationScope(
          { ...recipe(undefined, 3), controllerVersion: 2 } as never,
          organism(3),
        ),
    ).toThrow('controller version 1');
  });
});
