import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  WIDTH,
  Random,
  cloneGenome,
  founder,
  index,
  positions,
  validGenome,
  type Genome,
  type Cell,
} from '../src/model';
import {
  NEURAL_ACTIONS,
  NEURAL_COST,
  mutateController,
  neuralAction,
  newController,
  sameController,
  validController,
} from '../src/neural';
import { neuralInputs } from '../src/sensory';
import { sameInherited } from '../src/lineage';
import { birthObservation, inheritedDifference, validBirthEvent } from '../src/mutation-evidence';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { classifyRecord, createLibrary, libraryCandidate, type LibraryEntry } from '../src/library';
import { libraryHarness } from './fixtures/library';

const body: Cell[] = [
  { x: 0, y: 0, type: 8 },
  { x: 0, y: 1, type: 3 },
  { x: 1, y: 1, type: 5 },
];
function genome(action = 0, cells = body): Genome {
  const controller = newController();
  controller.biases[4 + action] = 1;
  return {
    cells: structuredClone(cells),
    preference: 0.5,
    tolerance: 0.2,
    tempo: 2,
    behavior: { version: 1, mode: 'legacy' },
    controller,
  };
}
function scene(action = 0, cells = body, rotation = 0, source = genome(action, cells)) {
  const world = new Ecosystem({ ...DEFAULTS, nutrients: 0, mutation: 0, climate: 0 }, false, {
    terrain: { version: 1, preset: 'open-field', seed: null },
  });
  const organism = world.spawn(source, 60, 60, undefined, undefined, rotation)!;
  organism.age = 1;
  return { world, organism };
}
function step(world: Ecosystem, ticks: number) {
  for (let tick = 0; tick < ticks; tick++) world.step();
}

describe('bounded inherited controller v1', () => {
  it('validates exact dimensions, dense finite parameters and detached inheritance', () => {
    expect(validController(newController())).toBe(true);
    for (const invalid of [
      null,
      [],
      {},
      { ...newController(), version: 2 },
      { ...newController(), extra: 0 },
      { ...newController(), weights: Array(40) },
      { ...newController(), weights: Array(41).fill(0) },
      { ...newController(), biases: [0] },
      ...[NaN, Infinity, -Infinity, 4.001, -4.001, '0', null].map((value) => ({
        ...newController(),
        weights: [value, ...Array(39).fill(0)],
      })),
      { ...newController(), biases: Array(8).fill(Infinity) },
    ])
      expect(validController(invalid)).toBe(false);
    const source = genome(),
      copy = cloneGenome(source);
    expect(sameController(source.controller, copy.controller)).toBe(true);
    expect(sameController()).toBe(true);
    expect(sameController(source.controller)).toBe(false);
    copy.controller!.weights[0] = 1;
    expect(source.controller!.weights[0]).toBe(0);
    expect(sameInherited(source, copy)).toBe(false);
    expect(inheritedDifference(source, copy)).toBe(true);
    expect(validGenome(source, true, true, false)).toBe(false);
    expect(validGenome({ ...source, controller: undefined })).toBe(false);
  });

  it('uses fixed row-major layers, clamps activations and breaks ties in declared order', () => {
    expect(neuralAction(newController(), Array(6).fill(0))).toBe('rest');
    for (let action = 0; action < 4; action++)
      expect(neuralAction(genome(action).controller!, Array(6).fill(0))).toBe(
        NEURAL_ACTIONS[action],
      );
    const controller = newController();
    controller.weights[0] = 4;
    controller.weights[28] = 4;
    expect(neuralAction(controller, [0, 0, 0, 0, 0, 0])).toBe('rest');
    expect(neuralAction(controller, [1, 0, 0, 0, 0, 0])).toBe('forward');
    controller.biases[6] = 4;
    expect(neuralAction(controller, [1, 0, 0, 0, 0, 0])).toBe('forward');
    controller.weights[0] = -4;
    expect(neuralAction(controller, [1, 0, 0, 0, 0, 0])).toBe('left');
  });

  it('mutates exactly one bounded explicit parameter channel, only for opted-in genomes', () => {
    const passive = founder(0),
      random = new Random(1),
      state = random.state;
    expect(mutateController(passive, random)).toBe(passive);
    expect(random.state).toBe(state);
    const channels = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const source = genome();
      source.controller!.weights.fill(seed % 2 ? 4 : -4);
      source.controller!.biases.fill(seed % 2 ? 4 : -4);
      const child = mutateController(source, new Random(seed), (channel) => channels.add(channel));
      expect(validController(child.controller)).toBe(true);
      expect(child.controller).not.toBe(source.controller);
      const before = [...source.controller!.weights, ...source.controller!.biases],
        after = [...child.controller!.weights, ...child.controller!.biases];
      expect(after.filter((value, offset) => value !== before[offset]).length).toBeLessThanOrEqual(
        1,
      );
      after.forEach((value, offset) =>
        expect(Math.abs(value - before[offset])).toBeLessThanOrEqual(0.25),
      );
    }
    expect([...channels].sort()).toEqual(['neural-bias', 'neural-weight']);
  });
});

