import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, release, totalmem } from 'node:os';
import { Ecosystem } from '../../src/ecosystem';
import {
  DEFAULTS,
  HEIGHT,
  WIDTH,
  LIMIT,
  TELEMETRY_CAPACITY,
  TELEMETRY_INTERVAL_TICKS,
  LINEAGE_SUMMARY_CAPACITY,
  LINEAGE_EVENT_CAPACITY,
  INTERVENTION_CAPACITY,
  WORLD_MAX_BYTES,
  encodeLegacyValue,
  validGenome,
  type Genome,
} from '../../src/model';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function context() {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  return {
    head: git('rev-parse', 'HEAD'),
    dirtyFiles: git('diff', '--name-only'),
    sourceSHA256: Object.fromEntries(
      [
        'src/ecosystem.ts',
        'src/model.ts',
        'src/terrain.ts',
        'src/refuges.ts',
        'src/lineage.ts',
        'test/long-run/support.ts',
        'test/long-run/soak.spec.ts',
        'test/long-run/throughput.spec.ts',
        'vitest.long-run.config.ts',
      ].map((file) => [file, digest(readFileSync(file, 'utf8'))]),
    ),
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpuModel: cpus()[0]?.model,
    logicalCPUs: cpus().length,
    availableParallelism: availableParallelism(),
    memoryBytes: totalmem(),
    loadAverage: loadavg(),
    timestamp: new Date().toISOString(),
    telemetry: true,
    lineage: true,
    rendering: 'none; direct real Ecosystem, not worker/browser throughput',
  };
}

export function receipt(name: string, evidence: unknown): void {
  mkdirSync('.scratch/long-run', { recursive: true });
  writeFileSync(`.scratch/long-run/${name}.json`, JSON.stringify(evidence, null, 2) + '\n');
}

