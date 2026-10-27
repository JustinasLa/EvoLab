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
function show(frame: Frame, run = 1, replacement = run) {
  update(frame, run, replacement);
  controller.render();
}
let revision = 0;
function update(frame: Frame, run = 1, replacement = run): void {
  revision++;
  controller.update({
    status: 'accepted',
    runId: run,
    replacementId: replacement,
    currentTick: frame.stats.tick,
    currentRevision: revision,
    source: {
      runId: run,
      replacementId: replacement,
      revision,
      tick: frame.stats.tick,
      telemetry: frame.telemetry,
      interventions: frame.interventions,
    },
  });
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
  it('distinguishes unknown sources, received empty sources and progress beyond the source boundary', () => {
    controller.update({
      status: 'accepted',
      runId: 1,
      replacementId: 2,
      currentTick: 25,
      currentRevision: 3,
      source: null,
    });
    controller.render();
    expect(get('telemetry-summary').textContent).toContain('history not yet known');
    expect(get<HTMLSelectElement>('telemetry-sample').disabled).toBe(true);
    const source = {
      runId: 1,
      replacementId: 2,
      tick: 25,
      revision: 3,
      telemetry: new Ecosystem(DEFAULTS, false).telemetrySnapshot(),
      interventions: new Ecosystem(DEFAULTS, false).interventionSnapshot(),
    };
    controller.update({
      status: 'accepted',
      runId: 1,
      replacementId: 2,
      currentTick: 26,
      currentRevision: 4,
      source,
    });
    controller.render();
    expect(get('telemetry-plots').textContent).toContain('boundary after this observation is 30');
    const replaced = vi.spyOn(get('telemetry-plots'), 'replaceChildren');
    controller.update({
      status: 'accepted',
      runId: 1,
      replacementId: 2,
      currentTick: 61,
      currentRevision: 5,
      source,
    });
    controller.render();
    expect(get('telemetry-plots').textContent).toContain('reached/passed boundary 30');
    expect(get('telemetry-summary').textContent).toContain(
      'source observed at tick 25 (revision 3)',
    );
    expect(get('telemetry-summary').textContent).toContain('World tick 61 (revision 5)');
    expect(replaced).not.toHaveBeenCalled();
  });
  it('retains focused pin through failed adoption and same-tick progress, resetting once only on successful replacement', () => {
    const world = new Ecosystem(DEFAULTS, false);
    advance(world, 60);
    const source = {
      runId: 1,
      replacementId: 2,
      tick: 60,
      revision: 3,
      telemetry: world.telemetrySnapshot(),
      interventions: world.interventionSnapshot(),
    };
    controller.update({
      status: 'accepted',
      runId: 1,
      replacementId: 2,
      currentTick: 60,
      currentRevision: 3,
      source,
    });
    controller.render();
    choose('telemetry-sample', '30');
    const select = get<HTMLSelectElement>('telemetry-sample');
    select.focus();
    const options = vi.spyOn(select, 'replaceChildren'),
      plots = vi.spyOn(get('telemetry-plots'), 'replaceChildren');
    controller.update({ status: 'pending', commandId: 9 });
    controller.update({
      status: 'accepted',
      runId: 2,
      replacementId: 2,
      currentTick: 61,
      currentRevision: 5,
      source: { ...source, runId: 2 },
    });
    controller.render();
    expect(select.value).toBe('30');
    expect(document.activeElement).toBe(select);
    expect(options).not.toHaveBeenCalled();
    expect(plots).not.toHaveBeenCalled();
    expect(get('telemetry-details').textContent).toContain('Selected sample at tick 30');
    controller.update({
      status: 'accepted',
      runId: 3,
      replacementId: 9,
      currentTick: 60,
      currentRevision: 6,
      source: { ...source, runId: 3, replacementId: 9, revision: 6 },
    });
    controller.render();
    expect(select.value).toBe('latest');
    expect(document.activeElement).toBe(select);
    expect(options).toHaveBeenCalledTimes(1);
    expect(get('telemetry-details').textContent).toContain('Selected sample at tick 60');
  });
  it('presents each real manual kind without inventing samples and redraws same-tick coalesced portions', () => {
    const world = new Ecosystem(DEFAULTS, false),
      paint = (x: number, sequence: number | null = null) =>
        world.recordPaint(world.paint('food', x, 1, 0, founder(0)), 'food', 0, x, 1, sequence);
    const sequence = paint(1)!;
    show(world.frame());
    expect(get('telemetry-intervention-details').textContent).toContain('Successful commands1');
    paint(2, sequence);
    show(world.frame());
    expect(get('telemetry-intervention-details').textContent).toContain('Successful commands2');
    expect(get('telemetry-plots').querySelector('svg')).toBeNull();
    const placement = world.paint('plant', 30, 30, 0, founder(0)).placement!;
    world.appendIntervention({ kind: 'placement', detail: placement });
    show(world.frame());
    expect(get('telemetry-intervention-details').textContent).toContain('not reproductive birth');
    world.changeSettings({ nutrients: 7 });
    show(world.frame());
    expect(get('telemetry-intervention-details').textContent).toContain('5 → 7');
    const before = { offset: world.eventOffset, until: world.eventUntil };
    world.shock('heat');
    world.appendIntervention({
      kind: 'shock',
      detail: {
        kind: 'heat',
        before,
        after: { offset: world.eventOffset, until: world.eventUntil },
      },
    });
    show(world.frame());
    expect(get('telemetry-intervention-details').textContent).toContain('Before stored event');
    choose('telemetry-intervention', '1');
    expect(get('telemetry-status').textContent).toContain('Selected manual action 1');
    choose('telemetry-intervention', 'latest');
    expect(get('telemetry-status').textContent).toContain(
      'Following latest retained manual action',
    );
  });
  it('clips only drawing, discloses before/after/crossing effects and keeps manual and sample pins independent', () => {
    const world = new Ecosystem(DEFAULTS, false),
      sequence = world.recordPaint(
        world.paint('food', 1, 1, 0, founder(0)),
        'food',
        0,
        1,
        1,
        null,
      )!;
    advance(world, 61);
    world.recordPaint(world.paint('food', 2, 1, 0, founder(0)), 'food', 0, 2, 1, sequence);
    world.changeSettings({ nutrients: 7 });
    const before = world.save();
    show(world.frame());
    choose('telemetry-sample', '30');
    choose('telemetry-intervention', '1');
    expect(get<HTMLSelectElement>('telemetry-sample').value).toBe('30');
    expect(get('telemetry-intervention-summary').textContent).toContain('crossing its edges');
    const highlight = root.querySelector('[data-manual-sequence="1"]')!;
    expect(highlight.textContent).toContain('continues beyond edge');
    expect(get('telemetry-intervention-details').textContent).toContain('0–61');
    expect(world.save()).toEqual(before);
    expect(
      [...root.querySelectorAll('svg[data-start-tick]')].every(
        (plot) =>
          plot.getAttribute('data-start-tick') === '30' &&
          plot.getAttribute('data-end-tick') === '60',
      ),
    ).toBe(true);
    show(world.frame(), 2, 1);
    expect(get<HTMLSelectElement>('telemetry-intervention').value).toBe('1');
    controller.update({ status: 'unavailable' });
    show(world.frame(), 2);
    expect(get<HTMLSelectElement>('telemetry-intervention').value).toBe('latest');
  });
  it('draws unselected crossing strokes without inventing clipped-edge anchors or disturbing either pin', () => {
    const world = new Ecosystem(DEFAULTS, false),
      sequence = world.recordPaint(
        world.paint('food', 1, 1, 0, founder(0)),
        'food',
        0,
        1,
        1,
        null,
      )!;
    advance(world, 45);
    world.recordPaint(world.paint('food', 2, 1, 0, founder(0)), 'food', 0, 2, 1, sequence);
    world.changeSettings({ nutrients: 6 });
    advance(world, 16);
    world.changeSettings({ nutrients: 7 });
    const before = JSON.stringify(world.save());
    show(world.frame());
    choose('telemetry-sample', '30');
    for (const selection of ['2', 'latest']) {
      choose('telemetry-intervention', selection);
      get('telemetry-intervention').focus();
      for (const view of ['population', 'food', 'adaptation']) {
        choose('telemetry-view', view);
        expect(document.activeElement).toBe(get('telemetry-intervention'));
        expect(get<HTMLSelectElement>('telemetry-sample').value).toBe('30');
        expect(get<HTMLSelectElement>('telemetry-intervention').value).toBe(selection);
        expect(root.querySelector('[data-manual-sequence="1"]')).toBeNull();
        for (const strip of root.querySelectorAll('.telemetry-manual-strip')) {
          const span = strip.querySelector('[data-first-tick="0"]')!;
          expect(span.getAttribute('data-last-tick')).toBe('45');
          expect(span.getAttribute('data-anchor-tick')).toBe('none');
          expect(span.getAttribute('data-clipped-first-tick')).toBe('30');
          expect(span.getAttribute('data-clipped-last-tick')).toBe('45');
          expect(span.getAttribute('d')).toMatch(/^M50,15H[\d.]+$/);
          expect(span.textContent).toContain('after completed ticks 0–45');
          expect(span.textContent).toContain(
            'clipped for drawing only, continues beyond plotted domain',
          );
          expect(strip.querySelectorAll('.telemetry-manual-density').length).toBeLessThanOrEqual(
            32,
          );
          expect(strip.querySelector('[data-first-tick="61"]')).toBeNull();
        }
        for (const plot of root.querySelectorAll('svg[data-start-tick]')) {
          expect(plot.getAttribute('data-start-tick')).toBe('30');
          expect(plot.getAttribute('data-end-tick')).toBe('60');
        }
        expect(root.querySelectorAll('*').length).toBeLessThan(2000);
      }
    }
    expect(JSON.stringify(world.save())).toBe(before);
  });
  it('bounds128 same-tick markers/options and honestly falls back when a selected sequence is evicted', () => {
    const world = new Ecosystem({ ...DEFAULTS, nutrients: 0 }, false);
    advance(world, 60);
    for (let entry = 0; entry < 128; entry++)
      world.changeSettings({ nutrients: entry % 2 ? 0 : 1 });
    show(world.frame());
    expect(get<HTMLSelectElement>('telemetry-intervention').options).toHaveLength(129);
    const strips = root.querySelectorAll('.telemetry-manual-strip');
    expect(strips.length).toBeGreaterThan(0);
    for (const strip of strips) {
      for (const id of strip.getAttribute('aria-labelledby')!.split(' '))
        expect(root.querySelector(`#${id}`)?.textContent).toBeTruthy();
      expect(strip.querySelectorAll('.telemetry-manual-density')).toHaveLength(1);
      expect(strip.querySelector('[data-count="128"]')!.textContent).toContain('sequences 1–128');
    }
    expect(root.querySelectorAll('*').length).toBeLessThan(2000);
    choose('telemetry-intervention', '1');
    get('telemetry-intervention').focus();
    world.changeSettings({ nutrients: 1 });
    show(world.frame());
    expect(get<HTMLSelectElement>('telemetry-intervention').value).toBe('2');
    expect(get('telemetry-status').textContent).toContain(
      'Manual sequence 1 is no longer retained',
    );
    expect(document.activeElement).toBe(get('telemetry-intervention'));
    expect(get('telemetry-intervention-summary').textContent).toContain(
      '1 evicted through tick 60',
    );
    controller.dispose();
    choose('telemetry-intervention', 'latest');
    expect(get('telemetry-status').textContent).toContain(
      'Manual sequence 1 is no longer retained',
    );
  });
  it('shows no synthetic initial point and defers hidden sources until reveal', () => {
    const world = new Ecosystem(),
      before = world.save();
    width = 0;
    show(world.frame());
    expect(get('telemetry-plots').children).toHaveLength(0);
    width = 220;
    controller.render();
    expect(get('telemetry-plots').textContent).toContain(
      'Received history was empty at source tick',
    );
    expect(get('telemetry-plots').textContent).toContain('observation is 30');
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
    const plots = root.querySelectorAll<SVGSVGElement>('#telemetry svg[data-start-tick]');
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
    expect(root.querySelectorAll('#telemetry svg:not(.telemetry-manual-strip)')).toHaveLength(3);
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
      update(world.frame(), 1);
      controller.render();
    }
    expect(replace).not.toHaveBeenCalled();
    advance(world, 30);
    update(world.frame(), 1);
    update(world.frame(), 1);
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
    update(world.frame(), 2);
    controller.render();
    expect(get('telemetry-details').textContent).toContain('Selected sample at tick 5430');
    controller.update({ status: 'unavailable' });
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
    const replace = vi.spyOn(get('telemetry-plots'), 'replaceChildren');
    resize();
    controller.render();
    expect(replace).not.toHaveBeenCalled();
    width = 250;
    resize();
    resize();
    controller.render();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(get('telemetry-plots').querySelector('svg')!.getAttribute('viewBox')).toBe(
      '0 0 250 180',
    );
    choose('telemetry-sample', '999999900');
    advance(world, 30);
    show(world.frame());
    expect(get<HTMLSelectElement>('telemetry-sample').value).toBe('999999900');
    controller.dispose();
    const before = root.innerHTML;
    width = 200;
    resize();
    update(world.frame(), 3);
    controller.update({ status: 'unavailable' });
    controller.render();
    expect(root.innerHTML).toBe(before);
    expect(disconnect).toHaveBeenCalled();
  });
});
