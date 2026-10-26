import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, founder, type Frame, type WorldFileV3 } from '../src/model';
import { markup } from '../src/view';
import { createTelemetryView, eventRate, stressPercent } from '../src/telemetry-view';

let root: HTMLElement, controller: ReturnType<typeof createTelemetryView>, width: number;
const advance = (world: Ecosystem, ticks: number) => {
  for (let tick = 0; tick < ticks; tick++) world.step();
};
const get = <Type extends HTMLElement>(id: string): Type => root.querySelector<Type>(`#${id}`)!;
function choose(id: string, value: string) {
  get<HTMLSelectElement>(id).value = value;
  get(id).dispatchEvent(new Event('change'));
  controller.render();
}
function show(frame: Frame, run = 1) {
  controller.update(frame, run);
  controller.render();
}
function legacy(world: Ecosystem): WorldFileV3 {
  const saved = world.save(),
    { adaptationOriginTick: _origin, ...telemetry } = saved.telemetry;
  return {
    ...saved,
    version: 3,
    telemetry: {
      ...telemetry,
      version: 1,
      samples: telemetry.samples.map(({ adaptation: _adaptation, ...sample }) => sample),
    },
  };
}
beforeEach(() => {
  width = 300;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width,
    height: 180,
    top: 0,
    left: 0,
    right: width,
    bottom: 180,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));
  root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  controller = createTelemetryView(root);
});
afterEach(() => {
  controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bounded model-dependent telemetry presentation', () => {
  it('shows no synthetic initial point and defers hidden sources until reveal', () => {
    const world = new Ecosystem(),
      before = world.save();
    width = 0;
    show(world.frame());
    expect(get('telemetry-plots').children).toHaveLength(0);
    width = 220;
    controller.render();
    expect(get('telemetry-plots').textContent).toContain('No recorded samples yet');
    expect(get('telemetry-plots').textContent).toContain('completed tick 30');
    expect(get('telemetry-plots').querySelector('svg')).toBeNull();
    expect(get<HTMLSelectElement>('telemetry-sample').disabled).toBe(true);
    expect(world.save()).toEqual(before);
  });

  it('uses actual five-tick coverage, exact rates, stock units, a single endpoint, names and headers', () => {
    const saved = new Ecosystem().save();
    const { telemetry: _telemetry, ...ecology } = saved;
    const world = Ecosystem.load(JSON.stringify({ ...ecology, version: 2, tick: 25 }));
    advance(world, 5);
    const frame = world.frame(),
      sample = frame.telemetry.samples[0];
    expect(eventRate(sample, 2)).toBe(12);
    show(frame);
    const plots = root.querySelectorAll<SVGSVGElement>('#telemetry svg');
    expect(plots).toHaveLength(2);
    expect(plots[0].dataset.startTick).toBe('25');
    expect(plots[0].dataset.endTick).toBe('30');
    const mark = plots[0].querySelector('circle')!;
    expect(Number(mark.getAttribute('cx'))).toBe(286);
    expect(plots[0].querySelectorAll('circle')).toHaveLength(1);
    expect(get('telemetry-details').textContent).toContain('5 ticks');
    expect(get('telemetry-details').textContent).toContain('per 30 ticks');
    expect(root.querySelectorAll('th[scope="col"]')).toHaveLength(2);
    expect(root.querySelectorAll('th[scope="row"]').length).toBeGreaterThan(3);
    for (const svg of plots) {
      expect(svg.getAttribute('role')).toBe('img');
      for (const id of svg.getAttribute('aria-labelledby')!.split(' '))
        expect(root.querySelector(`#${id}`)?.textContent).not.toBe('');
      expect(svg.textContent).toContain('Logical tick');
    }
    expect(root.querySelector('path[stroke-dasharray="9 4"]')).not.toBeNull();
    expect(root.querySelector('path[stroke-dasharray="4 3"]')).not.toBeNull();
  });

  it('retains fixed-order six anatomy series and measured energy without diet inference', () => {
    const world = new Ecosystem();
    advance(world, 60);
    const frame = world.frame(),
      before = JSON.stringify(frame);
    show(frame);
    choose('telemetry-view', 'food');
    const groups = [...root.querySelectorAll('[data-series]')].map((group) =>
      group.getAttribute('data-series'),
    );
    expect(groups).toEqual(['Food cells', 'Mouth', 'Leaf', 'Motor', 'Stinger', 'Armor', 'Eye']);
    for (const dash of ['', '9 4', '4 3', '1 4', '9 3 1 3', '9 3 4 3'])
      expect(root.querySelector(`path[stroke-dasharray="${dash}"]`)).not.toBeNull();
    expect(get('telemetry-details').textContent).toContain('anatomy, not measured diet');
    expect(get('telemetry-details').textContent).toContain(
      String(frame.telemetry.samples[1].energy.leavesGained),
    );
    expect(get('telemetry-details').textContent).toContain('Gross sting energy drained');
    expect(JSON.stringify(frame)).toBe(before);
  });

  it('exposes exact bins and honest percentages, distinct normalized means and post-tick semantics', () => {
    const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0 }, false);
    for (const preference of [0, 0.25, 0.5, 0.75, 1]) {
      const organism = world.spawn(
        { cells: [{ x: 0, y: 0, type: 7 }], preference, tolerance: 0.25, tempo: 2 },
        world.organisms.size * 10,
        10,
      )!;
      organism.energy = 100;
    }
    advance(world, 30);
    show(world.frame());
    choose('telemetry-view', 'adaptation');
    expect(root.querySelectorAll('#telemetry svg')).toHaveLength(3);
    expect(root.querySelectorAll('[data-bin]')).toHaveLength(10);
    expect(
      [...root.querySelectorAll('[data-bin]')].map((bar) => Number(bar.getAttribute('data-count'))),
    ).toEqual([1, 0, 1, 0, 0, 1, 0, 1, 0, 1]);
    expect(get('telemetry-details').textContent).toContain('2 / 5 (40.0%)');
    expect(get('telemetry-details').textContent).toContain('[0.9, 1]');
    expect(get('telemetry-details').textContent).toContain('post-tick anchors');
    expect(stressPercent(world.frame().telemetry.samples[0])).toBe(40);
  });

  it('keeps old distributions unknown, empty fractions undefined and null gaps disconnected', () => {
    const world = new Ecosystem(DEFAULTS, false);
    advance(world, 30);
    const restored = Ecosystem.load(JSON.stringify(legacy(world)));
    restored.spawn(founder(0), 50, 50);
    advance(restored, 30);
    restored.kill([...restored.organisms.values()][0], 'manual');
    advance(restored, 30);
    restored.spawn(founder(0), 50, 50);
    advance(restored, 30);
    show(restored.frame());
    choose('telemetry-view', 'adaptation');
    const path = root.querySelector('[data-series="Preference"]')!.previousElementSibling!;
    expect(path.getAttribute('d')!.match(/M/g) ?? []).toHaveLength(2);
    choose('telemetry-sample', '30');
    expect(get('telemetry-details').textContent).toContain('not recorded for tick 30');
    expect(root.querySelectorAll('[data-bin]')).toHaveLength(0);
    choose('telemetry-sample', '90');
    expect(get('telemetry-details').textContent).toContain('stressed fraction undefined');
    expect(root.querySelectorAll('[data-bin]')).toHaveLength(10);
    expect(stressPercent(restored.frame().telemetry.samples[0])).toBeNull();
    expect(stressPercent(restored.frame().telemetry.samples[2])).toBeNull();
  });

  it('coalesces updates, keeps focused native selectors stable, evicts pins and bounds DOM/history', () => {
    const world = new Ecosystem(DEFAULTS, false);
    advance(world, 5400);
    show(world.frame());
    const select = get<HTMLSelectElement>('telemetry-sample'),
      replace = vi.spyOn(get('telemetry-plots'), 'replaceChildren');
    select.focus();
    choose('telemetry-sample', '30');
    expect(document.activeElement).toBe(select);
    replace.mockClear();
    for (let repeat = 0; repeat < 40; repeat++) {
      controller.update(world.frame(), 1);
      controller.render();
    }
    expect(replace).not.toHaveBeenCalled();
    advance(world, 30);
    controller.update(world.frame(), 1);
    controller.update(world.frame(), 1);
    controller.render();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(select.value).toBe('60');
    expect(get('telemetry-status').textContent).toContain(
      'Tick 30 is no longer retained; showing tick 60',
    );
    expect(select.options).toHaveLength(181);
    expect(document.activeElement).toBe(select);
    choose('telemetry-view', 'food');
    expect(root.querySelectorAll('[data-series] [data-tick]')).toHaveLength(1260);
    expect(get('telemetry').querySelectorAll('*').length).toBeLessThan(2000);
    width = 180;
    controller.render();
    expect(get('telemetry-plots').querySelector('svg')!.getAttribute('viewBox')).toBe(
      '0 0 180 180',
    );
    choose('telemetry-sample', 'latest');
    expect(get('telemetry-details').textContent).toContain('Selected sample at tick 5430');
    controller.update(world.frame(), 2);
    controller.render();
    expect(get('telemetry-details').textContent).toContain('Selected sample at tick 5430');
    controller.reset();
    expect(select.value).toBe('latest');
    expect(get<HTMLSelectElement>('telemetry-view').value).toBe('food');
  });

  it('handles sparse extreme ticks with scientific labels and disposes scoped observer/listeners', () => {
    controller.dispose();
    const disconnect = vi.fn();
    let resize: () => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    controller = createTelemetryView(root);
    const { telemetry: _telemetry, ...saved } = new Ecosystem(DEFAULTS, false).save();
    const world = Ecosystem.load(JSON.stringify({ ...saved, version: 2, tick: 999_999_870 }));
    advance(world, 90);
    show(world.frame());
    expect(get('telemetry-plots').querySelector('svg')!.textContent).toContain('999999900');
    resize();
    controller.render();
    choose('telemetry-sample', '999999900');
    advance(world, 30);
    show(world.frame());
    expect(get<HTMLSelectElement>('telemetry-sample').value).toBe('999999900');
    controller.dispose();
    const before = root.innerHTML;
    resize();
    controller.update(world.frame(), 3);
    controller.reset();
    controller.render();
    expect(root.innerHTML).toBe(before);
    expect(disconnect).toHaveBeenCalled();
  });
});
