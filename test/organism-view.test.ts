import { afterEach, expect, it, vi } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, type ControlState } from '../src/model';
import { createOrganismView, genomeDiff } from '../src/organism-view';
import { markup, point, viewport, type Camera } from '../src/view';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function fixture() {
  const world = new Ecosystem(DEFAULTS, false, {
    terrain: { version: 1, preset: 'open-field', seed: null },
  });
  const organism = world.spawn(founder(2), 239, 155)!;
  const root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  root.querySelector<HTMLElement>('#organism-panel')!.hidden = false;
  root.querySelector<HTMLDetailsElement>('#specimen-details')!.open = true;
  const canvas = root.querySelector('canvas')!;
  const camera: Camera = { x: 0, y: 0, zoom: 2 };
  const changed = vi.fn();
  const view = createOrganismView(root, canvas, camera, changed);
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const state = (revision: number, replacementId = 1): ControlState =>
    ({
      replacementId,
      revision,
      selected: structuredClone(organism),
      world: world.presentation(organism.id),
    }) as ControlState;
  return { world, organism, root, canvas, camera, view, changed, get, state };
}

it('compares actual coordinate changes, exact traits and stored inactive reactions with explicit provenance', () => {
  const previous = founder(0),
    current = structuredClone(previous);
  current.cells[0].type = 7;
  current.cells.pop();
  current.cells.push({ x: 2, y: 0, type: 8 });
  current.preference = 0.7;
  current.behavior = {
    version: 1,
    mode: 'evolved',
    reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
  };
  const html = genomeDiff(current, {
    lineageId: 3,
    relation: 'parent-lineage',
    genome: previous,
    status: 'retained',
  });
  expect(html).toContain('parent lineage #3 founding genome');
  expect(html).toContain('Removed Leaf at (0,1)');
  expect(html).toContain('Added Eye at (2,0)');
  expect(html).toContain('Mouth → Armor');
  expect(html).toContain('→');
  expect(html).toContain('0.7');
  expect(html).toContain('food chase');
  expect(html).toContain('remain inactive');
  expect(
    genomeDiff(previous, {
      lineageId: 3,
      relation: 'own-lineage',
      genome: previous,
      status: 'retained',
    }),
  ).toContain('Anatomy unchanged');
  expect(genomeDiff(previous)).toContain('unknown / pruned');
  expect(
    genomeDiff(previous, {
      lineageId: 3,
      relation: 'own-lineage',
      genome: null,
      status: 'legacy-unknown',
    }),
  ).toContain('legacy-unknown');
});

it('follows shortest wrapped motion on both axes, rejects stale identities and leaves ecology and RNG exact', () => {
  const f = fixture(),
    before = f.world.save();
  f.get<HTMLButtonElement>('follow-organism').click();
  f.view.update(f.state(1));
  f.get('follow-organism').focus();
  f.get<HTMLButtonElement>('follow-organism').click();
  expect(f.get('release-follow')).toBe(document.activeElement);
  f.view.followFrame(f.state(1));
  const first = { ...f.camera },
    scale = viewport(f.canvas, f.camera).scale;
  f.organism.x = 0;
  f.organism.y = 0;
  f.view.update(f.state(2));
  f.view.followFrame(f.state(2));
  expect(f.camera.x - first.x).toBeCloseTo(-scale);
  expect(f.camera.y - first.y).toBeCloseTo(-scale);
  const next = { ...f.camera };
  f.view.followFrame(f.state(1));
  f.view.followFrame(f.state(3, 2));
  f.view.followFrame({ ...f.state(3), selected: { ...f.organism, id: 999 } });
  expect(f.camera).toEqual(next);
  const center = point(f.canvas, f.camera, 450, 325);
  expect(center).toEqual({ x: 0, y: 0 });
  f.organism.x = 239;
  f.organism.y = 155;
  f.view.update(f.state(3));
  f.view.followFrame(f.state(3));
  expect(f.camera).toEqual(first);
  expect(f.world.save()).toEqual(before);
  f.get<HTMLButtonElement>('release-follow').click();
  expect(f.get('follow-organism')).toBe(document.activeElement);
  f.view.followFrame(f.state(4));
  expect(f.camera).toEqual(first);
  f.get<HTMLButtonElement>('follow-organism').click();
  f.view.followFrame(f.state(4));
  Object.defineProperties(f.canvas, { clientWidth: { value: 1200 }, clientHeight: { value: 800 } });
  f.view.followFrame(f.state(4));
  expect(point(f.canvas, f.camera, 600, 400)).toEqual({ x: 239, y: 155 });
  f.view.dispose();
  expect(f.get<HTMLButtonElement>('follow-organism').disabled).toBe(true);
});

it('retains only the dead individual last observed summary, clears on replacement and never switches to a survivor', () => {
  const f = fixture();
  f.view.update(f.state(1));
  f.get<HTMLButtonElement>('follow-organism').click();
  f.get('release-follow').focus();
  const dead = { ...f.state(2), selected: null };
  f.view.update(dead);
  expect(f.get('organism-observed').textContent).toContain('Stale');
  expect(f.get('inspector').textContent).toContain(`Organism ${f.organism.id}`);
  expect(f.get('inspector').querySelector('button')).toBeNull();
  expect(f.get('specimen-details').querySelector('summary')).toBe(document.activeElement);
  expect(f.get('follow-status').textContent).toContain('off');
  f.view.followFrame(f.state(3));
  expect(f.camera.wrapped).toBeUndefined();
  f.view.update({ ...dead, replacementId: 2 });
  expect(f.get('organism-observed').textContent).toBe('');
  expect(f.get('inspector').textContent).toContain('Click any organism');
  f.view.update(f.state(3, 2));
  f.get('follow-organism').focus();
  f.view.clear();
  expect(f.get('organism-diff').textContent).toBe('');
  expect(f.get('specimen-details').querySelector('summary')).toBe(document.activeElement);
  f.view.dispose();
});
