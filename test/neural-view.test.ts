import { afterEach, expect, it, vi } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, type ControlState } from '../src/model';
import { newController } from '../src/neural';
import { createNeuralView, neuralHtml } from '../src/neural-view';
import { markup } from '../src/view';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function scene() {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
  const controller = newController();
  controller.weights[0] = -1;
  controller.weights[1] = 1;
  controller.biases[0] = -0;
  const organism = world.spawn({ ...founder(0), tempo: 2, controller }, 60, 60)!;
  world.selectNeural(organism.id, true);
  const root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  const changed = vi.fn();
  const view = createNeuralView(root, changed);
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  get('organism-panel').hidden = false;
  get<HTMLDetailsElement>('specimen-details').open = true;
  get<HTMLDetailsElement>('neural-inspector').open = true;
  const state = (): ControlState =>
    ({
      selected: structuredClone(organism),
      neural: world.neuralObservation(),
      world: world.presentation(organism.id),
      display: { epoch: 3, visible: true, enabled: false, neural: true },
      revision: world.tick,
      replacementId: 1,
    }) as ControlState;
  return { world, organism, root, view, get, state, changed };
}

it('provides an accessible network, exact equivalent tables, bounded history and honest freshness', () => {
  const setup = scene();
  setup.view.update(setup.state(), 3);
  expect(setup.get('neural-data').textContent).toContain('no evaluation captured yet');
  for (let tick = 0; tick < 28; tick++) setup.world.step();
  setup.view.update(setup.state(), 3);
  const region = setup.get('neural-data');
  expect(region.querySelector('svg')!.getAttribute('role')).toBe('img');
  expect(region.querySelectorAll('circle')).toHaveLength(14);
  expect(region.querySelectorAll('line')).toHaveLength(40);
  expect(region.querySelectorAll('circle.chosen')).toHaveLength(1);
  expect(region.querySelectorAll('table')).toHaveLength(3);
  expect(region.querySelectorAll('table')[0].querySelectorAll('tbody tr')).toHaveLength(14);
  expect(region.querySelectorAll('table')[1].querySelectorAll('tbody tr')).toHaveLength(12);
  expect(region.querySelectorAll('table')[2].querySelectorAll('tbody tr')).toHaveLength(40);
  expect(region.textContent).toContain('Pruned');
  expect(region.textContent).toContain('No eyes; four sensory inputs are zero');
  expect(region.textContent).toContain('not causal explanations');
  expect(region.textContent).toContain('not proof');
  expect(region.textContent).toContain('Actual incurred cost');
  expect(region.textContent).toContain('-0');
  region.focus();
  const network = region.querySelector('svg');
  setup.view.update(setup.state(), 3);
  expect(region.querySelector('svg')).toBe(network);
  setup.world.step();
  setup.view.update(setup.state(), 3);
  expect(region.textContent).toContain('stale/historical');
  expect(document.activeElement).toBe(region);
  setup.world.kill(setup.organism, 'manual');
  setup.view.update({ ...setup.state(), selected: null }, 3);
  expect(region.textContent).toContain('selected organism is dead');
  expect(region.textContent).toContain('death');
});

it('rejects old epochs, mismatched identities, pending selection and hidden demand without evaluating', () => {
  const setup = scene();
  const original = setup.world.save();
  setup.view.update(undefined, 3);
  expect(setup.get('neural-data').textContent).toContain('awaiting acknowledgement');
  setup.view.update(setup.state(), 2);
  expect(setup.get('neural-data').textContent).toContain('awaiting acknowledgement');
  setup.view.update({ ...setup.state(), selected: { ...setup.organism, id: 99 } }, 3);
  expect(setup.get('neural-data').textContent).toContain('selection is changing');
  setup.view.update({ ...setup.state(), selected: null }, 3);
  expect(setup.get('neural-data').textContent).toContain('selection is changing');
  setup.view.pendingSelection(true);
  setup.view.update(setup.state(), 3);
  expect(setup.get('neural-data').textContent).toContain('selection is changing');
  setup.view.pendingSelection(false);
  setup.view.update(setup.state(), 3);
  expect(setup.get('neural-data').textContent).toContain('no evaluation captured yet');
  setup.get<HTMLDetailsElement>('neural-inspector').open = false;
  setup.get('neural-inspector').dispatchEvent(new Event('toggle'));
  expect(setup.changed).toHaveBeenCalled();
  expect(setup.view.wanted()).toBe(false);
  setup.view.update(setup.state(), 3);
  expect(setup.get('neural-data').textContent).toContain('capture is off');
  setup.get<HTMLDetailsElement>('neural-inspector').open = true;
  setup.get('neural-inspector').dispatchEvent(new Event('toggle'));
  expect(setup.view.wanted()).toBe(true);
  setup.get('organism-panel').hidden = true;
  expect(setup.view.wanted()).toBe(false);
  setup.get('organism-panel').hidden = false;
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  expect(setup.view.wanted()).toBe(false);
  expect(setup.world.save()).toEqual(original);
  setup.view.dispose();
  expect(setup.root.querySelector('#neural-inspector')).toBeNull();
});

it('labels no selection, non-neural and death before capture without invented activity', () => {
  const setup = scene();
  setup.world.selectNeural(0, true);
  setup.view.update({ ...setup.state(), selected: null }, 3);
  expect(setup.get('neural-data').textContent).toContain('no selected organism');
  const legacy = setup.world.spawn(founder(0), 100, 100)!;
  setup.world.selectNeural(legacy.id, true);
  expect(neuralHtml(setup.world.neuralObservation(), 0)).toContain('no neural controller');
  setup.world.kill(legacy, 'manual');
  expect(neuralHtml(setup.world.neuralObservation(), 0)).toContain('selected organism is dead');
  expect(neuralHtml(setup.world.neuralObservation(), 0)).not.toContain('<svg');
});

it('renders actual rays and measured meals without assigning success to them', () => {
  const setup = scene();
  setup.organism.genome.cells[0].type = 8;
  setup.world.step();
  setup.world.step();
  const observation = setup.world.neuralObservation()!;
  expect(observation.decisions[0].rays.length).toBe(1);
  observation.decisions[0].outcome.lastMealTick = 3;
  observation.decisions[0].outcome.mouthsGained = 2.2;
  const html = neuralHtml(observation, 3);
  expect(html).toContain('Eye 0 at');
  expect(html).toContain('Subsequent mouth gain 2.2; last meal tick 3');
  expect(html).toContain('Not causal attribution');
});
