import { COLORS, HEIGHT, WIDTH, integer } from './model';
import type { EventJournal, EventReplay, ReplayResponse } from './event-model';

export const eventMarkup = `<details id="events"><summary>Observed events and replay</summary>
<p>Recording is opt-in and session-only. No pre-recording history is inferred. Observations occur after completed ticks and commands: a lineage must previously be living and then absent; a population drop must lose at least 5 and 25% since the previous observation. First traits cover the six functional cell types and legacy/evolved behavior only, not historical innovations. Within-tick appearances/disappearances can be missed. Events describe observations, not causes.</p>
<p>Limits: 32 events, four replay checkpoint pairs (12 MB total), one working checkpoint (2.5 MB), 120 ticks per replay. Old evidence is evicted, not reconstructed. Every edit seals a new complete checkpoint including its ordered effects; replay never crosses an edit boundary and has no intervening commands. Manual events can therefore have a zero-tick replay. Opening and seeking never edit or advance the sandbox. No restore is offered.</p>
<button id="event-record">Start new recording</button><button id="event-stop" disabled>Stop and clear recording</button>
<p id="event-window">Recording off.</p>
<label for="event-select">Recorded event bookmark</label><select id="event-select" size="5" aria-describedby="event-detail"></select>
<p id="event-detail">No event selected.</p>
<button id="event-open" disabled>Open isolated replay</button><button id="event-cancel" disabled>Cancel replay</button>
<label for="event-tick">Replay logical tick</label><input id="event-tick" type="number" min="0" step="1" value="0" disabled><button id="event-seek" disabled>Seek isolated replay</button>
<p id="event-status" role="status">No replay running.</p><canvas id="event-canvas" width="240" height="156" role="img" aria-label="Isolated replay habitat" hidden></canvas>
</details>`;

