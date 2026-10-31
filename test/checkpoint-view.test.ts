import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCheckpoints } from '../src/checkpoint-view';
import { checkpointRecord } from '../src/checkpoints';
import { markup } from '../src/view';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS } from '../src/model';
import { libraryHarness } from './fixtures/library';
const world = () => JSON.stringify(new Ecosystem(DEFAULTS).save());
const token = () => checkpointRecord('literal <name>', world());
const settle = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
let native: ReturnType<typeof libraryHarness>,
  root: HTMLElement,
  controller: ReturnType<typeof mountCheckpoints>;
let context: string, capture: ReturnType<typeof vi.fn>, restore: ReturnType<typeof vi.fn>;
const get = <T extends HTMLElement = HTMLElement>(id: string) =>
  root.querySelector<T>('#checkpoint-' + id)!;
const click = async (id: string) => {
  get(id).click();
  await settle();
};
const refresh = () => click('refresh');
beforeEach(() => {
  native = libraryHarness();
  vi.stubGlobal('indexedDB', native.factory);
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  context = 'world1';
  capture = vi.fn(() => true);
  restore = vi.fn(() => true);
  controller = mountCheckpoints(root, { context: () => context, capture, restore });
});
afterEach(() => {
  controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('explicit checkpoint interaction ownership', () => {
  it('requires refresh and valid names, preserves literal names and confirms overwrite/delete/restore', async () => {
    await click('save');
    expect(get('status').textContent).toContain('Refresh first');
    await refresh();
    await click('restore');
    expect(get('status').textContent).toContain('no restorable');
    get<HTMLInputElement>('name').value = ' ';
    await click('save');
    expect(capture).not.toHaveBeenCalled();
    get<HTMLInputElement>('name').value = 'Literal <img>';
    await click('save');
    expect(capture).toHaveBeenCalledOnce();
    await click('refresh');
    expect(get('status').textContent).toContain('busy');
    controller.saved(world());
    await settle();
    expect(get('usage').textContent).toContain('1 / 5');
    expect(get('slot').textContent).toContain('Literal <img>');
    expect(get('slot').querySelector('img')).toBeNull();
    await click('restore');
    expect(get<HTMLDialogElement>('dialog').open).toBe(true);
    await click('cancel');
    expect(restore).not.toHaveBeenCalled();
    await click('restore');
    await click('confirm');
    expect(restore).toHaveBeenCalledWith(world());
    await click('save');
    expect(get('confirm-description').textContent).toContain('Overwrite');
    await click('confirm');
    controller.saved(world());
    await settle();
    expect(get('status').textContent).toContain('saved');
    await click('delete');
    await click('confirm');
    expect(native.values.size).toBe(0);
    expect(get('status').textContent).toContain('deleted');
    await click('confirm');
    expect(get('status').textContent).toContain('expired');
  });
  it('treats corrupt strings including empty strings as occupied and keeps future values read-only', async () => {
    native.values.set(1, '');
    native.values.set(2, '{"version":2}');
    native.values.set('foreign', null);
    await refresh();
    await click('restore');
    expect(get('status').textContent).toContain('no restorable');
    await click('save');
    expect(get('confirm-description').textContent).toContain('corrupt');
    await click('cancel');
    await click('delete');
    await click('confirm');
    expect(native.values.has(1)).toBe(false);
    get<HTMLSelectElement>('slot').value = '2';
    await click('delete');
    expect(get('status').textContent).toContain('read-only');
    for (let i = 3; i <= 6; i++) native.values.set(i, token());
    await refresh();
    expect(get('usage').textContent).toContain('overfull');
  });
  it('rejects changed storage after confirmation without loading or deleting', async () => {
    native.values.set(1, token());
    await refresh();
    await click('restore');
    native.values.set(1, checkpointRecord('changed', world()));
    await click('confirm');
    expect(restore).not.toHaveBeenCalled();
    expect(get('status').textContent).toContain('changed or disappeared');
    await refresh();
    await click('delete');
    native.values.delete(1);
    await click('confirm');
    expect(get('status').textContent).toContain('changed or disappeared');
  });
  it('cancels stale confirmations, pending captures and stale native reads', async () => {
    native.values.set(1, token());
    await refresh();
    await click('restore');
    context = 'world2';
    await click('confirm');
    expect(restore).not.toHaveBeenCalled();
    await click('restore');
    get<HTMLSelectElement>('slot').dispatchEvent(new Event('change'));
    expect(get<HTMLDialogElement>('dialog').open).toBe(false);
    await click('restore');
    get('dialog').dispatchEvent(new Event('cancel'));
    expect(get<HTMLDialogElement>('dialog').open).toBe(false);
    get<HTMLSelectElement>('slot').value = '2';
    await click('save');
    context = 'world3';
    controller.saved(world());
    await settle();
    expect(native.values.has(2)).toBe(false);
    await click('save');
    controller.invalidate();
    expect(get('status').textContent).toContain('cancelled');
    controller.saved(world());
    expect(native.values.has(2)).toBe(false);
    await click('save');
    controller.failed('Native Save rejected');
    expect(get('status').textContent).toBe('Native Save rejected');
    get<HTMLSelectElement>('slot').value = '1';
    await click('restore');
    native.faults.completionStall = 'readonly';
    await click('confirm');
    context = 'world4';
    native.current.releaseCompletion();
    await settle();
    expect(restore).not.toHaveBeenCalled();
  });
  it('handles unavailable Save, malformed native payload, quota, refresh failure and retry', async () => {
    await refresh();
    capture.mockReturnValueOnce(false);
    await click('save');
    expect(get('status').textContent).toContain('not saved');
    await click('save');
    controller.saved('{');
    expect(get('status').textContent).toContain('JSON');
    await click('save');
    native.faults.commitError = 'QuotaExceededError';
    controller.saved(world());
    await settle();
    expect(get('status').textContent).toContain('full');
    expect(native.values.size).toBe(0);
    delete native.faults.commitError;
    await click('save');
    native.faults.requestError = 'SecurityError';
    controller.saved(world());
    await settle();
    expect(get('status').textContent).toContain('unavailable');
    delete native.faults.requestError;
    await refresh();
    await click('save');
    // Commit succeeds, while the following explicit list transaction fails.
    const original = native.connection.transaction.getMockImplementation()!;
    native.connection.transaction.mockImplementation((stores, mode) => {
      if (mode === 'readonly') throw new DOMException('', 'UnknownError');
      return original(stores, mode);
    });
    controller.saved(world());
    await settle();
    expect(native.values.size).toBe(1);
    expect(get('status').textContent).toContain('Complete checkpoint saved. Refresh failed');
    native.connection.transaction.mockImplementation(original);
    await refresh();
    restore.mockReturnValueOnce(false);
    await click('restore');
    await click('confirm');
    expect(get('status').textContent).toContain('active world was retained');
  });
  it('ignores revoked refresh, write and restore deliveries while preserving native ownership', async () => {
    native.values.set(1, token());
    await refresh();
    native.faults.completionStall = 'readonly';
    native.faults.abortThrow = true;
    await refresh();
    native.connection.onversionchange();
    native.current.releaseCompletion();
    await settle();
    expect(get('status').textContent).toContain('Another tab');
    delete native.faults.completionStall;
    await refresh();
    await click('restore');
    native.faults.completionStall = 'readonly';
    await click('confirm');
    native.connection.onclose();
    native.current.releaseCompletion();
    await settle();
    expect(restore).not.toHaveBeenCalled();
    expect(get('status').textContent).toContain('connection closed');
    delete native.faults.completionStall;
    await refresh();
    get<HTMLSelectElement>('slot').value = '2';
    await click('save');
    native.faults.completionStall = 'readwrite';
    controller.saved(world());
    await settle();
    native.connection.onversionchange();
    native.current.releaseCompletion();
    await settle();
    expect(native.values.has(2)).toBe(true);
    expect(get('status').textContent).toContain('Native write committed');
  });
  it('does not admit a capture write after its world context changes during native open', async () => {
    await refresh();
    await click('save');
    await click('save');
    expect(get('status').textContent).toContain('busy');
    controller.saved(world());
    context = 'replacement';
    await settle();
    expect(native.values.size).toBe(0);
  });
  it('suppresses open/operation results after disposal and closes hidden confirmations', async () => {
    const details = root.querySelector<HTMLDetailsElement>('#local-checkpoints')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await settle();
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    native.faults.completionStall = 'readonly';
    native.faults.abortThrow = true;
    await refresh();
    const owner = native.current;
    const before = get('status').textContent;
    controller.dispose();
    owner.releaseCompletion();
    await settle();
    expect(get('status').textContent).toBe(before);
  });
});
