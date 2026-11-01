import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { comparisonRuntime, createComparison, createRecipeComparison } from '../src/experiments';
import { DEFAULTS, WORLD_MAX_BYTES, encodeLegacyValue } from '../src/model';
import {
  COMPARISON_MAX_SAMPLES,
  RECIPE_MAX_BYTES,
  type ComparisonPlan,
} from '../src/experiment-model';
import { storedSensoryGenome } from './fixtures/sensory-legacy';

function source() {
  const world = new Ecosystem({ ...DEFAULTS, seed: 2019, mutation: 0.2 }, false);
  const genome = storedSensoryGenome();
  genome.legacyExtensions = [['opaque', encodeLegacyValue({ number: -0, more: Infinity })]];
  world.spawn(genome, 120, 78);
  world.spawn(genome, 20, 20);
  for (let tick = 0; tick < 2; tick++) world.step();
  const saved = world.save();
  saved.organisms.reverse();
  Object.defineProperty(saved.settings, '__proto__', { value: { opaque: true }, enumerable: true });
  return JSON.stringify(saved);
}
function finish(text: string, plan: ComparisonPlan) {
  const runner = createComparison(text, plan);
  let progress;
  do {
    progress = runner.advance(() => 0);
  } while (progress.tick < progress.horizonTick);
  const result = runner.result();
  runner.dispose();
  return result;
}
function intervene(world: Ecosystem, kind: 'heat' | 'cold') {
  const before = { offset: world.eventOffset, until: world.eventUntil };
  world.shock(kind);
  world.appendIntervention({
    kind: 'shock',
    detail: { kind, before, after: { offset: world.eventOffset, until: world.eventUntil } },
  });
}

