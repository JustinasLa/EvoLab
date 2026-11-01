import {
  ROLE_WINDOW_TICKS,
  ROLE_LINEAGE_CAPACITY,
  ROLE_EDGE_CAPACITY,
  roleSummary,
  type RoleSnapshot,
  type RoleEnergy,
} from './roles';

const energyText = (energy: RoleEnergy): string =>
  `photosynthesis ${energy.leavesGained}; food ${energy.mouthsGained}; stinger gain ${energy.stingsGained}; stinger loss ${energy.stingsDrained}`;

function table(caption: string, headers: string[], rows: (string | number)[][]): HTMLTableElement {
  const result = document.createElement('table');
  result.createCaption().textContent = caption;
  const heading = result.createTHead().insertRow();
  for (const label of headers) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    heading.append(cell);
  }
  const body = result.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    values.forEach((value, index) => {
      const cell = document.createElement(index === 0 ? 'th' : 'td');
      if (cell instanceof HTMLTableCellElement && index === 0) cell.scope = 'row';
      cell.textContent = String(value);
      row.append(cell);
    });
  }
  return result;
}

export function createRolesView(root: HTMLElement, subscribe: () => void) {
  const panel = root.querySelector<HTMLDetailsElement>('#ecological-roles')!;
  const status = root.querySelector<HTMLElement>('#roles-coverage')!;
  const content = root.querySelector<HTMLElement>('#roles-tables')!;
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-label', 'Measured ecological interaction tables');
  let snapshot: RoleSnapshot | undefined;
  let disposed = false;
  function render(): void {
    if (disposed || !panel.open) return;
    if (!snapshot) {
      status.textContent = 'Waiting for session observations. Earlier interactions are unknown.';
      content.replaceChildren();
      return;
    }
    status.textContent = `Window (${snapshot.fromTick}, ${snapshot.tick}] logical ticks; ${snapshot.tick - snapshot.fromTick} completed ticks covered. Session began at tick ${snapshot.originTick}. Fixed ${ROLE_WINDOW_TICKS}-tick windows aligned to tick 0; the first window may be partial. Previous windows are discarded at the next tick. ${snapshot.lineages.length}/${ROLE_LINEAGE_CAPACITY} lineage rows, ${snapshot.edges.length}/${ROLE_EDGE_CAPACITY} directed edges retained, first-seen admission. ${snapshot.omittedEvents} lineage energy entries and ${snapshot.omittedContacts} contacts omitted by capacity. All observed energy units: ${energyText(snapshot.totals)}. Omitted lineage energy units: ${energyText(snapshot.omitted)}. Omitted edge energy: drained ${snapshot.omittedDrained}; gained ${snapshot.omittedGained}.`;
    content.replaceChildren(
      table(
        'Measured lineage sources and losses — energy units in this window',
        [
          'Lineage',
          'Current status',
          'Measured sources (mixed strategies allowed)',
          'Photosynthesis',
          'Food (unknown origin)',
          'Stinger gain',
          'Stinger loss',
        ],
        snapshot.lineages.map((row) => [
          row.id,
          row.living ? `${row.living} living` : 'Extinct; interaction evidence retained',
          roleSummary(row),
          row.leavesGained,
          row.mouthsGained,
          row.stingsGained,
          row.stingsDrained,
        ]),
      ),
      table(
        'Measured stinger transfers — energy flows from contacted lineage to attacker',
        ['Contacted lineage → attacker', 'Unarmored contacts', 'Drained energy', 'Gained energy'],
        snapshot.edges.map((edge) => [
          `${edge.source} → ${edge.target}`,
          edge.contacts,
          edge.drained,
          edge.gained,
        ]),
      ),
    );
  }
  function reveal(): void {
    if (disposed || !panel.open) return;
    subscribe();
    render();
  }
  panel.addEventListener('toggle', reveal);
  return {
    update(value: RoleSnapshot | undefined): void {
      snapshot = value;
      render();
    },
    reveal,
    dispose(): void {
      disposed = true;
      panel.removeEventListener('toggle', reveal);
    },
  };
}
