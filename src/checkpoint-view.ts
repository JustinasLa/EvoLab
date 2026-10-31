import { checkpointRecord, createCheckpoints, type Checkpoint } from './checkpoints';

export function mountCheckpoints(
  root: HTMLElement,
  hooks: { context: () => string; capture: () => boolean; restore: (world: string) => boolean },
) {
  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>('#' + id)!;
  let alive = true,
    working = false,
    generation = 0;
  let rows: Checkpoint[] = [];
  let capture: { entry: Checkpoint; name: string; context: string } | undefined;
  let confirmation:
    | {
        action: 'overwrite' | 'restore' | 'delete';
        entry: Checkpoint;
        name: string;
        context: string;
      }
    | undefined;
  const status = (message: string): void => {
    if (alive) get('checkpoint-status').textContent = message;
  };
  const cancel = (): void => {
    confirmation = undefined;
    get<HTMLDialogElement>('checkpoint-dialog').close();
  };
  const storage = createCheckpoints({
    status,
    invalidated: () => {
      generation++;
      cancel();
      capture = undefined;
      working = false;
    },
  });
  const selected = (): Checkpoint | undefined =>
    rows.find((row) => row.slot === Number(get<HTMLSelectElement>('checkpoint-slot').value));
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : 'Checkpoint operation failed.';
  const busy = (): boolean => {
    if (working || storage.busy || capture || confirmation) {
      status('Checkpoint busy. No action was queued.');
      return true;
    }
    return false;
  };
  async function refresh(outcome = ''): Promise<void> {
    if (busy()) return;
    working = true;
    const owner = generation;
    try {
      const snapshot = await storage.list();
      if (!alive || owner !== generation) return;
      rows = snapshot.rows;
      get('checkpoint-usage').textContent =
        `${snapshot.count} / 5 checkpoints · ${snapshot.bytes.toLocaleString()} bytes in five slots${snapshot.count > 5 ? ' · overfull storage; saves blocked' : ''}`;
      const select = get<HTMLSelectElement>('checkpoint-slot');
      const previous = select.value;
      select.replaceChildren(
        ...rows.map((row) => {
          const option = document.createElement('option');
          option.value = String(row.slot);
          option.textContent = `Slot ${row.slot}: ${row.problem ?? (row.name ? `${row.name} · tick ${row.tick} · seed ${row.seed}` : 'Empty')}`;
          return option;
        }),
      );
      select.value = previous || '1';
      status(outcome || 'Checkpoints refreshed. Restore is explicit; reload starts a fresh world.');
    } catch (error) {
      if (alive && owner === generation)
        status(`${outcome ? outcome + ' Refresh failed: ' : ''}${message(error)}`);
    } finally {
      if (owner === generation) working = false;
    }
  }
  async function write(
    entry: Checkpoint,
    replacement: string | null,
    context?: string,
  ): Promise<void> {
    working = true;
    const owner = generation;
    try {
      await storage.open();
      if (!alive || owner !== generation || (context !== undefined && context !== hooks.context()))
        return;
      await storage.access(entry, replacement);
      if (!alive || owner !== generation) return;
      working = false;
      await refresh(replacement === null ? 'Checkpoint deleted.' : 'Complete checkpoint saved.');
    } catch (error) {
      if (alive && owner === generation) status(message(error));
    } finally {
      if (owner === generation) working = false;
    }
  }
  function requestCapture(entry: Checkpoint, name: string): void {
    capture = { entry, name, context: hooks.context() };
    status('Requesting a complete native world Save…');
    if (!hooks.capture()) {
      capture = undefined;
      status('World Save busy or unavailable. Checkpoint was not saved.');
    }
  }
  function action(action: 'save' | 'restore' | 'delete'): void {
    if (busy()) return;
    const entry = selected();
    if (!entry || entry.readonly) {
      status('Refresh first. Unsupported storage is read-only.');
      return;
    }
    const name = get<HTMLInputElement>('checkpoint-name').value;
    if (action === 'save' && (!name.trim() || name.length > 80)) {
      status('Enter a checkpoint name (1–80 characters).');
      return;
    }
    if (action === 'save' && !entry.token) {
      requestCapture(entry, name);
      return;
    }
    if (!entry.token || (action === 'restore' && !entry.world)) {
      status('This slot has no restorable checkpoint.');
      return;
    }
    confirmation = {
      action: action === 'save' ? 'overwrite' : action,
      entry: { ...entry },
      name,
      context: hooks.context(),
    };
    get('checkpoint-confirm-description').textContent =
      `${action === 'save' ? 'Overwrite' : action === 'restore' ? 'Restore' : 'Delete'} slot ${entry.slot}: ${entry.name ?? 'corrupt checkpoint'}${entry.tick === undefined ? '' : ` · tick ${entry.tick} · seed ${entry.seed}`}? ${action === 'restore' ? 'The active world will be replaced only after complete validation. Playback follows Pause on extinction, as with file import. Camera is unchanged.' : 'Existing checkpoint bytes will be lost. This cannot be undone.'} The live world may continue while this dialog is open.`;
    get<HTMLDialogElement>('checkpoint-dialog').showModal();
    get('checkpoint-cancel').focus();
  }
  async function confirm(): Promise<void> {
    const intent = confirmation;
    cancel();
    if (!intent || intent.context !== hooks.context()) {
      status('Confirmation expired: the world changed.');
      return;
    }
    if (intent.action === 'overwrite') {
      requestCapture(intent.entry, intent.name);
      return;
    }
    if (intent.action === 'delete') {
      await write(intent.entry, null);
      return;
    }
    working = true;
    const owner = generation;
    try {
      const current = await storage.access(intent.entry);
      if (!alive || owner !== generation || intent.context !== hooks.context()) return;
      status(
        current.world && hooks.restore(current.world)
          ? 'Restore requested. The worker validates the complete world before replacement.'
          : 'Restore unavailable. The active world was retained.',
      );
    } catch (error) {
      if (alive && owner === generation) status(message(error));
    } finally {
      if (owner === generation) working = false;
    }
  }
  const cleanups: (() => void)[] = [];
  function listen(id: string, event: string, handler: () => void): void {
    const element = get(id);
    element.addEventListener(event, handler);
    cleanups.push(() => element.removeEventListener(event, handler));
  }
  listen('checkpoint-refresh', 'click', () => void refresh());
  listen('local-checkpoints', 'toggle', () => {
    if (get<HTMLDetailsElement>('local-checkpoints').open) void refresh();
    else cancel();
  });
  for (const type of ['save', 'restore', 'delete'] as const)
    listen('checkpoint-' + type, 'click', () => action(type));
  listen('checkpoint-slot', 'change', cancel);
  listen('checkpoint-cancel', 'click', cancel);
  listen('checkpoint-dialog', 'cancel', cancel);
  listen('checkpoint-confirm', 'click', () => void confirm());
  return {
    saved(world: string): void {
      const intent = capture;
      capture = undefined;
      if (!intent || intent.context !== hooks.context()) {
        status('Checkpoint capture cancelled: the world changed.');
        return;
      }
      try {
        void write(intent.entry, checkpointRecord(intent.name, world), intent.context);
      } catch (error) {
        status(message(error));
      }
    },
    failed(message: string): void {
      capture = undefined;
      status(message);
    },
    invalidate(): void {
      cancel();
      if (capture) {
        capture = undefined;
        status('Checkpoint capture cancelled: the world changed.');
      }
    },
    dispose(): void {
      alive = false;
      generation++;
      cancel();
      storage.dispose();
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}
