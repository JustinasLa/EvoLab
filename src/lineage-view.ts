import {
  LINEAGE_SUMMARY_CAPACITY,
  LINEAGE_EVENT_CAPACITY,
  speciesName,
  type LineagePresentation,
  type LivingLineage,
  type LineageSummary,
  type LineageEvent,
} from './model';
import { genomeSvg } from './view';

type Current = LineagePresentation['current'][number];
interface Evidence {
  id: number;
  row?: LivingLineage;
  summary?: LineageSummary;
  current?: Current;
  created?: Extract<LineageEvent, { kind: 'created' }>;
  extinct?: Extract<LineageEvent, { kind: 'extinct' }>;
}
const PAGE_SIZE = 40;

/** A view-only projection. It never sends commands or reconstructs missing history. */
export function createLineageView(root: HTMLElement, changed: () => void) {
  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const search = get<HTMLInputElement>('lineage-search');
  const rows = get('lineage-rows');
  const detail = get('lineage-detail');
  const panel = get('ecosystem-panel');
  const explorer = get<HTMLDetailsElement>('lineage-explorer');
  const clear = get<HTMLButtonElement>('lineage-clear');
  const retention = get('lineage-retention');
  const results = get('lineage-results');
  const navigation = document.createElement('div');
  navigation.className = 'lineage-pages';
  const previous = document.createElement('button');
  previous.textContent = 'Previous lineages';
  const next = document.createElement('button');
  next.textContent = 'Next lineages';
  navigation.append(previous, next);
  rows.after(navigation);
  let data: LineagePresentation | undefined;
  let replacement: number | undefined;
  let selected: number | undefined;
  let page = 0;
  let tick = 0;
  let facts = new Map<number, Evidence>();
  function parent(entry: Evidence): number | null | undefined {
    return entry.row?.parentId ?? entry.created?.parentId;
  }
  function birth(entry: Evidence): number | null | undefined {
    return entry.row?.createdTick ?? entry.created?.tick;
  }
  function death(entry: Evidence): number | null | undefined {
    return entry.row?.extinctTick ?? entry.extinct?.tick;
  }
  function state(entry: Evidence): string {
    return entry.current ? 'Living' : death(entry) != null ? 'Extinct' : 'Unknown / pruned';
  }
  function live(entry: Evidence): number | string {
    return entry.current?.count ?? entry.row?.liveCount ?? (death(entry) != null ? 0 : 'unknown');
  }
  function genome(entry: Evidence) {
    return entry.summary?.foundingGenome ?? entry.current?.genome;
  }
  function category(entry: Evidence): string {
    const body = genome(entry);
    return body ? speciesName(body) : 'Unknown anatomy';
  }
  function select(id: number): void {
    selected = id;
    render();
    changed();
    detail.focus();
  }
  function link(id: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.lineageId = String(id);
    button.textContent = `Lineage #${id}`;
    button.addEventListener('click', () => select(id));
    return button;
  }
  function paragraph(text: string): void {
    const p = document.createElement('p');
    p.textContent = text;
    detail.append(p);
  }
  function render(): void {
    if (!data || panel.hidden || !explorer.open) return;
    const query = search.value.trim().toLowerCase();
    const identity = /^(?:lineage )?#?(\d+)$/.exec(query);
    const matching = [...facts.values()]
      .sort((a, b) => b.id - a.id)
      .filter((entry) =>
        identity
          ? entry.id === Number(identity[1])
          : `lineage #${entry.id} ${category(entry)} ${state(entry)}`.toLowerCase().includes(query),
      );
    page = Math.min(page, Math.max(0, Math.ceil(matching.length / PAGE_SIZE) - 1));
    previous.disabled = page === 0;
    next.disabled = (page + 1) * PAGE_SIZE >= matching.length;
    const visible = matching.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    results.textContent = matching.length
      ? `${matching.length} matching of ${facts.size} retained identities · showing ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + visible.length} · observed tick ${tick}`
      : facts.size
        ? 'No matching lineages.'
        : 'No retained lineages. Earlier ancestry is unknown.';
    // Restore keyboard focus to the same identity across observations.
    const active = document.activeElement as HTMLElement | null;
    const focusedId = rows.contains(active) ? active?.dataset.lineageId : undefined;
    const detailFocusedId = detail.contains(active) ? active?.dataset.lineageId : undefined;
    rows.replaceChildren();
    for (const entry of visible) {
      const li = document.createElement('li');
      const button = link(entry.id);
      button.dataset.lineageId = String(entry.id);
      button.setAttribute('aria-pressed', String(selected === entry.id));
      const body = genome(entry);
      if (body) button.insertAdjacentHTML('afterbegin', genomeSvg(body, 40));
      button.append(
        document.createTextNode(
          ` · ${state(entry)} · Anatomy category: ${category(entry)} · Live ${live(entry)} · Peak ${entry.row?.peakCount ?? 'unknown'}`,
        ),
      );
      li.append(button);
      rows.append(li);
    }
    if (focusedId)
      rows.querySelector<HTMLButtonElement>(`[data-lineage-id="${focusedId}"]`)?.focus();
    clear.disabled = selected === undefined;
    detail.replaceChildren();
    const entry = selected === undefined ? undefined : facts.get(selected);
    if (!entry) {
      paragraph(
        selected === undefined
          ? 'Select a lineage to inspect retained evidence.'
          : `Lineage #${selected}: evidence was pruned. No organisms highlighted.`,
      );
      return;
    }
    const heading = document.createElement('h3');
    heading.textContent = `Lineage #${entry.id} · ${state(entry)}`;
    detail.append(heading);
    const body = genome(entry);
    if (body) detail.insertAdjacentHTML('beforeend', genomeSvg(body, 72));
    paragraph(
      `Anatomy category: ${category(entry)}. ${entry.summary?.foundingGenome ? 'Retained founding anatomy.' : body ? 'Current living representative; founding anatomy unknown / pruned.' : `Founding anatomy ${entry.summary?.genomeStatus ?? 'unknown / pruned'}.`}`,
    );
    paragraph(
      `Live: ${live(entry)} · Peak: ${entry.row?.peakCount ?? 'unknown'}${entry.row?.peakKind === 'since-origin' ? ' since archive origin (earlier lifetime peak unknown)' : entry.row ? ' lifetime' : ''} · Generation: ${entry.current ? `${entry.current.generation} (maximum living)` : 'unknown (not archived)'}`,
    );
    paragraph(
      body
        ? `Preference: ${body.preference} · Tolerance: ${body.tolerance} (normalized traits).`
        : 'Preference / tolerance: unknown / pruned.',
    );
    paragraph(
      `Origin: ${entry.row?.origin ?? entry.created?.origin ?? 'unknown / pruned'}. Observed at tick ${tick}. Inspection changes no ecosystem state.`,
    );
    const ancestor = parent(entry);
    const relation = document.createElement('p');
    relation.append('Parent: ');
    if (ancestor != null)
      relation.append(
        link(ancestor),
        document.createTextNode(
          facts.get(ancestor)?.row || facts.get(ancestor)?.created
            ? ' (retained evidence)'
            : ' (unknown / pruned ancestor)',
        ),
      );
    else
      relation.append(
        entry.row?.origin === 'legacy-unknown' || (!entry.row && !entry.created)
          ? 'unknown ancestry before retained evidence.'
          : 'none recorded for this origin.',
      );
    detail.append(relation);
    const children = [...facts.values()].filter((child) => parent(child) === entry.id);
    const childList = document.createElement('p');
    childList.append('Children with retained transitions: ');
    for (const child of children) childList.append(link(child.id), document.createTextNode(' '));
    if (!children.length) childList.append('none retained (not proof of no descendants).');
    detail.append(childList);
    const timeline = document.createElement('ol');
    timeline.className = 'lineage-timeline';
    timeline.setAttribute('aria-label', `Retained timeline for lineage #${entry.id}`);
    const transitions: { tick: number; label: string }[] = [];
    const createdTick = birth(entry),
      extinctTick = death(entry);
    if (createdTick != null)
      transitions.push({
        tick: createdTick,
        label: `Created lineage #${entry.id}${ancestor != null ? ` from parent #${ancestor}` : ''}`,
      });
    for (const child of children) {
      const at = birth(child);
      if (at != null)
        transitions.push({ tick: at, label: `Parent #${entry.id} → child #${child.id}` });
    }
    if (extinctTick != null)
      transitions.push({ tick: extinctTick, label: `Extinction of lineage #${entry.id}` });
    for (const transition of transitions.sort((a, b) => a.tick - b.tick)) {
      const item = document.createElement('li');
      item.textContent = `Tick ${transition.tick}: ${transition.label}`;
      timeline.append(item);
    }
    if (transitions.length) {
      const first = transitions[0].tick,
        last = transitions[transitions.length - 1].tick;
      const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chart.setAttribute('viewBox', '0 0 300 64');
      chart.setAttribute('role', 'img');
      chart.setAttribute(
        'aria-label',
        'Retained events by logical tick; exact events listed below',
      );
      chart.classList.add('lineage-event-chart');
      chart.innerHTML = `<path d="M16 32H284" stroke="currentColor"/><text x="16" y="60">${first}</text><text x="284" y="60" text-anchor="end">${last}</text>${transitions
        .map((event) => {
          const x = first === last ? 150 : 16 + ((event.tick - first) / (last - first)) * 268;
          return `<path d="M${x} 22v20" stroke="currentColor"><title>Tick ${event.tick}: ${event.label}</title></path>`;
        })
        .join('')}`;
      detail.append(chart);
    }
    if (createdTick == null) paragraph('Creation tick unknown / pruned. No inferred birth event.');
    if (!transitions.length) paragraph('No timeline events retained for this identity.');
    detail.append(timeline);
    if (detailFocusedId)
      detail.querySelector<HTMLButtonElement>(`[data-lineage-id="${detailFocusedId}"]`)?.focus();
  }
  search.addEventListener('input', () => {
    page = 0;
    render();
  });
  previous.addEventListener('click', () => {
    page--;
    render();
  });
  next.addEventListener('click', () => {
    page++;
    render();
  });
  clear.addEventListener('click', () => {
    selected = undefined;
    render();
    changed();
  });
  detail.tabIndex = -1;
  return {
    update(value: LineagePresentation, at: number, replacementId: number): void {
      if (replacement !== replacementId) {
        selected = undefined;
        page = 0;
      }
      replacement = replacementId;
      data = value;
      tick = at;
      facts = new Map();
      const fact = (id: number): Evidence => {
        if (!facts.has(id)) facts.set(id, { id });
        return facts.get(id)!;
      };
      for (const row of data.archive.living) fact(row.id).row = row;
      for (const row of data.archive.summaries) Object.assign(fact(row.id), { row, summary: row });
      for (const current of data.current) fact(current.id).current = current;
      for (const event of data.archive.events) {
        const entry = fact(event.id);
        if (event.kind === 'created') entry.created = event;
        else entry.extinct = event;
      }
      for (const entry of [...facts.values()]) {
        const id = parent(entry);
        if (id != null) fact(id);
      }
      retention.textContent = `Bounded evidence: ${data.archive.summaries.length}/${LINEAGE_SUMMARY_CAPACITY} summaries; ${data.archive.events.length}/${LINEAGE_EVENT_CAPACITY} events. Archive origin: ${data.archive.originKind} at tick ${data.archive.originTick}. ${data.archive.summariesPruned ? 'Older summaries pruned.' : 'No summary eviction recorded.'} ${data.archive.eventsPruned ? `Events pruned through tick ${data.archive.eventsEvictedThroughTick}; that tick may be partial.` : 'No event eviction recorded.'} Missing ancestry stays unknown; retained transitions are incomplete.`;
      render();
      changed();
    },
    reveal: render,
    highlighted(value: LineagePresentation, frameReplacement = replacement): ReadonlySet<number> {
      if (frameReplacement !== replacement) return new Set();
      // Membership comes from the very frame being drawn, never an organism ID cache.
      return new Set(
        data?.current.some((entry) => entry.id === selected)
          ? value.current.find((entry) => entry.id === selected)?.organismIds
          : undefined,
      );
    },
  };
}
