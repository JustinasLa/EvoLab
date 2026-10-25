export const WIDTH = 240;
export const HEIGHT = 156;
export const LIMIT = 1600;
export const COLORS = [
  '#090f16',
  '#284b3b',
  '#374250',
  '#edae57',
  '#66db8b',
  '#58bce5',
  '#ed7085',
  '#a38ae4',
  '#dfebda',
];
export const CELL_NAMES = ['Mouth', 'Leaf', 'Motor', 'Stinger', 'Armor', 'Eye'];
export type CellType = 3 | 4 | 5 | 6 | 7 | 8;
export interface Cell {
  x: number;
  y: number;
  type: CellType;
}
export interface Genome {
  cells: Cell[];
  preference: number;
  tolerance: number;
  tempo: number;
}
export interface Organism {
  id: number;
  species: number;
  x: number;
  y: number;
  rotation: number;
  direction: number;
  age: number;
  energy: number;
  generation: number;
  children: number;
  ancestry: number[];
  genome: Genome;
}
export interface Settings {
  seed: number;
  mutation: number;
  nutrients: number;
  climate: number;
}
export const DEFAULTS: Settings = { seed: 42, mutation: 0.12, nutrients: 5, climate: 0.8 };
export type Tool = 'inspect' | 'pan' | 'food' | 'wall' | 'erase' | 'plant';
export interface Species {
  id: number;
  count: number;
  generation: number;
  genome: Genome;
  name: string;
}
export interface Stats {
  tick: number;
  population: number;
  species: number;
  births: number;
  deaths: number;
  generation: number;
  food: number;
  season: string;
  event: string;
  top: Species[];
}
export interface Frame {
  cells: Uint8Array;
  ids: Int32Array;
  stats: Stats;
  climate: number;
  offset: number;
}
export interface WorldFile {
  version: 2;
  settings: Settings;
  random: number;
  tick: number;
  births: number;
  deaths: number;
  nextId: number;
  nextSpecies: number;
  eventUntil: number;
  eventOffset: number;
  food: number[];
  walls: number[];
  organisms: Organism[];
}
export const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));
export const index = (x: number, y: number): number =>
  (((y % HEIGHT) + HEIGHT) % HEIGHT) * WIDTH + (((x % WIDTH) + WIDTH) % WIDTH);
export class Random {
  constructor(public state: number) {
    this.state >>>= 0;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}
export function positions(o: Pick<Organism, 'x' | 'y' | 'rotation' | 'genome'>): number[] {
  return o.genome.cells.map((c) => {
    let x = c.x,
      y = c.y;
    for (let i = 0; i < o.rotation; i++) [x, y] = [-y, x];
    return index(o.x + x, o.y + y);
  });
}
export function connected(cells: Cell[]): boolean {
  if (!cells.length) return false;
  const seen = new Set([`${cells[0].x},${cells[0].y}`]);
  for (let pass = 0; pass < cells.length; pass++)
    for (const a of cells)
      if (seen.has(`${a.x},${a.y}`))
        for (const b of cells)
          if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) seen.add(`${b.x},${b.y}`);
  return seen.size === cells.length;
}
export function validGenome(value: unknown): value is Genome {
  if (!value || typeof value !== 'object') return false;
  const g = value as Genome;
  return (
    Array.isArray(g.cells) &&
    g.cells.length > 0 &&
    g.cells.length <= 16 &&
    g.cells.every(
      (c) =>
        c &&
        Number.isInteger(c.x) &&
        Number.isInteger(c.y) &&
        Math.abs(c.x) <= 4 &&
        Math.abs(c.y) <= 4 &&
        Number.isInteger(c.type) &&
        c.type >= 3 &&
        c.type <= 8,
    ) &&
    new Set(g.cells.map((c) => `${c.x},${c.y}`)).size === g.cells.length &&
    connected(g.cells) &&
    finite(g.preference, 0, 1) &&
    finite(g.tolerance, 0.12, 0.6) &&
    integer(g.tempo, 2, 12)
  );
}
export const finite = (v: unknown, low: number, high: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;
export const integer = (v: unknown, low: number, high: number): v is number =>
  finite(v, low, high) && Number.isInteger(v);
export function validSettings(value: unknown): value is Settings {
  if (!value || typeof value !== 'object') return false;
  const s = value as Settings;
  return (
    integer(s.seed, 0, 4294967295) &&
    finite(s.mutation, 0, 0.4) &&
    integer(s.nutrients, 0, 20) &&
    finite(s.climate, 0, 1)
  );
}
export function founder(kind: number, preference = 0.5): Genome {
  const types: CellType[][] = [
    [3, 4, 4, 4, 4],
    [3, 5, 8, 3],
    [3, 5, 6, 8, 7],
    [3, 3, 5, 7],
  ];
  const xy = [
    [0, 0],
    [-1, 0],
    [0, -1],
    [1, 0],
    [0, 1],
  ];
  return {
    cells: types[kind].map((type, i) => ({ x: xy[i][0], y: xy[i][1], type })),
    preference,
    tolerance: 0.3,
    tempo: kind === 2 ? 3 : 5,
  };
}
export function mutate(source: Genome, random: Random): Genome {
  const g = structuredClone(source);
  const mode = random.int(3);
  if (mode === 0 && g.cells.length < 16) {
    const c = g.cells[random.int(g.cells.length)];
    const [dx, dy] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ][random.int(4)];
    const next: Cell = { x: c.x + dx, y: c.y + dy, type: (3 + random.int(6)) as CellType };
    if (
      Math.abs(next.x) <= 4 &&
      Math.abs(next.y) <= 4 &&
      !g.cells.some((c) => c.x === next.x && c.y === next.y)
    )
      g.cells.push(next);
  } else if (mode === 1 && g.cells.length > 1) {
    const remove = random.int(g.cells.length);
    const rest = g.cells.filter((_, i) => i !== remove);
    if (connected(rest)) g.cells = rest;
  } else g.cells[random.int(g.cells.length)].type = (3 + random.int(6)) as CellType;
  g.preference = clamp(g.preference + (random.next() - 0.5) * 0.18, 0, 1);
  g.tolerance = clamp(g.tolerance + (random.next() - 0.5) * 0.06, 0.12, 0.6);
  g.tempo = clamp(g.tempo + random.int(3) - 1, 2, 12);
  return g;
}
export function speciesName(g: Genome): string {
  if (g.cells.some((c) => c.type === 6)) return 'Hunter';
  if (g.cells.filter((c) => c.type === 4).length >= 2) return 'Bloom';
  return g.cells.some((c) => c.type === 5) ? 'Forager' : 'Rootling';
}
export function temperature(
  x: number,
  y: number,
  tick: number,
  strength: number,
  offset = 0,
): number {
  return clamp(
    0.5 +
      strength *
        (0.27 * Math.sin((x / WIDTH) * Math.PI * 2 - tick / 1100) +
          0.13 * Math.cos((y / HEIGHT) * Math.PI * 2) +
          0.12 * Math.sin(tick / 650)) +
      offset,
    0,
    1,
  );
}
