import {
  DEFAULTS,
  WIDTH,
  HEIGHT,
  LIMIT,
  Random,
  index,
  positions,
  founder,
  mutate,
  validGenome,
  validSettings,
  finite,
  integer,
  speciesName,
  temperature,
  type Genome,
  type Organism,
  type Settings,
  type WorldFile,
  type Frame,
  type Species,
  type Tool,
} from './model';
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
export class Ecosystem {
  random: Random;
  settings: Settings;
  organisms = new Map<number, Organism>();
  food = new Uint8Array(WIDTH * HEIGHT);
  walls = new Uint8Array(WIDTH * HEIGHT);
  occupied = new Int32Array(WIDTH * HEIGHT);
  tick = 0;
  births = 0;
  deaths = 0;
  nextId = 1;
  nextSpecies = 5;
  eventUntil = 0;
  eventOffset = 0;
  constructor(settings: Settings = DEFAULTS, seed = true) {
    this.settings = { ...settings };
    this.random = new Random(settings.seed);
    if (seed) this.seed();
  }
  seed(): void {
    // Porous mineral ridges partition habitats without sealing them off.
    for (let i = 0; i < 7; i++) {
      const x = 20 + this.random.int(WIDTH - 40),
        y = 15 + this.random.int(HEIGHT - 30);
      for (let j = -9; j <= 9; j++)
        if (Math.abs(j) > 2) {
          const p = index(x + j, y + Math.round(Math.sin(j / 3) * 2));
          this.walls[p] = 1;
          this.food[p] = 0;
        }
    }
    const genome = founder(0),
      x = WIDTH / 2,
      y = HEIGHT / 2;
    for (const position of positions({ genome, x, y, rotation: 0 })) this.walls[position] = 0;
    this.spawn(genome, x, y, 1);
  }
  canPlace(o: Pick<Organism, 'x' | 'y' | 'rotation' | 'genome'>, ignore = 0): boolean {
    return positions(o).every(
      (i) => !this.walls[i] && (!this.occupied[i] || this.occupied[i] === ignore),
    );
  }
  spawn(
    genome: Genome,
    x: number,
    y: number,
    species = this.nextSpecies++,
    parent?: Organism,
    rotation = 0,
  ): Organism | undefined {
    if (this.organisms.size >= LIMIT) return;
    const o: Organism = {
      id: this.nextId,
      species,
      x: (x + WIDTH) % WIDTH,
      y: (y + HEIGHT) % HEIGHT,
      rotation,
      direction: this.random.int(4),
      age: 0,
      energy: 8 + genome.cells.length,
      generation: parent ? parent.generation + 1 : 0,
      children: 0,
      ancestry: parent
        ? parent.species === species
          ? [...parent.ancestry]
          : [...parent.ancestry, parent.species].slice(-8)
        : [],
      genome: structuredClone(genome),
    };
    if (!this.canPlace(o)) return;
    this.nextId++;
    this.organisms.set(o.id, o);
    for (const i of positions(o)) {
      this.occupied[i] = o.id;
      this.food[i] = 0;
    }
    return o;
  }
  kill(o: Organism): void {
    for (const i of positions(o)) {
      this.occupied[i] = 0;
      this.food[i] = 1;
    }
    this.organisms.delete(o.id);
    this.deaths++;
  }
  move(o: Organism, dx: number, dy: number, rotation = o.rotation): boolean {
    const target = {
      ...o,
      x: (o.x + dx + WIDTH) % WIDTH,
      y: (o.y + dy + HEIGHT) % HEIGHT,
      rotation,
    };
    if (!this.canPlace(target, o.id)) return false;
    for (const i of positions(o)) this.occupied[i] = 0;
    Object.assign(o, { x: target.x, y: target.y, rotation });
    for (const i of positions(o)) {
      this.occupied[i] = o.id;
      this.food[i] = 0;
    }
    return true;
  }
  step(): void {
    this.tick++;
    const daylight = 0.65 + 0.35 * Math.sin(this.tick / 180);
    for (const o of [...this.organisms.values()]) {
      if (!this.organisms.has(o.id)) continue;
      o.age++;
      const temp = temperature(
        o.x,
        o.y,
        this.tick,
        this.settings.climate,
        this.tick < this.eventUntil ? this.eventOffset : 0,
      );
      const stress = Math.max(0, Math.abs(temp - o.genome.preference) - o.genome.tolerance);
      const upkeep = 0.012 + Math.max(0, o.genome.tolerance - 0.2) * 0.025;
      o.energy -= (upkeep + stress * 0.2) * o.genome.cells.length;
      const places = positions(o);
      for (let c = 0; c < o.genome.cells.length; c++) {
        const type = o.genome.cells[c].type,
          p = places[c],
          x = p % WIDTH,
          y = Math.floor(p / WIDTH);
        if (type === 4) {
          o.energy += 0.04 * daylight * (1 - stress);
          if (this.random.next() < (this.settings.nutrients / 100) * daylight * (1 - stress)) {
            const [dx, dy] = DIRECTIONS[this.random.int(4)],
              n = index(x + dx, y + dy);
            if (!this.occupied[n] && !this.walls[n]) this.food[n] = 1;
          }
        }
        if (type === 3 || type === 6)
          for (const [dx, dy] of DIRECTIONS) {
            const n = index(x + dx, y + dy);
            if (type === 3 && this.food[n]) {
              this.food[n] = 0;
              o.energy += 2.2;
            }
            const victim = this.organisms.get(this.occupied[n]);
            if (type === 6 && victim && victim.id !== o.id && o.age % 4 === 0) {
              const cell = positions(victim).indexOf(n);
              if (victim.genome.cells[cell].type !== 7) {
                victim.energy -= 2.5;
                o.energy += 0.65;
              }
            }
          }
      }
      if (o.genome.cells.some((c) => c.type === 5) && o.age % o.genome.tempo === 0) {
        if (o.genome.cells.some((c) => c.type === 8)) {
          let best = -Infinity,
            direction = o.direction;
          for (let d = 0; d < 4; d++) {
            const [dx, dy] = DIRECTIONS[d];
            let score = this.random.next() * 0.3;
            for (let r = 1; r <= 5; r++) {
              const p = index(o.x + dx * r, o.y + dy * r);
              score += this.food[p] / r;
              if (this.walls[p]) score -= 1 / r;
              const seen = this.organisms.get(this.occupied[p]);
              if (seen && seen.id !== o.id)
                score += (o.genome.cells.some((c) => c.type === 6) ? 0.3 : -0.25) / r;
            }
            if (score > best) {
              best = score;
              direction = d;
            }
          }
          o.direction = direction;
        } else if (this.random.next() < 0.12) o.direction = this.random.int(4);
        const [dx, dy] = DIRECTIONS[o.direction];
        if (!this.move(o, dx, dy)) {
          o.direction = this.random.int(4);
          this.move(o, 0, 0, (o.rotation + 1) % 4);
        }
        o.energy -= 0.03;
      }
      if (o.energy <= 0 || o.age > 900 + o.genome.cells.length * 75) {
        this.kill(o);
        continue;
      }
      if (
        o.age > 30 &&
        o.age % 11 === 0 &&
        o.energy > o.genome.cells.length * 3 + 9 &&
        this.organisms.size < LIMIT
      ) {
        const changed = this.random.next() < this.settings.mutation;
        const genome = changed ? mutate(o.genome, this.random) : o.genome;
        for (let attempt = 0; attempt < 3; attempt++) {
          const [dx, dy] = DIRECTIONS[this.random.int(4)],
            distance = 3 + this.random.int(5);
          const child = this.spawn(
            genome,
            o.x + dx * distance,
            o.y + dy * distance,
            changed ? this.nextSpecies : o.species,
            o,
            this.random.int(4),
          );
          if (child) {
            if (changed) this.nextSpecies++;
            child.energy = genome.cells.length * 1.5 + 3;
            o.energy -= child.energy + 2;
            o.children++;
            this.births++;
            break;
          }
        }
      }
    }
  }
  paint(tool: Tool, x: number, y: number, radius: number, genome: Genome): void {
    if (tool === 'plant') {
      this.spawn(genome, x, y);
      return;
    }
    const victims = new Set<number>();
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++)
        if (dx * dx + dy * dy <= radius * radius) {
          const p = index(x + dx, y + dy);
          if (tool === 'erase') {
            if (this.occupied[p]) victims.add(this.occupied[p]);
            this.food[p] = 0;
            this.walls[p] = 0;
          }
          if (tool === 'food' && !this.walls[p] && !this.occupied[p]) this.food[p] = 1;
          if (tool === 'wall' && !this.occupied[p]) {
            this.walls[p] = 1;
            this.food[p] = 0;
          }
        }
    for (const id of victims) {
      this.kill(this.organisms.get(id)!);
    }
    if (tool === 'erase')
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++)
          if (dx * dx + dy * dy <= radius * radius) this.food[index(x + dx, y + dy)] = 0;
  }
  shock(kind: 'cold' | 'heat'): void {
    this.eventOffset = kind === 'cold' ? -0.32 : 0.32;
    this.eventUntil = this.tick + 900;
  }
  frame(): Frame {
    const cells = new Uint8Array(this.food.length),
      ids = this.occupied.slice();
    const species = new Map<number, Species>();
    let generation = 0,
      food = 0;
    for (let i = 0; i < cells.length; i++) {
      cells[i] = this.walls[i] ? 2 : this.food[i] ? 1 : 0;
      if (this.food[i]) food++;
    }
    for (const o of this.organisms.values()) {
      positions(o).forEach((p, c) => {
        cells[p] = o.genome.cells[c].type;
      });
      const s = species.get(o.species);
      if (s) {
        s.count++;
        s.generation = Math.max(s.generation, o.generation);
      } else
        species.set(o.species, {
          id: o.species,
          count: 1,
          generation: o.generation,
          genome: o.genome,
          name: speciesName(o.genome),
        });
      generation = Math.max(generation, o.generation);
    }
    return {
      cells,
      ids,
      offset: this.tick < this.eventUntil ? this.eventOffset : 0,
      climate: this.settings.climate,
      stats: {
        tick: this.tick,
        population: this.organisms.size,
        species: species.size,
        births: this.births,
        deaths: this.deaths,
        generation,
        food,
        season: ['Vernal drift', 'Warm season', 'Cooling drift', 'Cold season'][
          Math.floor(this.tick / 900) % 4
        ],
        event:
          this.tick < this.eventUntil
            ? `${this.eventOffset < 0 ? 'Cold snap' : 'Heatwave'} · ${this.eventUntil - this.tick} ticks`
            : 'Drifting climate',
        top: [...species.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      },
    };
  }
  save(): WorldFile {
    return {
      version: 2,
      settings: { ...this.settings },
      random: this.random.state,
      tick: this.tick,
      births: this.births,
      deaths: this.deaths,
      nextId: this.nextId,
      nextSpecies: this.nextSpecies,
      eventUntil: this.eventUntil,
      eventOffset: this.eventOffset,
      food: [...this.food.keys()].filter((i) => this.food[i]),
      walls: [...this.walls.keys()].filter((i) => this.walls[i]),
      organisms: structuredClone([...this.organisms.values()]),
    };
  }
  static load(text: string): Ecosystem {
    if (text.length > 2500000) throw new Error('World file exceeds 2.5 MB.');
    const f = JSON.parse(text) as WorldFile;
    if (
      !f ||
      f.version !== 2 ||
      !validSettings(f.settings) ||
      !integer(f.random, -2147483648, 4294967295) ||
      !integer(f.tick, 0, 1e9) ||
      !integer(f.births, 0, 1e9) ||
      !integer(f.deaths, 0, 1e9) ||
      !integer(f.nextId, 1, 1e9) ||
      !integer(f.nextSpecies, 1, 1e9) ||
      !integer(f.eventUntil, 0, 1e9) ||
      !finite(f.eventOffset, -0.32, 0.32) ||
      !Array.isArray(f.organisms) ||
      f.organisms.length > LIMIT
    )
      throw new Error('Not a valid EvoLab ecosystem (version 2).');
    const world = new Ecosystem(f.settings, false);
    for (const [field, array] of [
      ['food', world.food],
      ['walls', world.walls],
    ] as const) {
      const values = f[field];
      if (
        !Array.isArray(values) ||
        values.length > WIDTH * HEIGHT ||
        !values.every((i) => integer(i, 0, WIDTH * HEIGHT - 1))
      )
        throw new Error('Invalid world terrain.');
      for (const i of values) array[i] = 1;
    }
    for (const o of f.organisms) {
      if (
        !o ||
        !integer(o.id, 1, f.nextId - 1) ||
        world.organisms.has(o.id) ||
        !integer(o.species, 1, f.nextSpecies - 1) ||
        !integer(o.x, 0, WIDTH - 1) ||
        !integer(o.y, 0, HEIGHT - 1) ||
        !integer(o.rotation, 0, 3) ||
        !integer(o.direction, 0, 3) ||
        !integer(o.age, 0, 100000) ||
        !finite(o.energy, -1000, 100000) ||
        !integer(o.generation, 0, 1e9) ||
        !integer(o.children, 0, 1e9) ||
        !Array.isArray(o.ancestry) ||
        o.ancestry.length > 8 ||
        !o.ancestry.every((s) => integer(s, 1, f.nextSpecies - 1)) ||
        !validGenome(o.genome) ||
        !world.canPlace(o)
      )
        throw new Error('Invalid or overlapping organism.');
      world.organisms.set(o.id, structuredClone(o));
      for (const p of positions(o)) {
        world.occupied[p] = o.id;
        world.food[p] = 0;
      }
    }
    for (let i = 0; i < world.food.length; i++) if (world.walls[i]) world.food[i] = 0;
    Object.assign(world, {
      tick: f.tick,
      births: f.births,
      deaths: f.deaths,
      nextId: f.nextId,
      nextSpecies: f.nextSpecies,
      eventUntil: f.eventUntil,
      eventOffset: f.eventOffset,
    });
    world.random.state = f.random;
    return world;
  }
}
