import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineageView } from '../src/lineage-view';
import { markup } from '../src/view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, encodeLegacyValue, type LineagePresentation } from '../src/model';
import {
  admissionGenome,
  sameTickLineages,
  readmittedParentOrder,
  relationshipEviction,
  paginationEviction,
} from './fixtures/lineage';
import { legacyV7, advance } from './fixtures/telemetry';

let root: HTMLDivElement;
let changed: ReturnType<typeof vi.fn>;
let view: ReturnType<typeof createLineageView>;
const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
const select = (id: number) =>
  root.querySelector<HTMLButtonElement>(`#lineage-rows [data-lineage-id="${id}"]`)!.click();
function search(value: string) {
  get<HTMLInputElement>('lineage-search').value = value;
  get('lineage-search').dispatchEvent(new Event('input'));
}
const fresh = () => new Ecosystem({ ...DEFAULTS, nutrients: 0, climate: 0, mutation: 0 }, false);
function update(world: Ecosystem, replacement = 1) {
  view.update(world.presentation(0, true).lineage!, world.tick, replacement);
}

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.innerHTML = markup;
  root.querySelector<HTMLDetailsElement>('#lineage-explorer')!.open = true;
  document.body.append(root);
  changed = vi.fn();
  view = createLineageView(root, changed);
});

afterEach(() => view.dispose());

