import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, index, type CellType, type Genome } from '../../src/model';

export const roleGenome = (type: CellType): Genome => ({
  cells: [{ x: 0, y: 0, type }],
  preference: 0.5,
  tolerance: 0.6,
  tempo: 12,
  behavior: { version: 1, mode: 'legacy' },
});

export function roleScene() {
  const world = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
  const attacker = world.spawn(
    {
      ...roleGenome(3),
      cells: [
        { x: 0, y: 0, type: 3 },
        { x: 1, y: 0, type: 4 },
        { x: 0, y: 1, type: 6 },
      ],
    },
    20,
    20,
  )!;
  attacker.age = 3;
  attacker.energy = 12;
  const victim = world.spawn(roleGenome(3), 20, 22)!;
  victim.energy = 0.5;
  const armor = world.spawn(roleGenome(7), 19, 21)!;
  armor.energy = 10;
  world.food[index(19, 20)] = 1;
  return { world, attacker, victim, armor };
}
