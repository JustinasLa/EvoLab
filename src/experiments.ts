import { Ecosystem } from './ecosystem';
import { finite, integer, LIMIT, WORLD_VERSION, WORLD_MAX_BYTES } from './model';
import {
  COMPARISON_MAX_TICKS,
  COMPARISON_MAX_SAMPLES,
  RECIPE_MAX_BYTES,
  EXPERIMENT_RULES_VERSION,
  type ExperimentRecipe,
  COMPARISON_SAMPLE_INTERVAL,
  COMPARISON_BATCH_TICKS,
  type ComparisonPlan,
  type ComparisonBranch,
  type ComparisonResult,
} from './experiment-model';

export function comparisonRuntime(): string {
  return typeof navigator === 'undefined' ? 'non-browser ECMAScript' : navigator.userAgent;
}

export function createComparison(text: string, input: ComparisonPlan) {
  return comparison(text, input);
}

function comparison(text: string, input: ComparisonPlan, expected?: ExperimentRecipe) {
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
    seed = control.settings.seed,
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
    for (const [position, world] of worlds.entries()) {
      const observation = world.populationObservation();
      branches[position].samples.push({
        tick: world.tick,
        population: world.organisms.size,
        births: world.births,
        deaths: world.deaths,
        meanPreference: observation.meanPreference,
        meanTolerance: observation.meanTolerance,
        stressedFraction: world.organisms.size
          ? observation.adaptation.stressedOrganisms / world.organisms.size
          : null,
      });
    }
  };
  sample();
  if (expected && (expected.sourceTick !== sourceTick || expected.seed !== seed))
    throw new Error('Recipe seed or starting tick does not match its complete checkpoint.');
  let disposed = false;
  return {
    advance(now: () => number) {
      if (disposed) throw new Error('Comparison was disposed.');
      const [control, treatment] = worlds;
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
      if (disposed || worlds[0].tick !== plan.horizonTick)
        throw new Error('Comparison has no completed result.');
      for (const [position, world] of worlds.entries()) {
        const state = JSON.stringify(world.save());
        if (new TextEncoder().encode(state).byteLength > WORLD_MAX_BYTES)
          throw new Error('A final comparison checkpoint exceeds 2.5 MB. No result retained.');
        Ecosystem.load(state);
        branches[position].state = state;
      }
      const receipt = (branch: ComparisonBranch) => ({
        samples: branch.samples,
        extinction: branch.extinction,
      });
      const recipe: ExperimentRecipe = {
        format: 'evolab-drift-experiment',
        version: 1,
        rules: {
          id: 'evolab-drift-cellular',
          version: EXPERIMENT_RULES_VERSION,
          worldVersion: WORLD_VERSION,
        },
        runtime: comparisonRuntime(),
        checkpoint: text,
        sourceTick,
        seed,
        plan,
        control: receipt(branches[0]),
        treatment: receipt(branches[1]),
      };
      const recorded = expected;
      if (
        recorded &&
        !(['control', 'treatment'] as const).every(
          (branch) =>
            recipe[branch].samples.every((sample, i) =>
              Object.entries(sample).every(
                ([key, value]) => value === recorded[branch].samples[i][key as keyof typeof sample],
              ),
            ) &&
            recipe[branch].extinction?.tick === recorded[branch].extinction?.tick &&
            recipe[branch].extinction?.cause === recorded[branch].extinction?.cause,
        )
      )
        throw new Error(
          'Recipe replay differs from the recorded samples or extinction; no reproduced result retained.',
        );
      const encoded = JSON.stringify(recipe);
      if (new TextEncoder().encode(encoded).byteLength > RECIPE_MAX_BYTES)
        throw new Error('Experiment recipe exceeds its bounded format.');
      return structuredClone({
        plan,
        sourceTick,
        seed,
        recipe: encoded,
        reproduced: !!expected,
        control: branches[0],
        treatment: branches[1],
      });
    },
    dispose(): void {
      disposed = true;
      worlds.length = branches.length = 0;
      text = '';
      expected = undefined;
    },
  };
}

function keys(value: any, expected: string[]): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected.sort().join(',')
  );
}

