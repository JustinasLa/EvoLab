import { dataRecord, exactDataRecord, finite, integer, type Organism } from './model';
import {
  NEURAL_ACTION_COST,
  NEURAL_COST,
  NEURAL_HIDDEN,
  NEURAL_INPUTS,
  NEURAL_WEIGHTS,
  neuralAction,
  validController,
  type NeuralAction,
  type NeuralActivity,
  type NeuralController,
} from './neural';

/**
 * Experiment-only neural masks (#115). A mask never enters a genome, world,
 * blueprint or library entry: it lives in its own strictly versioned recipe and
 * is applied to a private copy of one selected organism's controller.
 */
export const NEURAL_ABLATION_FORMAT = 'evolab-drift-neural-ablation';
export const NEURAL_ABLATION_VERSION = 1;
/** Only the shipped fixed 6–4–4 feed-forward controller is supported. */
export const NEURAL_ABLATION_CONTROLLER = 1;
export const NEURAL_ABLATION_MAX_BYTES = 1024;
/** Input→hidden contributions occupy weights 0–23; hidden→output 24–39. */
export const NEURAL_INPUT_CONNECTIONS = NEURAL_INPUTS * NEURAL_HIDDEN;
export const NEURAL_MASK_LIMITS = Object.freeze({
  input: NEURAL_INPUTS,
  connection: NEURAL_WEIGHTS,
  hidden: NEURAL_HIDDEN,
});
export type NeuralMaskKind = keyof typeof NEURAL_MASK_LIMITS;
export interface NeuralMask {
  kind: NeuralMaskKind;
  index: number;
}
export interface NeuralAblationTarget {
  scope: 'organism';
  organismId: number;
}
export interface NeuralAblationRecipe {
  format: typeof NEURAL_ABLATION_FORMAT;
  version: typeof NEURAL_ABLATION_VERSION;
  controllerVersion: typeof NEURAL_ABLATION_CONTROLLER;
  target: NeuralAblationTarget;
  mask: NeuralMask;
}
export type NeuralConnection =
  | { layer: 'input-hidden'; input: number; hidden: number }
  | { layer: 'hidden-output'; hidden: number; output: number };

const recipeKeys = ['format', 'version', 'controllerVersion', 'target', 'mask'];

/** Reads exactly one mask, rejecting lists, unknown kinds and out-of-range indices. */
export function readNeuralMask(mask: unknown): NeuralMask {
  if (Array.isArray(mask)) throw new Error('A treatment branch carries exactly one neural mask.');
  if (
    !exactDataRecord(mask, ['kind', 'index']) ||
    typeof mask.kind !== 'string' ||
    !Object.hasOwn(NEURAL_MASK_LIMITS, mask.kind)
  )
    throw new Error('Neural mask must be one input, connection or hidden-neuron mask.');
  const kind = mask.kind as NeuralMaskKind,
    limit = NEURAL_MASK_LIMITS[kind];
  if (!integer(mask.index, 0, limit - 1))
    throw new Error(`Neural ${kind} mask index must be an integer from 0 to ${limit - 1}.`);
  return { kind, index: mask.index };
}

