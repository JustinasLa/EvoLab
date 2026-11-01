import { describe, it, expect } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, index } from '../src/model';
import { RoleObserver, ROLE_LINEAGE_CAPACITY, ROLE_EDGE_CAPACITY, roleSummary } from '../src/roles';
import { roleGenome, roleScene } from './fixtures/roles';

describe('bounded measured ecological roles', () => {
  it('reconciles real photosynthesis, feeding and unarmored attacks with the exact ledger', () => {
    const { world, attacker, victim, armor } = roleScene();
    const reference = Ecosystem.load(JSON.stringify(world.save()));
    expect(world.roleSnapshot()).toBeUndefined();
    world.observeRoles();
    expect(world.roleSnapshot()).toMatchObject({ originTick: 0, tick: 0, lineages: [], edges: [] });
    world.step();
    reference.step();
    expect(world.save()).toEqual(reference.save());
    const observed = world.roleSnapshot()!;
    expect(observed.lineages.map((row) => row.id)).not.toContain(armor.species);
    expect(observed.lineages.find((row) => row.id === victim.species)).toMatchObject({
      living: 0,
      stingsDrained: 2.5,
    });
    expect(roleSummary(observed.lineages.find((row) => row.id === attacker.species)!)).toBe(
      'photosynthesis + food consumption (origin unknown) + stinger gain',
    );
    expect(observed.edges).toEqual([
      {
        source: victim.species,
        target: attacker.species,
        contacts: 1,
        drained: 2.5,
        gained: observed.totals.stingsGained,
      },
    ]);
    for (const [key, value] of Object.entries(observed.totals))
      expect(value).toBe(
        world.telemetrySnapshot().pending.energy[key as keyof typeof observed.totals],
      );
    observed.lineages[0].mouthsGained = -1;
    observed.edges[0].contacts = -1;
    observed.totals.leavesGained = -1;
    expect(world.roleSnapshot()).not.toEqual(observed);
    world.observeRoles();
    expect(world.roleSnapshot()!.tick).toBe(1);
    for (let count = 0; count < 599; count++) {
      world.step();
      reference.step();
      if (count % 30 === 0) world.roleSnapshot();
    }
    expect(world.save()).toEqual(reference.save());
    expect(world.roleSnapshot()).toMatchObject({ originTick: 0, fromTick: 300, tick: 600 });
    const imported = Ecosystem.load(JSON.stringify(world.save()));
    expect(imported.roleSnapshot()).toBeUndefined();
    imported.observeRoles();
    expect(imported.roleSnapshot()).toMatchObject({ originTick: 600, fromTick: 600, lineages: [] });
  });

  it('keeps real same-lineage contacts and ignores armor, self and anatomy-only claims', () => {
    const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0 }, false);
    const attacker = world.spawn(roleGenome(6), 30, 30)!;
    const relative = world.spawn(roleGenome(6), 31, 30, attacker.species)!;
    attacker.age = 3;
    attacker.energy = relative.energy = 10;
    world.observeRoles();
    world.step();
    const observed = world.roleSnapshot()!;
    expect(observed.lineages).toHaveLength(1);
    expect(observed.lineages[0].living).toBe(2);
    expect(observed.edges[0]).toMatchObject({
      source: attacker.species,
      target: attacker.species,
      contacts: 1,
    });
    expect(observed.totals.stingsDrained).toBe(2.5);
    expect(
      roleSummary({ leavesGained: 0, mouthsGained: 0, stingsGained: 0, stingsDrained: 2.5 }),
    ).toBe('No measured energy acquisition');
  });

  it('starts at opt-in, drops expired evidence, and changes measured sources at the next window', () => {
    const world = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0 }, false);
    const organism = world.spawn(roleGenome(3), 10, 10)!;
    organism.energy = 10;
    for (let tick = 0; tick < 298; tick++) world.step();
    world.observeRoles();
    world.food[index(11, 10)] = 1;
    world.step();
    expect(world.roleSnapshot()).toMatchObject({ originTick: 298, fromTick: 298, tick: 299 });
    expect(world.roleSnapshot()!.lineages[0].mouthsGained).toBeGreaterThan(2);
    world.step();
    expect(world.roleSnapshot()!.fromTick).toBe(298);
    world.step();
    expect(world.roleSnapshot()).toMatchObject({
      fromTick: 300,
      tick: 301,
      lineages: [],
      edges: [],
    });
    const leaf = world.spawn(roleGenome(4), 50, 50)!;
    world.step();
    expect(world.roleSnapshot()!.lineages.map((row) => roleSummary(row))).toEqual([
      'photosynthesis',
    ]);
    const before = world.roleSnapshot()!;
    world.paint('erase', leaf.x, leaf.y, 0, leaf.genome);
    expect(world.roleSnapshot()!.tick).toBe(before.tick);
    expect(world.roleSnapshot()!.lineages[0].living).toBe(0);
    expect(world.roleSnapshot()!.totals).toEqual(before.totals);
  });

  it('bounds first-seen lineage admission and accounts for every omitted energy delta', () => {
    const observer = new RoleObserver(11);
    observer.beginTick(12);
    observer.energy(1, 'leavesGained', 0);
    expect(observer.snapshot([]).lineages).toEqual([]);
    for (let id = 1; id <= ROLE_LINEAGE_CAPACITY + 2; id++)
      observer.energy(id, 'mouthsGained', 2.2);
    observer.energy(1, 'mouthsGained', 2.2);
    observer.sting(ROLE_LINEAGE_CAPACITY + 1, 1, 2.5, 0.65);
    const snapshot = observer.snapshot([{ species: 1 }, { species: 1 }]);
    expect(snapshot.lineages).toHaveLength(ROLE_LINEAGE_CAPACITY);
    expect(snapshot.lineages[0].living).toBe(2);
    expect(snapshot.omittedEvents).toBe(3);
    expect(snapshot.omitted).toMatchObject({ mouthsGained: 4.4, stingsDrained: 2.5 });
    expect(snapshot).toMatchObject({
      omittedContacts: 1,
      omittedDrained: 2.5,
      omittedGained: 0.65,
    });
    for (const key of Object.keys(snapshot.totals) as (keyof typeof snapshot.totals)[])
      expect(
        snapshot.lineages.reduce((sum, row) => sum + row[key], snapshot.omitted[key]),
      ).toBeCloseTo(snapshot.totals[key], 10);
    observer.beginTick(301);
    expect(observer.snapshot([])).toMatchObject({
      fromTick: 300,
      omittedEvents: 0,
      omittedContacts: 0,
      lineages: [],
      edges: [],
    });
  });

  it('bounds directed contacts, retains known edges at capacity, and reconciles omitted transfers', () => {
    const observer = new RoleObserver(0);
    observer.beginTick(1);
    for (let source = 1; source <= 20; source++)
      for (let target = 1; target <= 20; target++) observer.sting(source, target, 2.5, 0.65);
    observer.sting(1, 1, 2.5, 0.65);
    const snapshot = observer.snapshot([]);
    expect(snapshot.edges).toHaveLength(ROLE_EDGE_CAPACITY);
    expect(snapshot.edges[0].contacts).toBe(2);
    expect(snapshot.omittedContacts).toBe(400 - ROLE_EDGE_CAPACITY);
    expect(snapshot.edges.reduce((sum, edge) => sum + edge.drained, snapshot.omittedDrained)).toBe(
      snapshot.totals.stingsDrained,
    );
    expect(
      snapshot.edges.reduce((sum, edge) => sum + edge.gained, snapshot.omittedGained),
    ).toBeCloseTo(snapshot.totals.stingsGained, 10);
  });

  it('reconciles completed 30-tick ledgers and pending energy, including shade and deaths', () => {
    const { world } = roleScene();
    world.changeShadeMode(true);
    world.paintShade({ rulesVersion: 1, tool: 'shade', units: 8, radius: 2 }, 20, 20);
    world.observeRoles();
    for (let tick = 0; tick < 95; tick++) world.step();
    const snapshot = world.roleSnapshot()!;
    const telemetry = world.telemetrySnapshot();
    for (const key of Object.keys(snapshot.totals) as (keyof typeof snapshot.totals)[])
      expect(
        telemetry.samples.reduce(
          (sum, sample) => sum + sample.energy[key],
          telemetry.pending.energy[key],
        ),
      ).toBeCloseTo(snapshot.totals[key], 10);
  });
});
