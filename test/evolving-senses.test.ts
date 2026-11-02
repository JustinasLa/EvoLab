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
