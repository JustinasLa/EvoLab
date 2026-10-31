import { Ecosystem } from './ecosystem';
import { integer, WORLD_MAX_BYTES } from './model';
import {
  COMPARISON_MAX_TICKS,
  COMPARISON_SAMPLE_INTERVAL,
  COMPARISON_BATCH_TICKS,
  type ComparisonPlan,
  type ComparisonBranch,
  type ComparisonResult,
} from './experiment-model';

export function createComparison(text: string, input: ComparisonPlan) {
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'horizonTick,intervention,treatmentTick' ||
    !['none', 'heat', 'cold'].includes(input.intervention) ||
    !integer(input.horizonTick, 1, 1e9) ||
    !integer(input.treatmentTick, 0, input.horizonTick - 1)
  )
    throw new Error('Invalid comparison plan.');
  if (typeof text !== 'string') throw new Error('Invalid complete checkpoint text.');
  const control = Ecosystem.load(text),
    treatment = Ecosystem.load(text),
    sourceTick = control.tick,
    plan = { ...input };
  if (
    plan.horizonTick <= sourceTick ||
    plan.horizonTick - sourceTick > COMPARISON_MAX_TICKS ||
    plan.treatmentTick < sourceTick ||
    (plan.intervention !== 'none' && plan.treatmentTick + 900 > 1e9)
  )
    throw new Error(
      'Comparison requires 1–3600 ticks and a treatment boundary before its horizon.',
    );
  if (plan.intervention !== 'none') {
    treatment.requireInterventionCapacity();
    if (
      treatment.eventUntil === plan.treatmentTick + 900 &&
      treatment.eventOffset === (plan.intervention === 'heat' ? 0.32 : -0.32)
    )
      throw new Error('The declared treatment would not change the checkpoint climate event.');
  }
  const worlds = [control, treatment];
  const branches: ComparisonBranch[] = worlds.map((world) => ({
    state: '',
    samples: [],
    extinction: world.organisms.size ? null : { tick: null, cause: 'initially empty checkpoint' },
  }));
  const sample = (): void => {
    for (const [position, world] of worlds.entries())
      branches[position].samples.push({
        tick: world.tick,
        population: world.organisms.size,
        births: world.births,
        deaths: world.deaths,
      });
  };
  sample();
  let disposed = false;
  return {
    advance(now: () => number) {
      if (disposed) throw new Error('Comparison was disposed.');
      const began = now();
      for (
        let count = 0;
        count < COMPARISON_BATCH_TICKS && control.tick < plan.horizonTick;
        count++
      ) {
        if (treatment.tick === plan.treatmentTick && plan.intervention !== 'none') {
          const before = { offset: treatment.eventOffset, until: treatment.eventUntil };
          treatment.shock(plan.intervention);
          treatment.appendIntervention({
            kind: 'shock',
            detail: {
              kind: plan.intervention,
              before,
              after: { offset: treatment.eventOffset, until: treatment.eventUntil },
            },
          });
        }
        for (const [position, world] of worlds.entries()) {
          world.step();
          if (!world.organisms.size && !branches[position].extinction)
            branches[position].extinction = { tick: world.tick, cause: world.lastDeath!.cause };
        }
        if (
          (control.tick - sourceTick) % COMPARISON_SAMPLE_INTERVAL === 0 ||
          control.tick === plan.horizonTick
        )
          sample();
        if (now() - began >= 8) break;
      }
      return { sourceTick, tick: control.tick, horizonTick: plan.horizonTick };
    },
    result(): ComparisonResult {
      if (disposed || control.tick !== plan.horizonTick)
        throw new Error('Comparison has no completed result.');
      for (const [position, world] of worlds.entries()) {
        const state = JSON.stringify(world.save());
        if (new TextEncoder().encode(state).byteLength > WORLD_MAX_BYTES)
          throw new Error('A final comparison checkpoint exceeds 2.5 MB. No result retained.');
        Ecosystem.load(state);
        branches[position].state = state;
      }
      return structuredClone({
        plan,
        sourceTick,
        seed: control.settings.seed,
        control: branches[0],
        treatment: branches[1],
      });
    },
    dispose(): void {
      disposed = true;
      worlds.length = branches.length = 0;
    },
  };
}