describe('bounded retained lineage evidence', () => {
  it('handles controls before data and an empty archive without fabricated events', () => {
    search('');
    view.reveal();
    const world = fresh();
    update(world);
    expect(get('lineage-results').textContent).toContain('No retained lineages');
    expect(get('lineage-rows').children).toHaveLength(0);
    expect(get<HTMLButtonElement>('lineage-clear').disabled).toBe(true);
    expect(view.highlighted(world.presentation(0, true).lineage!).size).toBe(0);
  });

  it('navigates a real same-tick radiation and extinction without changing ecology', () => {
    const world = fresh();
    const parent = world.spawn(admissionGenome(), 10, 10)!;
    const clone = world.spawn(admissionGenome(), 12, 10, parent.species, parent)!;
    const body = admissionGenome();
    body.preference = 0.6;
    const child = world.spawn(body, 14, 10, undefined, parent)!;
    const before = world.save();
    update(world);
    select(parent.species);
    expect(get('lineage-detail').textContent).toContain('Peak: 2 lifetime');
    expect(get('lineage-detail').textContent).toContain('maximum living');
    expect(get('lineage-detail').textContent).toContain('Retained founding anatomy');
    expect(get('lineage-detail').textContent).toContain(
      `Parent #${parent.species} → child #${child.species}`,
    );
    expect([...view.highlighted(world.presentation(0, true).lineage!)]).toEqual([
      parent.id,
      clone.id,
    ]);
    expect(world.save()).toEqual(before);
    const childLink = get('lineage-detail').querySelector<HTMLButtonElement>(
      `[data-lineage-id="${child.species}"]`,
    )!;
    childLink.focus();
    update(world);
    expect((document.activeElement as HTMLElement).dataset.lineageId).toBe(String(child.species));
    (document.activeElement as HTMLButtonElement).click();
    expect(get('lineage-detail').textContent).toContain(`Lineage #${child.species} · Living`);
    expect(document.activeElement).toBe(get('lineage-detail'));
    world.kill(child, 'manual');
    const stale = before.organisms;
    update(world);
    expect(get('lineage-detail').textContent).toContain('Extinct');
    expect(get('lineage-detail').textContent).toContain('Generation: unknown (not archived)');
    expect(get('lineage-detail').textContent).toContain(
      `Tick 0: Extinction of lineage #${child.species}`,
    );
    expect(
      view.highlighted({
        ...world.presentation(0, true).lineage!,
        current: [
          {
            ...world.presentation(0, true).lineage!.current[0],
            id: child.species,
            organismIds: stale.map((o) => o.id),
          },
        ],
      }).size,
    ).toBe(0);
    get('lineage-clear').click();
    expect(get('lineage-detail').textContent).toContain('Select a lineage');
    expect(changed).toHaveBeenCalled();
  });

  it('retains pressed navigation and timeline scroll while real observations change', () => {
    const world = fresh();
    const parent = world.spawn(admissionGenome(), 10, 10)!;
    const child = world.spawn(admissionGenome(), 12, 10, undefined, parent)!;
    update(world);
    select(parent.species);
    const row = get('lineage-rows').querySelector<HTMLButtonElement>(
      `[data-lineage-id="${child.species}"]`,
    )!;
    const relation = get('lineage-detail').querySelector<HTMLButtonElement>(
      `[data-lineage-id="${child.species}"]`,
    )!;
    const timeline = get('lineage-detail').querySelector<HTMLOListElement>('.lineage-timeline')!;
    timeline.scrollTop = 80;
    row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    advance(world, 1);
    const nextChild = world.spawn(admissionGenome(), 14, 10, undefined, parent)!;
    update(world);
    expect(get('lineage-rows').querySelector(`[data-lineage-id="${child.species}"]`)).toBe(row);
    expect(get('lineage-detail').querySelector(`[data-lineage-id="${child.species}"]`)).toBe(
      relation,
    );
    expect(get('lineage-detail').querySelector('.lineage-timeline')).toBe(timeline);
    expect(timeline.scrollTop).toBe(80);
    expect(timeline.textContent).not.toContain(`child #${nextChild.species}`);
    expect(get('lineage-observed').textContent).toContain('Observed at tick 1');
    row.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    row.click();
    expect(get('lineage-detail').textContent).toContain(`Lineage #${child.species} · Living`);
    expect(document.activeElement).toBe(get('lineage-detail'));
  });

  for (const finish of ['release', 'cancel', 'blur', 'dispose', 'replacement'] as const) {
    it(`defers eviction layout through native pointer ownership until ${finish}`, async () => {
      const { world, parent, extinct, retained } = relationshipEviction();
      update(world);
      search(String(parent.species));
      select(parent.species);
      const detail = get('lineage-detail');
      const expired = detail.querySelector(`[data-lineage-id="${extinct.species}"]`)!;
      const target = detail.querySelector<HTMLButtonElement>(
        `[data-lineage-id="${retained.species}"]`,
      )!;
      const pointer = (type: string, id: number) =>
        Object.assign(new MouseEvent(type, { bubbles: true }), { pointerId: id });
      target.dispatchEvent(pointer('pointerdown', 1));
      target.dispatchEvent(pointer('pointerdown', 2));
      world.step();
      update(world);
      expect(expired.isConnected).toBe(true);
      expect(get('lineage-observed').textContent).toContain('Observed at tick 1');
      window.dispatchEvent(pointer('pointerup', 1));
      window.dispatchEvent(pointer('pointerup', 99));
      expect(expired.isConnected).toBe(true);
      if (finish === 'blur') window.dispatchEvent(new Event('blur'));
      else if (finish === 'replacement') update(fresh(), 2);
      else {
        window.dispatchEvent(pointer(finish === 'cancel' ? 'pointercancel' : 'pointerup', 2));
        // A second terminal before the timer runs must not enqueue duplicate refreshes.
        window.dispatchEvent(pointer('pointerup', 2));
        if (finish === 'dispose') view.dispose();
      }
      if (finish !== 'replacement') expect(expired.isConnected).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(expired.isConnected).toBe(finish === 'dispose');
      if (finish === 'replacement')
        expect(get('lineage-detail').textContent).toContain('Select a lineage');
      else if (finish !== 'dispose')
        expect(detail.querySelector(`[data-lineage-id="${retained.species}"]`)).toBe(target);
    });
  }

  it('keeps focused relationship controls stable when a preceding child becomes extinct', () => {
    const world = fresh();
    const parent = world.spawn(admissionGenome(), 10, 10)!;
    const first = world.spawn(admissionGenome(), 12, 10, undefined, parent)!;
    const second = world.spawn(admissionGenome(), 14, 10, undefined, parent)!;
    update(world);
    select(parent.species);
    const target = get('lineage-detail').querySelector<HTMLButtonElement>(
      `[data-lineage-id="${second.species}"]`,
    )!;
    const relation = target.parentElement!.parentElement!;
    target.focus();
    world.kill(first, 'manual');
    update(world);
    expect(target.parentElement!.parentElement).toBe(relation);
    expect(document.activeElement).toBe(target);
    expect(
      [...relation.querySelectorAll('button')].map((button) => Number(button.dataset.lineageId)),
    ).toEqual([first.species, second.species]);
    target.click();
    expect(get('lineage-detail').textContent).toContain(`Lineage #${second.species} · Living`);
  });

  for (const fixture of ['relationship', 'pagination'] as const) {
    it(`validates complete native ${fixture} fixture continuation at its eviction boundary`, () => {
      const world =
        fixture === 'relationship' ? relationshipEviction().world : paginationEviction();
      const before = world.save();
      const restored = Ecosystem.load(JSON.stringify(before));
      expect(restored.save()).toEqual(before);
      world.step();
      restored.step();
      expect(restored.save()).toEqual(world.save());
      expect(restored.births - before.births).toBe(3);
      expect(restored.save().nextSpecies - before.nextSpecies).toBe(2);
    });
  }

  it('keeps a retained child and separator together when earlier relationship evidence expires', () => {
    const { world, parent, extinct, retained } = relationshipEviction();
    update(world);
    search(String(parent.species));
    select(parent.species);
    const detail = get('lineage-detail');
    expect(detail.querySelector(`[data-lineage-id="${extinct.species}"]`)).not.toBeNull();
    const target = detail.querySelector<HTMLButtonElement>(
      `[data-lineage-id="${retained.species}"]`,
    )!;
    const wrapper = target.parentElement!;
    const separator = wrapper.lastChild;
    target.focus();
    world.step();
    update(world);
    expect(world.lineageSnapshot().events.some((event) => event.id === extinct.species)).toBe(
      false,
    );
    expect(detail.querySelector(`[data-lineage-id="${extinct.species}"]`)).toBeNull();
    expect(target.parentElement).toBe(wrapper);
    expect(wrapper.lastChild).toBe(separator);
    expect(document.activeElement).toBe(target);
  });

  it('returns focus to search when selected evidence and its parent control expire', () => {
    const { world, parent, extinct } = relationshipEviction();
    update(world);
    search(String(extinct.species));
    select(extinct.species);
    get('lineage-detail')
      .querySelector<HTMLButtonElement>(`[data-lineage-id="${parent.species}"]`)!
      .focus();
    world.step();
    update(world);
    expect(get('lineage-detail').textContent).toContain('evidence was pruned');
    expect(document.activeElement).toBe(get('lineage-search'));
  });

  for (const pager of ['previous', 'next'] as const) {
    it(`returns focused ${pager} pagination to search when real eviction removes the last page`, () => {
      const world = paginationEviction();
      update(world);
      search('extinct');
      expect(get('lineage-results').textContent).toContain('41 matching');
      const buttons = root.querySelectorAll<HTMLButtonElement>('.lineage-pages button');
      if (pager === 'previous') buttons[1].click();
      const target = buttons[pager === 'previous' ? 0 : 1];
      expect(target.disabled).toBe(false);
      target.focus();
      world.step();
      update(world);
      expect(get('lineage-results').textContent).toContain('40 matching');
      expect(get('lineage-results').textContent).toContain('showing 1–40');
      expect(target.disabled).toBe(true);
      expect(document.activeElement).toBe(get('lineage-search'));
    });
  }

  it('pages and searches all living IDs beyond the summary ring and preserves focused identity', () => {
    const world = sameTickLineages();
    for (let i = 0; i < 60; i++) world.spawn(admissionGenome(), i, 10);
    update(world);
    expect(get('lineage-rows').children).toHaveLength(40);
    expect(get('lineage-retention').textContent).toContain('Older summaries pruned');
    root.querySelector<HTMLButtonElement>('.lineage-pages button:last-child')!.click();
    expect(get('lineage-results').textContent).toContain('showing 41–80');
    root.querySelector<HTMLButtonElement>('.lineage-pages button:first-child')!.click();
    expect(get('lineage-results').textContent).toContain('showing 1–40');
    search('lineage #5');
    select(5);
    expect(get('lineage-detail').textContent).toContain(
      'Current living representative; founding anatomy unknown / pruned',
    );
    const button = get('lineage-rows').querySelector<HTMLButtonElement>('[data-lineage-id="5"]')!;
    button.focus();
    update(world);
    expect((document.activeElement as HTMLElement).dataset.lineageId).toBe('5');
    search('no such anatomy');
    expect(get('lineage-results').textContent).toBe('No matching lineages.');
    expect(get('lineage-detail').textContent).toContain('Lineage #5');
    search('living');
    expect(get('lineage-results').textContent).toContain('316 matching');
    search('extinct');
    expect(get('lineage-rows').children).toHaveLength(0);
  });

  it('returns Clear selection focus to search without changing the complete world', () => {
    const world = fresh();
    const organism = world.spawn(admissionGenome(), 10, 10)!;
    update(world);
    select(organism.species);
    const before = world.save();
    get('lineage-clear').focus();
    get('lineage-clear').click();
    expect(get<HTMLButtonElement>('lineage-clear').disabled).toBe(true);
    expect(document.activeElement).toBe(get('lineage-search'));
    expect(get('lineage-detail').textContent).toContain('Select a lineage');
    expect(world.save()).toEqual(before);
  });

  it('labels legacy peaks, unknown anatomy and missing ancestry honestly', () => {
    const world = fresh();
    const organism = world.spawn(admissionGenome(), 10, 10)!;
    const legacy = Ecosystem.load(JSON.stringify(legacyV7(world.save())));
    update(legacy);
    select(organism.species);
    expect(get('lineage-detail').textContent).toContain(
      'since archive origin (earlier lifetime peak unknown)',
    );
    expect(get('lineage-detail').textContent).toContain('unknown ancestry');
    expect(get('lineage-detail').textContent).toContain('Creation tick unknown / pruned');
    expect(get('lineage-detail').textContent).toContain('No timeline events retained');
    legacy.kill(legacy.organisms.get(organism.id)!, 'manual');
    update(legacy);
    expect(get('lineage-detail').textContent).toContain('Founding anatomy legacy-unknown');
    expect(get('lineage-detail').textContent).toContain('Preference / tolerance: unknown / pruned');
    expect(get('lineage-rows').textContent).toContain('Unknown anatomy');
  });

  it('retains event-only and pruned ancestor navigation and labels partial event ticks', () => {
    const world = readmittedParentOrder();
    update(world);
    search('lineage #257');
    // The readmitted parent remains evidence even when its founding anatomy is pruned.
    const ids = [...get('lineage-rows').querySelectorAll<HTMLButtonElement>('button')].map(
      (button) => Number(button.dataset.lineageId),
    );
    expect(ids).toContain(257);
    select(257);
    expect(get('lineage-retention').textContent).toContain('Events pruned through tick');
    expect(get('lineage-detail').textContent).toContain('unknown / pruned');
    // Explicit bounded projection of retained event-only evidence tests no-summary display.
    const evidence: LineagePresentation = {
      archive: {
        ...world.lineageSnapshot(),
        living: [],
        summaries: [],
        events: [
          { kind: 'created', id: 900, tick: 10, origin: 'mutation', parentId: 899 },
          { kind: 'extinct', id: 900, tick: 11 },
        ],
      },
      current: [],
    };
    view.update(evidence, 11, 2);
    search('lineage #900');
    select(900);
    expect(get('lineage-detail').textContent).toContain('Peak: unknown');
    expect(get('lineage-detail').textContent).toContain('unknown / pruned ancestor');
    get('lineage-detail').querySelector<HTMLButtonElement>('[data-lineage-id="899"]')!.click();
    expect(get('lineage-detail').textContent).toContain('Unknown / pruned');
    expect(get('lineage-detail').textContent).toContain('Live: unknown');
    expect(get('lineage-detail').textContent).toContain('Origin: unknown / pruned');
    expect(get('lineage-detail').textContent).toContain('Parent #899 → child #900');
    view.update({ ...evidence, archive: { ...evidence.archive, events: [] } }, 11, 2);
    expect(get('lineage-detail').textContent).toContain('evidence was pruned');
    expect(view.highlighted(evidence).size).toBe(0);
  });

  it('clears identity on world replacement even when IDs are reused', () => {
    const world = fresh();
    world.spawn(admissionGenome(), 10, 10);
    update(world);
    select(5);
    expect(view.highlighted(world.presentation(0, true).lineage!).size).toBe(1);
    expect(view.highlighted(world.presentation(0, true).lineage!, 99).size).toBe(0);
    advance(world, 1);
    update(world, 2);
    expect(get('lineage-detail').textContent).toContain('Select a lineage');
    expect(view.highlighted(world.presentation(0, true).lineage!).size).toBe(0);
  });
});

