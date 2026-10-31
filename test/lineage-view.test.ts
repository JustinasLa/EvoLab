import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineageView } from '../src/lineage-view';
import { markup } from '../src/view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, type LineagePresentation } from '../src/model';
import { admissionGenome, sameTickLineages, readmittedParentOrder } from './fixtures/lineage';
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
  view.update(world.presentation().lineage, world.tick, replacement);
}

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  changed = vi.fn();
  view = createLineageView(root, changed);
});

describe('bounded retained lineage evidence', () => {
  it('handles controls before data and an empty archive without fabricated events', () => {
    search('');
    const world = fresh();
    update(world);
    expect(get('lineage-results').textContent).toContain('No retained lineages');
    expect(get('lineage-rows').children).toHaveLength(0);
    expect(get<HTMLButtonElement>('lineage-clear').disabled).toBe(true);
    expect(view.highlighted(world.presentation().lineage).size).toBe(0);
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
    expect([...view.highlighted(world.presentation().lineage)]).toEqual([parent.id, clone.id]);
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
        ...world.presentation().lineage,
        current: [
          {
            ...world.presentation().lineage.current[0],
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
    expect(view.highlighted(world.presentation().lineage).size).toBe(1);
    advance(world, 1);
    update(world, 2);
    expect(get('lineage-detail').textContent).toContain('Select a lineage');
    expect(view.highlighted(world.presentation().lineage).size).toBe(0);
  });
});
