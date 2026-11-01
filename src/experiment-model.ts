import { WORLD_MAX_BYTES } from './model';

export const COMPARISON_MAX_TICKS = 3600;
export const COMPARISON_SAMPLE_INTERVAL = 30;
export const COMPARISON_MAX_SAMPLES = 121;
export const COMPARISON_BATCH_TICKS = 12;
// A checkpoint string can expand sixfold when escaped in the outer JSON.
export const RECIPE_MAX_BYTES = WORLD_MAX_BYTES * 6 + 200_000;
export const EXPERIMENT_RULES_VERSION = 6;
export interface ComparisonPlan {
  intervention: 'none' | 'heat' | 'cold';
  treatmentTick: number;
  horizonTick: number;
}
export interface ComparisonSample {
  tick: number;
  population: number;
  births: number;
  deaths: number;
  meanPreference: number | null;
  meanTolerance: number | null;
  stressedFraction: number | null;
}
export interface ComparisonBranch {
  state: string;
  samples: ComparisonSample[];
  extinction: { tick: number | null; cause: string } | null;
}
export interface ComparisonProgress {
  sourceTick: number;
  tick: number;
  horizonTick: number;
}
export interface ComparisonResult {
  plan: ComparisonPlan;
  sourceTick: number;
  seed: number;
  recipe: string;
  reproduced: boolean;
  control: ComparisonBranch;
  treatment: ComparisonBranch;
}
export type ComparisonResponse =
  | { type: 'progress'; progress: ComparisonProgress }
  | { type: 'complete'; result: ComparisonResult }
  | { type: 'error'; message: string };

export interface ExperimentRecipe {
  format: 'evolab-drift-experiment';
  version: 1;
  rules: { id: 'evolab-drift-cellular'; version: number; worldVersion: number };
  runtime: string;
  checkpoint: string;
  sourceTick: number;
  seed: number;
  plan: ComparisonPlan;
  control: Pick<ComparisonBranch, 'samples' | 'extinction'>;
  treatment: Pick<ComparisonBranch, 'samples' | 'extinction'>;
}
