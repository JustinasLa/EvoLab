import {
  WIDTH,
  HEIGHT,
  Random,
  founder,
  positions,
  index,
  integer,
  type TerrainRecipe,
} from './model';

export const DEFAULT_TERRAIN: Readonly<TerrainRecipe> = Object.freeze({
  version: 1,
  preset: 'porous-ridges',
  seed: null,
});
export const TERRAIN_LABELS = {
  'open-field': 'Open field',
  'porous-ridges': 'Porous ridges',
  'chambered-refuges': 'Chambered refuges',
} as const;

export function validTerrain(value: unknown): value is TerrainRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recipe = value as TerrainRecipe;
  return (
    Object.keys(value).length === 3 &&
    Object.hasOwn(value, 'version') &&
    Object.hasOwn(value, 'preset') &&
    Object.hasOwn(value, 'seed') &&
    recipe.version === 1 &&
    typeof recipe.preset === 'string' &&
    Object.hasOwn(TERRAIN_LABELS, recipe.preset) &&
    (recipe.seed === null || integer(recipe.seed, 0, 4294967295))
  );
}

export const sameTerrain = (left: TerrainRecipe, right: TerrainRecipe): boolean =>
  left.version === right.version && left.preset === right.preset && left.seed === right.seed;

export function resolvedTerrainSeed(recipe: TerrainRecipe, worldSeed: number): number {
  if (!validTerrain(recipe) || !integer(worldSeed, 0, 4294967295))
    throw new Error('Invalid wall recipe or world seed.');
  return recipe.seed ?? worldSeed;
}

export function generateTerrain(recipe: TerrainRecipe, worldSeed: number): Uint8Array {
  const random = new Random(resolvedTerrainSeed(recipe, worldSeed)),
    walls = new Uint8Array(WIDTH * HEIGHT);
  if (recipe.preset === 'porous-ridges') {
    for (let ridge = 0; ridge < 7; ridge++) {
      const anchorX = 20 + random.int(200),
        anchorY = 15 + random.int(126);
      for (let offset = -9; offset <= 9; offset++)
        if (Math.abs(offset) > 2)
          walls[index(anchorX + offset, anchorY + Math.round(Math.sin(offset / 3) * 2))] = 1;
    }
  } else if (recipe.preset === 'chambered-refuges') {
    const shiftX = random.int(60),
      shiftY = random.int(52);
    for (let vertical = 0; vertical < HEIGHT; vertical++)
      for (let horizontal = 0; horizontal < WIDTH; horizontal++)
        if (horizontal % 60 === 0 || vertical % 52 === 0)
          walls[index(horizontal + shiftX, vertical + shiftY)] = 1;
    for (let column = 0; column < 4; column++)
      for (let row = 0; row < 3; row++) {
        const doorway = 52 * row + 8 + random.int(32);
        for (let offset = 0; offset < 5; offset++)
          walls[index(60 * column + shiftX, doorway + offset + shiftY)] = 0;
      }
    for (let column = 0; column < 4; column++)
      for (let row = 0; row < 3; row++) {
        const doorway = 60 * column + 8 + random.int(40);
        for (let offset = 0; offset < 5; offset++)
          walls[index(doorway + offset + shiftX, 52 * row + shiftY)] = 0;
      }
  }
  for (const cell of positions({ x: WIDTH / 2, y: HEIGHT / 2, rotation: 0, genome: founder(0) }))
    walls[cell] = 0;
  return walls;
}
