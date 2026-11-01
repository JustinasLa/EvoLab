import { expect, it } from 'vitest';
import { Ecosystem } from '../../src/ecosystem';
import { EventRecorder, completeCheckpoint } from '../../src/event-journal';
import { DEFAULTS, founder } from '../../src/model';
import { EVENT_CAPACITY } from '../../src/event-model';
import { receipt } from './support';

it('measures opt-in recording cost and preserves complete trajectories over bounded long runs', () => {
  const receipts = [];
  for (const population of [1, 160, 1600]) {
    const source = new Ecosystem({ ...DEFAULTS, seed: 42, climate: 0, mutation: 0 }, false);
    for (let position = 0; position < population; position++)
      expect(
        source.spawn(founder(0), (position % 60) * 4 + 1, Math.floor(position / 60) * 4 + 1),
      ).toBeTruthy();
    const checkpoint = completeCheckpoint(source);
    const durations = [],
      endpoints = [];
    for (const recording of [false, true]) {
      const world = Ecosystem.load(checkpoint);
      const began = performance.now();
      const recorder = recording ? new EventRecorder(world) : undefined;
      for (let count = 0; count < 1200; count++) {
        world.step();
        recorder?.observe(world);
        if (count === 400) {
          world.shock('heat');
          recorder?.observe(world, true);
        }
      }
      durations.push(performance.now() - began);
      endpoints.push(completeCheckpoint(world));
      if (recorder) expect(recorder.snapshot().events.length).toBeLessThanOrEqual(EVENT_CAPACITY);
      Ecosystem.load(endpoints.at(-1)!);
    }
    expect(endpoints[1]).toBe(endpoints[0]);
    receipts.push({
      population,
      ticks: 1200,
      disabledMs: durations[0],
      enabledMs: durations[1],
      completeEndpointsEqual: true,
    });
  }
  receipt('event-recording-throughput', receipts);
});
