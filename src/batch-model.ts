import { integer, validSettings, type Settings, type TerrainRecipe } from './model';
import { validTerrain } from './terrain';
import {
  validExperimentIntervention,
  type ExperimentIntervention,
} from './experiment-interventions';
import type { ExperimentRecipe } from './experiment-model';

export const BATCH_MAX_RUNS = 8;
export const BATCH_MAX_TICKS = 28_800;
export const BATCH_MAX_BYTES = 16_000_000;
export interface BatchPlan {
  seeds: number[];
  initialization: 'single-founder';
  settings: Omit<Settings, 'seed'>;
  terrain: TerrainRecipe;
  burnInTicks: number;
  treatmentDelay: number;
  durationTicks: number;
  intervention: ExperimentIntervention;
}
export interface BatchRun {
  seed: number;
  status: 'pending' | 'cancelled' | 'failed' | 'complete';
  tick: number;
  error: string | null;
  recipe: ExperimentRecipe | null;
  reproduced: boolean;
}
export interface BatchExport {
  format: 'evolab-drift-batch';
  version: 1;
  rules: { version: number; worldVersion: number };
  runtime: string;
  plan: BatchPlan;
  runs: BatchRun[];
}
export interface BatchProgress {
  run: number;
  tick: number;
  phase: 'initialization' | 'burn-in' | 'paired' | 'done';
  done: boolean;
}
export const exactKeys = (value: unknown, names: string): boolean =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === names.split(',').sort().join(',');

export function validateBatchPlan(value: BatchPlan): void {
  if (
    !exactKeys(
      value,
      'seeds,initialization,settings,terrain,burnInTicks,treatmentDelay,durationTicks,intervention',
    ) ||
    !Array.isArray(value.seeds) ||
    !integer(value.seeds.length, 1, BATCH_MAX_RUNS) ||
    value.seeds.some((seed) => !integer(seed, 0, 0xffffffff)) ||
    new Set(value.seeds).size !== value.seeds.length ||
    value.initialization !== 'single-founder' ||
    !exactKeys(value.settings, 'mutation,nutrients,climate') ||
    !validSettings({ ...value.settings, seed: 0 }) ||
    !validTerrain(value.terrain) ||
    !integer(value.burnInTicks, 0, 1200) ||
    !integer(value.durationTicks, 1, 3600) ||
    !integer(value.treatmentDelay, 0, value.durationTicks - 1) ||
    !validExperimentIntervention(value.intervention) ||
    value.seeds.length * (value.burnInTicks + 2 * value.durationTicks) > BATCH_MAX_TICKS
  )
    throw new Error(
      'Invalid batch plan: 1–8 unique uint32 seeds, burn-in 0–1200, horizon 1–3600, delay before horizon, at most 28800 engine ticks.',
    );
}

export function encodeBatch(batch: BatchExport): string {
  const text = JSON.stringify(batch);
  if (new TextEncoder().encode(text).byteLength > BATCH_MAX_BYTES)
    throw new Error('Batch export exceeds 16 MB; no truncated result is published.');
  return text;
}
