import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  HEIGHT,
  WIDTH,
  Random,
  cloneGenome,
  index,
  observedGenome,
  positions,
  validGenome,
  type Cell,
  type Genome,
  type Perception,
} from '../src/model';
import { newController, neuralAction, validController } from '../src/neural';
import { expandedInputs, neuralInputs } from '../src/sensory';
import { newSenses, validSenses, mutateSenses, sameSenses, SENSE_CHANNELS } from '../src/senses';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { classifyRecord, createLibrary, libraryCandidate, type LibraryEntry } from '../src/library';
import { libraryHarness } from './fixtures/library';
import { NUTRIENT_TOTAL, nutrientSummary, validateNutrients } from '../src/nutrients';
import { createComparison, createRecipeComparison } from '../src/experiments';
import { sameInherited } from '../src/lineage';
import { birthObservation, inheritedDifference, validBirthEvent } from '../src/mutation-evidence';

const cells: Cell[] = [
  { x: 0, y: 0, type: 8 },
  { x: 0, y: 1, type: 5 },
];
function design(): Genome {
  return {
    cells: structuredClone(cells),
    preference: 0.5,
    tolerance: 0.2,
    tempo: 2,
    behavior: { version: 1, mode: 'legacy' },
    controller: newController(2),
    senses: newSenses(),
  };
}
function scene(genome = design(), x = 60, y = 60, rotation = 0) {
  const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, mutation: 0, climate: 0 }, false);
  const organism = world.spawn(genome, x, y, undefined, undefined, rotation)!;
  organism.age = 1;
  const trace: Perception = {
    id: organism.id,
    tick: world.tick,
    rays: [],
    chosenEye: null,
    direction: organism.direction,
    moved: false,
    finalDirection: organism.direction,
    finalRotation: rotation,
  };
  return { world, organism, trace };
}

