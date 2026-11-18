import {
  createRecovery,
  recoveryRecord,
  RECOVERY_CAPACITY,
  RECOVERY_INTERVAL_MS,
  RecoveryError,
  type RecoveryClaim,
  type RecoverySnapshot,
} from './recovery';

export const RECOVERY_PREFERENCE = 'evolab-recovery-capture';

const identity = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * Automatic recovery capture. Captures are complete native Saves requested at
 * worker command boundaries; they never step, pause or restore the world.
 */
export function mountRecovery(
  root: HTMLElement,
  hooks: {
    /** Changes whenever a reset, import or restore replaces the world. */
    context: () => string;
    /** World-state revision of the accepted observation, or null before one exists. */
    revision: () => string | null;
    /** Post one complete Save; false when the worker or controls are busy. */
    capture: () => boolean;
  },
  options: {
    factory?: () => IDBFactory | undefined;
    preferences?: () => Storage | undefined;
    now?: () => number;
    clock?: () => number;
    owner?: string;
  } = {},
) {
  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>('#' + id)!;
  const toggle = get<HTMLInputElement>('recovery-enabled');
  const storage = createRecovery({ factory: options.factory });
  const preferences = (): Storage | undefined =>
    options.preferences ? options.preferences() : globalThis.localStorage;
  const now = options.now ?? (() => performance.now());
  const clock = options.clock ?? (() => Date.now());
  const owner = (options.owner ?? identity()).toLowerCase().slice(0, 36);
  let alive = true,
    enabled = false,
    foreground = 0,
    sampled = now(),
    sequence = 0,
    generations = 0,
    worldContext: string | undefined,
    generation = '';
  type Intent = { context: string; revision: string };
  let inflight: Intent | null = null;
  let captured: Intent | null = null;
  const status = (message: string): void => {
    if (alive) get('recovery-status').textContent = message;
  };
  const describe = (rows: RecoverySnapshot[]): void => {
    const kept = rows.filter((row) => row.world);
    const newest = kept.sort((left, right) => right.savedAt! - left.savedAt!)[0];
    const preserved = rows.filter((row) => row.readonly).length;
    get('recovery-usage').textContent =
      `${kept.length} / ${RECOVERY_CAPACITY} recovery snapshots` +
      (newest
        ? ` · newest tick ${newest.tick} · seed ${newest.seed} · saved ${new Date(newest.savedAt!).toLocaleString()}`
        : '') +
      (preserved ? ` · ${preserved} unsupported preserved read-only` : '') +
      (rows.some((row) => row.problem && !row.readonly) ? ' · corrupt slot replaceable' : '');
  };
  const message = (error: unknown): string =>
    error instanceof RecoveryError ? error.message : 'Recovery storage failed.';
  // Reset, import and restore establish a new capture generation.
  const currentGeneration = (): string => {
    const context = hooks.context();
    if (context !== worldContext) {
      worldContext = context;
      generations++;
      generation = `${owner}-${generations}`;
      captured = null;
    }
    return generation;
  };
  const sample = (): void => {
    const time = now();
    if (enabled && document.visibilityState === 'visible')
      foreground += Math.max(0, time - sampled);
    sampled = time;
  };
  function tick(): void {
    sample();
    if (!enabled || inflight || storage.busy || foreground < RECOVERY_INTERVAL_MS) return;
    currentGeneration();
    const revision = hooks.revision();
    if (revision === null || captured?.revision === revision) return;
    inflight = { context: worldContext!, revision };
    if (hooks.capture()) {
      foreground = 0;
      status('Capturing an automatic recovery snapshot at the next completed tick…');
    } else {
      // Skip instead of queueing; the next one-second check may try again.
      inflight = null;
      status('Recovery capture skipped: the world was busy. Nothing was queued.');
    }
  }
  async function inspect(): Promise<void> {
    try {
      const inspection = await storage.inspect();
      if (!alive) return;
      describe(inspection.rows);
      const preserved = inspection.rows.some((row) => row.readonly);
      status(
        inspection.lease === 'unsupported' || preserved
          ? 'Recovery storage holds unsupported data; it is preserved read-only.'
          : enabled
            ? 'Automatic recovery on. Captures follow 60 s of foreground activity with world changes.'
            : 'Automatic recovery off. Stored recovery snapshots are kept.',
      );
    } catch (error) {
      status(message(error));
    }
  }
  async function persist(intent: Intent, claim: RecoveryClaim, record: string): Promise<void> {
    try {
      const result = await storage.commit(claim, record);
      if (!alive) return;
      captured = intent;
      describe(result.rows);
      const row = result.rows.find((candidate) => candidate.slot === result.slot)!;
      status(
        `Recovery snapshot saved: tick ${row.tick} · seed ${row.seed}. Manual checkpoints were not touched.`,
      );
    } catch (error) {
      status(message(error));
    } finally {
      inflight = null;
    }
  }
  function setEnabled(value: boolean, remember: boolean): void {
    enabled = value;
    toggle.checked = value;
    foreground = 0;
    sampled = now();
    if (!remember) return;
    try {
      preferences()!.setItem(RECOVERY_PREFERENCE, value ? 'on' : 'off');
    } catch {
      status(
        `Automatic recovery ${value ? 'on' : 'off'} for this page only; the preference could not be stored.`,
      );
      return;
    }
    void inspect();
  }
  let remembered: string | null = null;
  try {
    remembered = preferences()!.getItem(RECOVERY_PREFERENCE);
  } catch {
    status('Recovery preference unavailable; automatic recovery is off.');
  }
  setEnabled(remembered === 'on', false);
  if (enabled) void inspect();
  const onToggle = (): void => setEnabled(toggle.checked, true);
  toggle.addEventListener('change', onToggle);
  document.addEventListener('visibilitychange', sample);
  const timer = setInterval(tick, 1000);
  return {
    saved(world: string): void {
      const intent = inflight;
      if (!intent) return;
      if (!alive || intent.context !== hooks.context()) {
        inflight = null;
        status('Recovery capture discarded: the world changed.');
        return;
      }
      const claim: RecoveryClaim = {
        owner,
        generation: currentGeneration(),
        sequence: ++sequence,
        savedAt: Math.max(0, Math.floor(clock())),
      };
      let record: string;
      try {
        record = recoveryRecord(claim, world);
      } catch (error) {
        inflight = null;
        status(message(error));
        return;
      }
      void persist(intent, claim, record);
    },
    failed(reason: string): void {
      if (!inflight) return;
      inflight = null;
      status(`Recovery capture failed; the previous snapshot was kept. ${reason}`.slice(0, 300));
    },
    get enabled(): boolean {
      return enabled;
    },
    dispose(): void {
      alive = false;
      clearInterval(timer);
      toggle.removeEventListener('change', onToggle);
      document.removeEventListener('visibilitychange', sample);
      storage.dispose();
    },
  };
}
