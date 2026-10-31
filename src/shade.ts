import {
  WIDTH,
  HEIGHT,
  index,
  integer,
  clamp,
  positions,
  type Organism,
  type ShadeTool,
  type ShadeBrush,
  type ShadePlane,
  type ShadeField,
  type ShadeFile,
  type ShadeSummary,
  type SelectedLeafLight,
} from './model';
export type {
  ShadeTool,
  ShadeBrush,
  ShadePlane,
  ShadeField,
  ShadeFile,
  ShadeSummary,
  SelectedLeafLight,
} from './model';

export const SHADE_CAPACITY = 4096;
export const SHADE_MAX_BYTES = 65_536;
export const SHADE_UNITS_PER_FULL_LIGHT = 16;

export interface ShadeDab {
  changes: [number, number][];
  nonzeroCells: number;
  changedBrushCells: number;
}

export const shadeTool = (tool: unknown): tool is ShadeTool =>
  tool === 'shade' || tool === 'lighten' || tool === 'erase-shade';

export function validShadeBrush(value: unknown): value is ShadeBrush {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const brush = value as ShadeBrush;
  return (
    brush.rulesVersion === 1 &&
    shadeTool(brush.tool) &&
    integer(brush.radius, 0, 8) &&
    (brush.tool === 'shade'
      ? integer(brush.units, 1, SHADE_UNITS_PER_FULL_LIGHT)
      : brush.tool === 'lighten'
        ? integer(brush.units, -SHADE_UNITS_PER_FULL_LIGHT, -1)
        : brush.units === 0)
  );
}

export const emptyShade = (): ShadeField => ({
  version: 1,
  enabled: false,
  units: new Uint8Array(WIDTH * HEIGHT),
  nonzeroCells: 0,
});

export function parseShade(value: unknown): ShadeField {
  const field = value as ShadeFile;
  if (
    !field ||
    typeof field !== 'object' ||
    Array.isArray(field) ||
    Reflect.ownKeys(field).length !== 3 ||
    !['version', 'enabled', 'cells'].every((key) => Object.hasOwn(field, key)) ||
    field.version !== 1 ||
    typeof field.enabled !== 'boolean' ||
    !Array.isArray(field.cells) ||
    field.cells.length > SHADE_CAPACITY
  )
    throw new Error('Invalid painted shade field.');
  if (new TextEncoder().encode(JSON.stringify(field)).byteLength > SHADE_MAX_BYTES)
    throw new Error('Painted shade field exceeds 64 KiB.');
  const result = emptyShade();
  result.enabled = field.enabled;
  let previous = -1;
  for (const tuple of field.cells) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      !integer(tuple[0], 0, WIDTH * HEIGHT - 1) ||
      tuple[0] <= previous ||
      !integer(tuple[1], 0, SHADE_UNITS_PER_FULL_LIGHT)
    )
      throw new Error('Invalid painted shade cell.');
    previous = tuple[0];
    if (tuple[1] !== 0) {
      result.units[tuple[0]] = tuple[1];
      result.nonzeroCells++;
    }
  }
  return result;
}

export function shadeFile(field: ShadePlane): ShadeFile {
  const cells: [number, number][] = [];
  for (let position = 0; position < field.units.length; position++)
    if (field.units[position] !== 0) cells.push([position, field.units[position]]);
  return { version: 1, enabled: field.enabled, cells };
}

export function shadeSummary(field: ShadePlane): ShadeSummary {
  let maximumShadeUnits = 0,
    sumShadeUnits = 0,
    nonzeroCells = 0;
  for (const units of field.units)
    if (units !== 0) {
      maximumShadeUnits = Math.max(maximumShadeUnits, units);
      sumShadeUnits += units;
      nonzeroCells++;
    }
  return {
    version: 1,
    enabled: field.enabled,
    nonzeroCells,
    capacity: SHADE_CAPACITY,
    unitsPerFullLight: SHADE_UNITS_PER_FULL_LIGHT,
    minimumStoredLightUnits: SHADE_UNITS_PER_FULL_LIGHT - maximumShadeUnits,
    maximumStoredLightUnits: SHADE_UNITS_PER_FULL_LIGHT,
    sumShadeUnits,
  };
}

export const activeShadeUnits = (field: ShadePlane, x: number, y: number): number =>
  field.enabled ? field.units[index(x, y)] : 0;

// This is current spatial exposure, not an earlier metabolic observation.
export function selectedLeafLight(
  field: ShadePlane,
  organism: Pick<Organism, 'x' | 'y' | 'rotation' | 'genome'> | null,
): SelectedLeafLight | null {
  if (!organism) return null;
  const places = positions(organism);
  let leafCells = 0,
    minimumLightUnits = SHADE_UNITS_PER_FULL_LIGHT,
    maximumLightUnits = 0,
    sumLightUnits = 0;
  for (let cell = 0; cell < organism.genome.cells.length; cell++) {
    if (organism.genome.cells[cell].type !== 4) continue;
    const lightUnits = SHADE_UNITS_PER_FULL_LIGHT - (field.enabled ? field.units[places[cell]] : 0);
    leafCells++;
    minimumLightUnits = Math.min(minimumLightUnits, lightUnits);
    maximumLightUnits = Math.max(maximumLightUnits, lightUnits);
    sumLightUnits += lightUnits;
  }
  return leafCells ? { leafCells, minimumLightUnits, maximumLightUnits, sumLightUnits } : null;
}

// The caller must admit history/stroke capacity before installing any changes.
export function shadeDab(field: ShadeField, brush: ShadeBrush, x: number, y: number): ShadeDab {
  if (!validShadeBrush(brush) || !integer(x, 0, WIDTH - 1) || !integer(y, 0, HEIGHT - 1))
    throw new Error('Invalid painted shade dab.');
  if (!field.enabled) throw new Error('Painted shade habitats are disabled.');
  const changes: [number, number][] = [];
  let nonzeroCells = field.nonzeroCells;
  for (let vertical = -brush.radius; vertical <= brush.radius; vertical++)
    for (let horizontal = -brush.radius; horizontal <= brush.radius; horizontal++) {
      if (horizontal * horizontal + vertical * vertical > brush.radius * brush.radius) continue;
      const position = index(x + horizontal, y + vertical),
        previous = field.units[position],
        next =
          brush.tool === 'erase-shade'
            ? 0
            : clamp(previous + brush.units, 0, SHADE_UNITS_PER_FULL_LIGHT);
      if (previous === next) continue;
      nonzeroCells += Number(next !== 0) - Number(previous !== 0);
      changes.push([position, next]);
    }
  if (nonzeroCells > SHADE_CAPACITY)
    throw new Error('Painted shade capacity is 4096 nonzero cells. Whole dab rejected.');
  return { changes, nonzeroCells, changedBrushCells: changes.length };
}