describe('isolated complete checkpoint comparisons', () => {
  it('repeats control/control identically with RNG, order, complete archives and passive opaque genomes', () => {
    const text = source(),
      original = JSON.parse(text),
      plan = { intervention: 'none', treatmentTick: 2, horizonTick: 92 } as const;
    const first = finish(text, plan),
      second = finish(text, plan),
      independent = Ecosystem.load(text);
    while (independent.tick < 92) independent.step();
    expect(first).toEqual(second);
    expect(first.control).toEqual(first.treatment);
    expect(JSON.parse(first.control.state)).toEqual(independent.save());
    expect(first.control.samples.map((sample) => sample.tick)).toEqual([2, 32, 62, 92]);
    expect(first.control.samples[0].population).toBe(2);
    expect(JSON.parse(text)).toEqual(original);
    expect(JSON.parse(first.control.state).organisms[0].genome.behavior.version).toBe(1);
  });
  for (const intervention of ['heat', 'cold'] as const)
    for (const delay of [0, 1, 12, 30, 35, 59])
      it(`${intervention} applies once at exact boundary ${delay}, including batch/sample boundaries`, () => {
        const text = source(),
          plan = { intervention, treatmentTick: 2 + delay, horizonTick: 62 },
          output = finish(text, plan),
          control = Ecosystem.load(text),
          treatment = Ecosystem.load(text);
        while (control.tick < plan.horizonTick) {
          if (treatment.tick === plan.treatmentTick) intervene(treatment, intervention);
          control.step();
          treatment.step();
        }
        expect(JSON.parse(output.control.state)).toEqual(control.save());
        expect(JSON.parse(output.treatment.state)).toEqual(treatment.save());
        expect(output.treatment.samples.map((sample) => sample.tick)).toEqual([2, 32, 62]);
        const rows = JSON.parse(output.treatment.state).interventions.entries;
        expect(rows.filter((row: any) => row.kind === 'shock')).toEqual([
          expect.objectContaining({ firstTick: plan.treatmentTick, lastTick: plan.treatmentTick }),
        ]);
        expect(finish(text, plan)).toEqual(output);
      });
  it('yields after one costly tick pair or at most twelve ordinary pairs and owns result copies', () => {
    const plan = { intervention: 'none', treatmentTick: 2, horizonTick: 15 } as const,
      runner = createComparison(source(), plan);
    expect(() => runner.result()).toThrow('no completed result');
    let time = 0;
    expect(runner.advance(() => (time += 9)).tick).toBe(3);
    expect(runner.advance(() => 0).tick).toBe(15);
    const result = runner.result();
    result.control.samples.length = 0;
    expect(runner.result().control.samples).toHaveLength(2);
    expect(plan.horizonTick).toBe(15);
    runner.dispose();
    runner.dispose();
    expect(() => runner.advance(() => 0)).toThrow('disposed');
    expect(() => runner.result()).toThrow('no completed result');
  });
  it('retains honest initial/natural extinction and bounded samples through the equal empty horizon', () => {
    const empty = new Ecosystem(DEFAULTS, false),
      text = JSON.stringify(empty.save()),
      output = finish(text, { intervention: 'none', treatmentTick: 0, horizonTick: 3600 });
    expect(output.control.extinction).toEqual({ tick: null, cause: 'initially empty checkpoint' });
    expect(output.control.samples).toHaveLength(COMPARISON_MAX_SAMPLES);
    expect(output.control.samples.at(-1)?.tick).toBe(3600);
    expect(output.control).toEqual(output.treatment);
    const world = new Ecosystem(DEFAULTS, false);
    world.spawn({ ...storedSensoryGenome(), cells: [{ x: 0, y: 0, type: 3 }] }, 10, 10)!.energy =
      0.001;
    const extinct = finish(JSON.stringify(world.save()), {
      intervention: 'cold',
      treatmentTick: 5,
      horizonTick: 31,
    });
    expect(extinct.control.extinction).toEqual({ tick: 1, cause: 'energy' });
    expect(extinct.treatment.extinction).toEqual(extinct.control.extinction);
    expect(extinct.control.samples.map((sample) => sample.tick)).toEqual([0, 30, 31]);
    expect(JSON.parse(extinct.treatment.state).tick).toBe(31);
    expect(JSON.parse(extinct.treatment.state).interventions.entries.at(-1).firstTick).toBe(5);
  });
  it('rejects malformed checkpoints and plans before running, without retaining partial replacements', () => {
    const text = source(),
      valid = { intervention: 'heat', treatmentTick: 2, horizonTick: 62 };
    for (const input of [
      null,
      {},
      { ...valid, extra: true },
      { ...valid, intervention: 'pressure' },
      { ...valid, horizonTick: NaN },
      { ...valid, horizonTick: 2 },
      { ...valid, horizonTick: 3603 },
      { ...valid, treatmentTick: 1 },
      { ...valid, treatmentTick: 62 },
      { ...valid, treatmentTick: 2.5 },
    ])
      expect(() => createComparison(text, input as ComparisonPlan)).toThrow();
    expect(() => createComparison(null as unknown as string, valid as ComparisonPlan)).toThrow(
      'checkpoint text',
    );
    expect(() => createComparison('{}', valid as ComparisonPlan)).toThrow('valid EvoLab');
    const invalid = JSON.parse(text);
    invalid.organisms[0].genome.behavior.version = 3;
    expect(() => createComparison(JSON.stringify(invalid), valid as ComparisonPlan)).toThrow();
    const event = Ecosystem.load(text);
    intervene(event, 'heat');
    expect(() => createComparison(JSON.stringify(event.save()), valid as ComparisonPlan)).toThrow(
      'would not change',
    );
    const edge = new Ecosystem(DEFAULTS, false).save();
    edge.tick = 999999999;
    edge.telemetry.originTick =
      edge.telemetry.adaptationOriginTick =
      edge.telemetry.pending.fromTick =
        edge.tick;
    expect(() =>
      createComparison(JSON.stringify(edge), {
        intervention: 'heat',
        treatmentTick: edge.tick,
        horizonTick: 1000000000,
      }),
    ).toThrow('1–3600');
  });
  it('rejects overlarge final checkpoints instead of truncating opaque state or samples', () => {
    const world = new Ecosystem(DEFAULTS, false).save() as any;
    world.settings.padding = '';
    const bytes = JSON.stringify(world).length;
    world.settings.padding = 'x'.repeat(WORLD_MAX_BYTES - bytes - 10);
    const runner = createComparison(JSON.stringify(world), {
      intervention: 'none',
      treatmentTick: 0,
      horizonTick: 30,
    });
    while (runner.advance(() => 0).tick < 30) {}
    expect(() => runner.result()).toThrow('exceeds 2.5 MB');
    runner.dispose();
  });
});

