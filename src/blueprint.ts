import { validGenome, type Cell, type Genome } from './model';

export const BLUEPRINT_MAX_BYTES = 16_384;
export const BLUEPRINT_NAME_MAX = 80;
export const BLUEPRINT_DESCRIPTION_MAX = 1_000;
export const BLUEPRINT_DEFAULT_NAME = 'Untitled organism';

export interface BlueprintFileV1 {
  format: 'evolab-organism-blueprint';
  version: 1;
  name: string;
  description: string;
  genome: Genome;
}

const genomeKeys = {
  cells: true,
  preference: true,
  tolerance: true,
  tempo: true,
} satisfies Record<keyof Genome, true>;
const cellKeys = { x: true, y: true, type: true } satisfies Record<keyof Cell, true>;
const rootKeys = { format: true, version: true, name: true, description: true, genome: true };

function exactKeys(value: unknown, keys: object): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === Object.keys(keys).length &&
    Object.keys(keys).every((key) => Object.hasOwn(value, key))
  );
}

function validate(value: unknown): BlueprintFileV1 {
  if (!exactKeys(value, rootKeys) || value.format !== 'evolab-organism-blueprint')
    throw new Error('Choose a standalone EvoLab organism blueprint.');
  if (value.version !== 1) throw new Error('Unsupported blueprint version. Expected version 1.');
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > BLUEPRINT_NAME_MAX
  )
    throw new Error('Blueprint name must contain 1–80 characters and cannot be blank.');
  if (typeof value.description !== 'string' || value.description.length > BLUEPRINT_DESCRIPTION_MAX)
    throw new Error('Blueprint description must contain at most 1,000 characters.');
  const genome = value.genome;
  if (
    !exactKeys(genome, genomeKeys) ||
    !Array.isArray(genome.cells) ||
    !genome.cells.every((cell) => exactKeys(cell, cellKeys)) ||
    !validGenome(genome)
  )
    throw new Error('Blueprint needs 1–16 connected cells and valid temperature and tempo traits.');
  return {
    format: 'evolab-organism-blueprint',
    version: 1,
    name: value.name,
    description: value.description,
    genome: {
      cells: genome.cells.map((cell) => ({ x: cell.x, y: cell.y, type: cell.type })),
      preference: genome.preference,
      tolerance: genome.tolerance,
      tempo: genome.tempo,
    },
  };
}

export function parseBlueprint(text: string): BlueprintFileV1 {
  if (new TextEncoder().encode(text).byteLength > BLUEPRINT_MAX_BYTES)
    throw new Error('Blueprint files must be 16 KiB or smaller.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Could not parse this blueprint. Choose a valid JSON file.');
  }
  return validate(value);
}

export function serializeBlueprint(
  input: Pick<BlueprintFileV1, 'name' | 'description' | 'genome'>,
): string {
  const blueprint = validate({
    format: 'evolab-organism-blueprint',
    version: 1,
    name: input.name,
    description: input.description,
    genome: input.genome,
  });
  return JSON.stringify(blueprint, null, 2);
}
