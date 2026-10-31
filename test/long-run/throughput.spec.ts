import assert from 'node:assert/strict';
import { it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, LIMIT, founder } from '../../src/model';
import { context, digest, invariants, receipt } from './support';

const WARMUPS = 2;
const REPETITIONS = 5;
const TICKS = 600;

function fixture(population: number): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, seed: 42, mutation: 0, climate: 0 }, false, {
    terrain: { version: 1, preset: 'open-field', seed: null },
  });
  const genome = founder(0);
  for (let position = 0; position < population; position++)
    assert.ok(
      world.spawn(
        genome,
        (position % 60) * 4 + 1,
        Math.floor(position / 60) * 4 + 1,
        position ? 5 : undefined,
      ),
    );
  invariants(world);
  return world;
}

it('records distinct empty, moderate and saturated ecology throughput without timing assertions', () => {
  const evidence = {
    ...context(),
    status: 'incomplete',
    elapsedMs: 0,
    warmups: WARMUPS,
    repetitions: REPETITIONS,
    ticksPerMeasurement: TICKS,
    seed: 42,
    fixtures: [] as {
      initialPopulation: number;
      initialSaveSHA256: string;
      settings: object;
      anatomy: object;
    }[],
    measurements: [] as {
      repetition: number;
      fixture: string;
      initialPopulation: number;
      finalPopulation: number;
      minPopulation: number;
      maxPopulation: number;
      populationTickSum: number;
      emptyTicks: number;
      saturatedTicks: number;
      completedTicks: number;
      elapsedMs: number;
      ticksPerSecond: number;
      finalSaveSHA256: string;
      births: number;
      deaths: number;
    }[],
    limitations:
      'Direct synchronous engine throughput with telemetry and lineage enabled, not worker scheduling/rendering or physical-device performance. Population counters are inside timing; setup, load, Save, invariants and equality assertions are outside. Identical clonal stationary five-cell mouth/leaf producers in an open climate-neutral field; no claim of worst-case predator/motor or mixed evolved anatomy performance. Empty ecology is reported separately. Shared-host load, JIT and GC affect elapsed time. No wall-clock pass/fail threshold.',
  };
  const started = performance.now();
  const populations = [0, 64, LIMIT];
  const files = populations.map((population) => {
    const world = fixture(population);
    const text = JSON.stringify(world.save());
    evidence.fixtures.push({
      initialPopulation: population,
      initialSaveSHA256: digest(text),
      settings: world.settings,
      anatomy: founder(0),
    });
    return text;
  });
  const endpoints = new Map<number, string>();
  try {
    for (let repetition = -WARMUPS; repetition < REPETITIONS; repetition++)
      for (let order = 0; order < populations.length; order++) {
        const position = (order + repetition + WARMUPS) % populations.length;
        const population = populations[position];
        const world = Ecosystem.load(files[position]);
        let minimum = population,
          maximum = population,
          sum = 0,
          empty = 0,
          saturated = 0;
        const start = performance.now();
        for (let tick = 0; tick < TICKS; tick++) {
          world.step();
          const count = world.organisms.size;
          minimum = Math.min(minimum, count);
          maximum = Math.max(maximum, count);
          sum += count;
          if (count === 0) empty++;
          if (count === LIMIT) saturated++;
        }
        const elapsedMs = performance.now() - start;
        invariants(world);
        const complete = JSON.stringify(world.save());
        if (endpoints.has(population))
          assert.equal(complete, endpoints.get(population), 'repeatable complete endpoint');
        else endpoints.set(population, complete);
        assert.equal(world.tick, TICKS);
        if (population) assert.ok(minimum > 0, 'a populated fixture must stay populated');
        else assert.equal(empty, TICKS);
        if (population === LIMIT) assert.ok(saturated > 0);
        if (repetition >= 0)
          evidence.measurements.push({
            repetition,
            fixture: population === 0 ? 'empty' : population === LIMIT ? 'saturated' : 'moderate',
            initialPopulation: population,
            finalPopulation: world.organisms.size,
            minPopulation: minimum,
            maxPopulation: maximum,
            populationTickSum: sum,
            emptyTicks: empty,
            saturatedTicks: saturated,
            completedTicks: world.tick,
            elapsedMs,
            ticksPerSecond: (world.tick * 1000) / elapsedMs,
            finalSaveSHA256: digest(complete),
            births: world.births,
            deaths: world.deaths,
          });
      }
    assert.equal(evidence.measurements.length, populations.length * REPETITIONS);
    evidence.status = 'passed';
  } finally {
    evidence.elapsedMs = performance.now() - started;
    receipt('throughput', evidence);
  }
});
