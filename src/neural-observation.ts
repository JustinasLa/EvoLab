import type { Organism, PerceptionRay } from './model';
import type { NeuralAction, NeuralActivity, NeuralController } from './neural';

export const NEURAL_HISTORY_LIMIT = 12;
export interface NeuralDecision extends NeuralActivity {
  tick: number;
  inputs: number[];
  rays: PerceptionRay[];
  action: NeuralAction;
  result: 'rest' | 'no-motor' | 'accepted' | 'blocked';
  evaluationCost: number;
  actionCost: number;
  before: { x: number; y: number; rotation: number; energy: number };
  after: { x: number; y: number; rotation: number; energy: number };
  outcome: {
    throughTick: number;
    boundary: 'completed-tick' | 'before-next-evaluation' | 'death';
    energy: number;
    mouthsGained: number;
    lastMealTick: number | null;
  };
}
export interface NeuralObservation {
  id: number;
  fromTick: number;
  status: 'no-selection' | 'non-neural' | 'awaiting-evaluation' | 'observed' | 'dead';
  controller: NeuralController | null;
  pruned: boolean;
  decisions: NeuralDecision[];
}

export class NeuralObserver {
  private decisions: NeuralDecision[] = [];
  private pruned = false;
  private controller: NeuralController | null;
  constructor(
    readonly id: number,
    private fromTick: number,
    organism?: Organism,
  ) {
    this.controller = organism?.genome.controller
      ? structuredClone(organism.genome.controller)
      : null;
  }
  begin(organism: Organism, tick: number): NeuralDecision {
    this.finish(organism, tick, 'before-next-evaluation');
    const { x, y, rotation, energy } = organism;
    const decision: NeuralDecision = {
      tick,
      inputs: [],
      hidden: [],
      outputs: [],
      rays: [],
      action: 'rest',
      result: 'rest',
      evaluationCost: 0,
      actionCost: 0,
      before: { x, y, rotation, energy },
      after: { x, y, rotation, energy },
      outcome: {
        throughTick: tick,
        boundary: 'completed-tick',
        energy,
        mouthsGained: 0,
        lastMealTick: null,
      },
    };
    this.decisions.push(decision);
    if (this.decisions.length > NEURAL_HISTORY_LIMIT) {
      this.decisions.shift();
      this.pruned = true;
    }
    return decision;
  }
  meal(id: number, tick: number, gained: number): void {
    const last = this.decisions.at(-1);
    if (id !== this.id || !last) return;
    last.outcome.mouthsGained += gained;
    last.outcome.lastMealTick = tick;
  }
  finish(
    organism: Organism | undefined,
    tick: number,
    boundary: NeuralDecision['outcome']['boundary'] = 'completed-tick',
  ): void {
    const last = this.decisions.at(-1);
    if (!organism || !last) return;
    last.outcome.throughTick = tick;
    last.outcome.boundary = boundary;
    last.outcome.energy = organism.energy;
  }
  snapshot(organism?: Organism): NeuralObservation {
    return structuredClone({
      id: this.id,
      fromTick: this.fromTick,
      status: !this.id
        ? 'no-selection'
        : !organism
          ? 'dead'
          : !this.controller
            ? 'non-neural'
            : this.decisions.length
              ? 'observed'
              : 'awaiting-evaluation',
      controller: this.controller,
      pruned: this.pruned,
      decisions: this.decisions,
    });
  }
}
