import { expect, it, vi } from 'vitest';
import { founder, type Perception } from '../src/model';
import { newController } from '../src/neural';
import { newSenses } from '../src/senses';
import { editSenses, sensesEditor, sensesStatus } from '../src/senses-view';
import { behaviorStatus, neuralEditor, transformDesign } from '../src/view';
import { perceptionHtml, drawPerception } from '../src/perception-view';
import { genomeDiff } from '../src/organism-view';

it('only explicitly opts an existing neural design in, resets topology and retains detached bounded traits', () => {
  const legacy = founder(0);
  expect(sensesEditor(legacy)).toBe('');
  expect(sensesStatus(legacy)).toBe('');
  expect(editSenses(legacy, 'enabled', true)).toBeNull();
  legacy.controller = newController();
  expect(sensesEditor(legacy)).toContain('resets neural parameters');
  expect(editSenses(legacy, 'range', 3)).toBeNull();
  const unfinished = { ...legacy, cells: [] };
  expect(editSenses(unfinished, 'enabled', true)!.cells).toEqual([]);
  const active = editSenses(legacy, 'enabled', true)!;
  expect(active.controller).toEqual(newController(2));
  expect(active.senses).toEqual(newSenses());
  expect(legacy.senses).toBeUndefined();
  expect(sensesEditor(active)).toContain('data-sense="temperature"');
  for (const [key, value] of [
    ['range', 8],
    ['orientation', 3],
    ['fov', 3],
    ['temperature', true],
  ] as const) {
    const edited = editSenses(active, key, value)!;
    expect(edited.senses![key]).toBe(value);
    expect(active.senses![key]).not.toBe(value);
    expect(sensesEditor(edited)).toContain('selected');
  }
  expect(editSenses(active, 'fov', 4)!.senses!.fov).toBe(4);
  for (const [key, value] of [
    ['range', 9],
    ['range', -1],
    ['range', 1.5],
    ['orientation', 4],
    ['fov', 2],
    ['temperature', 1],
    ['unknown', true],
    ['enabled', 1],
  ] as const)
    expect(editSenses(active, key, value)).toBeNull();
  const reset = editSenses(active, 'enabled', false)!;
  expect(reset.controller).toEqual(newController());
  expect(reset.senses).toBeUndefined();
  expect(behaviorStatus(active)).toContain('Neural controller v2');
  expect(sensesStatus(active)).toContain('zero thermal cost');
  active.senses!.temperature = true;
  expect(sensesStatus(active)).toContain('four paid samples');
  expect(neuralEditor(active)).toContain('10 → 4 → 4');
  expect(neuralEditor(active)).toContain('Neural weight 55');
  expect(neuralEditor(active)).toContain('Neural bias 7');
  expect(transformDesign(active, 'rotate').senses!.orientation).toBe(1);
  active.senses!.orientation = 1;
  expect(transformDesign(active, 'mirror').senses!.orientation).toBe(3);
  const baseline = {
    lineageId: 1,
    relation: 'own-lineage' as const,
    status: 'retained' as const,
    genome: legacy,
  };
  expect(genomeDiff(active, baseline)).toContain('Baseline senses: expanded senses unavailable');
  expect(genomeDiff(legacy, { ...baseline, genome: active })).toContain(
    'Selected senses: expanded senses unavailable',
  );
});

it('renders actual retained v2 evidence with explicit unavailable, historical, occlusion and action states', () => {
  const trace: Perception = {
    id: 1,
    tick: 2,
    direction: 3,
    chosenEye: null,
    moved: true,
    finalDirection: 3,
    finalRotation: 0,
    rays: [
      { eye: 0, origin: 0, heading: 0, cells: [240], stop: 'stinger', reaction: null },
      { eye: 1, origin: 1, heading: 1, cells: [2], stop: 'range', reaction: null },
    ],
    senses: {
      inputs: Array(10).fill(0.5),
      available: Array(10).fill(true),
      temperatures: [{ position: 0, value: 0.5 }],
      eyeCost: 0.008,
      temperatureCost: 0.032,
      action: 'forward',
    },
  };
  const current = perceptionHtml(trace, 2);
  const strokeRect = vi.fn();
  drawPerception({ strokeRect } as unknown as CanvasRenderingContext2D, trace, 10, 20, 5);
  expect(strokeRect).toHaveBeenCalledWith(11, 21, 3, 3);
  expect(current).toContain('Actual controller v2 perception');
  expect(current).toContain('accepted');
  expect(current).toContain('occluded by stinger');
  expect(current).toContain('range exhausted');
  expect(current).toContain('(0,0) = 0.5');
  expect(current).not.toContain('historical');
  trace.moved = false;
  expect(perceptionHtml(trace, 3)).toContain('blocked');
  trace.senses!.action = 'rest';
  trace.senses!.available.fill(false, 6);
  trace.senses!.temperatures = [];
  trace.senses!.temperatureCost = 0;
  const disabled = perceptionHtml(trace, 3);
  expect(disabled).toContain('rested');
  expect(disabled).toContain('historical');
  expect(disabled).toContain('unavailable (network value 0)');
  expect(disabled).toContain('no samples taken and no thermal cost');
});
