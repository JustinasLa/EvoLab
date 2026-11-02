import { WIDTH, HEIGHT, index, positions, type Organism, type ShadePlane } from './model';

export const ARMOR_SHADE_UNITS = 4;
export const ARMOR_SHADE_UPKEEP = 0.008;
export interface BiologicalShadeMode {
  version: 1;
  enabled: boolean;
}
export interface BiologicalShadePlane {
  units: Uint8Array;
  armorCells: number;
}
export interface BiologicalShadeSummary {
  armorCells: number;
  affectedCells: number;
  maximumUnits: number;
  sumUnits: number;
}
export interface BiologicalShadeExposure {
  anchorUnits: number;
  armorCells: number;
  leafCells: number;
  biologicalLeafUnits: number;
  paintedLeafUnits: number;
}

export function parseBiologicalShade(value: unknown): BiologicalShadeMode {
  const mode = value as BiologicalShadeMode;
  if (
    !mode ||
    typeof mode !== 'object' ||
    Array.isArray(mode) ||
    Reflect.ownKeys(mode).length !== 2 ||
    !Object.hasOwn(mode, 'version') ||
    !Object.hasOwn(mode, 'enabled') ||
    mode.version !== 1 ||
    typeof mode.enabled !== 'boolean'
  )
    throw new Error('Invalid biological shade mode.');
  return { version: 1, enabled: mode.enabled };
}

export function armorCells(organism: Pick<Organism, 'genome'>): number {
  return organism.genome.cells.filter((cell) => cell.type === 7).length;
}

export function biologicalShadeField(organisms: Iterable<Organism>): BiologicalShadePlane {
  const units = new Uint8Array(WIDTH * HEIGHT);
  let armorCells = 0;
  for (const organism of organisms) {
    const footprint = positions(organism);
    for (let cell = 0; cell < footprint.length; cell++) {
      if (organism.genome.cells[cell].type !== 7) continue;
      armorCells++;
      const position = footprint[cell],
        column = position % WIDTH,
        row = Math.floor(position / WIDTH);
      for (const target of [
        position,
        index(column - 1, row),
        index(column + 1, row),
        index(column, row - 1),
        index(column, row + 1),
      ])
        units[target] = Math.min(16, units[target] + ARMOR_SHADE_UNITS);
    }
  }
  return { units, armorCells };
}

export function biologicalShadeSummary(field: BiologicalShadePlane): BiologicalShadeSummary {
  let affectedCells = 0,
    maximumUnits = 0,
    sumUnits = 0;
  for (const units of field.units) {
    if (units) affectedCells++;
    maximumUnits = Math.max(maximumUnits, units);
    sumUnits += units;
  }
  return { armorCells: field.armorCells, affectedCells, maximumUnits, sumUnits };
}

export function biologicalShadeExposure(
  field: BiologicalShadePlane,
  painted: ShadePlane,
  organism: Organism,
): BiologicalShadeExposure {
  const footprint = positions(organism);
  let leafCells = 0,
    biologicalLeafUnits = 0,
    paintedLeafUnits = 0;
  for (let cell = 0; cell < footprint.length; cell++) {
    if (organism.genome.cells[cell].type !== 4) continue;
    leafCells++;
    biologicalLeafUnits += field.units[footprint[cell]];
    paintedLeafUnits += painted.enabled ? painted.units[footprint[cell]] : 0;
  }
  return {
    anchorUnits: field.units[index(organism.x, organism.y)],
    armorCells: armorCells(organism),
    leafCells,
    biologicalLeafUnits,
    paintedLeafUnits,
  };
}

export const combinedShadeUnits = (painted: number, biological: number): number =>
  Math.min(16, painted + biological);
