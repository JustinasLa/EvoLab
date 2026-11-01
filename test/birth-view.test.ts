import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBirthView } from '../src/birth-view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, positions, type Genome } from '../src/model';
import { MUTATION_CHANNELS, weightedMutation, type MutationChannel } from '../src/mutation';
import { retainedBirthExport, type BirthEvent } from '../src/mutation-evidence';
import { markup } from '../src/view';

const genome = (): Genome => ({
  cells: [
    { x: 0, y: 0, type: 7 },
    { x: 1, y: 0, type: 7 },
  ],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 5,
  behavior: {
    version: 2,
    mode: 'evolved',
    reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
  },
  mutationPropensity: 0.5,
});
function scene(seed = 7, channel?: MutationChannel | 'none', blocked = false) {
  const world = new Ecosystem(
    { ...DEFAULTS, nutrients: 0, climate: 0, mutation: channel ? 0.4 : 0 },
    false,
  );
  if (channel) {
    const policy = weightedMutation();
    for (const k of MUTATION_CHANNELS) policy.weights[k] = k === channel ? 1 : 0;
    world.changeMutationPolicy(policy);
  }
  const parent = world.spawn(genome(), 60, 60)!;
  parent.age = 32;
  parent.energy = 100;
  if (blocked) {
    world.walls.fill(1);
    for (const i of positions(parent)) world.walls[i] = 0;
  }
  world.random.state = seed;
  return { world, parent };
}
const births = (world: Ecosystem) =>
  world.lineageSnapshot().events.filter((e): e is BirthEvent => e.kind === 'reproduction');
let root: HTMLDivElement, view: ReturnType<typeof createBirthView>;
const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
const click = () => get('birth-export').dispatchEvent(new MouseEvent('click'));
const update = (world: Ecosystem, replacement = 1) =>
  view.update(world.lineageSnapshot(), world.tick, replacement);
beforeEach(() => {
  root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  get<HTMLDetailsElement>('lineage-explorer').open = true;
  view = createBirthView(root);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:births');
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  view.dispose();
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('actual reproductive pair viewer', () => {
  it('discloses unknown evidence, preserves paused ecology and keeps native controls stable', () => {
    view.reveal();
    click();
    get('birth-select').dispatchEvent(new Event('change'));
    const { world } = scene();
    update(world);
    expect(get('birth-detail').textContent).toContain('No retained reproductive attempts');
    expect(get('birth-retention').textContent).toContain('earlier births are unknown');
    expect(get<HTMLSelectElement>('birth-select').disabled).toBe(true);
    const before = world.save(),
      select = get('birth-select');
    get('ecosystem-panel').hidden = true;
    world.step();
    update(world);
    expect(get('birth-detail').textContent).toContain('No retained reproductive attempts');
    get('ecosystem-panel').hidden = false;
    get<HTMLDetailsElement>('lineage-explorer').open = false;
    view.reveal();
    get<HTMLDetailsElement>('lineage-explorer').open = true;
    view.reveal();
    expect(get('birth-select')).toBe(select);
    expect(get('birth-detail').textContent).toContain('Clone birth');
    expect(get('birth-detail').textContent).toContain('actual reproductive parent');
    expect(get('birth-detail').textContent).not.toContain('founding genome');
    const after = world.save();
    update(world);
    view.reveal();
    expect(world.save()).toEqual(after);
    expect(world.tick).toBe(before.tick + 1);
  });
  it('shows every changed channel and actual anatomy/numeric/reaction pairs from funded engine births', () => {
    for (const channel of MUTATION_CHANNELS) {
      let shown = false;
      for (let i = 1; i < 80 && !shown; i++) {
        const { world } = scene((i * 2654435761) >>> 0, channel);
        world.step();
        const event = births(world)[0];
        if (event.outcome !== 'born-changed' || !event.channels.includes(channel)) continue;
        const before = world.save();
        update(world, i * 10 + MUTATION_CHANNELS.indexOf(channel));
        expect(get('birth-detail').textContent).toContain('Changed offspring');
        expect(get('birth-detail').textContent).toContain(channel);
        expect(get('birth-detail').textContent).toContain(
          `child organism #${event.childOrganismId}`,
        );
        expect(get('birth-detail').querySelectorAll('svg')).toHaveLength(2);
        expect(get('birth-detail').textContent).toContain('mutation propensity');
        expect(world.save()).toEqual(before);
        shown = true;
      }
      expect(shown).toBe(true);
    }
  });
  it('separates no-op births and failed placements without attributing failed candidates to a child', () => {
    let found = false;
    for (let i = 1; i < 60 && !found; i++) {
      const { world } = scene((i * 2654435761) >>> 0, 'none');
      world.step();
      if (births(world)[0].outcome !== 'born-no-op') continue;
      update(world, i);
      expect(get('birth-detail').textContent).toContain('No-op mutation');
      found = true;
    }
    expect(found).toBe(true);
    const { world } = scene(7, undefined, true);
    world.step();
    update(world, 100);
    expect(get('birth-detail').textContent).toContain('Failed placement');
    expect(get('birth-detail').textContent).toContain('No child genome or inherited delta exists');
    expect(get('birth-detail').querySelectorAll('svg')).toHaveLength(1);
    expect(get('birth-detail').textContent).toContain('Placement attempts: 3');
  });
  it('preserves selection until eviction, discloses the missing pair, resets on replacement and exports only the retained ring', async () => {
    const { world, parent } = scene();
    world.step();
    update(world);
    const selected = get<HTMLSelectElement>('birth-select').value;
    for (let i = 0; i < 520; i++) {
      parent.age = 32;
      parent.energy = 100;
      world.step();
      for (const o of [...world.organisms.values()]) if (o !== parent) world.kill(o, 'manual');
    }
    const before = world.save();
    update(world);
    expect(get<HTMLSelectElement>('birth-select').value).toBe(selected);
    expect(get('birth-detail').textContent).toContain('Selected attempt is unknown / pruned');
    expect(get('birth-retention').textContent).toContain('Events evicted through tick');
    expect(get<HTMLSelectElement>('birth-select').options.length).toBeLessThanOrEqual(513);
    const latest = births(world).at(-1)!;
    get<HTMLSelectElement>('birth-select').value = `${latest.tick}:${latest.parentOrganismId}`;
    get('birth-select').dispatchEvent(new Event('change'));
    expect(get('birth-detail').textContent).toContain(`Tick ${latest.tick}:`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    click();
    click();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual(retainedBirthExport(world.lineageSnapshot(), world.tick));
    expect(JSON.parse(text).window.eventsPruned).toBe(true);
    expect(get('birth-export-status').textContent).toContain('truncation metadata');
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:births');
    click();
    update(world, 2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(get('birth-export-status').textContent).toBe('');
    expect(world.save()).toEqual(before);
    click();
    view.dispose();
    click();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });
  it.each(['create', 'click'])(
    'recovers a %s download failure without leaking a lease or changing the world',
    (fault) => {
      const { world } = scene();
      world.step();
      update(world);
      const before = world.save();
      if (fault === 'create')
        vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
          throw new Error('blocked');
        });
      else
        vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
          throw new Error('blocked');
        });
      click();
      expect(get('birth-export-status').textContent).toContain('failed');
      expect(root.querySelector('a[download]')).toBeNull();
      click();
      expect(get('birth-export-status').textContent).toContain('exported');
      expect(world.save()).toEqual(before);
    },
  );
});
