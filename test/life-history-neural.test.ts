import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS, Random, founder, type Genome } from '../src/model';
import { newController, mutateController } from '../src/neural';
import { defaultLifeHistory, emptyLifeHistoryLog, lifeRules } from '../src/life-history';
import {
  MUTATION_CHANNELS,
  weightedMutation,
  mutatePropensity,
  mutateLifeHistory,
} from '../src/mutation';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { validBirthEvent, type BirthEvent } from '../src/mutation-evidence';
import captured from './fixtures/life-history-neural16.json';

const births = (world: Ecosystem) =>
  world
    .save()
    .lineageArchive.events.filter((event): event is BirthEvent => event.kind === 'reproduction');

describe('life-history composition with canonical neural controllers', () => {
  it('preserves complete frozen neural16 trajectories, random state, histories and controller state', () => {
    for (const fixture of captured.outcomes) {
      const world = Ecosystem.load(JSON.stringify(fixture.initial));
      const project = () => {
        const { lifeHistoryLog: log, ...old } = world.save();
        expect(log).toEqual(emptyLifeHistoryLog(fixture.initial.tick));
        const projected = { ...old, version: 16 };
        for (const event of projected.lineageArchive.events)
          if (event.kind === 'reproduction') delete event.payment;
        return projected;
      };
      expect(project()).toEqual(fixture.initial);
      for (const endpoint of fixture.endpoints) {
        while (world.tick < endpoint.tick) world.step();
        expect(createHash('sha256').update(JSON.stringify(project())).digest('hex')).toBe(
          endpoint.hash,
        );
        expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
      }
    }
  });

  it('preserves neural blueprint5 and creates blueprint6 only for life-history activation', () => {
    const genome = founder(1);
    genome.controller = newController();
    const current = JSON.parse(serializeBlueprint({ name: 'Combined', description: '', genome }));
    expect(current.version).toBe(6);
    expect(parseBlueprint(JSON.stringify({ ...current, version: 5 })).genome).toEqual(genome);
    current.genome.lifeHistory = defaultLifeHistory();
    expect(parseBlueprint(JSON.stringify(current)).genome).toEqual(current.genome);
    expect(() => parseBlueprint(JSON.stringify({ ...current, version: 5 }))).toThrow();
  });

  it('keeps neural then propensity draws before life-history mutation, with parent-paid successful births', () => {
    let successful = 0;
    for (const seed of [1, 7, 42, 123, 1000, 3000]) {
      const world = new Ecosystem(
        { ...DEFAULTS, seed, nutrients: 0, climate: 0, mutation: 0.4 },
        false,
      );
      const genome = founder(0);
      genome.cells = [{ x: 0, y: 0, type: 7 }];
      genome.controller = newController();
      genome.mutationPropensity = 1;
      genome.lifeHistory = defaultLifeHistory();
      const policy = weightedMutation();
      for (const key of MUTATION_CHANNELS) policy.weights[key] = 0;
      world.changeMutationPolicy(policy);
      const parent = world.spawn(genome, 120, 78)!;
      parent.age = 32;
      parent.energy = 100;
      // The armor-only body has no neural action or movement draws. Weighted zero
      // disables ordinary channels while preserving the successful gate trials.
      const random = new Random(world.random.state);
      const gate = random.next() < 0.4;
      const expectedChannels: string[] = [];
      let child: Genome = genome;
      if (gate)
        child = mutateController(child, random, (channel) => expectedChannels.push(channel));
      child = mutatePropensity(child, random, (channel) => expectedChannels.push(channel));
      if (gate)
        child = mutateLifeHistory(child, random, (channel) => expectedChannels.push(channel));
      world.step();
      const event = births(world)[0];
      for (let attempt = 0; attempt < event.placementAttempts; attempt++) {
        random.int(4);
        random.int(5);
        random.int(4);
        random.int(4);
      }
      expect(world.random.state).toBe(random.state);
      expect(event.gate).toBe(gate);
      expect(event.channels).toEqual(expectedChannels);
      expect(event.childGenome).toEqual(child);
      expect(event.payment!.offspringGranted).toBe(
        lifeRules(parent.genome).grant(child.cells.length),
      );
      expect(event.payment!.parentPaid).toBeCloseTo(
        event.payment!.offspringGranted + event.payment!.overhead,
        12,
      );
      expect(validBirthEvent(event, world.save().nextSpecies, world.save().nextId)).toBe(true);
      expect(
        validBirthEvent(event, world.save().nextSpecies, world.save().nextId, true, false),
      ).toBe(false);
      expect(
        validBirthEvent(event, world.save().nextSpecies, world.save().nextId, false, true),
      ).toBe(false);
      expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
      successful += Number(gate);
    }
    expect(successful).toBeGreaterThan(0);
  });

  it('validates both traits in living, extinct, mutation and identity records before replacement', () => {
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 }, false);
    const genome = founder(1);
    genome.controller = newController();
    genome.lifeHistory = defaultLifeHistory();
    const parent = world.spawn(genome, 120, 78)!;
    parent.age = 30;
    parent.energy = 100;
    for (let tick = 0; tick < 3; tick++) world.step();
    const current = world.save();
    for (const version of [15, 16])
      expect(() => Ecosystem.load(JSON.stringify({ ...current, version }))).toThrow();
    const missingNeuralState = structuredClone(current);
    delete missingNeuralState.organisms[0].neuralBlocked;
    expect(() => Ecosystem.load(JSON.stringify(missingNeuralState))).toThrow('organism');
    const invalidIdentity = structuredClone(current);
    invalidIdentity.lineageArchive.summaries[0].foundingGenome!.controller!.biases[0] = 1;
    expect(() => Ecosystem.load(JSON.stringify(invalidIdentity))).toThrow('lineage archive');
    const badLog = structuredClone(current);
    badLog.lifeHistoryLog.events[0].traits.maintenance = 2;
    expect(() => Ecosystem.load(JSON.stringify(badLog))).toThrow('life-history identity');
    const badBirth = structuredClone(current);
    const event = badBirth.lineageArchive.events.find(
      (row): row is BirthEvent => row.kind === 'reproduction',
    )!;
    event.childGenome!.controller!.weights[0] = 5;
    expect(() => Ecosystem.load(JSON.stringify(badBirth))).toThrow('lineage archive');
    for (const organism of [...world.organisms.values()]) world.kill(organism, 'manual');
    const extinct = world.save();
    expect(Ecosystem.load(JSON.stringify(extinct)).save()).toEqual(extinct);
    extinct.lineageArchive.summaries[0].foundingGenome!.lifeHistory!.investment = 3;
    expect(() => Ecosystem.load(JSON.stringify(extinct))).toThrow('lineage archive');
  });
});