afterEach(() => vi.unstubAllGlobals());
function finishRunner(runner: ReturnType<typeof createComparison>) {
  let progress;
  do {
    progress = runner.advance(() => 0);
  } while (progress.tick < progress.horizonTick);
  const result = runner.result();
  runner.dispose();
  return result;
}
describe('measured paired recipes', () => {
  it('observes exact traits and real post-tick stress without modifying RNG or telemetry', () => {
    const text = source(),
      plan = { intervention: 'heat', treatmentTick: 2, horizonTick: 33 } as const;
    const result = finish(text, plan);
    const world = Ecosystem.load(text),
      before = world.save();
    const observation = world.populationObservation();
    expect(world.save()).toEqual(before);
    expect(result.control.samples[0]).toMatchObject({
      meanPreference: observation.meanPreference,
      meanTolerance: observation.meanTolerance,
      stressedFraction: observation.adaptation.stressedOrganisms / world.organisms.size,
    });
    while (world.tick < 33) world.step();
    const last = world.populationObservation();
    expect(result.control.samples.at(-1)).toMatchObject({
      meanPreference: last.meanPreference,
      meanTolerance: last.meanTolerance,
      stressedFraction: last.adaptation.stressedOrganisms / world.organisms.size,
    });
    expect(JSON.parse(result.control.state)).toEqual(world.save());
    const recipe = JSON.parse(result.recipe);
    expect(recipe).toMatchObject({
      checkpoint: text,
      sourceTick: 2,
      seed: 2019,
      plan,
      rules: { version: 5, worldVersion: 12 },
      runtime: comparisonRuntime(),
    });
    const replay = finishRunner(createRecipeComparison(result.recipe));
    expect(replay).toEqual({ ...result, reproduced: true });
    const reordered = JSON.parse(result.recipe);
    reordered.control.samples = reordered.control.samples.map((s: any) =>
      Object.fromEntries(Object.entries(s).reverse()),
    );
    expect(finishRunner(createRecipeComparison(JSON.stringify(reordered)))).toEqual(replay);
  });
  it('preserves empty/terminal outcomes and rejects altered but superficially valid measurements on replay', () => {
    const world = new Ecosystem(DEFAULTS, false);
    world.spawn({ ...storedSensoryGenome(), cells: [{ x: 0, y: 0, type: 3 }] }, 1, 1)!.energy =
      0.001;
    const result = finish(JSON.stringify(world.save()), {
      intervention: 'cold',
      treatmentTick: 0,
      horizonTick: 31,
    });
    expect(result.control.samples.at(-1)).toMatchObject({
      population: 0,
      meanPreference: null,
      meanTolerance: null,
      stressedFraction: null,
    });
    expect(finishRunner(createRecipeComparison(result.recipe)).control).toEqual(result.control);
    const altered = JSON.parse(result.recipe);
    altered.control.samples[0].meanPreference = 0.99;
    expect(() => finishRunner(createRecipeComparison(JSON.stringify(altered)))).toThrow(
      'replay differs',
    );
    const empty = finish(JSON.stringify(new Ecosystem(DEFAULTS, false).save()), {
      intervention: 'none',
      treatmentTick: 0,
      horizonTick: 3600,
    });
    expect(finishRunner(createRecipeComparison(empty.recipe))).toEqual({
      ...empty,
      reproduced: true,
    });
  });
  it('validates every envelope, observation, extinction, runtime and full checkpoint before starting', () => {
    const result = finish(source(), { intervention: 'none', treatmentTick: 2, horizonTick: 33 });
    const edits: ((r: any) => void)[] = [
      (r) => (r.extra = true),
      (r) => (r.version = 2),
      (r) => r.rules.version++,
      (r) => r.rules.worldVersion++,
      (r) => (r.runtime = 'another runtime'),
      (r) => (r.checkpoint = '{}'),
      (r) => r.seed++,
      (r) => r.sourceTick++,
      (r) => (r.plan.extra = true),
      (r) => (r.plan.intervention = 'invalid'),
      (r) => (r.plan.horizonTick = 2),
      (r) => (r.control.extra = true),
      (r) => r.control.samples.pop(),
      (r) => r.control.samples.push(r.control.samples[0]),
      (r) => r.control.samples[0].tick++,
      (r) => (r.control.samples[0].extra = true),
      (r) => (r.control.samples[0].population = 1601),
      (r) => (r.control.samples[0].births = -1),
      (r) => (r.control.samples[1].deaths = -1),
      (r) => (r.control.samples[0].meanPreference = null),
      (r) => (r.control.samples[0].meanTolerance = 0.1),
      (r) => (r.control.samples[0].stressedFraction = 2),
      (r) => (r.control.extinction = { tick: 1, cause: 'age' }),
      (r) => (r.control.extinction = { tick: null, cause: 'initially empty checkpoint' }),
      (r) => (r.control.extinction = { tick: 3, cause: 'energy' }),
      (r) => (r.control.extinction = { tick: 3, cause: 'manual' }),
      (r) => {
        const w = JSON.parse(r.checkpoint);
        w.organisms[0].genome.behavior.version = 3;
        r.checkpoint = JSON.stringify(w);
      },
      (r) => {
        const w = JSON.parse(r.checkpoint);
        w.lineageArchive.summaries[0].foundingGenome.preference = 2;
        r.checkpoint = JSON.stringify(w);
      },
    ];
    for (const edit of edits) {
      const recipe = JSON.parse(result.recipe);
      edit(recipe);
      expect(() => createRecipeComparison(JSON.stringify(recipe))).toThrow();
    }
    for (const text of [
      'null',
      '[]',
      '{',
      'x'.repeat(RECIPE_MAX_BYTES + 1),
      'é'.repeat(RECIPE_MAX_BYTES / 2 + 1),
    ])
      expect(() => createRecipeComparison(text)).toThrow();
    expect(() => createRecipeComparison(null as unknown as string)).toThrow();
    const empty = JSON.parse(
      finish(JSON.stringify(new Ecosystem(DEFAULTS, false).save()), {
        intervention: 'none',
        treatmentTick: 0,
        horizonTick: 1,
      }).recipe,
    );
    empty.control.samples[0].stressedFraction = 0;
    expect(() => createRecipeComparison(JSON.stringify(empty))).toThrow('observation');
    empty.control.samples[0].stressedFraction = null;
    empty.control.extinction = null;
    expect(() => createRecipeComparison(JSON.stringify(empty))).toThrow('extinction');
  });
  it('bounds outbound recipes and records non-browser runtime explicitly', () => {
    vi.stubGlobal('navigator', undefined);
    expect(comparisonRuntime()).toBe('non-browser ECMAScript');
    const runner = createComparison(source(), {
      intervention: 'none',
      treatmentTick: 2,
      horizonTick: 3,
    });
    runner.advance(() => 0);
    vi.stubGlobal('navigator', { userAgent: 'x'.repeat(RECIPE_MAX_BYTES) });
    expect(() => runner.result()).toThrow('recipe exceeds');
    runner.dispose();
  });
});
