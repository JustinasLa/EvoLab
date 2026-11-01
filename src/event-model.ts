import { WORLD_VERSION } from './model';

export const EVENT_RULES = 1;
export const REPLAY_RULES = `cellular-${WORLD_VERSION}-event-1`;
export const EVENT_CAPACITY = 32;
export const REPLAY_CAPACITY = 4;
export const REPLAY_WINDOW = 120;
export const REPLAY_BYTES = 12_000_000;
export interface ObservedEvent {
  id: number;
  tick: number;
  kind: 'lineage-extinction' | 'population-drop' | 'first-trait';
  detail: string;
  replay: boolean;
}
export interface EventJournal {
  originTick: number;
  tick: number;
  evicted: number;
  evidenceEvicted: number;
  problem: string;
  events: ObservedEvent[];
}
export interface EventReplay {
  rules: typeof REPLAY_RULES;
  eventRules: typeof EVENT_RULES;
  worldVersion: typeof WORLD_VERSION;
  boundary: number;
  interventions: [];
  sourceTick: number;
  endpointTick: number;
  checkpoint: string;
  endpoint: string;
}
export type ReplayResponse =
  | { type: 'progress'; tick: number; endpointTick: number }
  | { type: 'complete'; tick: number; population: number; verified: true; cells: Uint8Array }
  | { type: 'error'; message: string };
