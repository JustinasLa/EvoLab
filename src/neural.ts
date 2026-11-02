import { clamp, denseArray, exactDataRecord, finite, type Genome, type Random } from './model';

export interface NeuralController {
  version: 1;
  weights: number[];
  biases: number[];
}
export const NEURAL_INPUTS = 6;
export const NEURAL_HIDDEN = 4;
export const NEURAL_OUTPUTS = 4;
export const NEURAL_WEIGHTS = 40;
export const NEURAL_BIASES = 8;
export const NEURAL_COST = 0.02;
export const NEURAL_ACTION_COST = 0.03;
export const NEURAL_CHANNELS = ['neural-weight', 'neural-bias'] as const;
export const NEURAL_ACTIONS = ['rest', 'forward', 'left', 'right'] as const;
export type NeuralAction = (typeof NEURAL_ACTIONS)[number];
export interface NeuralActivity {
  hidden: number[];
  outputs: number[];
}

export function newController(): NeuralController {
  return {
    version: 1,
    weights: Array(NEURAL_WEIGHTS).fill(0),
    biases: Array(NEURAL_BIASES).fill(0),
  };
}

export function validController(value: unknown): value is NeuralController {
  return (
    exactDataRecord(value, ['version', 'weights', 'biases']) &&
    value.version === 1 &&
    denseArray(value.weights) &&
    value.weights.length === NEURAL_WEIGHTS &&
    value.weights.every((weight) => finite(weight, -4, 4)) &&
    denseArray(value.biases) &&
    value.biases.length === NEURAL_BIASES &&
    value.biases.every((bias) => finite(bias, -4, 4))
  );
}

export function sameController(first?: NeuralController, second?: NeuralController): boolean {
  if (!first || !second) return first === second;
  return (
    first.weights.every((weight, offset) => Object.is(weight, second.weights[offset])) &&
    first.biases.every((bias, offset) => Object.is(bias, second.biases[offset]))
  );
}

export function neuralAction(
  controller: NeuralController,
  inputs: readonly number[],
  activity?: NeuralActivity,
): NeuralAction {
  const hidden = Array<number>(NEURAL_HIDDEN).fill(0);
  for (let neuron = 0; neuron < NEURAL_HIDDEN; neuron++) {
    let activation = controller.biases[neuron];
    for (let input = 0; input < NEURAL_INPUTS; input++)
      activation += inputs[input] * controller.weights[neuron * NEURAL_INPUTS + input];
    hidden[neuron] = clamp(activation, -1, 1);
  }
  if (activity) activity.hidden = hidden;
  let chosen = 0,
    best = -Infinity;
  for (let output = 0; output < NEURAL_OUTPUTS; output++) {
    let activation = controller.biases[NEURAL_HIDDEN + output];
    for (let neuron = 0; neuron < NEURAL_HIDDEN; neuron++)
      activation += hidden[neuron] * controller.weights[24 + output * NEURAL_HIDDEN + neuron];
    const score = clamp(activation, -1, 1);
    activity?.outputs.push(score);
    if (score > best) {
      best = score;
      chosen = output;
    }
  }
  return NEURAL_ACTIONS[chosen];
}

export function mutateController(
  genome: Genome,
  random: Random,
  observe?: (channel: string) => void,
): Genome {
  if (!genome.controller) return genome;
  const controller = structuredClone(genome.controller),
    channel = random.int(2),
    parameters = channel === 0 ? controller.weights : controller.biases,
    offset = random.int(parameters.length);
  observe?.(NEURAL_CHANNELS[channel]);
  parameters[offset] = clamp(parameters[offset] + (random.next() - 0.5) * 0.5, -4, 4);
  return { ...genome, controller };
}
