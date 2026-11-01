import { afterEach, describe, expect, it } from 'vitest';
import { mutationControlsMarkup, mountMutationControls } from '../src/mutation-view';
import { weightedMutation, legacyMutation } from '../src/mutation';
import { Ecosystem } from '../src/ecosystem';
import { captureCommand } from '../src/main';
import { DEFAULTS } from '../src/model';
afterEach(() => {
  document.body.innerHTML = '';
});
describe('mutation controls draft and confirmed ownership', () => {
  it('validates and detaches command payloads before admission', () => {
    const policy = weightedMutation(),
      payload = captureCommand({ type: 'mutation-policy', policy }, DEFAULTS);
    policy.weights.add = 0;
    expect(payload).toEqual({ type: 'mutation-policy', policy: weightedMutation() });
    expect(() => captureCommand({ type: 'mutation-policy', policy: {} }, DEFAULTS)).toThrow(
      'Invalid mutation policy',
    );
  });
  it('keeps drafts through observations, replaces them on authoritative change, and disposes listeners', () => {
    document.body.innerHTML = mutationControlsMarkup();
    const world = new Ecosystem(DEFAULTS, false),
      root = document.body;
    const view = mountMutationControls(root, (policy) => world.changeMutationPolicy(policy)),
      get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    view.update(world.mutationPolicy, 1);
    const mode = get<HTMLSelectElement>('mutation-mode'),
      add = get<HTMLInputElement>('mutation-weight-add'),
      status = get('mutation-status');
    expect(add.disabled).toBe(true);
    mode.value = 'weighted';
    mode.dispatchEvent(new Event('change'));
    add.value = '0';
    add.dispatchEvent(new Event('input'));
    expect(status.textContent).toContain('Draft');
    const before = world.save();
    view.update(world.mutationPolicy, 1);
    expect(add.value).toBe('0');
    expect(world.save()).toEqual(before);
    mode.value = 'invalid';
    mode.dispatchEvent(new Event('change'));
    get('mutation-apply').click();
    expect(world.save()).toEqual(before);
    mode.value = 'weighted';
    mode.dispatchEvent(new Event('change'));
    add.value = '';
    add.dispatchEvent(new Event('input'));
    get('mutation-apply').click();
    expect(status.textContent).toContain('whole weights');
    expect(world.save()).toEqual(before);
    add.value = '0';
    add.dispatchEvent(new Event('input'));
    get('mutation-apply').click();
    view.update(world.mutationPolicy, 1);
    expect(status.textContent).toContain('Confirmed policy: Weighted');
    expect(world.tick).toBe(0);
    view.setBusy(true);
    expect(get<HTMLFieldSetElement>('mutation-fields').disabled).toBe(true);
    expect(status.textContent).toContain('Waiting');
    view.setBusy(false);
    add.value = '19';
    add.dispatchEvent(new Event('input'));
    view.update(world.mutationPolicy, 2);
    expect(add.value).toBe('0');
    world.changeMutationPolicy(legacyMutation());
    view.update(world.mutationPolicy, 2);
    expect(mode.value).toBe('legacy');
    expect(add.disabled).toBe(true);
    view.dispose();
    const final = world.save(),
      text = status.textContent;
    mode.value = 'weighted';
    mode.dispatchEvent(new Event('change'));
    add.value = '10';
    add.dispatchEvent(new Event('input'));
    get('mutation-apply').click();
    expect(status.textContent).toBe(text);
    expect(world.save()).toEqual(final);
  });
});