describe('neural ecology and sensory limits', () => {
  it.each([0, 1, 2, 3])(
    'moves forward along actual body rotation %s without random steering',
    (rotation) => {
      const { world, organism } = scene(1, body, rotation),
        random = world.random.state;
      const [dx, dy] = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ][rotation];
      world.step();
      expect([organism.x, organism.y, organism.rotation, organism.direction]).toEqual([
        60 + dx,
        60 + dy,
        rotation,
        (rotation + 3) % 4,
      ]);
      expect(organism.neuralBlocked).toBe(false);
      expect(world.random.state).toBe(random);
      expect(world.save().telemetry.pending.energy.movementSpent).toBeCloseTo(0.03, 12);
    },
  );

  it.each([2, 3])(
    'turns in place with cost for action %s and retains blocked feedback',
    (action) => {
      const { world, organism } = scene(action);
      world.step();
      expect([organism.x, organism.y, organism.rotation]).toEqual([60, 60, action === 2 ? 3 : 1]);
      expect(world.save().telemetry.pending.energy.movementSpent).toBeCloseTo(0.03, 12);
      const blocked = scene(action);
      for (const cell of positions({ ...blocked.organism, rotation: action === 2 ? 3 : 1 }))
        if (!blocked.world.occupied[cell]) blocked.world.walls[cell] = 1;
      blocked.world.step();
      expect(blocked.organism.rotation).toBe(0);
      expect(blocked.organism.neuralBlocked).toBe(true);
      expect(neuralInputs(blocked.organism, blocked.world)[5]).toBe(1);
    },
  );

  it('charges blocked translation without random recovery; rest clears feedback and adds no movement charge', () => {
    const { world, organism } = scene(1);
    world.walls[index(60, 59)] = 1;
    const random = world.random.state;
    world.selectPerception(organism.id);
    world.step();
    expect(organism.neuralBlocked).toBe(true);
    expect(world.random.state).toBe(random);
    expect([organism.x, organism.y, organism.rotation]).toEqual([60, 60, 0]);
    const restored = Ecosystem.load(JSON.stringify(world.save()));
    step(world, 20);
    step(restored, 20);
    expect(restored.save()).toEqual(world.save());
    const rest = scene();
    rest.organism.neuralBlocked = true;
    rest.world.step();
    expect(rest.organism.neuralBlocked).toBe(false);
    expect(rest.world.save().telemetry.pending.energy.movementSpent).toBe(0);
  });

  it('uses only actual five-cell occluded eye observations and bounded internal signals', () => {
    const { world, organism } = scene();
    organism.energy = 100000;
    world.food[index(60, 55)] = 1;
    world.food[index(59, 60)] = 1;
    expect(neuralInputs(organism, world)).toEqual([0.2, 0, 0, 0, 1, 0]);
    world.walls[index(60, 57)] = 1;
    expect(neuralInputs(organism, world)).toEqual([0, 0.6, 0, 0, 1, 0]);
    const harmless = world.spawn(genome(0, [{ x: 0, y: 0, type: 3 }]), 60, 58)!;
    expect(neuralInputs(organism, world).slice(0, 4)).toEqual([0, 0, 0.8, 0]);
    harmless.genome.cells[0].type = 6;
    expect(neuralInputs(organism, world).slice(0, 4)).toEqual([0, 0, 0, 0.8]);
    const blind = scene(1, [{ x: 0, y: 0, type: 3 }]);
    blind.world.food[index(60, 59)] = 1;
    blind.world.step();
    expect(neuralInputs(blind.organism, blind.world).slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(blind.world.save().telemetry.pending.energy.movementSpent).toBe(0);
    const self = scene(0, [
      { x: 0, y: 0, type: 8 },
      { x: 0, y: -1, type: 3 },
    ]);
    self.world.food[index(60, 58)] = 1;
    expect(neuralInputs(self.organism, self.world).slice(0, 4)).toEqual([0, 0, 0, 0]);
    const wrap = new Ecosystem({ ...DEFAULTS, climate: 0 }, false);
    const wrapped = wrap.spawn(genome(), WIDTH - 2, 0)!;
    wrap.food[index(WIDTH - 2, -1)] = 1;
    expect(neuralInputs(wrapped, wrap)[0]).toBe(1);
  });

  it('charges evaluation even without useful senses and reduces funded reproductive outcomes', () => {
    const cells: Cell[] = [{ x: 0, y: 0, type: 3 }],
      neural = scene(0, cells);
    const plain = new Ecosystem({ ...DEFAULTS, nutrients: 0, mutation: 0, climate: 0 }, false);
    const passive = cloneGenome(neural.organism.genome);
    delete passive.controller;
    const control = plain.spawn(passive, 60, 60)!;
    control.age = neural.organism.age = 1;
    control.energy = neural.organism.energy = 12 + 32 * 0.012 + 0.1;
    const initial = control.energy;
    step(neural.world, 31);
    step(plain, 31);
    expect(control.energy - neural.organism.energy).toBeCloseTo(16 * NEURAL_COST, 10);
    expect(neural.organism.energy).toBeLessThan(initial);
    plain.step();
    neural.world.step();
    expect(control.children).toBe(1);
    expect(neural.organism.children).toBe(0);
    expect(plain.births).toBe(1);
    expect(neural.world.births).toBe(0);
  });

  it('can use food sight to acquire energy and pay for actual offspring', () => {
    const cells: Cell[] = [
      { x: 0, y: 0, type: 8 },
      { x: 1, y: 0, type: 3 },
      { x: 0, y: 1, type: 5 },
    ];
    const source = genome(0, cells);
    source.controller = newController();
    source.controller.weights[0] = 1;
    source.controller.weights[28] = 1;
    const { world, organism } = scene(0, cells, 0, source),
      resting = scene(0, cells);
    for (let distance = 1; distance <= 15; distance++) {
      world.food[index(60, 60 - distance)] = 1;
      world.food[index(61, 60 - distance)] = 1;
      resting.world.food[index(60, 60 - distance)] = 1;
      resting.world.food[index(61, 60 - distance)] = 1;
    }
    const initial = organism.energy;
    step(world, 32);
    step(resting.world, 32);
    expect(organism.y).toBeLessThan(60);
    expect(world.save().telemetry.samples.some((sample) => sample.energy.mouthsGained > 0)).toBe(
      true,
    );
    expect(organism.children).toBeGreaterThan(0);
    expect(world.births).toBeGreaterThan(0);
    expect(resting.organism.children).toBe(0);
    expect(organism.energy).toBeGreaterThan(resting.organism.energy);
    expect(Ecosystem.load(JSON.stringify(world.save())).save()).toEqual(world.save());
    expect(
      world.save().telemetry.samples.some((sample) => sample.energy.reproductionSpent > 0) ||
        world.save().telemetry.pending.energy.reproductionSpent > 0,
    ).toBe(true);
    expect(initial).toBe(11);
  });
});

