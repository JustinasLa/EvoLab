import { type LineageArchiveState } from './model';
import { retainedBirthExport, type BirthEvent } from './mutation-evidence';
import { genomeDiff } from './organism-view';
import { genomeSvg } from './view';

const key = (event: BirthEvent) => `${event.tick}:${event.parentOrganismId}`;
const outcomes: Record<BirthEvent['outcome'], string> = {
  'born-clone': 'Clone birth — no mutation attempted',
  'born-no-op': 'No-op mutation — offspring born without an observed inherited difference',
  'born-changed': 'Changed offspring — successful birth',
  'failed-placement': 'Failed placement — no offspring born',
};

/** View-only retained observations; no simulation command or ecological state. */
export function createBirthView(root: HTMLElement) {
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const select = get<HTMLSelectElement>('birth-select'),
    detail = get('birth-detail'),
    status = get('birth-retention'),
    download = get<HTMLButtonElement>('birth-export'),
    exported = get('birth-export-status'),
    panel = get('ecosystem-panel'),
    explorer = get<HTMLDetailsElement>('lineage-explorer');
  let archive: LineageArchiveState | undefined,
    tick = 0,
    replacement: number | undefined,
    selected: string | undefined,
    options = '',
    html = '',
    lease: { url: string; timer: ReturnType<typeof setTimeout> } | undefined;
  function release() {
    if (lease) {
      URL.revokeObjectURL(lease.url);
      clearTimeout(lease.timer);
      lease = undefined;
    }
    download.disabled = !archive;
  }
  function render() {
    if (!archive || panel.hidden || !explorer.open) return;
    const events = archive.events.filter(
        (entry): entry is BirthEvent => entry.kind === 'reproduction',
      ),
      event = events.find((entry) => key(entry) === selected);
    const statusText = `Observed at tick ${tick}. ${events.length} retained reproductive attempts in the shared ${archive.events.length}/512 event ring. Recording begins after tick ${archive.mutationOriginTick}; earlier births are unknown / not recorded. ${archive.eventsPruned ? `Events evicted through tick ${archive.eventsEvictedThroughTick}; that tick may be partial. Missing events are unknown / pruned.` : 'No event eviction recorded since recording began.'} Population-cap prevention is outside reproductive attempts. Attempted channels may leave values unchanged; outcomes are not fitness or adaptive progress.`;
    if (status.textContent !== statusText) status.textContent = statusText;
    const choices = events
      .slice()
      .reverse()
      .map(
        (entry) =>
          `<option value="${key(entry)}">Tick ${entry.tick} · parent #${entry.parentOrganismId} · ${entry.outcome}</option>`,
      )
      .join('');
    const nextOptions = `${selected && !event ? `<option value="${selected}">Selected attempt: unknown / pruned</option>` : ''}${choices || '<option value="">No retained reproductive attempts</option>'}`;
    if (nextOptions !== options) {
      select.innerHTML = nextOptions;
      options = nextOptions;
    }
    if (select.value !== (selected ?? '')) select.value = selected ?? '';
    select.disabled = events.length === 0 && !selected;
    const nextHtml = event
      ? `<h4>${outcomes[event.outcome]}</h4><p>Tick ${event.tick}: parent organism #${event.parentOrganismId}, lineage #${event.id}. Ordinary mutation gate ${event.gate ? 'passed' : 'did not pass'}. Attempted channels: ${event.channels.join(', ') || 'none'}. Placement attempts: ${event.placementAttempts}.</p>${event.payment ? `<p>Parent age ${event.payment.parentAge}. Actual parental payment ${event.payment.parentPaid}; offspring grant ${event.payment.offspringGranted}; birth overhead ${event.payment.overhead}. Overhead charged once after successful placement.</p>` : '<p>Parental age and exact payments unknown / not recorded for this historical attempt.</p>'}${event.childGenome ? `<p>Admitted child organism #${event.childOrganismId}, lineage #${event.childLineageId}. Lineage identity follows the existing mutation rules; a numeric no-op can still have a distinct lineage.</p><div class="baseline-preview">${genomeSvg(event.childGenome, 72)}<span>Born child anatomy</span></div>${genomeDiff(event.childGenome, { genome: event.parentGenome, lineageId: event.id, relation: 'parent-lineage', status: 'retained' }, 'direct-parent')}` : `<div class="baseline-preview">${genomeSvg(event.parentGenome, 72)}<span>Actual parent anatomy</span></div><p>No child genome or inherited delta exists. Failed candidate anatomies are not inherited evidence. No birth, child grant or parent reproductive payment occurred.</p>`}`
      : `<p>${selected ? 'Selected attempt is unknown / pruned. Its parent/child pair cannot be reconstructed.' : 'No retained reproductive attempts. Parent/child differences are unknown; founding genomes do not establish an individual birth pair.'}</p>`;
    if (nextHtml !== html) {
      detail.innerHTML = nextHtml;
      html = nextHtml;
    }
  }
  function change() {
    const event = archive?.events.find(
      (entry): entry is BirthEvent => entry.kind === 'reproduction' && key(entry) === select.value,
    );
    if (event) selected = key(event);
    render();
  }
  function save() {
    if (!archive || lease) return;
    let url: string | undefined;
    const anchor = document.createElement('a');
    try {
      url = URL.createObjectURL(
        new Blob([JSON.stringify(retainedBirthExport(archive, tick), null, 2)], {
          type: 'application/json',
        }),
      );
      anchor.href = url;
      anchor.download = `evolab-retained-births-tick-${tick}.json`;
      root.append(anchor);
      anchor.click();
      lease = { url, timer: setTimeout(release, 1000) };
      download.disabled = true;
      exported.textContent = `Retained events exported at tick ${tick}, including recording origin and truncation metadata.`;
    } catch {
      if (url) URL.revokeObjectURL(url);
      exported.textContent = 'Retained-event download failed. Try again.';
    } finally {
      anchor.remove();
    }
  }
  select.addEventListener('change', change);
  download.addEventListener('click', save);
  download.disabled = true;
  return {
    update(value: LineageArchiveState, at: number, replacementId: number) {
      const changed = replacement !== replacementId;
      archive = value;
      tick = at;
      if (changed) {
        release();
        selected = undefined;
        exported.textContent = '';
      }
      if (selected === undefined) {
        const latest = value.events.findLast(
          (event): event is BirthEvent => event.kind === 'reproduction',
        );
        if (latest) selected = key(latest);
      }
      replacement = replacementId;
      render();
    },
    reveal: render,
    dispose() {
      release();
      select.removeEventListener('change', change);
      download.removeEventListener('click', save);
    },
  };
}