export function createRecipeComparison(text: string) {
  if (
    typeof text !== 'string' ||
    text.length > RECIPE_MAX_BYTES ||
    new TextEncoder().encode(text).byteLength > RECIPE_MAX_BYTES
  )
    throw new Error('Experiment recipe exceeds its byte limit.');
  const value = JSON.parse(text);
  if (
    !keys(value, [
      'format',
      'version',
      'rules',
      'runtime',
      'checkpoint',
      'sourceTick',
      'seed',
      'plan',
      'control',
      'treatment',
    ]) ||
    value.format !== 'evolab-drift-experiment' ||
    value.version !== 1 ||
    !keys(value.rules, ['id', 'version', 'worldVersion']) ||
    value.rules.id !== 'evolab-drift-cellular' ||
    value.rules.version !== EXPERIMENT_RULES_VERSION ||
    value.rules.worldVersion !== WORLD_VERSION ||
    value.runtime !== comparisonRuntime() ||
    typeof value.checkpoint !== 'string' ||
    !integer(value.sourceTick, 0, 1e9) ||
    !integer(value.seed, 0, 0xffffffff) ||
    !keys(value.plan, ['intervention', 'treatmentTick', 'horizonTick']) ||
    !integer(
      value.plan.horizonTick,
      value.sourceTick + 1,
      Math.min(1e9, value.sourceTick + COMPARISON_MAX_TICKS),
    )
  )
    throw new Error(
      'Invalid recipe format, rules, runtime or metadata. Replay requires the same rules/runtime.',
    );
  const ticks: number[] = [value.sourceTick];
  for (
    let tick = value.sourceTick + COMPARISON_SAMPLE_INTERVAL;
    tick < value.plan.horizonTick;
    tick += COMPARISON_SAMPLE_INTERVAL
  )
    ticks.push(tick);
  ticks.push(value.plan.horizonTick);
  for (const name of ['control', 'treatment']) {
    const branch = value[name];
    if (
      !keys(branch, ['samples', 'extinction']) ||
      !Array.isArray(branch.samples) ||
      branch.samples.length !== ticks.length ||
      branch.samples.length > COMPARISON_MAX_SAMPLES
    )
      throw new Error('Recipe requires complete bounded tick-aligned samples.');
    let births = 0,
      deaths = 0;
    for (const [i, sample] of branch.samples.entries()) {
      if (
        !keys(sample, [
          'tick',
          'population',
          'births',
          'deaths',
          'meanPreference',
          'meanTolerance',
          'stressedFraction',
        ]) ||
        sample.tick !== ticks[i] ||
        !integer(sample.population, 0, LIMIT) ||
        !integer(sample.births, births, 1e9) ||
        !integer(sample.deaths, deaths, 1e9) ||
        (sample.population === 0
          ? sample.meanPreference !== null ||
            sample.meanTolerance !== null ||
            sample.stressedFraction !== null
          : !finite(sample.meanPreference, 0, 1) ||
            !finite(sample.meanTolerance, 0.12, 0.6) ||
            !finite(sample.stressedFraction, 0, 1))
      )
        throw new Error('Invalid recipe observation.');
      births = sample.births;
      deaths = sample.deaths;
    }
    const extinction = branch.extinction;
    if (
      extinction !== null &&
      (!keys(extinction, ['tick', 'cause']) ||
        (extinction.tick === null
          ? extinction.cause !== 'initially empty checkpoint' || branch.samples[0].population !== 0
          : !integer(extinction.tick, value.sourceTick + 1, value.plan.horizonTick) ||
            !['age', 'energy'].includes(extinction.cause)))
    )
      throw new Error('Invalid recipe extinction evidence.');
    if (
      (extinction === null) !== branch.samples.at(-1).population > 0 ||
      (extinction &&
        branch.samples.some(
          (sample: ComparisonBranch['samples'][number]) =>
            (extinction.tick === null || sample.tick >= extinction.tick) && sample.population !== 0,
        ))
    )
      throw new Error('Inconsistent recipe extinction evidence.');
  }
  return comparison(value.checkpoint, value.plan, value);
}
