import { afterEach, describe, expect, it, vi } from 'vitest';
import { markup } from '../src/view';
import { createRolesView } from '../src/roles-view';
import { roleScene } from './fixtures/roles';

afterEach(() => document.body.replaceChildren());
describe('accessible measured roles tables', () => {
  it('subscribes on reveal and discloses exact units, coverage, loss and mixed sources', () => {
    const root = document.createElement('main');
    root.innerHTML = markup;
    document.body.append(root);
    const subscribe = vi.fn();
    const view = createRolesView(root, subscribe);
    const panel = root.querySelector<HTMLDetailsElement>('#ecological-roles')!;
    view.reveal();
    expect(subscribe).not.toHaveBeenCalled();
    panel.open = true;
    panel.dispatchEvent(new Event('toggle'));
    expect(root.querySelector('#roles-coverage')!.textContent).toContain(
      'Earlier interactions are unknown',
    );
    const { world, victim } = roleScene();
    world.observeRoles();
    world.step();
    const saved = world.save();
    view.update(world.roleSnapshot());
    expect(root.querySelectorAll('#roles-tables table')).toHaveLength(2);
    expect(root.querySelector('#roles-tables')!.getAttribute('tabindex')).toBe('0');
    expect(root.querySelector('#roles-tables')!.getAttribute('aria-label')).toBe(
      'Measured ecological interaction tables',
    );
    expect(root.querySelectorAll('#roles-tables caption')).toHaveLength(2);
    expect(root.querySelector('#roles-coverage')!.textContent).toContain('Window (0, 1]');
    expect(panel.textContent).toContain(
      'photosynthesis + food consumption (origin unknown) + stinger gain',
    );
    expect(panel.textContent).toContain('Extinct; interaction evidence retained');
    expect(panel.textContent).toContain(`${victim.species} →`);
    expect(root.querySelector('#roles-tables th[scope=row]')).not.toBeNull();
    expect(world.save()).toEqual(saved);
    panel.open = false;
    view.update(undefined);
    expect(root.querySelectorAll('#roles-tables table')).toHaveLength(2);
    panel.open = true;
    view.reveal();
    expect(root.querySelectorAll('#roles-tables table')).toHaveLength(0);
    view.dispose();
    subscribe.mockClear();
    panel.dispatchEvent(new Event('toggle'));
    view.reveal();
    view.update(world.roleSnapshot());
    expect(subscribe).not.toHaveBeenCalled();
    expect(root.querySelectorAll('#roles-tables table')).toHaveLength(0);
  });
});