/** Reads one recipe, throwing a specific reason for every rejected shape. */
export function readNeuralAblation(value: unknown): NeuralAblationRecipe {
  if (!dataRecord(value)) throw new Error('Neural ablation recipe must be an object.');
  if (value.format !== NEURAL_ABLATION_FORMAT) throw new Error('Not a neural ablation recipe.');
  if (value.version !== NEURAL_ABLATION_VERSION)
    throw new Error('Unsupported neural ablation recipe version.');
  if (Object.hasOwn(value, 'masks'))
    throw new Error('A treatment branch carries exactly one neural mask.');
  if (!exactDataRecord(value, recipeKeys))
    throw new Error('Neural ablation recipe has missing or unknown fields.');
  if (value.controllerVersion !== NEURAL_ABLATION_CONTROLLER)
    throw new Error('Only the fixed feed-forward controller version 1 can be ablated.');
  const target = value.target;
  if (
    !exactDataRecord(target, ['scope', 'organismId']) ||
    target.scope !== 'organism' ||
    !integer(target.organismId, 1, Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Neural ablation target must be one selected organism ID.');
  const mask = readNeuralMask(value.mask);
  return {
    format: NEURAL_ABLATION_FORMAT,
    version: NEURAL_ABLATION_VERSION,
    controllerVersion: NEURAL_ABLATION_CONTROLLER,
    target: { scope: 'organism', organismId: target.organismId },
    mask,
  };
}

export const serializeNeuralAblation = (recipe: NeuralAblationRecipe): string =>
  JSON.stringify(readNeuralAblation(recipe));

export function parseNeuralAblation(text: string): NeuralAblationRecipe {
  if (new TextEncoder().encode(text).length > NEURAL_ABLATION_MAX_BYTES)
    throw new Error('Neural ablation recipe is too large.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Neural ablation recipe is not valid JSON.');
  }
  return readNeuralAblation(value);
}

/** Names the two neurons joined by one of the forty controller-v1 weights. */
export function neuralConnection(index: number): NeuralConnection {
  if (!integer(index, 0, NEURAL_WEIGHTS - 1))
    throw new Error('Neural connection index is out of range.');
  if (index < NEURAL_INPUT_CONNECTIONS)
    return {
      layer: 'input-hidden',
      hidden: Math.floor(index / NEURAL_INPUTS),
      input: index % NEURAL_INPUTS,
    };
  const offset = index - NEURAL_INPUT_CONNECTIONS;
  return {
    layer: 'hidden-output',
    output: Math.floor(offset / NEURAL_HIDDEN),
    hidden: offset % NEURAL_HIDDEN,
  };
}

/**
 * Builds the private masked controller evaluated by the authoritative
 * `neuralAction`. Each mask is exact because every remaining term is finite:
 * a removed connection contributes `input × 0`, and a hidden neuron with zero
 * bias and zero incoming weights activates to exactly 0 before its outgoing
 * contributions are summed.
 */
function maskedController(controller: NeuralController, mask: NeuralMask): NeuralController {
  const masked = structuredClone(controller);
  if (mask.kind === 'connection') masked.weights[mask.index] = 0;
  else if (mask.kind === 'hidden') {
    masked.biases[mask.index] = 0;
    masked.weights.fill(0, mask.index * NEURAL_INPUTS, (mask.index + 1) * NEURAL_INPUTS);
  }
  return masked;
}

/**
 * Isolated inference for one controller. It reuses `neuralAction` unchanged,
 * including its clamping and first-maximum output tie-break (rest, forward,
 * left, right), and never draws random numbers. Inputs must be the six real
 * controller-v1 observations in [0, 1]. An input mask is applied to the
 * inputs, not to `controller`, so callers must evaluate through `evaluate`.
 */
export class NeuralAblationAdapter {
  readonly controller: NeuralController;
  readonly mask: NeuralMask | null;
  constructor(controller: NeuralController, mask: NeuralMask | null) {
    if (!validController(controller, false))
      throw new Error('Only the fixed feed-forward controller version 1 can be ablated.');
    this.mask = mask && readNeuralMask(mask);
    this.controller = this.mask
      ? maskedController(controller, this.mask)
      : structuredClone(controller);
  }
  evaluate(inputs: readonly number[], activity?: NeuralActivity): NeuralAction {
    if (inputs.length !== NEURAL_INPUTS || !inputs.every((input) => finite(input, 0, 1)))
      throw new Error('Neural ablation inputs must be six finite values from 0 to 1.');
    const masked =
      this.mask?.kind === 'input'
        ? inputs.map((input, offset) => (offset === this.mask!.index ? 0 : input))
        : inputs;
    return neuralAction(this.controller, masked, activity);
  }
}

/**
 * Energy charged for one controller-v1 evaluation. It depends only on the
 * chosen action and whether the body has a motor, so a masked and an unmasked
 * branch pay identical sensing (none), inference and action costs for the same
 * decision; a mask never makes an organism cheaper.
 */
export function neuralCharges(
  action: NeuralAction,
  motor: boolean,
): { evaluation: number; action: number } {
  return { evaluation: NEURAL_COST, action: action !== 'rest' && motor ? NEURAL_ACTION_COST : 0 };
}

export type NeuralAblationRole = 'target' | 'descendant' | 'unrelated';
export interface NeuralAblationScopeSummary {
  targetId: number;
  status: 'active' | 'ended';
  endedTick: number | null;
  descendantsBorn: number;
  descendantsDied: number;
  livingDescendants: number;
}

/**
 * Applies a recipe's single mask to its selected organism only. Offspring keep
 * their inherited, unmasked controllers and are labeled descendants so their
 * outcomes stay measurable. The target's death ends the intervention for good.
 * Only living descendants are retained, so state stays within the population
 * bound.
 */
export class NeuralAblationScope {
  readonly recipe: NeuralAblationRecipe;
  private adapter: NeuralAblationAdapter | null;
  private living = new Set<number>();
  private born = 0;
  private died = 0;
  private ended: number | null = null;
  constructor(recipe: NeuralAblationRecipe, target: Organism) {
    this.recipe = readNeuralAblation(recipe);
    if (target.id !== this.recipe.target.organismId)
      throw new Error('Neural ablation target does not match the selected organism.');
    if (!target.genome.controller) throw new Error('Neural ablation target has no controller.');
    this.adapter = new NeuralAblationAdapter(target.genome.controller, this.recipe.mask);
  }
  get targetId(): number {
    return this.recipe.target.organismId;
  }
  /** The masked adapter while the target lives; undefined for everyone else. */
  adapterFor(organismId: number): NeuralAblationAdapter | undefined {
    return organismId === this.targetId ? (this.adapter ?? undefined) : undefined;
  }
  role(organismId: number): NeuralAblationRole {
    if (organismId === this.targetId) return 'target';
    return this.living.has(organismId) ? 'descendant' : 'unrelated';
  }
  birth(parentId: number, childId: number): void {
    if (this.role(parentId) === 'unrelated' || this.role(childId) !== 'unrelated') return;
    this.living.add(childId);
    this.born++;
  }
  death(organismId: number, tick: number): void {
    if (organismId === this.targetId) {
      if (this.ended === null) this.ended = tick;
      this.adapter = null;
    } else if (this.living.delete(organismId)) this.died++;
  }
  summary(): NeuralAblationScopeSummary {
    return {
      targetId: this.targetId,
      status: this.ended === null ? 'active' : 'ended',
      endedTick: this.ended,
      descendantsBorn: this.born,
      descendantsDied: this.died,
      livingDescendants: this.living.size,
    };
  }
}
