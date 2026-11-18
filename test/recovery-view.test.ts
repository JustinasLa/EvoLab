import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountRecovery, RECOVERY_PREFERENCE } from '../src/recovery-view';
import { classifyRecovery, leaseRecord, RECOVERY_INTERVAL_MS } from '../src/recovery';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS } from '../src/model';
import { libraryHarness as harness } from './fixtures/library';

const world = (ticks: number) => {
  const source = new Ecosystem(DEFAULTS);
  for (let tick = 0; tick < ticks; tick++) source.step();
  return JSON.stringify(source.save());
};
const settle = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
let root: HTMLElement;
let time = 0;
let visibility: DocumentVisibilityState = 'visible';
function memoryStorage(values = new Map<string, string>()) {
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } as unknown as Storage,
  };
}
function setup(
  options: {
    preference?: string;
    preferences?: () => Storage | undefined;
    native?: ReturnType<typeof harness>;
    owner?: string;
  } = {},
) {
  const native = options.native ?? harness();
  const memory = memoryStorage();
  if (options.preference) memory.values.set(RECOVERY_PREFERENCE, options.preference);
  const state = { context: 'world-1', revision: '1:1:0' as string | null, accept: true };
  const capture = vi.fn(() => state.accept);
  const recovery = mountRecovery(
    root,
    {
      context: () => state.context,
      revision: () => state.revision,
      capture,
    },
    {
      factory: () => native.factory,
      preferences: options.preferences ?? (() => memory.storage),
      now: () => time,
      clock: () => 1_700_000_000_000 + time,
      owner: options.owner ?? 'tab-one',
    },
  );
  const toggle = root.querySelector<HTMLInputElement>('#recovery-enabled')!;
  const enable = (value = true) => {
    toggle.checked = value;
    toggle.dispatchEvent(new Event('change'));
  };
  const status = () => root.querySelector('#recovery-status')!.textContent!;
  const usage = () => root.querySelector('#recovery-usage')!.textContent!;
  const elapse = async (ms: number) => {
    time += ms;
    await vi.advanceTimersByTimeAsync(1000);
  };
  return { native, memory, state, capture, recovery, enable, status, usage, elapse, toggle };
}
beforeEach(() => {
  vi.useFakeTimers();
  time = 0;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  root = document.createElement('div');
  root.innerHTML =
    '<input id="recovery-enabled" type="checkbox"><p id="recovery-usage"></p><p id="recovery-status"></p>';
  document.body.append(root);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('automatic recovery capture', () => {
  it('stays off until enabled explicitly, then remembers the choice locally', async () => {
    const view = setup();
    expect(view.toggle.checked).toBe(false);
    await view.elapse(RECOVERY_INTERVAL_MS * 2);
    expect(view.capture).not.toHaveBeenCalled();
    view.enable();
    expect(view.memory.values.get(RECOVERY_PREFERENCE)).toBe('on');
    await settle();
    expect(view.status()).toContain('Automatic recovery on');
    expect(view.usage()).toBe('0 / 2 recovery snapshots');
    view.enable(false);
    expect(view.memory.values.get(RECOVERY_PREFERENCE)).toBe('off');
    await settle();
    expect(view.status()).toContain('off');
    expect(view.recovery.enabled).toBe(false);
    view.recovery.dispose();
    const remembered = setup({ preference: 'on' });
    expect(remembered.toggle.checked).toBe(true);
    expect(remembered.recovery.enabled).toBe(true);
    remembered.recovery.dispose();
  });
  it('captures at most once per 60 s of foreground activity and only when the world changed', async () => {
    const view = setup({ preference: 'on' });
    await view.elapse(RECOVERY_INTERVAL_MS - 1);
    expect(view.capture).not.toHaveBeenCalled();
    await view.elapse(1);
    expect(view.capture).toHaveBeenCalledTimes(1);
    expect(view.status()).toContain('next completed tick');
    // Overlapping callbacks are skipped while one capture is in flight.
    await view.elapse(RECOVERY_INTERVAL_MS * 2);
    expect(view.capture).toHaveBeenCalledTimes(1);
    view.recovery.saved(world(2));
    await settle();
    expect(view.status()).toContain('Recovery snapshot saved: tick 2');
    expect(view.status()).toContain('Manual checkpoints were not touched');
    expect(view.usage()).toContain('1 / 2 recovery snapshots · newest tick 2');
    const first = classifyRecovery(1, view.native.values.get(1));
    expect(first).toMatchObject({ owner: 'tab-one', generation: 'tab-one-1', sequence: 1 });
    // A completion that nobody requested is ignored.
    view.recovery.saved(world(3));
    view.recovery.failed('ignored');
    await settle();
    expect(view.native.values.has(2)).toBe(false);
    // Unchanged world: no capture even after more foreground time.
    await view.elapse(RECOVERY_INTERVAL_MS * 3);
    expect(view.capture).toHaveBeenCalledTimes(1);
    view.state.revision = '1:2:1';
    await view.elapse(0);
    expect(view.capture).toHaveBeenCalledTimes(2);
    view.recovery.saved(world(4));
    await settle();
    // No foreground time has accrued since the last capture.
    view.state.revision = '1:3:2';
    await view.elapse(RECOVERY_INTERVAL_MS / 2);
    expect(view.capture).toHaveBeenCalledTimes(2);
    // Hidden time does not count as foreground activity.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await view.elapse(RECOVERY_INTERVAL_MS * 10);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(view.capture).toHaveBeenCalledTimes(2);
    await view.elapse(RECOVERY_INTERVAL_MS / 2);
    expect(view.capture).toHaveBeenCalledTimes(3);
    view.recovery.saved(world(5));
    await settle();
    expect(view.native.values.size).toBe(3);
    expect(classifyRecovery(1, view.native.values.get(1)).sequence).toBe(3);
    expect(classifyRecovery(2, view.native.values.get(2)).sequence).toBe(2);
    view.recovery.dispose();
  });
  it('skips instead of queueing when the world is busy, and waits for an accepted observation', async () => {
    const view = setup({ preference: 'on' });
    view.state.revision = null;
    await view.elapse(RECOVERY_INTERVAL_MS);
    expect(view.capture).not.toHaveBeenCalled();
    view.state.revision = '1:1:0';
    view.state.accept = false;
    await view.elapse(0);
    expect(view.capture).toHaveBeenCalledTimes(1);
    expect(view.status()).toContain('skipped');
    view.state.accept = true;
    await view.elapse(0);
    expect(view.capture).toHaveBeenCalledTimes(2);
    view.recovery.failed('World file exceeds 2.5 MB. Nothing was downloaded.');
    expect(view.status()).toContain('previous snapshot was kept');
    expect(view.status()).toContain('2.5 MB');
    view.recovery.dispose();
  });
  it('starts a new generation for reset or imported worlds and discards old-world completions', async () => {
    const view = setup({ preference: 'on' });
    await view.elapse(RECOVERY_INTERVAL_MS);
    view.recovery.saved(world(1));
    await settle();
    // The same revision string in a new world is still a change.
    view.state.context = 'world-2';
    await view.elapse(RECOVERY_INTERVAL_MS);
    expect(view.capture).toHaveBeenCalledTimes(2);
    view.state.context = 'world-3';
    view.recovery.saved(world(2));
    expect(view.status()).toContain('discarded');
    await view.elapse(RECOVERY_INTERVAL_MS);
    view.recovery.saved(world(3));
    await settle();
    expect(classifyRecovery(2, view.native.values.get(2))).toMatchObject({
      generation: 'tab-one-3',
      sequence: 2,
      tick: 3,
    });
    view.recovery.dispose();
  });
  it('reports invalid worlds, owned leases and failed storage while retrying on later intervals', async () => {
    const native = harness();
    native.values.set(
      'lease',
      leaseRecord({
        owner: 'other-tab',
        generation: 'other-tab-1',
        sequence: 1,
        savedAt: 1_700_000_000_000 + RECOVERY_INTERVAL_MS,
      }),
    );
    const view = setup({ preference: 'on', native });
    await settle();
    await view.elapse(RECOVERY_INTERVAL_MS);
    view.recovery.saved('{}');
    expect(view.status()).toContain('lacks complete world metadata');
    view.state.revision = '1:2:0';
    await view.elapse(RECOVERY_INTERVAL_MS);
    view.recovery.saved(world(1));
    await settle();
    expect(view.status()).toContain('Another EvoLab tab owns automatic recovery');
    expect(native.values.size).toBe(1);
    // The failed capture did not mark the revision captured, so the next interval retries.
    native.faults.requestError = 'QuotaExceededError';
    time += 200_000;
    await view.elapse(RECOVERY_INTERVAL_MS);
    expect(view.capture).toHaveBeenCalledTimes(3);
    view.recovery.saved(world(1));
    await settle();
    expect(view.status()).toContain('Recovery storage is full');
    delete native.faults.requestError;
    await view.elapse(RECOVERY_INTERVAL_MS);
    view.recovery.saved(world(1));
    await settle();
    expect(view.status()).toContain('Recovery snapshot saved');
    view.recovery.dispose();
  });
  it('describes preserved unsupported records and reports unavailable storage on inspection', async () => {
    const native = harness();
    native.values.set(1, '{"format":"evolab-recovery","version":2}');
    native.values.set(2, '{');
    const view = setup({ preference: 'on', native });
    await settle();
    expect(view.usage()).toContain('1 unsupported preserved read-only');
    expect(view.usage()).toContain('corrupt slot replaceable');
    expect(view.status()).toContain('preserved read-only');
    view.recovery.dispose();
    const missing = harness();
    missing.faults.openError = 'SecurityError';
    const blocked = setup({ preference: 'on', native: missing });
    await settle();
    expect(blocked.status()).toContain('unavailable');
    blocked.recovery.dispose();
  });
  it('keeps working for this page when local preferences are blocked', async () => {
    const view = setup({
      preferences: () => {
        throw new DOMException('', 'SecurityError');
      },
    });
    expect(view.status()).toContain('preference unavailable');
    view.enable();
    expect(view.status()).toContain('for this page only');
    expect(view.recovery.enabled).toBe(true);
    await view.elapse(RECOVERY_INTERVAL_MS);
    expect(view.capture).toHaveBeenCalledTimes(1);
    view.recovery.dispose();
    // After disposal, late completions and the timer are inert.
    view.recovery.saved(world(1));
    await view.elapse(RECOVERY_INTERVAL_MS);
    expect(view.capture).toHaveBeenCalledTimes(1);
  });
  it('drops results that settle after disposal', async () => {
    const view = setup({ preference: 'on' });
    await view.elapse(RECOVERY_INTERVAL_MS);
    view.recovery.saved(world(1));
    view.recovery.dispose();
    await settle();
    expect(view.status()).toContain('next completed tick');
    root.querySelector('#recovery-usage')!.textContent = '';
    const inspecting = setup({ preference: 'on' });
    inspecting.recovery.dispose();
    await settle();
    expect(inspecting.usage()).toBe('');
  });
  it('generates its own lowercase owner identity when none is supplied', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '0A1B2C3D-0000-4000-8000-000000000000' as any,
    );
    const recovery = mountRecovery(root, {
      context: () => '',
      revision: () => null,
      capture: () => false,
    });
    recovery.dispose();
    expect(globalThis.crypto.randomUUID).toHaveBeenCalled();
  });
});