describe('neural persistence, inheritance and rejection', () => {
  it('round-trips a complete controller through blueprint and local collection', async () => {
    const source = genome(3),
      text = serializeBlueprint({ name: 'Neural', description: 'Inherited', genome: source });
    expect(parseBlueprint(text).genome).toEqual(source);
    const native = libraryHarness();
    const library = createLibrary({
      factory: () => native.factory,
      randomId: () => '00000000-0000-4000-8000-000000000001',
    });
    await library.list();
    await library.mutate({ type: 'create', candidate: libraryCandidate(source, 'Neural', '') });
    const entry = (await library.list()).rows[0] as LibraryEntry;
    expect((await library.read(entry)).blueprint.genome).toEqual(source);
    expect((classifyRecord(entry.id, entry.token) as LibraryEntry).blueprint.genome).toEqual(
      source,
    );
    library.dispose();
    for (const version of [2, 3, 4])
      expect(() => parseBlueprint(JSON.stringify({ ...JSON.parse(text), version }))).toThrow();
  });

  it('preserves complete deterministic worlds with mutation, lineage evidence and detached offspring', () => {
    const { world, organism } = scene(0, founder(0).cells);
    world.changeSettings({ mutation: 0.4 });
    organism.energy = 100;
    step(world, 120);
    expect(world.births).toBeGreaterThan(0);
    expect(
      world
        .lineageSnapshot()
        .events.some(
          (event) =>
            event.kind === 'reproduction' &&
            event.channels.some((channel) => channel.startsWith('neural-')),
        ),
    ).toBe(true);
    const restored = Ecosystem.load(JSON.stringify(world.save()));
    expect(restored.save()).toEqual(world.save());
    step(world, 240);
    step(restored, 240);
    expect(restored.save()).toEqual(world.save());
    const children = [...world.organisms.values()].filter((child) => child.generation > 0);
    expect(children.length).toBeGreaterThan(0);
    expect(children[0].genome.controller).not.toBe(organism.genome.controller);
  });

  it('rejects unsupported, malformed, oversized controller worlds, archives and blueprints', () => {
    const { world } = scene(),
      saved = world.save();
    for (const version of [9, 10, 11, 12, 13, 14, 15])
      expect(() => Ecosystem.load(JSON.stringify({ ...saved, version }))).toThrow();
    for (const mutate of [
      (file: any) => {
        delete file.organisms[0].neuralBlocked;
      },
      (file: any) => {
        file.organisms[0].neuralBlocked = 1;
      },
      (file: any) => {
        file.organisms[0].genome.controller.weights.pop();
      },
      (file: any) => {
        file.organisms[0].genome.controller.weights[0] = null;
      },
      (file: any) => {
        file.organisms[0].genome.controller.biases[0] = 5;
      },
      (file: any) => {
        file.lineageArchive.summaries[0].foundingGenome.controller.version = 2;
      },
      (file: any) => {
        file.organisms[0].genome.controller.weights = Array(1_300_000).fill(0);
      },
    ]) {
      const file = structuredClone(saved);
      mutate(file);
      expect(() => Ecosystem.load(JSON.stringify(file))).toThrow();
    }
    expect(world.save()).toEqual(saved);
    expect(() =>
      parseBlueprint(
        JSON.stringify({
          format: 'evolab-organism-blueprint',
          version: 5,
          name: 'Huge',
          description: '',
          genome: {
            ...genome(),
            controller: { ...newController(), weights: Array(10000).fill(0) },
          },
        }),
      ),
    ).toThrow();
  });

  it('validates mutation evidence channels and unchanged topology independently', () => {
    const parent = genome(),
      child = cloneGenome(parent);
    child.controller!.weights[0] = 0.1;
    const event = birthObservation({
      id: 1,
      tick: 33,
      parentOrganismId: 1,
      parentGenome: parent,
      gate: true,
      channels: ['neural-weight'],
      placementAttempts: 1,
      childOrganismId: 2,
      childLineageId: 2,
      childGenome: child,
    });
    expect(validBirthEvent(event, 3, 3)).toBe(true);
    expect(validBirthEvent(event, 3, 3, false)).toBe(false);
    expect(validBirthEvent({ ...event, channels: [] }, 3, 3)).toBe(false);
    expect(validBirthEvent({ ...event, channels: ['neural-bias', 'neural-weight'] }, 3, 3)).toBe(
      false,
    );
    delete child.controller;
    expect(validBirthEvent({ ...event, childGenome: child }, 3, 3)).toBe(false);
    const bias = cloneGenome(parent);
    bias.controller!.biases[0] = 0.1;
    expect(
      validBirthEvent(
        birthObservation({ ...event, childGenome: bias, channels: ['neural-bias'] }),
        3,
        3,
      ),
    ).toBe(true);
  });
});
