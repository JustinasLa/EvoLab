import assert from 'node:assert/strict';
import type { WorldFile } from '../../src/model';

// Historical trajectory projections may omit only this new observer after proving
// it has recorded no strategy activation, energy spending or fabricated outcomes.
export function assertLegacyLifeHistory(saved: WorldFile): void {
  assert.ok(Number.isInteger(saved.lifeHistoryLog.originTick));
  assert.ok(saved.lifeHistoryLog.originTick >= 0 && saved.lifeHistoryLog.originTick <= saved.tick);
  assert.deepEqual(saved.lifeHistoryLog, {
    version: 1,
    originTick: saved.lifeHistoryLog.originTick,
    maintenanceSpent: 0,
    eventsPruned: false,
    events: [],
  });
  assert.ok(saved.organisms.every((organism) => organism.genome.lifeHistory === undefined));
}