export function mountEvents(
  root: HTMLElement,
  hooks: {
    context: () => string;
    record: (enabled: boolean) => boolean;
    request: (eventId: number) => boolean;
  },
  createWorker: () => Worker = () =>
    new Worker(new URL('./event-replay-worker.ts', import.meta.url), { type: 'module' }),
) {
  const controls = new Map(
    [...root.querySelectorAll<HTMLElement>('[id]')].map((element) => [element.id, element]),
  );
  const get = <T extends HTMLElement>(id: string): T => controls.get('event-' + id) as T;
  const select = get<HTMLSelectElement>('select');
  const tick = get<HTMLInputElement>('tick');
  const canvas = get<HTMLCanvasElement>('canvas');
  const disable = (id: string, value: boolean): void => {
    const control = get<HTMLButtonElement | HTMLInputElement>(id);
    if (value && document.activeElement === control) select.focus();
    if (control.disabled !== value) control.disabled = value;
  };
  let journal: EventJournal | undefined;
  let worker: Worker | undefined;
  let evidence: EventReplay | undefined;
  let capture: { context: string; id: number } | undefined;
  let generation = 0,
    alive = true;
  const status = (message: string): void => {
    if (get('status').textContent !== message) get('status').textContent = message;
  };
  const release = (): void => {
    generation++;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      worker = undefined;
    }
    capture = undefined;
    disable('cancel', true);
  };
  const invalidate = (): void => {
    release();
    evidence = undefined;
    canvas.hidden = true;
    disable('tick', true);
    disable('seek', true);
    status('Replay cancelled or invalidated; sandbox unchanged.');
  };
  const detail = (): void => {
    const event = journal?.events.find((event) => event.id === Number(select.value));
    get('detail').textContent = event
      ? `Tick ${event.tick}: ${event.detail} ${event.replay ? 'Complete replay evidence retained.' : 'Exact replay unavailable: evidence evicted or not captured.'}`
      : 'No event selected.';
    disable('open', !event?.replay);
  };
  const fail = (message: string): void => {
    invalidate();
    status(message);
  };
  const launch = (): void => {
    if (!alive || !evidence) return;
    const target = Number(tick.value);
    if (!integer(target, evidence.sourceTick, evidence.endpointTick)) {
      status('Choose a whole tick inside the retained replay window.');
      return;
    }
    release();
    canvas.hidden = true;
    const owner = generation,
      context = hooks.context();
    const current = (): boolean => alive && owner === generation && context === hooks.context();
    try {
      worker = createWorker();
      worker.onerror = worker.onmessageerror = () => {
        if (current()) fail('Event replay worker failed; no reconstruction shown.');
      };
      worker.onmessage = ({ data }: MessageEvent<ReplayResponse>) => {
        if (!current()) return;
        if (data.type === 'error') fail(data.message);
        else if (data.type === 'progress') {
          status(`Verifying replay tick ${data.tick} / ${data.endpointTick}; sandbox unchanged.`);
          try {
            worker!.postMessage({ type: 'ack' });
          } catch {
            fail('Replay acknowledgement failed.');
          }
        } else {
          release();
          const drawing = canvas.getContext('2d')!;
          for (let position = 0; position < WIDTH * HEIGHT; position++) {
            drawing.fillStyle = COLORS[data.cells[position]];
            drawing.fillRect(position % WIDTH, Math.floor(position / WIDTH), 1, 1);
          }
          canvas.hidden = false;
          canvas.setAttribute(
            'aria-label',
            `Isolated replay tick ${data.tick}, population ${data.population}`,
          );
          status(
            `Verified original complete endpoint. Viewing tick ${data.tick}, population ${data.population}; sandbox unchanged. Same-runtime rules only.`,
          );
        }
      };
      disable('cancel', false);
      status('Replaying in isolation; verifying the complete original endpoint before display.');
      worker.postMessage({ type: 'start', evidence, tick: target });
    } catch {
      fail('Could not start isolated event replay.');
    }
  };
  const listeners: (() => void)[] = [];
  const listen = (id: string, callback: () => void, event = 'click'): void => {
    get(id).addEventListener(event, callback);
    listeners.push(() => get(id).removeEventListener(event, callback));
  };
  for (const enabled of [true, false])
    listen(enabled ? 'record' : 'stop', () => {
      invalidate();
      if (!hooks.record(enabled)) status('Recording control busy or unavailable; nothing queued.');
    });
  listen(
    'select',
    () => {
      invalidate();
      detail();
    },
    'change',
  );
  listen('cancel', invalidate);
  listen('seek', launch);
  listen('open', () => {
    invalidate();
    const id = Number(select.value);
    capture = { id, context: hooks.context() };
    disable('cancel', false);
    if (!hooks.request(id)) fail('Event evidence busy or unavailable; retry explicitly.');
  });
  return {
    update(next: EventJournal | undefined) {
      if (!journal && !next) return;
      journal = next;
      disable('stop', !next);
      get('window').textContent = next
        ? `Recording since tick ${next.originTick}; observed tick ${next.tick}. ${next.evicted} journal entries and ${next.evidenceEvicted} checkpoint pairs evicted. ${next.problem}`
        : 'Recording off; no earlier history retained.';
      const selected = select.value;
      const signature =
        next?.events
          .map((event) => `${event.id}:${event.tick}:${event.kind}:${event.replay}`)
          .join(',') ?? '';
      if (select.dataset.signature !== signature) {
        select.dataset.signature = signature;
        select.replaceChildren(
          ...(next?.events ?? []).map(
            (event) =>
              new Option(`Tick ${event.tick} · ${event.kind} · #${event.id}`, String(event.id)),
          ),
        );
        if ([...select.options].some((option) => option.value === selected))
          select.value = selected;
        else if (select.options.length) select.selectedIndex = 0;
        if (selected && selected !== select.value) invalidate();
      }
      detail();
    },
    received(value: EventReplay) {
      if (!alive || !capture || capture.context !== hooks.context()) return;
      evidence = value;
      tick.min = String(value.sourceTick);
      tick.max = tick.value = String(value.endpointTick);
      disable('tick', false);
      disable('seek', false);
      launch();
    },
    failed: fail,
    invalidate,
    dispose() {
      invalidate();
      alive = false;
      for (const remove of listeners) remove();
    },
  };
}
