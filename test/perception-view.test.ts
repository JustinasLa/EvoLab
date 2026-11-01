import { afterEach, expect, it, vi } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, index, type ControlState, type Genome } from '../src/model';
import { createOrganismView } from '../src/organism-view';
import { drawPerception, perceptionHtml } from '../src/perception-view';
import { markup } from '../src/view';

const source: Genome = {
  cells: [
    { x: 0, y: 0, type: 8 },
    { x: 1, y: 0, type: 5 },
  ],
  preference: 0.5,
  tolerance: 0.2,
  tempo: 2,
  behavior: {
    version: 2,
    mode: 'evolved',
    reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
  },
};
function fixture() {
  const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0, mutation: 0 }, false),
    organism = world.spawn(source, 0, 0)!;
  organism.age = 1;
  organism.direction = 0;
  world.selectPerception(organism.id);
  world.food[index(0, -3)] = 1;
  const state = (replacementId = 1): ControlState =>
    ({
      replacementId,
      revision: world.tick + 1,
      selected: world.organisms.get(organism.id) ?? null,
      perception: world.perception(),
      world: world.presentation(organism.id),
    }) as ControlState;
  return { world, organism, state };
}
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('uses exact historical decisions, distinguishes none and blocked fallback, and draws wrapped visits in camera coordinates', () => {
  const { world } = fixture();
  expect(perceptionHtml(null, 0)).toContain('never reconstructs');
  world.step();
  const trace = world.perception()!;
  expect(perceptionHtml(trace, 2)).toContain('tick 1; current observation tick 2 — historical');
  expect(perceptionHtml(trace, 1)).toContain('Eye 0 selected: north');
  expect(perceptionHtml(trace, 1)).toContain('occluded by food; chase; chosen');
  const ctx = {
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: '',
    lineWidth: 0,
  };
  drawPerception(ctx as unknown as CanvasRenderingContext2D, trace, 10, 20, 2);
  expect(ctx.strokeRect.mock.calls.slice(0, 3)).toEqual([
    [10, 330, 2, 2],
    [10, 328, 2, 2],
    [10, 326, 2, 2],
  ]);
  expect(ctx.strokeRect.mock.calls[3]).toEqual([10, 326, 2, 2]);
  expect(ctx.moveTo.mock.calls[0]).toEqual([11, 21]);
  expect(ctx.lineTo.mock.calls[0]).toEqual([11, 20.2]);
  expect(ctx.strokeStyle).toBe('#ffffff');
  const alternate = structuredClone(trace);
  alternate.chosenEye = null;
  alternate.moved = false;
  alternate.rays[0].stop = 'range';
  alternate.rays[0].reaction = null;
  expect(perceptionHtml(alternate, 1)).toContain('No non-ignored candidate');
  expect(perceptionHtml(alternate, 1)).toContain('Translation blocked');
  expect(perceptionHtml(alternate, 1)).toContain('range exhausted');
  ctx.strokeRect.mockClear();
  ctx.stroke.mockClear();
  drawPerception(ctx as unknown as CanvasRenderingContext2D, alternate, 0, 0, 1);
  expect(ctx.strokeRect).toHaveBeenCalledTimes(3);
  expect(ctx.stroke).not.toHaveBeenCalled();
});

it('retains one actual selected observation across pauses, with local overlay controls and immediate death/reset clearing', () => {
  const { world, organism, state } = fixture(),
    root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  const changed = vi.fn(),
    view = createOrganismView(
      root,
      root.querySelector('canvas')!,
      { x: 0, y: 0, zoom: 1 },
      changed,
    ),
    observation = root.querySelector('#perception-observation')!,
    overlay = root.querySelector<HTMLInputElement>('#perception-enabled')!;
  view.update(state());
  expect(observation.textContent).toContain('No retained perception');
  overlay.click();
  expect(changed).toHaveBeenCalledOnce();
  expect(view.perception()).toBeNull();
  world.step();
  view.update(state());
  const trace = world.perception();
  expect(view.perception()).toEqual(trace);
  const saved = world.save();
  view.update(state(), false);
  expect(observation.textContent).toContain('tick 1');
  overlay.click();
  expect(view.perception()).toBeNull();
  overlay.click();
  expect(view.perception()).toEqual(trace);
  expect(world.save()).toEqual(saved);
  world.step();
  view.update(state());
  expect(observation.textContent).toContain('historical');
  world.kill(organism, 'manual');
  view.update(state());
  expect(view.perception()).toBeNull();
  expect(observation.textContent).toContain('No retained perception');
  view.update({ ...state(2), selected: { ...organism, id: organism.id }, perception: null });
  expect(view.perception()).toBeNull();
  view.clear();
  expect(observation.textContent).toContain('No retained perception');
  view.dispose();
  changed.mockClear();
  overlay.click();
  expect(changed).not.toHaveBeenCalled();
});