function integer(value: number, min: number, max: number): void {
  assert.ok(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${value} in ${min}..${max}`,
  );
}
function finite(value: number, min: number, max: number): void {
  assert.ok(Number.isFinite(value) && value >= min && value <= max, `${value} in ${min}..${max}`);
}

// Independent cardinal flood fill and coordinate projection supplement the codec.
function anatomy(genome: Genome): void {
  assert.ok(validGenome(genome));
  const remaining = new Set(genome.cells.map(({ x, y }) => `${x},${y}`));
  assert.equal(remaining.size, genome.cells.length);
  const frontier = [genome.cells[0]];
  remaining.delete(`${frontier[0].x},${frontier[0].y}`);
  for (const { x, y } of frontier)
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      if (remaining.delete(`${x + dx},${y + dy}`)) frontier.push({ x: x + dx, y: y + dy, type: 3 });
    }
  assert.equal(remaining.size, 0, 'connected anatomy');
}

export function invariants(world: Ecosystem): void {
  integer(world.tick, 0, 1e9);
  integer(world.organisms.size, 0, LIMIT);
  for (const value of [world.nextId, world.nextSpecies]) integer(value, 1, 1e9);
  for (const value of [world.births, world.deaths]) integer(value, 0, 1e9);
  const occupied = new Int32Array(WIDTH * HEIGHT);
  const lineageCounts = new Map<number, number>();
  for (const [id, organism] of world.organisms) {
    assert.equal(id, organism.id);
    integer(id, 1, world.nextId - 1);
    integer(organism.species, 1, world.nextSpecies - 1);
    integer(organism.x, 0, WIDTH - 1);
    integer(organism.y, 0, HEIGHT - 1);
    integer(organism.rotation, 0, 3);
    integer(organism.direction, 0, 3);
    integer(organism.age, 0, 900 + 75 * organism.genome.cells.length);
    // Later attackers or a larger mutated child can leave a survivor negative
    // until its next turn. Use the actual supported Save bounds, not energy > 0.
    finite(organism.energy, -1000, 100000);
    integer(organism.children, 0, 1e9);
    integer(organism.generation, 0, 1e9);
    assert.ok(organism.ancestry.length <= 8);
    for (const ancestor of organism.ancestry) integer(ancestor, 1, world.nextSpecies - 1);
    anatomy(organism.genome);
    for (const cell of organism.genome.cells) {
      const [dx, dy] = [
        [cell.x, cell.y],
        [-cell.y, cell.x],
        [-cell.x, -cell.y],
        [cell.y, -cell.x],
      ][organism.rotation];
      const x = (organism.x + dx + WIDTH) % WIDTH;
      const y = (organism.y + dy + HEIGHT) % HEIGHT;
      const position = y * WIDTH + x;
      assert.equal(occupied[position], 0, 'no overlapping bodies');
      assert.equal(world.walls[position], 0, 'no body in a wall');
      assert.equal(world.food[position], 0, 'no food under a body');
      occupied[position] = id;
    }
    lineageCounts.set(organism.species, (lineageCounts.get(organism.species) ?? 0) + 1);
  }
  assert.deepEqual(world.occupied, occupied, 'complete occupancy including empty cells');
  for (let position = 0; position < occupied.length; position++) {
    integer(world.food[position], 0, 1);
    integer(world.walls[position], 0, 1);
    assert.ok(!(world.food[position] && world.walls[position]), 'no food under walls');
  }
  const saved = world.save();
  const history = saved.telemetry;
  assert.equal(history.samples.length, Math.min(TELEMETRY_CAPACITY, Math.floor(world.tick / 30)));
  assert.equal(history.pending.fromTick, Math.floor(world.tick / 30) * 30);
  for (const [offset, sample] of history.samples.entries()) {
    assert.equal(
      sample.tick,
      (Math.floor(world.tick / 30) - history.samples.length + offset + 1) * 30,
    );
    assert.equal(sample.tick - sample.fromTick, TELEMETRY_INTERVAL_TICKS);
    integer(sample.population, 0, LIMIT);
    integer(sample.food, 0, WIDTH * HEIGHT);
    assert.equal(
      sample.adaptation!.preferenceBins.reduce((sum, count) => sum + count, 0),
      sample.population,
    );
    integer(sample.adaptation!.stressedOrganisms, 0, sample.population);
    if (sample.population) {
      finite(sample.meanPreference!, 0, 1);
      finite(sample.meanTolerance!, 0.12, 0.6);
    } else {
      assert.equal(sample.meanPreference, null);
      assert.equal(sample.meanTolerance, null);
    }
  }
  assert.ok(saved.interventions.entries.length <= INTERVENTION_CAPACITY);
  const archive = saved.lineageArchive;
  assert.ok(archive.living.length <= LIMIT);
  assert.ok(archive.summaries.length <= LINEAGE_SUMMARY_CAPACITY);
  assert.ok(archive.events.length <= LINEAGE_EVENT_CAPACITY);
  assert.deepEqual(new Map(archive.living.map((row) => [row.id, row.liveCount])), lineageCounts);
  for (const row of archive.summaries) if (row.foundingGenome) anatomy(row.foundingGenome);
  assert.ok(new TextEncoder().encode(JSON.stringify(saved)).byteLength <= WORLD_MAX_BYTES);
}

export const starvationGenome: Genome = {
  cells: [{ x: 0, y: 0, type: 3 }],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 2,
  behavior: { version: 1, mode: 'legacy' },
};

export function starved(seed: number): Ecosystem {
  const world = new Ecosystem({ ...DEFAULTS, seed, climate: 0, nutrients: 0 }, false, {
    terrain: { version: 1, preset: 'open-field', seed: null },
  });
  assert.ok(world.spawn(starvationGenome, WIDTH / 2, HEIGHT / 2));
  return world;
}

export function withOpaquePayload(world: Ecosystem): Ecosystem {
  const saved = world.save();
  const opaque = JSON.parse('{"nested":[null,true,"retained"],"__proto__":{"data":true}}');
  Object.defineProperty(saved.settings, '__proto__', { value: opaque, enumerable: true });
  for (const organism of saved.organisms) Object.assign(organism, { opaque });
  // Encoded opaque values preserve signed zero/overflow without JSON loss.
  const extension = encodeLegacyValue({ opaque, signed: -0, overflow: Infinity });
  for (const genome of [
    ...saved.organisms.map((organism) => organism.genome),
    ...saved.lineageArchive.summaries.flatMap((row) =>
      row.foundingGenome ? [row.foundingGenome] : [],
    ),
  ]) {
    genome.legacyExtensions = [['payload', extension]];
    for (const cell of genome.cells) cell.legacyExtensions = [['payload', extension]];
  }
  return Ecosystem.load(JSON.stringify(saved));
}
