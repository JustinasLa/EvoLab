export const COMPARISON_MAX_TICKS = 3600;
export const COMPARISON_SAMPLE_INTERVAL = 30;
export const COMPARISON_MAX_SAMPLES = 121;
export const COMPARISON_BATCH_TICKS = 12;
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
  control: ComparisonBranch;
  treatment: ComparisonBranch;
}
export type ComparisonResponse =
  | { type: 'progress'; progress: ComparisonProgress }
  | { type: 'complete'; result: ComparisonResult }
  | { type: 'error'; message: string };
