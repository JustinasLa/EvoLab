export type Course = 'meadow' | 'steps' | 'gaps';
export interface Settings {
  seed: number;
  population: number;
  gravity: number;
  course: Course;
  mutation: number;
}
export interface Gene {
  parent: number;
  length: number;
  width: number;
  angle: number;
  frequency: number;
  phase: number;
  amplitude: number;
  torque: number;
}
export interface Genome {
  id: string;
  hue: number;
  genes: Gene[];
}
export interface Trial {
  genome: Genome;
  fitness: number;
  distance: number;
  frames: number[][];
  energy: number;
}
export interface Generation {
  index: number;
  best: number;
  median: number;
  diversity: number;
  champion: Trial;
}
export interface ChampionFile {
  version: 1;
  settings: Settings;
  genome: Genome;
}
export const DEFAULTS: Settings = {
  seed: 42,
  population: 24,
  gravity: 9.81,
  course: 'meadow',
  mutation: 0.18,
};
export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export class Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi));
  }
}

export function gene(random: Random, parent: number): Gene {
  return {
    parent,
    length: random.range(0.45, 1.15),
    width: random.range(0.09, 0.19),
    angle: random.range(-Math.PI, Math.PI),
    frequency: random.range(0.5, 2.5),
    phase: random.range(0, Math.PI * 2),
    amplitude: random.range(0.25, 1.3),
    torque: random.range(4, 25),
  };
}

export function creature(random: Random): Genome {
  const count = random.int(4, 8);
  const genes = [gene(random, -1)];
  genes[0].angle = 0;
  for (let i = 1; i < count; i++) genes.push(gene(random, i < 3 ? 0 : random.int(0, i)));
  return {
    id: random.int(0, 0xffffff).toString(36).padStart(5, '0'),
    hue: random.int(135, 320),
    genes,
  };
}

export function mutate(source: Genome, random: Random, rate: number): Genome {
  const child = structuredClone(source);
  child.id = random.int(0, 0xffffff).toString(36).padStart(5, '0');
  child.hue = (child.hue + random.range(-14, 14) + 360) % 360;
  for (const g of child.genes) {
    if (random.next() < rate) g.length = clamp(g.length + random.range(-0.25, 0.25), 0.3, 1.5);
    if (random.next() < rate) g.width = clamp(g.width + random.range(-0.04, 0.04), 0.07, 0.25);
    if (random.next() < rate) g.angle = clamp(g.angle + random.range(-0.6, 0.6), -Math.PI, Math.PI);
    if (random.next() < rate) g.frequency = clamp(g.frequency + random.range(-0.5, 0.5), 0.2, 3);
    if (random.next() < rate) g.phase += random.range(-1, 1);
    if (random.next() < rate) g.amplitude = clamp(g.amplitude + random.range(-0.3, 0.3), 0.1, 1.4);
    if (random.next() < rate) g.torque = clamp(g.torque + random.range(-5, 5), 2, 30);
  }
  child.genes[0].angle = 0;
  if (random.next() < rate && child.genes.length < 10)
    child.genes.push(gene(random, random.int(0, child.genes.length)));
  if (random.next() < rate && child.genes.length > 3) child.genes.pop();
  return child;
}

function numberIn(x: unknown, low: number, high: number): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= low && x <= high;
}

export function validSettings(s: unknown): s is Settings {
  if (!s || typeof s !== 'object') return false;
  const v = s as Settings;
  return (
    numberIn(v.seed, 0, 4294967295) &&
    Number.isInteger(v.seed) &&
    [12, 24, 48].includes(v.population) &&
    numberIn(v.gravity, 1.6, 20) &&
    ['meadow', 'steps', 'gaps'].includes(v.course) &&
    numberIn(v.mutation, 0.05, 0.6)
  );
}

export function readChampion(text: string): ChampionFile {
  if (text.length > 32000)
    throw new Error('This file is too large. Choose an EvoLab champion JSON.');
  const file = JSON.parse(text) as ChampionFile;
  if (
    !file ||
    file.version !== 1 ||
    !validSettings(file.settings) ||
    !file.genome ||
    typeof file.genome.id !== 'string' ||
    !/^[a-z0-9]{1,12}$/.test(file.genome.id) ||
    !numberIn(file.genome.hue, 0, 360) ||
    !Array.isArray(file.genome.genes) ||
    file.genome.genes.length < 3 ||
    file.genome.genes.length > 10
  )
    throw new Error('Not a valid EvoLab champion.');
  for (const [i, g] of file.genome.genes.entries()) {
    if (
      !g ||
      !Number.isInteger(g.parent) ||
      (i === 0 ? g.parent !== -1 || g.angle !== 0 : g.parent < 0 || g.parent >= i) ||
      !numberIn(g.length, 0.3, 1.5) ||
      !numberIn(g.width, 0.07, 0.25) ||
      !numberIn(g.angle, -Math.PI, Math.PI) ||
      !numberIn(g.frequency, 0.2, 3) ||
      !numberIn(g.phase, -1000000, 1000000) ||
      !numberIn(g.amplitude, 0.1, 1.4) ||
      !numberIn(g.torque, 2, 30)
    )
      throw new Error('This creature has invalid body or motor values.');
  }
  return structuredClone(file);
}
