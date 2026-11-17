import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, HEIGHT, WIDTH, index, type CellType } from '../../src/model';
import { roleGenome } from './roles';

/** One event of every kind, each placed across a wrapped world edge. */
export function wrappedScene() {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  const mouth = world.spawn(roleGenome(3), 0, 0)!;
  mouth.energy = 10;
  world.food[index(-1, 0)] = 1;
  const attacker = world.spawn(roleGenome(6), WIDTH - 1, 80)!;
  attacker.age = 3;
  attacker.energy = 10;
  const victim = world.spawn(roleGenome(4), 0, 80)!;
  victim.energy = 10;
  const parent = world.spawn(roleGenome(4), WIDTH - 2, HEIGHT - 2)!;
  parent.age = 32;
  parent.energy = 40;
  const starving = world.spawn(roleGenome(3), WIDTH - 1, HEIGHT - 1)!;
  starving.energy = 0.01;
  const old = world.spawn(roleGenome(4), 100, 150)!;
  old.age = 975;
  old.energy = 10;
  const erased = world.spawn(roleGenome(4), 50, 50)!;
  erased.energy = 10;
  return { world, parent, erased };
}

const mixed: [number, number, CellType][][] = [
  [
    [0, 0, 4],
    [1, 0, 3],
    [0, 1, 5],
  ],
  [
    [0, 0, 6],
    [1, 0, 5],
    [0, 1, 4],
  ],
  [
    [0, 0, 4],
    [1, 0, 4],
  ],
  [
    [0, 0, 3],
    [1, 0, 6],
    [0, 1, 5],
  ],
];

/** A populated mixed world where feeding, attacks, births and deaths all occur. */
export function populatedWorld(): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0.2 }, false);
  for (let count = 0; count < 240; count++) {
    const organism = world.spawn(
      {
        ...roleGenome(4),
        tempo: 3,
        cells: mixed[count % 4].map(([x, y, type]) => ({ x, y, type })),
      },
      (count % 30) * 8 + 1,
      Math.floor(count / 30) * 19 + 1,
    );
    organism!.energy = 20;
  }
  for (let position = 0; position < world.food.length; position += 7)
    if (!world.occupied[position] && !world.walls[position]) world.food[position] = 1;
  return world;
}
