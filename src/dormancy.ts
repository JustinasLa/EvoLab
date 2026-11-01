import type { DormancyTraits, Organism, ReserveFlow } from './model';

export const DEFAULT_DORMANCY: DormancyTraits = {
  version: 1,
  capacity: 24,
  enterStress: 0.15,
  wakeStress: 0.05,
  enterEnergy: 3,
  wakeEnergy: 10,
};

export const emptyReserveFlow = (): ReserveFlow => ({
  deposited: 0,
  withdrawn: 0,
  conversionSpent: 0,
  maintenanceSpent: 0,
  entrySpent: 0,
  exitSpent: 0,
});

export function dormancyTick(
  organism: Organism,
  stress: number,
  record: (field: keyof ReserveFlow, amount: number) => void,
): boolean {
  const traits = organism.genome.dormancy;
  if (!traits) return false;
  const state = organism.reserves!;
  const size = organism.genome.cells.length;
  const withdraw = (needed: number) => {
    const amount = Math.min(state.stored, Math.max(0, needed - organism.energy));
    state.stored -= amount;
    organism.energy += amount;
    record('withdrawn', amount);
  };
  const spend = (field: keyof ReserveFlow, amount: number) => {
    withdraw(amount);
    organism.energy -= amount;
    record(field, amount);
  };
  if (!state.dormant && (stress >= traits.enterStress || organism.energy <= traits.enterEnergy)) {
    const cost = 0.2 * size;
    if (organism.energy + state.stored > cost) {
      spend('entrySpent', cost);
      state.dormant = true;
    }
  }
  spend('maintenanceSpent', 0.001 * size + state.stored * 0.0005);
  if (state.dormant) {
    const exit = 0.3 * size;
    if (stress <= traits.wakeStress && organism.energy + state.stored >= traits.wakeEnergy + exit) {
      withdraw(traits.wakeEnergy + exit);
      spend('exitSpent', exit);
      state.dormant = false;
    }
  }
  if (!state.dormant) {
    const input = Math.min(0.25 * size, Math.max(0, organism.energy - traits.wakeEnergy), (traits.capacity - state.stored) / 0.8);
    organism.energy -= input;
    state.stored += input * 0.8;
    record('deposited', input * 0.8);
    record('conversionSpent', input * 0.2);
  }
  return state.dormant;
}

export function fundReserveUpkeep(organism: Organism, cost: number): number {
  const amount = Math.min(organism.reserves!.stored, Math.max(0, cost - organism.energy));
  organism.reserves!.stored -= amount;
  organism.energy += amount;
  return amount;
}
