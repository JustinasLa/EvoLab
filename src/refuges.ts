import {
  WIDTH,
  HEIGHT,
  index,
  integer,
  clamp,
  temperature,
  type RefugeBrush,
  type RefugeField,
  type RefugePlane,
  type RefugeFile,
  type RefugeSummary,
  type RefugeTool,
} from './model';

export const REFUGE_CAPACITY = 4096;
export const REFUGE_MAX_BYTES = 65_536;
export const refugeTool = (tool: unknown): tool is RefugeTool =>
  tool === 'warm' || tool === 'cool' || tool === 'erase-temperature';

export function validRefugeBrush(value: {
  rulesVersion?: unknown;
  tool?: unknown;
  radius?: unknown;
  units?: unknown;
}): boolean {
  return (
    value.rulesVersion === 1 &&
    refugeTool(value.tool) &&
    integer(value.radius, 0, 8) &&
    (value.tool === 'warm'
      ? integer(value.units, 1, 32)
      : value.tool === 'cool'
        ? integer(value.units, -32, -1)
        : value.units === 0)
  );
}

export const emptyRefuges = (): RefugeField => ({
  version: 1,
  enabled: false,
  units: new Int8Array(WIDTH * HEIGHT),
  nonzeroCells: 0,
});

export function parseRefuges(value: unknown): RefugeField {
  const field = value as RefugeFile;
  if (
    !field ||
    typeof field !== 'object' ||
    Array.isArray(field) ||
    Object.keys(field).length !== 3 ||
    !['version', 'enabled', 'cells'].every((key) => Object.hasOwn(field, key)) ||
    field.version !== 1 ||
    typeof field.enabled !== 'boolean' ||
    !Array.isArray(field.cells) ||
    field.cells.length > REFUGE_CAPACITY
  )
    throw new Error('Invalid painted temperature field.');
  if (new TextEncoder().encode(JSON.stringify(field)).byteLength > REFUGE_MAX_BYTES)
    throw new Error('Painted temperature field exceeds 64 KiB.');
  const result = emptyRefuges();
  result.enabled = field.enabled;
  let previous = -1;
  for (const tuple of field.cells) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      !integer(tuple[0], 0, WIDTH * HEIGHT - 1) ||
      tuple[0] <= previous ||
      !integer(tuple[1], -32, 32)
    )
      throw new Error('Invalid painted temperature cell.');
    previous = tuple[0];
    if (tuple[1] !== 0) {
      result.units[tuple[0]] = tuple[1];
      result.nonzeroCells++;
    }
  }
  return result;
}

export function refugeFile(field: RefugePlane): RefugeFile {
  const cells: [number, number][] = [];
  for (let position = 0; position < field.units.length; position++)
    if (field.units[position] !== 0) cells.push([position, field.units[position]]);
  return { version: 1, enabled: field.enabled, cells };
}

export function refugeSummary(field: RefugePlane): RefugeSummary {
  let minimumUnits = 0,
    maximumUnits = 0,
    sumUnits = 0,
    nonzeroCells = 0;
  for (const units of field.units) {
    minimumUnits = Math.min(minimumUnits, units);
    maximumUnits = Math.max(maximumUnits, units);
    sumUnits += units;
    if (units !== 0) nonzeroCells++;
  }
  return {
    version: 1,
    enabled: field.enabled,
    nonzeroCells,
    capacity: 4096,
    unitsPerNormalized: 100,
    minimumUnits,
    maximumUnits,
    sumUnits,
  };
}

export const activeRefugeUnits = (field: RefugePlane, x: number, y: number): number =>
  field.enabled ? field.units[index(x, y)] : 0;

export function localTemperature(
  x: number,
  y: number,
  tick: number,
  strength: number,
  offset: number,
  field: RefugePlane,
): number {
  return temperature(x, y, tick, strength, offset, activeRefugeUnits(field, x, y));
}

export function refugeDab(field: RefugeField, brush: RefugeBrush, x: number, y: number) {
  if (!validRefugeBrush(brush) || !integer(x, 0, WIDTH - 1) || !integer(y, 0, HEIGHT - 1))
    throw new Error('Invalid painted temperature dab.');
  if (!field.enabled) throw new Error('Painted temperature refuges are disabled.');
  const changes: [number, number][] = [],
    visited = new Set<number>();
  let nonzeroCells = field.nonzeroCells;
  for (let vertical = -brush.radius; vertical <= brush.radius; vertical++)
    for (let horizontal = -brush.radius; horizontal <= brush.radius; horizontal++) {
      if (horizontal * horizontal + vertical * vertical > brush.radius * brush.radius) continue;
      const position = index(x + horizontal, y + vertical);
      if (visited.has(position)) continue;
      visited.add(position);
      const previous = field.units[position],
        next = brush.tool === 'erase-temperature' ? 0 : clamp(previous + brush.units, -32, 32);
      if (previous === next) continue;
      nonzeroCells += Number(next !== 0) - Number(previous !== 0);
      changes.push([position, next]);
    }
  if (nonzeroCells > REFUGE_CAPACITY)
    throw new Error('Painted temperature capacity is 4096 nonzero cells. Whole dab rejected.');
  return { changes, nonzeroCells, changedBrushCells: changes.length };
}