it('projects detached known fields while complete accepted opaque genomes survive inspection', () => {
  const world = fresh();
  const body = admissionGenome();
  body.legacyExtensions = [['opaque', encodeLegacyValue({ nested: ['retained', { count: 3 }] })]];
  const organism = world.spawn(body, 10, 10)!;
  const before = world.save();
  expect(world.presentation().lineage).toBeUndefined();
  const projection = world.presentation(0, true).lineage!;
  expect(projection.current[0].genome.legacyExtensions).toBeUndefined();
  expect(projection.archive.summaries[0].foundingGenome!.legacyExtensions).toBeUndefined();
  expect(before.lineageArchive.summaries[0].foundingGenome!.legacyExtensions).toEqual(
    body.legacyExtensions,
  );
  view.update(projection, world.tick, 1);
  select(organism.species);
  projection.current[0].organismIds.length = 0;
  projection.current[0].genome.preference = 0;
  projection.archive.summaries[0].foundingGenome!.preference = 0;
  expect(world.save()).toEqual(before);
  expect(Ecosystem.load(JSON.stringify(before)).save()).toEqual(before);
});

it('keeps keyboard identity on its page when births arrive and returns focus to search when a status filter removes it', () => {
  const world = sameTickLineages();
  update(world);
  const focused = get('lineage-rows').querySelector<HTMLButtonElement>('button')!;
  const id = Number(focused.dataset.lineageId);
  focused.focus();
  for (let i = 0; i < 40; i++) world.spawn(admissionGenome(), i, 10);
  update(world);
  expect((document.activeElement as HTMLElement).dataset.lineageId).toBe(String(id));
  expect(get('lineage-results').textContent).toContain('showing 41–80');
  search('living');
  get('lineage-rows').querySelector<HTMLButtonElement>('button')!.focus();
  const removed = Number((document.activeElement as HTMLElement).dataset.lineageId);
  world.kill(
    [...world.organisms.values()].find((organism) => organism.species === removed)!,
    'manual',
  );
  update(world);
  expect(document.activeElement).toBe(get('lineage-search'));
});

it('keeps advancing observation ticks outside live search announcements', () => {
  const world = fresh();
  world.spawn(admissionGenome(), 10, 10);
  update(world);
  const status = get('lineage-results');
  const observer = new MutationObserver(() => {});
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  advance(world, 1);
  update(world);
  expect(observer.takeRecords()).toEqual([]);
  expect(status.getAttribute('role')).toBe('status');
  expect(get('lineage-observed').hasAttribute('role')).toBe(false);
  expect(get('lineage-observed').textContent).toBe('Observed at tick 1.');
  observer.disconnect();
});
