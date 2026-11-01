export const ROLE_WINDOW_TICKS = 300;
export const ROLE_LINEAGE_CAPACITY = 128;
export const ROLE_EDGE_CAPACITY = 256;

export interface RoleEnergy {
  leavesGained: number;
  mouthsGained: number;
  stingsGained: number;
  stingsDrained: number;
}
export interface RoleLineage extends RoleEnergy {
  id: number;
  events: number;
}
export interface RoleEdge {
  source: number;
  target: number;
  contacts: number;
  drained: number;
  gained: number;
}
export interface RoleSnapshot {
  originTick: number;
  fromTick: number;
  tick: number;
  totals: RoleEnergy;
  omitted: RoleEnergy;
  omittedEvents: number;
  omittedContacts: number;
  omittedDrained: number;
  omittedGained: number;
  lineages: (RoleLineage & { living: number })[];
  edges: RoleEdge[];
}
const emptyEnergy = (): RoleEnergy => ({
  leavesGained: 0,
  mouthsGained: 0,
  stingsGained: 0,
  stingsDrained: 0,
});

export class RoleObserver {
  private fromTick: number;
  private tick: number;
  private totals = emptyEnergy();
  private omitted = emptyEnergy();
  private omittedEvents = 0;
  private omittedContacts = 0;
  private omittedDrained = 0;
  private omittedGained = 0;
  private lineages = new Map<number, RoleLineage>();
  private edges = new Map<string, RoleEdge>();
  constructor(private readonly originTick: number) {
    this.fromTick = this.tick = originTick;
  }
  beginTick(tick: number): void {
    const boundary = Math.floor((tick - 1) / ROLE_WINDOW_TICKS) * ROLE_WINDOW_TICKS;
    if (boundary > this.fromTick) {
      this.fromTick = boundary;
      this.totals = emptyEnergy();
      this.omitted = emptyEnergy();
      this.omittedEvents = this.omittedContacts = this.omittedDrained = this.omittedGained = 0;
      this.lineages.clear();
      this.edges.clear();
    }
    this.tick = tick;
  }
  energy(id: number, field: keyof RoleEnergy, amount: number): void {
    if (amount === 0) return;
    this.totals[field] += amount;
    let row = this.lineages.get(id);
    if (!row && this.lineages.size < ROLE_LINEAGE_CAPACITY) {
      row = { id, events: 0, ...emptyEnergy() };
      this.lineages.set(id, row);
    }
    if (row) {
      row[field] += amount;
      row.events++;
    } else {
      this.omitted[field] += amount;
      this.omittedEvents++;
    }
  }
  sting(source: number, target: number, drained: number, gained: number): void {
    this.energy(source, 'stingsDrained', drained);
    this.energy(target, 'stingsGained', gained);
    const key = `${source}:${target}`;
    let edge = this.edges.get(key);
    if (
      !edge &&
      this.edges.size < ROLE_EDGE_CAPACITY &&
      this.lineages.has(source) &&
      this.lineages.has(target)
    ) {
      edge = { source, target, contacts: 0, drained: 0, gained: 0 };
      this.edges.set(key, edge);
    }
    if (edge) {
      edge.contacts++;
      edge.drained += drained;
      edge.gained += gained;
    } else {
      this.omittedContacts++;
      this.omittedDrained += drained;
      this.omittedGained += gained;
    }
  }
  snapshot(organisms: Iterable<{ species: number }>): RoleSnapshot {
    const living = new Map<number, number>();
    for (const organism of organisms)
      living.set(organism.species, (living.get(organism.species) ?? 0) + 1);
    return {
      originTick: this.originTick,
      fromTick: this.fromTick,
      tick: this.tick,
      totals: { ...this.totals },
      omitted: { ...this.omitted },
      omittedEvents: this.omittedEvents,
      omittedContacts: this.omittedContacts,
      omittedDrained: this.omittedDrained,
      omittedGained: this.omittedGained,
      lineages: [...this.lineages.values()].map((row) => ({
        ...row,
        living: living.get(row.id) ?? 0,
      })),
      edges: [...this.edges.values()].map((edge) => ({ ...edge })),
    };
  }
}

export function roleSummary(energy: RoleEnergy): string {
  const sources: string[] = [];
  if (energy.leavesGained > 0) sources.push('photosynthesis');
  if (energy.mouthsGained > 0) sources.push('food consumption (origin unknown)');
  if (energy.stingsGained > 0) sources.push('stinger gain');
  return sources.length ? sources.join(' + ') : 'No measured energy acquisition';
}
