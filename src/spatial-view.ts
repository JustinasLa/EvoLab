import {
  SPATIAL_BIN_TILES,
  SPATIAL_COMPLETED_WINDOWS,
  SPATIAL_WINDOW_TICKS,
  type SpatialSummary,
} from './spatial';

const energy = (value: number): string => String(Math.round(value * 1000) / 1000);

/** `request` returns the display epoch that carries the new capture choice. */
export function createSpatialView(root: HTMLElement, request: (enabled: boolean) => number) {
  const toggle = root.querySelector<HTMLInputElement>('#spatial-capture')!;
  const status = root.querySelector<HTMLElement>('#spatial-status')!;
  const content = root.querySelector<HTMLElement>('#spatial-windows')!;
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-label', 'Spatial event window totals');
  let summary: SpatialSummary | undefined;
  let requestedEpoch = 0;
  let pending = false;
  let disposed = false;
  function render(): void {
    if (disposed) return;
    if (!toggle.checked) {
      status.textContent = pending
        ? 'Stopping capture; retained spatial evidence will be discarded.'
        : 'Capture off. No spatial evidence is recorded; earlier events are unknown.';
      content.replaceChildren();
      return;
    }
    if (!summary || pending) {
      status.textContent = 'Starting capture at the current world tick…';
      content.replaceChildren();
      return;
    }
    const s = summary;
    const evicted = s.evictedWindows
      ? ` ${s.evictedWindows} older window${s.evictedWindows === 1 ? '' : 's'} evicted; retained evidence starts after tick ${s.evictedThroughTick}.`
      : ' No windows evicted.';
    status.textContent = `Capturing at tick ${s.tick}. Coverage began at tick ${s.coverageStartTick} (${s.startReason === 'world-replaced' ? 'world reset or import cleared earlier evidence' : 'capture enabled'}); earlier events are unknown. ${s.columns}×${s.rows} bins of ${SPATIAL_BIN_TILES}×${SPATIAL_BIN_TILES} tiles over the ${s.width}×${s.height} wrapped world (edge bins may be partial). Fixed ${SPATIAL_WINDOW_TICKS}-tick windows aligned to tick 0; at most ${SPATIAL_COMPLETED_WINDOWS} completed windows plus the pending one.${evicted}`;
    const table = document.createElement('table');
    table.createCaption().textContent =
      'Recorded spatial events per window — counts are events; energy is abstract engine energy units (display rounded to 0.001).';
    const head = table.createTHead().insertRow();
    for (const label of [
      'Window (logical ticks)',
      'Status',
      'Births',
      'Starvation deaths',
      'Age deaths',
      'Manual removals',
      'Feedings',
      'Food energy',
      'Stinger transfers',
      'Drained energy',
      'Gained energy',
      'Bins with events',
    ]) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.append(cell);
    }
    const body = table.createTBody();
    for (const window of [...s.windows].reverse()) {
      const row = body.insertRow();
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = `(${window.fromTick}, ${window.complete ? window.toTick : `${window.throughTick} of ${window.toTick}`}]`;
      row.append(label);
      const t = window.totals;
      for (const value of [
        window.complete
          ? window.partial
            ? `Complete, partial (${window.toTick - window.fromTick} ticks)`
            : 'Complete'
          : `Pending (${window.throughTick - window.fromTick} ticks covered)`,
        t.births,
        t.starvationDeaths,
        t.ageDeaths,
        t.manualRemovals,
        t.feedings,
        energy(t.feedingEnergy),
        t.attacks,
        energy(t.attackDrained),
        energy(t.attackGained),
        window.activeBins,
      ])
        row.insertCell().textContent = String(value);
    }
    content.replaceChildren(table);
  }
  const change = (): void => {
    if (disposed) return;
    summary = undefined;
    pending = true;
    requestedEpoch = request(toggle.checked);
    render();
  };
  toggle.addEventListener('change', change);
  return {
    /** Evidence from a display epoch older than the latest toggle is never shown. */
    update(value: SpatialSummary | undefined, displayEpoch: number): void {
      if (displayEpoch < requestedEpoch) return;
      pending = false;
      summary = toggle.checked ? value : undefined;
      render();
    },
    dispose(): void {
      disposed = true;
      toggle.removeEventListener('change', change);
    },
  };
}
