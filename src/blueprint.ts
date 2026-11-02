import {
  validGenome,
  validHistoricalGenome,
  migrateHistoricalGenome,
  cloneGenome,
  exactDataRecord,
  type Genome,
  type HistoricalGenome,
} from './model';

export const BLUEPRINT_MAX_BYTES = 16_384;
export const BLUEPRINT_NAME_MAX = 80;
export const BLUEPRINT_DESCRIPTION_MAX = 1_000;
export const BLUEPRINT_DEFAULT_NAME = 'Untitled organism';

export interface BlueprintFileV1 {
  format: 'evolab-organism-blueprint';
  version: 1;
  name: string;
  description: string;
  genome: HistoricalGenome;
}
export interface BlueprintFile {
  format: 'evolab-organism-blueprint';
  version: 6;
  name: string;
  description: string;
  genome: Genome;
}

const genomeKeys = {
  cells: true,
  preference: true,
  tolerance: true,
  tempo: true,
};
const cellKeys = { x: true, y: true, type: true };
const rootKeys = { format: true, version: true, name: true, description: true, genome: true };

function exactKeys(value: unknown, keys: object): value is Record<string, unknown> {
  return exactDataRecord(value, Object.keys(keys));
}

function validate(value: unknown): BlueprintFile {
  if (!exactKeys(value, rootKeys) || value.format !== 'evolab-organism-blueprint')
    throw new Error('Choose a standalone EvoLab organism blueprint.');
  if (
    value.version !== 1 &&
    value.version !== 2 &&
    value.version !== 3 &&
    value.version !== 4 &&
    value.version !== 5 &&
    value.version !== 6
  )
    throw new Error('Unsupported blueprint version. Expected version 1, 2, 3, 4, 5 or 6.');
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
    !(value.version === 1
      ? exactKeys(genome, genomeKeys) &&
        Array.isArray(genome.cells) &&
        genome.cells.every((cell) => exactKeys(cell, cellKeys)) &&
        validHistoricalGenome(genome)
      : validGenome(
          genome,
          value.version >= 3,
          value.version >= 4,
          value.version >= 5,
          value.version >= 6,
        ))
  )
    throw new Error('Blueprint needs 1–16 connected cells and valid temperature and tempo traits.');
  return {
    format: 'evolab-organism-blueprint',
    version: 6,
    name: value.name,
    description: value.description,
    genome:
      value.version === 1
        ? migrateHistoricalGenome(genome as HistoricalGenome)
        : cloneGenome(genome as Genome),
  };
}

export function parseBlueprint(text: string): BlueprintFile {
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
  input: Pick<BlueprintFile, 'name' | 'description' | 'genome'>,
): string {
  const blueprint = validate({
    format: 'evolab-organism-blueprint',
    version: 6,
    name: input.name,
    description: input.description,
    genome: input.genome,
  });
  const text = JSON.stringify(blueprint, null, 2);
  if (new TextEncoder().encode(text).byteLength > BLUEPRINT_MAX_BYTES)
    throw new Error('Blueprint files must be 16 KiB or smaller.');
  return text;
}