describe('explicit inherited expanded senses', () => {
  it('charges expanded sensing into the finite nutrient budget without creating matter or energy', () => {
    const states = [false, true].map((expanded) => {
      const source = design();
      if (expanded) source.senses = { ...newSenses(), range: 8, fov: 4, temperature: true };
      else {
        source.controller = newController();
        delete source.senses;
      }
      const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false, {
        nutrientCycle: true,
      });
      const organism = world.spawn(source, 60, 60)!;
      organism.age = 1;
      organism.energy = 10;
      world.step();
      const resources = nutrientSummary(world.nutrientCycle!, world.organisms.values(), world.food);
      expect(resources.total).toBe(NUTRIENT_TOTAL);
      expect(resources.food).toBe(0);
      expect(resources.budget!.sunlight).toBe(0);
      expect(resources.budget!.before - resources.budget!.after).toBeCloseTo(
        resources.budget!.dissipated,
        12,
      );
      expect(resources.budget!.dissipated).toBeCloseTo(0.024 + 0.02 + (expanded ? 0.064 : 0), 12);
      validateNutrients(world.nutrientCycle!, world.organisms.values(), world.food);
      expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
      return { world, organism, resources };
    });
    expect(states[0].organism.energy - states[1].organism.energy).toBeCloseTo(0.064, 12);
    const paid = states[1];
    paid.organism.energy = 0.05;
    paid.organism.age = 3;
    paid.world.step();
    const death = nutrientSummary(
      paid.world.nutrientCycle!,
      paid.world.organisms.values(),
      paid.world.food,
    );
    expect(death.total).toBe(NUTRIENT_TOTAL);
    expect(death.biomass).toBe(0);
    expect(death.detritus).toBe(2);
    expect(death.food).toBe(0);
    expect(death.budget!.dissipated).toBeCloseTo(0.05, 12);
    expect(Ecosystem.load(JSON.stringify(paid.world.save())).save()).toEqual(paid.world.save());
  });

  it.each([16, 17])(
    'keeps literal world%i neural state strict without silently activating expanded senses',
    (version) => {
      const source = design();
      source.controller = newController();
      delete source.senses;
      const original = new Ecosystem(
        { ...DEFAULTS, nutrients: 0, mutation: 0, climate: 0 },
        false,
        { nutrientCycle: version === 17 },
      );
      const organism = original.spawn(source, 60, 60)!;
      organism.neuralBlocked = true;
      const file = { ...original.save(), version };
      const restored = Ecosystem.load(JSON.stringify(file));
      for (let tick = 0; tick < 4; tick++) {
        original.step();
        restored.step();
      }
      expect(restored.save()).toEqual(original.save());
      expect(restored.organisms.get(organism.id)!.genome.senses).toBeUndefined();
      for (const target of ['living', 'founding'] as const) {
        const invalid = structuredClone(file);
        const genome =
          target === 'living'
            ? invalid.organisms[0].genome
            : invalid.lineageArchive.summaries[0].foundingGenome!;
        genome.controller = newController(2);
        genome.senses = newSenses();
        expect(() => Ecosystem.load(JSON.stringify(invalid))).toThrow();
      }
      const missingBlocked = structuredClone(file);
      delete missingBlocked.organisms[0].neuralBlocked;
      expect(() => Ecosystem.load(JSON.stringify(missingBlocked))).toThrow();
      const missingFields = structuredClone(file) as Record<string, unknown>;
      delete missingFields.nutrientCycle;
      if (version === 17) expect(() => Ecosystem.load(JSON.stringify(missingFields))).toThrow();
      else expect(Ecosystem.load(JSON.stringify(missingFields)).nutrientCycle).toBeNull();
      const extinct = scene();
      extinct.world.paint(
        'erase',
        extinct.organism.x,
        extinct.organism.y,
        0,
        extinct.organism.genome,
      );
      expect(extinct.world.organisms.size).toBe(0);
      expect(Ecosystem.load(JSON.stringify(extinct.world.save())).save()).toEqual(
        extinct.world.save(),
      );
      expect(() => Ecosystem.load(JSON.stringify({ ...extinct.world.save(), version }))).toThrow(
        'lineage',
      );
    },
  );

  it('preserves composed nutrient and sensory checkpoints through declared comparison provenance', () => {
    const source = design();
    source.senses!.temperature = true;
    const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false, {
      nutrientCycle: true,
    });
    world.spawn(source, 60, 60);
    const initial = JSON.stringify(world.save());
    const runner = createComparison(initial, {
      intervention: 'none',
      treatmentTick: 0,
      horizonTick: 4,
    });
    while (runner.advance(() => 0).tick < 4) {}
    const result = runner.result();
    expect(result.control.state).toBe(result.treatment.state);
    const replay = createRecipeComparison(result.recipe);
    while (replay.advance(() => 0).tick < 4) {}
    expect(replay.result()).toEqual({ ...result, reproduced: true });
    for (const branch of [result.control, result.treatment]) {
      const saved = Ecosystem.load(branch.state);
      expect(saved.nutrientCycle).not.toBeNull();
      expect(saved.organisms.values().next().value!.genome.senses).toEqual(source.senses);
      expect(
        nutrientSummary(saved.nutrientCycle!, saved.organisms.values(), saved.food).total,
      ).toBe(NUTRIENT_TOTAL);
    }
    expect(JSON.stringify(world.save())).toBe(initial);
    runner.dispose();
    replay.dispose();
  });
  it('preserves current and predecessor controllers through complete library storage and world continuation', async () => {
    const native = libraryHarness();
    let identity = 0;
    const library = createLibrary({
      factory: () => native.factory,
      randomId: () => `00000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`,
    });
    await library.list();
    for (const version of [1, 2] as const) {
      const source = design();
      source.controller = newController(version);
      if (version === 1) delete source.senses;
      else source.senses!.temperature = true;
      source.controller.biases[5] = 1;
      await library.mutate({
        type: 'create',
        candidate: libraryCandidate(source, `Senses v${version}`, ''),
      });
      const rows = (await library.list()).rows;
      const entry = rows.find(
        (row) => row.kind === 'valid' && row.blueprint.name === `Senses v${version}`,
      )! as LibraryEntry;
      expect(entry.kind).toBe('valid');
      const classified = classifyRecord(entry.id, entry.token);
      expect(classified.kind).toBe('valid');
      if (classified.kind !== 'valid') throw new Error('Expected valid local design');
      expect(classified.blueprint.genome).toEqual(source);
      const { world, organism } = scene(source);
      organism.neuralBlocked = true;
      const file = world.save();
      if (version === 1) (file as { version: number }).version = 16;
      const restored = Ecosystem.load(JSON.stringify(file));
      for (let tick = 0; tick < 12; tick++) {
        world.step();
        restored.step();
      }
      expect(restored.save()).toEqual(world.save());
    }
    library.dispose();
  });

  it('inherits real accepted offspring, validates retained birth and extinct founding senses before loading', () => {
    let witnessed = false;
    for (let seed = 1; seed <= 16 && !witnessed; seed++) {
      const { world, organism } = scene();
      world.changeSettings({ mutation: 0.4 });
      world.random = new Random(seed);
      organism.age = 32;
      organism.energy = 100;
      world.step();
      const file = world.save();
      expect(Ecosystem.load(JSON.stringify(file)).save()).toEqual(file);
      const birth = file.lineageArchive.events.find(
        (event) => event.kind === 'reproduction' && event.gate,
      );
      if (!birth || birth.kind !== 'reproduction' || !birth.childGenome) continue;
      witnessed = true;
      expect(birth.channels.some((channel) => SENSE_CHANNELS.includes(channel as never))).toBe(
        true,
      );
      const child = world.organisms.get(birth.childOrganismId!)!;
      expect(child.genome.senses).not.toBe(organism.genome.senses);
      expect(child.genome.controller).not.toBe(organism.genome.controller);
      expect(validGenome(child.genome)).toBe(true);
      const corruptBirth = structuredClone(file);
      const corrupted = corruptBirth.lineageArchive.events.find(
        (event) => event.kind === 'reproduction',
      )!;
      if (corrupted.kind !== 'reproduction') throw new Error('Expected birth evidence');
      corrupted.parentGenome.senses!.range = 9;
      expect(() => Ecosystem.load(JSON.stringify(corruptBirth))).toThrow();
      world.paint('erase', organism.x, organism.y, 0, organism.genome);
      const extinct = world.save();
      const summary = extinct.lineageArchive.summaries.find((row) => row.id === organism.species)!;
      expect(summary.liveCount).toBe(0);
      expect(Ecosystem.load(JSON.stringify(extinct)).save()).toEqual(extinct);
      summary.foundingGenome!.senses!.orientation = 4;
      expect(() => Ecosystem.load(JSON.stringify(extinct))).toThrow();
    }
    expect(witnessed).toBe(true);
  });
  it('validates the exact paired opt-in and rejects malformed or predecessor declarations', () => {
    const source = design();
    expect(validGenome(source)).toBe(true);
    expect(validGenome(source, true, true, true, false)).toBe(false);
    expect(validController(source.controller, false)).toBe(false);
    for (const invalid of [
      undefined,
      null,
      {},
      { ...newSenses(), extra: 1 },
      { ...newSenses(), version: 2 },
      { ...newSenses(), orientation: 4 },
      { ...newSenses(), orientation: -1 },
      { ...newSenses(), orientation: 0.5 },
      { ...newSenses(), range: 0 },
      { ...newSenses(), range: 9 },
      { ...newSenses(), range: NaN },
      { ...newSenses(), fov: 2 },
      { ...newSenses(), temperature: 1 },
    ]) {
      expect(validSenses(invalid)).toBe(false);
      expect(validGenome({ ...source, senses: invalid })).toBe(false);
    }
    expect(validGenome({ ...source, controller: newController() })).toBe(false);
    const missing = structuredClone(source);
    delete missing.senses;
    expect(validGenome(missing)).toBe(false);
    delete missing.controller;
    expect(validGenome(missing)).toBe(true);
    expect(mutateSenses(missing, new Random(1))).toBe(missing);
    expect(sameSenses()).toBe(true);
    expect(sameSenses(source.senses)).toBe(false);
    const clone = cloneGenome(source),
      observation = observedGenome(source);
    clone.senses!.orientation = observation.senses!.orientation = 2;
    expect(source.senses!.orientation).toBe(0);
    expect(sameInherited(source, clone)).toBe(false);
    expect(inheritedDifference(source, clone)).toBe(true);
  });

  it.each([0, 1, 2, 3])(
    'starts at actual rotated wrapped eyes for body rotation %s',
    (rotation) => {
      const source = design();
      source.cells = [
        { x: 1, y: 0, type: 8 },
        { x: 1, y: 1, type: 5 },
      ];
      source.senses!.orientation = 1;
      const { world, organism, trace } = scene(source, WIDTH - 1, HEIGHT - 1, rotation);
      const origin = positions(organism)[0],
        heading = (rotation + 1) % 4;
      const [dx, dy] = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ][heading];
      const food = index((origin % WIDTH) + dx, Math.floor(origin / WIDTH) + dy);
      world.food[food] = 1;
      const result = expandedInputs(
        organism,
        world,
        () => {
          throw new Error('Disabled thermometer called');
        },
        trace,
      );
      expect(result.inputs[0]).toBe(1);
      expect(trace.rays[0]).toMatchObject({ origin, heading, stop: 'food', cells: [food] });
      expect(result.temperatures).toEqual([]);
      expect(result.temperatureCost).toBe(0);
      expect(result.available.slice(6)).toEqual([false, false, false, false]);
    },
  );

  it('changes measured sight and provisioned cost with range, orientation and cardinal field of view', () => {
    const { world, organism, trace } = scene();
    world.food[index(60, 54)] = 1;
    expect(expandedInputs(organism, world, () => 0).inputs[0]).toBe(0);
    organism.genome.senses!.range = 8;
    expect(expandedInputs(organism, world, () => 0).inputs[0]).toBe(3 / 8);
    organism.genome.senses!.orientation = 1;
    expect(expandedInputs(organism, world, () => 0).inputs[0]).toBe(0);
    organism.genome.senses!.fov = 3;
    const wide = expandedInputs(organism, world, () => 0, trace);
    expect(wide.inputs[0]).toBe(3 / 8);
    expect(wide.eyeCost).toBe(3 * 8 * 0.001);
    expect(trace.rays).toHaveLength(3);
    organism.genome.senses!.fov = 4;
    expect(expandedInputs(organism, world, () => 0).eyeCost).toBe(4 * 8 * 0.001);
  });

  it('stops at first occlusion including self and reports only the visible body cell', () => {
    const { world, organism, trace } = scene();
    world.food[index(60, 56)] = 1;
    world.walls[index(60, 58)] = 1;
    const wall = expandedInputs(organism, world, () => 0, trace);
    expect(wall.inputs.slice(0, 4)).toEqual([0, 0.8, 0, 0]);
    expect(wall.eyeCost).toBe(0.005);
    const victim = design();
    delete victim.controller;
    delete victim.senses;
    victim.cells = [
      { x: 0, y: 0, type: 7 },
      { x: 1, y: 0, type: 6 },
    ];
    world.spawn(victim, 60, 59);
    expect(expandedInputs(organism, world, () => 0).inputs.slice(0, 4)).toEqual([0, 0, 1, 0]);
    expect(neuralInputs(organism, world).slice(0, 4)).toEqual([0, 0, 0, 1]);
    const seen = [...world.organisms.values()][1];
    seen.genome.cells[0].type = 6;
    expect(expandedInputs(organism, world, () => 0).inputs.slice(0, 4)).toEqual([0, 0, 0, 1]);
    organism.genome.senses!.orientation = 2;
    expect(expandedInputs(organism, world, () => 0, trace).inputs.slice(0, 4)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(trace.rays.at(-1)?.stop).toBe('self');
  });

  it('samples exactly four rotated wrapped local temperatures only when declared', () => {
    const source = design();
    source.cells = [{ x: 1, y: 0, type: 5 }];
    source.senses!.temperature = true;
    const { world, organism } = scene(source, WIDTH - 1, HEIGHT - 1, 1);
    const visited: number[] = [];
    const result = expandedInputs(organism, world, (position) => {
      visited.push(position);
      return position / (WIDTH * HEIGHT);
    });
    expect(visited).toEqual([
      index(WIDTH - 1, 0),
      index(0, 0),
      index(WIDTH - 1, -1),
      index(WIDTH - 1, 1),
    ]);
    expect(result.temperatures.map((sample) => sample.position)).toEqual(visited);
    expect(result.inputs.slice(6)).toEqual(visited.map((position) => position / (WIDTH * HEIGHT)));
    expect(result.available).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(result.eyeCost).toBe(0);
    expect(result.temperatureCost).toBe(0.032);
  });

  it('charges real energy and changes actual movement without sensory RNG or extra inspection work', () => {
    const source = design();
    source.controller!.weights[0] = 1;
    source.controller!.weights[44] = 1;
    const narrow = scene(source),
      wideSource = cloneGenome(source);
    wideSource.senses!.orientation = 1;
    const turned = scene(wideSource);
    for (const { world, organism } of [narrow, turned]) {
      world.food[index(60, 58)] = 1;
      world.selectPerception(organism.id);
      const random = world.random.state,
        energy = organism.energy;
      world.step();
      expect(world.random.state).toBe(random);
      const trace = world.perception()!;
      expect(trace.senses!.eyeCost).toBe(0.005);
      expect(world.save().telemetry.pending.energy.upkeepSpent).toBeCloseTo(
        2 * 0.012 + 0.02 + 0.005,
        12,
      );
      expect(energy - organism.energy).toBeCloseTo(
        2 * 0.012 + 0.02 + 0.005 + (trace.senses!.action === 'forward' ? 0.03 : 0),
        12,
      );
      const before = world.save();
      trace.senses!.inputs[0] = 99;
      expect(world.perception()!.senses!.inputs[0]).not.toBe(99);
      expect(world.save()).toEqual(before);
    }
    expect(narrow.organism.y).toBe(59);
    expect(turned.organism.y).toBe(60);
  });

  it('range and occlusion change real actions while blocked sight still pays its provisioned range', () => {
    const short = design();
    short.controller!.weights[0] = 1;
    short.controller!.weights[44] = 1;
    const long = cloneGenome(short);
    long.senses!.range = 8;
    const shortScene = scene(short),
      longScene = scene(long),
      occluded = scene(long);
    for (const candidate of [shortScene, longScene, occluded]) {
      candidate.world.food[index(60, 54)] = 1;
      candidate.world.selectPerception(candidate.organism.id);
    }
    occluded.world.walls[index(60, 57)] = 1;
    for (const candidate of [shortScene, longScene, occluded]) candidate.world.step();
    expect(shortScene.organism.y).toBe(60);
    expect(longScene.organism.y).toBe(59);
    expect(occluded.organism.y).toBe(60);
    expect(shortScene.world.perception()!.senses!.eyeCost).toBe(0.005);
    expect(longScene.world.perception()!.senses!.eyeCost).toBe(0.008);
    expect(occluded.world.perception()!.senses!.eyeCost).toBe(0.008);
    expect(shortScene.organism.energy - longScene.organism.energy).toBeCloseTo(0.003 + 0.03, 12);
    expect(occluded.organism.energy - longScene.organism.energy).toBeCloseTo(0.03, 12);
  });

  it('additional sensing can cause genuine energy exhaustion and the maximum trace stays bounded', () => {
    const costly = design();
    costly.senses!.range = 8;
    costly.senses!.fov = 4;
    const paid = scene(costly),
      legacy = cloneGenome(costly);
    legacy.controller = newController();
    delete legacy.senses;
    const control = scene(legacy);
    for (const candidate of [paid, control]) candidate.organism.energy = 0.05;
    paid.world.selectPerception(paid.organism.id);
    paid.world.step();
    control.world.step();
    expect(paid.world.organisms.size).toBe(0);
    expect(paid.world.deaths).toBe(1);
    expect(paid.world.perception()).toBeNull();
    expect(control.world.organisms.size).toBe(1);
    const maximum = design();
    maximum.cells = Array.from({ length: 16 }, (_, cell) => ({
      x: cell % 4,
      y: Math.floor(cell / 4),
      type: 8,
    }));
    maximum.senses = { ...newSenses(), range: 8, fov: 4, temperature: true };
    const { world, organism, trace } = scene(maximum);
    const measurement = expandedInputs(organism, world, () => 0.5, trace);
    expect(trace.rays).toHaveLength(64);
    expect(trace.rays.reduce((count, ray) => count + ray.cells.length, 0)).toBeLessThanOrEqual(512);
    expect(measurement.eyeCost).toBe(0.512);
    expect(measurement.temperatures).toHaveLength(4);
  });

  it('uses paid local temperature to steer but cannot promise migration through walls', () => {
    const source = design();
    source.senses!.temperature = true;
    source.controller!.weights[6] = 1;
    source.controller!.weights[7] = -1;
    source.controller!.weights[44] = 1;
    const enabled = scene(source),
      off = cloneGenome(source);
    off.senses!.temperature = false;
    const disabled = scene(off),
      blocked = scene(source);
    for (const { world, organism } of [enabled, disabled, blocked]) {
      world.changeRefugeMode(true);
      world.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 0, units: 20 }, 60, 60);
      world.selectPerception(organism.id);
    }
    blocked.world.walls[index(60, 59)] = 1;
    for (const { world } of [enabled, disabled, blocked]) world.step();
    expect(enabled.organism.y).toBe(59);
    expect(disabled.organism.y).toBe(60);
    expect(blocked.organism.y).toBe(60);
    expect(blocked.organism.neuralBlocked).toBe(true);
    expect(enabled.world.perception()!.senses!.temperatures).toHaveLength(4);
    expect(disabled.world.perception()!.senses!.temperatureCost).toBe(0);
    expect(
      enabled.world.save().telemetry.pending.energy.upkeepSpent -
        disabled.world.save().telemetry.pending.energy.upkeepSpent,
    ).toBeCloseTo(0.032, 12);
  });

  it('mutates detached bounded traits through each declared channel and round trips complete evidence', () => {
    const source = design(),
      original = structuredClone(source),
      channels = new Set<string>();
    let child = source;
    for (let seed = 1; seed <= 200; seed++) {
      child = mutateSenses(child, new Random(seed), (channel) => channels.add(channel));
      expect(validGenome(child)).toBe(true);
    }
    expect([...channels].sort()).toEqual([...SENSE_CHANNELS].sort());
    expect(source).toEqual(original);
    const blueprint = serializeBlueprint({ name: 'Local senses', description: '', genome: child });
    expect(parseBlueprint(blueprint).genome).toEqual(child);
    const { world } = scene(child);
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    for (const version of [5, 4, 3, 2])
      expect(() => parseBlueprint(JSON.stringify({ ...JSON.parse(blueprint), version }))).toThrow();
    expect(() => Ecosystem.load(JSON.stringify({ ...world.save(), version: 16 }))).toThrow();
    const changed = cloneGenome(source);
    changed.senses!.temperature = true;
    const event = birthObservation({
      kind: 'reproduction',
      id: 1,
      tick: 33,
      parentOrganismId: 1,
      parentGenome: source,
      gate: true,
      channels: ['temperature-sensor'],
      placementAttempts: 1,
      childOrganismId: 2,
      childLineageId: 2,
      childGenome: changed,
      outcome: 'born-changed',
    });
    expect(validBirthEvent(event, 3, 3)).toBe(true);
    expect(validBirthEvent(event, 3, 3, true, false)).toBe(false);
    expect(validBirthEvent({ ...event, channels: [] }, 3, 3)).toBe(false);
    expect(validBirthEvent({ ...event, channels: ['temperature-sensor', 'eye-range'] }, 3, 3)).toBe(
      false,
    );
    expect(neuralAction(newController(2), Array(10).fill(0))).toBe('rest');
  });
});
