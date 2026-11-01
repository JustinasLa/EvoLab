import type { Ecosystem } from './ecosystem';
import { WIDTH, HEIGHT } from './model';

function shock(world: Ecosystem, kind: 'heat' | 'cold'): void {
  world.requireInterventionCapacity();
  const before = { offset: world.eventOffset, until: world.eventUntil };
  world.shock(kind);
  world.appendIntervention({
    kind: 'shock',
    detail: { kind, before, after: { offset: world.eventOffset, until: world.eventUntil } },
  });
}

function mutation(world: Ecosystem, after: number): void {
  const before = world.settings.mutation;
  if (before === after) return;
  world.requireInterventionCapacity();
  world.appendIntervention({
    kind: 'settings',
    detail: { changes: { mutation: { before, after } } },
  });
  world.settings.mutation = after;
}

export const EXPERIMENT_INTERVENTIONS = Object.freeze({
  none: { label: 'No intervention (control/control)', apply: (_world: Ecosystem) => {} },
  heat: { label: 'Heatwave (+0.32, 900 ticks)', apply: (world: Ecosystem) => shock(world, 'heat') },
  cold: {
    label: 'Cold snap (−0.32, 900 ticks)',
    apply: (world: Ecosystem) => shock(world, 'cold'),
  },
  shade: {
    label: 'Full shade, center disk radius 8 (197 cells)',
    apply: (world: Ecosystem) => {
      world.changeShadeMode(true);
      world.paintShade(
        { rulesVersion: 1, tool: 'shade', radius: 8, units: 16 },
        WIDTH / 2,
        HEIGHT / 2,
      );
    },
  },
  'mutation-off': {
    label: 'Birth mutation probability 0',
    apply: (world: Ecosystem) => mutation(world, 0),
  },
  'mutation-high': {
    label: 'Birth mutation probability 0.4',
    apply: (world: Ecosystem) => mutation(world, 0.4),
  },
});

export type ExperimentIntervention = keyof typeof EXPERIMENT_INTERVENTIONS;
export const validExperimentIntervention = (value: unknown): value is ExperimentIntervention =>
  typeof value === 'string' && Object.hasOwn(EXPERIMENT_INTERVENTIONS, value);
