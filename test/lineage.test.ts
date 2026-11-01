import { describe, expect, it } from 'vitest';
import { Ecosystem } from '../src/ecosystem';
import {
  DEFAULTS,
  LIMIT,
  Random,
  WIDTH,
  type Genome,
  type WorldFile,
  type LineageSummary,
  type LineageEvent,
} from '../src/model';
import {
  advance,
  legacyV3,
  legacyV4,
  legacyV5,
  legacyV6,
  legacyV7,
  legacyV8,
} from './fixtures/telemetry';
import { cpus, platform, totalmem } from 'node:os';
import {
  admissionGenome,
  contradictoryPruning,
  impossibleReadmission,
  omittedNewestAdmission,
  retainedAdjacentExtinction,
  sameTickLineages,
  falsePruningClaim,
  prunedCreationOrder,
  reversedPrunedParent,
  readmittedParentOrder,
  reversedReadmittedParent,
  relatedChildMembership,
  omittedRelatedChild,
  missingFinalExtinction,
  extinctionOccupancyContradiction,
} from './fixtures/lineage';

const genome = (): Genome => ({
  cells: [{ x: 0, y: 0, type: 7 }],
  preference: 0.5,
  tolerance: 0.3,
  tempo: 2,
  behavior: { version: 1 as const, mode: 'legacy' as const },
});
const empty = () => new Ecosystem({ ...DEFAULTS, mutation: 0, climate: 0, nutrients: 0 }, false);
const reload = (world: Ecosystem) => Ecosystem.load(JSON.stringify(world.save()));
const beforeArchive = ({ lineageArchive: _archive, ...saved }: WorldFile) => saved;

function knownSummary(
  id: number,
  createdTick: number,
  extinctTick: number | null,
  parentId: number | null = null,
): LineageSummary {
  return {
    id,
    origin: parentId === null ? 'manual' : 'mutation',
    createdTick,
    parentId,
    liveCount: extinctTick === null ? 1 : 0,
    peakCount: 1,
    peakKind: 'lifetime',
    extinctTick,
    admittedTick: createdTick,
    foundingGenome: genome(),
    genomeStatus: 'retained',
  };
}
function evidence(events: LineageEvent[], rows: LineageSummary[] = [], watermark = 0): WorldFile {
  const world = empty();
  advance(world, 100);
  const saved = world.save();
  saved.nextSpecies = 10_000;
  saved.deaths = 1000;
  const admissionTick =
    Math.max(
      watermark,
      ...events.map((event) => event.tick),
      ...rows.map((row) => row.extinctTick!),
    ) + 1;
  const filler = Array.from({ length: 256 - rows.length }, (_, offset) =>
    knownSummary(1000 + offset, admissionTick, admissionTick),
  );
  const padding: LineageEvent[] = Array.from(
    { length: Math.max(events.length === 0 ? 1 : 0, 512 - events.length - filler.length * 2) },
    (_, offset) => extinct(3000 + offset, watermark),
  );
  const livingCount = Math.max(0, padding.length + events.length + filler.length * 2 - 512);
  for (const row of filler.slice(filler.length - livingCount)) {
    row.liveCount = 1;
    row.extinctTick = null;
  }
  saved.organisms = filler
    .filter((row) => row.liveCount)
    .map((row, offset) => ({
      id: offset + 1,
      species: row.id,
      genome: genome(),
      x: offset % WIDTH,
      y: 10 + Math.floor(offset / WIDTH),
      rotation: 0,
      direction: 0,
      age: 0,
      energy: 10,
      generation: 0,
      ancestry: [],
      children: 0,
    }));
  saved.nextId = saved.organisms.length + 1;
  saved.lineageArchive = {
    version: 1,
    originKind: 'fresh',
    originTick: 0,
    summariesPruned: true,
    eventsPruned: true,
    eventsEvictedThroughTick: watermark,
    living: filler
      .filter((row) => row.liveCount)
      .map(
        ({ admittedTick: _tick, foundingGenome: _genome, genomeStatus: _status, ...row }) => row,
      ),
    summaries: [...rows, ...filler],
    events: [
      ...padding,
      ...events,
      ...filler.map((row) => created(row.id, admissionTick)),
      ...filler.filter((row) => !row.liveCount).map((row) => extinct(row.id, admissionTick)),
    ],
  };
  return saved;
}
function created(id: number, tick: number, parentId: number | null = null): LineageEvent {
  return { kind: 'created', id, tick, origin: parentId === null ? 'manual' : 'mutation', parentId };
}
const extinct = (id: number, tick: number): LineageEvent => ({ kind: 'extinct', id, tick });
function summaryById(saved: WorldFile, id: number): LineageSummary {
  const row = saved.lineageArchive.summaries.find((summary) => summary.id === id);
  expect(row?.id).toBe(id);
  return row!;
}
function rejects(saved: WorldFile): void {
  const active = new Ecosystem();
  advance(active, 31);
  const before = active.save();
  expect(() => Ecosystem.load(JSON.stringify(saved))).toThrow('lineage archive');
  expect(active.save()).toEqual(before);
}

describe('strict bounded archive candidate validation', () => {
  it('composes literal world7 refuges, terrain and interventions without trusting an old archive extension', () => {
    const world = empty();
    world.spawn(genome(), 40, 40);
    world.changeRefugeMode(true);
    world.paintRefuge({ rulesVersion: 1, tool: 'warm', radius: 1, units: 4 }, 40, 40);
    world.changeTerrain('regenerate', { version: 1, preset: 'chambered-refuges', seed: 123 });
    const historical = legacyV7(world.save());
    Object.assign(historical, { lineageArchive: { untrusted: 'ignored' } });
    const migrated = Ecosystem.load(JSON.stringify(historical));
    expect(beforeArchive(migrated.save())).toEqual(beforeArchive(world.save()));
    expect(migrated.lineageSnapshot()).toMatchObject({ originKind: 'legacy-import', events: [] });
    expect(migrated.lineageSnapshot().summaries[0]).toMatchObject({
      genomeStatus: 'legacy-unknown',
      createdTick: null,
    });
    const restored = reload(migrated);
    for (const candidate of [world, migrated, restored]) advance(candidate, 31);
    expect(beforeArchive(migrated.save())).toEqual(beforeArchive(world.save()));
    expect(restored.save()).toEqual(migrated.save());
    const missing = world.save();
    delete (missing as Partial<WorldFile>).lineageArchive;
    rejects(missing);
  });
  it('C16-R4-001 rejects impossible fresh pruning and preserves the 256/257 admission boundary', () => {
    const world = sameTickLineages();
    expect(world.lineageSnapshot().summariesPruned).toBe(false);
    expect(reload(world).save()).toEqual(world.save());
    rejects(falsePruningClaim());
    for (const organism of world.organisms.values()) world.kill(organism, 'manual');
    expect(world.lineageSnapshot().summariesPruned).toBe(false);
    expect(reload(world).save()).toEqual(world.save());
    world.spawn(genome(), 40, 40);
    expect(world.lineageSnapshot().summariesPruned).toBe(true);
    expect(reload(world).save()).toEqual(world.save());
  });

  it('C16-FIFO-R1-001 rejects final-event absence and aggregate extinction occupancy contradictions', () => {
    const final = missingFinalExtinction();
    expect(final.lineageArchive.events.at(-1)).toEqual(extinct(1999, 0));
    expect(final.lineageArchive.summaries.some((row) => row.id === 1999)).toBe(false);
    rejects(final);
    const crowded = extinctionOccupancyContradiction();
    expect(crowded.lineageArchive.events).toHaveLength(512);
    expect(crowded.lineageArchive.summaries.slice(0, 2).map((row) => row.genomeStatus)).toEqual([
      'retained',
      'retained',
    ]);
    rejects(crowded);
    const control = prunedCreationOrder(false);
    expect(reload(control).save()).toEqual(control.save());
  });

  it('C16-FIFO-R1-002 preserves known parent-before-child FIFO order across a missing same-tick prefix', () => {
    const world = prunedCreationOrder();
    const saved = world.save();
    expect(saved.lineageArchive.summaries.slice(0, 2)).toMatchObject([
      { id: 7, genomeStatus: 'retained' },
      { id: 8, parentId: 7, genomeStatus: 'retained' },
    ]);
    expect(
      saved.lineageArchive.events.filter(
        (event) => event.kind === 'created' && [7, 8].includes(event.id),
      ),
    ).toEqual([]);
    rejects(reversedPrunedParent());
    const restored = reload(world);
    for (const candidate of [world, restored]) candidate.spawn(genome(), 40, 40);
    expect(restored.save()).toEqual(world.save());
    expect(
      world
        .lineageSnapshot()
        .summaries.slice(0, 2)
        .map((row) => row.id),
    ).toEqual([8, 9]);
    const unrelated = prunedCreationOrder(false).save();
    [unrelated.lineageArchive.summaries[0], unrelated.lineageArchive.summaries[1]] = [
      unrelated.lineageArchive.summaries[1],
      unrelated.lineageArchive.summaries[0],
    ];
    expect(Ecosystem.load(JSON.stringify(unrelated)).save()).toEqual(unrelated);
  });
  it.each([false, true])(
    'C16-OWNER-R1-001 preserves child founding before parent extinction readmission with legacy %s',
    (legacy) => {
      const world = readmittedParentOrder(legacy);
      const saved = world.save();
      expect(saved.lineageArchive.summaries.map((row) => row.id)).toEqual([
        261,
        5,
        ...Array.from({ length: 254 }, (_, offset) => offset + 262),
      ]);
      expect(saved.lineageArchive.summaries.slice(0, 2)).toMatchObject([
        { id: 261, parentId: 5, genomeStatus: 'retained', admittedTick: world.tick },
        { id: 5, genomeStatus: legacy ? 'legacy-unknown' : 'pruned', admittedTick: world.tick },
      ]);
      expect(saved.lineageArchive.events).toHaveLength(512);
      expect(saved.lineageArchive.events.filter((event) => [5, 261].includes(event.id))).toEqual(
        [],
      );
      expect(saved.lineageArchive).toMatchObject({
        summariesPruned: true,
        eventsPruned: true,
        eventsEvictedThroughTick: world.tick,
      });
      rejects(reversedReadmittedParent(legacy));
      const text = JSON.stringify(saved);
      const restored = Ecosystem.load(text);
      expect(JSON.stringify(restored.save())).toBe(text);
      for (const candidate of [world, restored]) candidate.spawn(admissionGenome(), 80, 80);
      expect(restored.save()).toEqual(world.save());
      expect(world.lineageSnapshot().summaries.map((row) => row.id)).toEqual([
        5,
        ...Array.from({ length: 255 }, (_, offset) => offset + 262),
      ]);
    },
  );

  it('C16-OWNER-R2-001 preserves younger living-only child membership while its parent retains founding detail', () => {
    const { world } = relatedChildMembership(),
      saved = world.save();
    expect(saved.lineageArchive.summaries.map((row) => row.id)).toEqual([
      260,
      261,
      ...Array.from({ length: 254 }, (_, offset) => offset + 262),
    ]);
    expect(saved.lineageArchive.living.find((row) => row.id === 261)).toMatchObject({
      origin: 'mutation',
      parentId: 260,
    });
    expect(
      saved.lineageArchive.events.filter(
        (event) => event.kind === 'created' && [260, 261].includes(event.id),
      ),
    ).toEqual([]);
    expect(saved.lineageArchive.events.slice(0, 4)).toEqual([
      extinct(8, 0),
      extinct(7, 0),
      extinct(6, 0),
      extinct(260, 0),
    ]);
    const invalid = omittedRelatedChild();
    expect(invalid).toEqual({
      ...saved,
      lineageArchive: {
        ...saved.lineageArchive,
        summaries: [
          invalid.lineageArchive.summaries[0],
          ...saved.lineageArchive.summaries.filter((row) => row.id !== 261),
        ],
      },
    });
    expect(invalid.lineageArchive.summaries.slice(0, 2).map((row) => row.id)).toEqual([259, 260]);
    rejects(invalid);
    const text = JSON.stringify(saved),
      restored = Ecosystem.load(text);
    expect(JSON.stringify(restored.save())).toBe(text);
    for (const candidate of [world, restored]) candidate.spawn(admissionGenome(), 80, 80);
    expect(restored.save()).toEqual(world.save());
    expect(world.lineageSnapshot().summaries.map((row) => row.id)).toEqual([
      261,
      ...Array.from({ length: 255 }, (_, offset) => offset + 262),
    ]);
    const missingParent = sameTickLineages();
    missingParent.spawn(admissionGenome(), 40, 40, undefined, missingParent.organisms.get(1));
    expect(missingParent.lineageSnapshot().summaries.some((row) => row.id === 5)).toBe(false);
    expect(reload(missingParent).save()).toEqual(missingParent.save());
  });

  it('C16-R3-001 rejects impossible readmission at 255 following admissions and continues retained detail', () => {
    const invalid = impossibleReadmission();
    expect(invalid.tick).toBe(0);
    expect(invalid.lineageArchive.events).toHaveLength(258);
    expect(invalid.lineageArchive.eventsPruned).toBe(false);
    expect(invalid.lineageArchive.summariesPruned).toBe(true);
    expect(invalid.lineageArchive.summaries.map((row) => row.id)).toEqual([
      ...Array.from({ length: 255 }, (_, offset) => offset + 7),
      6,
    ]);
    expect(invalid.lineageArchive.events.filter((event) => event.kind === 'extinct')).toEqual([
      extinct(6, 0),
    ]);
    rejects(invalid);
    const actual = retainedAdjacentExtinction();
    expect(actual.lineageSnapshot().summaries[0]).toMatchObject({
      id: 6,
      genomeStatus: 'retained',
      foundingGenome: admissionGenome(),
      extinctTick: 0,
    });
    const restored = reload(actual);
    expect(restored.save()).toEqual(actual.save());
    for (const candidate of [actual, restored]) {
      candidate.spawn(admissionGenome(), 80, 80);
      expect(candidate.lineageSnapshot().summaries[0].id).toBe(7);
      expect(candidate.lineageSnapshot().summaries.some((row) => row.id === 6)).toBe(false);
      candidate.step();
    }
    expect(restored.save()).toEqual(actual.save());
    expect(reload(restored).save()).toEqual(actual.save());
  });

  it.each([254, 255, 256])(
    'C16-R3-001 distinguishes %i following admissions without treating retained extinctions as admissions',
    (following) => {
      const world = sameTickLineages();
      world.spawn(admissionGenome(), 40, 40);
      const target = 261 - following;
      for (const organism of [...world.organisms.values()]
        .filter((row) => row.species > target)
        .slice(0, 10))
        world.kill(organism, 'manual');
      world.kill(
        [...world.organisms.values()].find((row) => row.species === target)!,
        'manual',
      );
      const valid = world.save();
      expect(valid.lineageArchive.eventsPruned).toBe(false);
      expect(summaryById(valid, target).genomeStatus).toBe(
        following === 256 ? 'pruned' : 'retained',
      );
      expect(reload(world).save()).toEqual(valid);
      if (following < 256) {
        const forged = structuredClone(valid),
          summary = summaryById(forged, target);
        summary.genomeStatus = 'pruned';
        summary.foundingGenome = null;
        forged.lineageArchive.summaries = [
          ...forged.lineageArchive.summaries.filter((row) => row.id !== target),
          summary,
        ];
        rejects(forged);
      }
    },
  );

  it('C16-R3-001 accounts for a real intervening extinction readmission and its eviction chain', () => {
    const world = sameTickLineages();
    world.spawn(admissionGenome(), 40, 40);
    for (const organismId of [1, 2, 3]) {
      world.kill(world.organisms.get(organismId)!, 'manual');
      expect(world.lineageSnapshot().summaries.at(-1)).toMatchObject({
        id: organismId + 4,
        genomeStatus: 'pruned',
        admittedTick: 0,
      });
      expect(reload(world).save()).toEqual(world.save());
    }
    const candidate = reload(world);
    for (const current of [world, candidate]) {
      current.spawn(admissionGenome(), 80, 80);
      expect(current.lineageSnapshot().summaries[0].id).toBe(10);
      current.step();
    }
    expect(candidate.save()).toEqual(world.save());
  });

  it('C16-R3-001 proves retained suffix membership even at a partially evicted same-tick watermark', () => {
    const world = empty();
    for (let index = 0; index < 300; index++) {
      const organism = world.spawn(admissionGenome(), 40, 40)!;
      world.kill(organism, 'manual');
    }
    for (let position = 0; position < 257; position++)
      world.spawn(admissionGenome(), position % WIDTH, Math.floor(position / WIDTH));
    world.kill(world.organisms.get(302)!, 'manual');
    const valid = world.save(),
      target = valid.lineageArchive.summaries[0];
    expect(valid.lineageArchive.eventsPruned).toBe(true);
    expect(valid.lineageArchive.eventsEvictedThroughTick).toBe(0);
    expect(target).toMatchObject({ id: 306, genomeStatus: 'retained', extinctTick: 0 });
    expect(valid.lineageArchive.events).toContainEqual(created(306, 0));
    expect(reload(world).save()).toEqual(valid);
    target.genomeStatus = 'pruned';
    target.foundingGenome = null;
    valid.lineageArchive.summaries.push(valid.lineageArchive.summaries.shift()!);
    rejects(valid);
  });

  it('C16-R3-001 cannot retain older founding detail across a claimed later eviction', () => {
    const older = knownSummary(5, 0, 0),
      readmitted = {
        ...knownSummary(6, 20, 30),
        admittedTick: 30,
        genomeStatus: 'pruned' as const,
        foundingGenome: null,
      };
    const unknown = Array.from({ length: 256 }, (_, offset) => extinct(3000 + offset, 21));
    const invalid = evidence([created(6, 20), ...unknown, extinct(6, 30)], [older, readmitted], 10);
    expect(invalid.lineageArchive.events).toHaveLength(512);
    rejects(invalid);
    const repaired = evidence(
      [created(6, 20), ...unknown.slice(1), extinct(5, 30), extinct(6, 30)],
      [
        {
          ...older,
          extinctTick: 30,
          admittedTick: 30,
          genomeStatus: 'pruned',
          foundingGenome: null,
        },
        readmitted,
      ],
      10,
    );
    const restored = Ecosystem.load(JSON.stringify(repaired));
    expect(restored.save()).toEqual(repaired);
    expect(reload(restored).save()).toEqual(repaired);
  });

  it('C16-R3-001 preserves an ambiguous initial legacy readmission required by later known eviction', () => {
    const legacy = {
      ...knownSummary(5, 0, 0),
      origin: 'legacy-unknown' as const,
      createdTick: null,
      peakKind: 'since-origin' as const,
      genomeStatus: 'legacy-unknown' as const,
      foundingGenome: null,
    };
    const candidate = evidence(
      [
        created(6, 0),
        ...Array.from({ length: 255 }, (_, offset) => extinct(3000 + offset, 0)),
        extinct(5, 0),
        extinct(6, 0),
      ],
      [legacy, { ...knownSummary(6, 0, 0), genomeStatus: 'pruned', foundingGenome: null }],
    );
    candidate.lineageArchive.originKind = 'legacy-import';
    const world = Ecosystem.load(JSON.stringify(candidate));
    expect(world.save()).toEqual(candidate);
    expect(reload(world).save()).toEqual(candidate);
    world.spawn(admissionGenome(), 80, 80);
    expect(world.lineageSnapshot().summaries[0].id).toBe(6);
    expect(reload(world).save()).toEqual(world.save());
  });

  it('C16-R2-001 rejects ordered membership omitting the provably newest admission', () => {
    const invalid = omittedNewestAdmission();
    expect(invalid.tick).toBe(0);
    expect(invalid.lineageArchive.events).toHaveLength(257);
    expect(invalid.lineageArchive.eventsPruned).toBe(false);
    expect(invalid.lineageArchive.summariesPruned).toBe(true);
    expect(invalid.lineageArchive.summaries.map((row) => row.id)).toEqual(
      Array.from({ length: 256 }, (_, offset) => offset + 5),
    );
    expect(invalid.lineageArchive.events.at(-1)).toMatchObject({ kind: 'created', id: 261 });
    rejects(invalid);
    const actual = sameTickLineages();
    actual.spawn(admissionGenome(), 40, 40);
    const restored = reload(actual);
    expect(restored.lineageSnapshot().summaries.map((row) => row.id)).toEqual(
      Array.from({ length: 256 }, (_, offset) => offset + 6),
    );
    for (const candidate of [actual, restored]) {
      candidate.spawn(admissionGenome(), 80, 80);
      candidate.step();
      expect(candidate.lineageSnapshot().summaries[0].id).toBe(7);
    }
    expect(restored.save()).toEqual(actual.save());
    expect(reload(restored).save()).toEqual(actual.save());
  });

  it('C16-R2-001 preserves genuinely unknown initial legacy membership and its FIFO continuation', () => {
    const world = sameTickLineages();
    world.spawn(admissionGenome(), 40, 40);
    const candidate = Ecosystem.load(JSON.stringify(legacyV5(world.save()))).save();
    const oldest = candidate.lineageArchive.living.find((row) => row.id === 5)!;
    candidate.lineageArchive.summaries[0] = {
      ...oldest,
      admittedTick: 0,
      genomeStatus: 'legacy-unknown',
      foundingGenome: null,
    };
    expect(candidate.lineageArchive.events).toEqual([]);
    expect(candidate.lineageArchive.summaries[0]).toMatchObject({ id: 5, createdTick: null });
    expect(candidate.lineageArchive.summaries[1].id).toBe(7);
    const restored = Ecosystem.load(JSON.stringify(candidate)),
      control = reload(restored);
    expect(restored.save()).toEqual(candidate);
    for (const continued of [restored, control]) {
      continued.spawn(genome(), 80, 80);
      continued.step();
      expect(continued.lineageSnapshot().summaries[0].id).toBe(7);
    }
    expect(restored.save()).toEqual(control.save());
  });

  it('C16-R2-001 includes provable omitted extinction readmissions, including event-only identities', () => {
    const world = sameTickLineages();
    world.spawn(admissionGenome(), 40, 40);
    const beforeDeath = world.save();
    world.kill(world.organisms.get(1)!, 'manual');
    const invalid = world.save();
    invalid.lineageArchive.summaries = beforeDeath.lineageArchive.summaries;
    expect(invalid.lineageArchive.summaries[0].id).toBe(6);
    expect(invalid.lineageArchive.events.at(-1)).toEqual(extinct(5, 0));
    expect(invalid.lineageArchive.living.some((row) => row.id === 5)).toBe(false);
    rejects(invalid);
    expect(reload(world).save()).toEqual(world.save());
    const retained = structuredClone(invalid);
    const original = knownSummary(5, 0, 0);
    retained.lineageArchive.summaries = [original, ...retained.lineageArchive.summaries.slice(1)];
    rejects(retained);
  });
  it('C16-R1-001 requires eviction provenance for known and provable legacy readmissions', () => {
    for (const legacy of [false, true]) {
      const invalid = contradictoryPruning(legacy);
      expect(invalid.lineageArchive.summariesPruned).toBe(false);
      rejects(invalid);
      invalid.lineageArchive.summariesPruned = true;
      rejects(invalid); // Provenance still requires the full 256-row ring.
    }
    const world = empty();
    const placed = world.spawn(genome(), 1, 1)!;
    // An initial legacy placeholder may die at the import tick without eviction.
    const imported = Ecosystem.load(JSON.stringify(legacyV5(world.save())));
    imported.kill(imported.organisms.get(placed.id)!, 'manual');
    expect(reload(imported).save()).toEqual(imported.save());
    expect(imported.lineageSnapshot().summariesPruned).toBe(false);
  });

  it('C16-R1-002 rejects same-tick creation/extinction FIFO inversions and continues actual overflow', () => {
    const world = sameTickLineages();
    const invalid = world.save();
    [invalid.lineageArchive.summaries[0], invalid.lineageArchive.summaries[1]] = [
      invalid.lineageArchive.summaries[1],
      invalid.lineageArchive.summaries[0],
    ];
    rejects(invalid);
    const restored = reload(world);
    for (const candidate of [world, restored]) {
      candidate.spawn(admissionGenome(), 40, 40);
      expect(candidate.lineageSnapshot().summaries[0].id).toBe(6);
      candidate.kill(candidate.organisms.get(1)!, 'manual');
      candidate.kill(candidate.organisms.get(2)!, 'manual');
    }
    expect(restored.save()).toEqual(world.save());
    expect(
      world
        .lineageSnapshot()
        .summaries.slice(-2)
        .map((row) => row.genomeStatus),
    ).toEqual(['pruned', 'pruned']);
    const inverted = world.save(),
      summaries = inverted.lineageArchive.summaries;
    [summaries[254], summaries[255]] = [summaries[255], summaries[254]];
    rejects(inverted);
    const continued = reload(restored);
    for (const candidate of [world, continued]) {
      candidate.spawn(genome(), 80, 80);
      candidate.step();
    }
    expect(continued.save()).toEqual(world.save());
  });

  it('C16-R1-002 uses retained watermark-prefix facts while preserving genuinely lost order', () => {
    const world = sameTickLineages();
    for (const organism of [...world.organisms.values()].reverse()) world.kill(organism, 'manual');
    const placed = world.spawn(genome(), 40, 40)!;
    world.kill(placed, 'manual');
    const valid = world.save();
    expect(valid.lineageArchive.eventsEvictedThroughTick).toBe(0);
    expect(valid.lineageArchive.summaries[0].id).toBe(6);
    expect(
      valid.lineageArchive.events.some((event) => event.kind === 'created' && event.id === 6),
    ).toBe(false);
    expect(reload(world).save()).toEqual(valid);
    const inverted = structuredClone(valid);
    [inverted.lineageArchive.summaries[0], inverted.lineageArchive.summaries[1]] = [
      inverted.lineageArchive.summaries[1],
      inverted.lineageArchive.summaries[0],
    ];
    rejects(inverted); // The missing creation precedes every retained event at W.
    const second = world.spawn(genome(), 40, 40)!;
    world.kill(second, 'manual');
    const uncertain = world.save();
    [uncertain.lineageArchive.summaries[0], uncertain.lineageArchive.summaries[1]] = [
      uncertain.lineageArchive.summaries[1],
      uncertain.lineageArchive.summaries[0],
    ];
    expect(Ecosystem.load(JSON.stringify(uncertain)).save()).toEqual(uncertain);
  });

  it('C16-R1-002 keeps initial legacy admissions before events and permits uncertain same-tick readmission', () => {
    for (const later of [false, true]) {
      const world = Ecosystem.load(JSON.stringify(legacyV5(sameTickLineages().save())));
      if (later) world.step();
      world.spawn(genome(), 40, 40);
      world.kill(world.organisms.get(1)!, 'manual');
      expect(world.lineageSnapshot().summaries.at(-1)).toMatchObject({
        id: 5,
        genomeStatus: 'legacy-unknown',
        admittedTick: later ? 1 : 0,
      });
      const restored = reload(world);
      expect(restored.save()).toEqual(world.save());
      const inverted = world.save(),
        summaries = inverted.lineageArchive.summaries;
      if (later) {
        // A later extinction is a provable readmission after the retained creation.
        [summaries[254], summaries[255]] = [summaries[255], summaries[254]];
        rejects(inverted);
      } else {
        // At origin the same row could instead be an original placeholder.
        [summaries[254], summaries[255]] = [summaries[255], summaries[254]];
        expect(Ecosystem.load(JSON.stringify(inverted)).save()).toEqual(inverted);
        const impossible = world.save();
        [impossible.lineageArchive.summaries[0], impossible.lineageArchive.summaries[254]] = [
          impossible.lineageArchive.summaries[254],
          impossible.lineageArchive.summaries[0],
        ];
        rejects(impossible); // Living initial placeholders must precede known creations.
      }
      for (const candidate of [world, restored]) {
        candidate.spawn(genome(), 80, 80);
        candidate.step();
      }
      expect(restored.save()).toEqual(world.save());
    }
  });

  it('F1/F2 requires transitions strictly after the watermark, including observed legacy deaths', () => {
    const world = empty();
    advance(world, 80);
    for (let iteration = 0; iteration < 513; iteration++)
      world.kill(world.spawn(genome(), 1, 1)!, 'manual');
    advance(world, 10);
    for (let iteration = 0; iteration < 256; iteration++)
      world.kill(world.spawn(genome(), 1, 1)!, 'manual');
    advance(world, 10);
    const suffix = world.lineageSnapshot();
    expect(suffix.eventsEvictedThroughTick).toBe(80);
    expect(suffix.events.every((event) => event.tick === 90)).toBe(true);
    const placed = world.spawn(genome(), 1, 1)!;
    const missingCreation = world.save();
    missingCreation.lineageArchive.events = suffix.events;
    missingCreation.lineageArchive.eventsEvictedThroughTick = 80;
    rejects(missingCreation);
    world.kill(placed, 'manual');
    const missingDeath = world.save();
    const row = summaryById(missingDeath, placed.species);
    row.createdTick = 80;
    row.admittedTick = 100;
    row.genomeStatus = 'pruned';
    row.foundingGenome = null;
    missingDeath.lineageArchive.events = suffix.events;
    missingDeath.lineageArchive.eventsEvictedThroughTick = 80;
    rejects(missingDeath);
    row.origin = 'legacy-unknown';
    row.createdTick = null;
    row.peakKind = 'since-origin';
    row.genomeStatus = 'legacy-unknown';
    missingDeath.lineageArchive.originKind = 'legacy-import';
    rejects(missingDeath);
    missingDeath.lineageArchive.events = [...suffix.events.slice(1), extinct(row.id, 100)];
    missingDeath.lineageArchive.eventsEvictedThroughTick = 90;
    expect(Ecosystem.load(JSON.stringify(missingDeath)).save()).toEqual(missingDeath);
  });

  it('F4 checks metadata, mixed and event-only direct parent dates without reconstructing ancestors', () => {
    const impossible = [created(5, 0), extinct(5, 10), created(6, 20, 5), extinct(6, 30)];
    for (const rows of [
      [],
      [knownSummary(6, 20, 30, 5)],
      [knownSummary(5, 0, 10), knownSummary(6, 20, 30, 5)],
    ]) {
      const invalid = evidence(impossible, rows);
      rejects(invalid);
      const detached = structuredClone(invalid);
      const childEvent = detached.lineageArchive.events.find(
        (event) => event.kind === 'created' && event.id === 6,
      )!;
      expect(childEvent).toMatchObject({ kind: 'created', id: 6, tick: 20, parentId: 5 });
      Object.assign(childEvent, { origin: 'manual', parentId: null });
      if (rows.some((row) => row.id === 6))
        Object.assign(summaryById(detached, 6), { origin: 'manual', parentId: null });
      expect(Ecosystem.load(JSON.stringify(detached)).save()).toEqual(detached);
    }
    rejects(evidence([created(6, 10, 5), created(5, 20), extinct(5, 30), extinct(6, 30)]));
    const metadataOnly = evidence([], [knownSummary(5, 0, 0), knownSummary(6, 0, 0, 5)], 10);
    expect(Ecosystem.load(JSON.stringify(metadataOnly)).save()).toEqual(metadataOnly);
    const child = summaryById(metadataOnly, 6);
    expect(child).toMatchObject({ parentId: 5, createdTick: 0, admittedTick: 0, extinctTick: 0 });
    Object.assign(child, { createdTick: 1, admittedTick: 1, extinctTick: 1 });
    rejects(metadataOnly);
    const repaired = structuredClone(metadataOnly);
    summaryById(repaired, 5).extinctTick = 1;
    expect(Ecosystem.load(JSON.stringify(repaired)).save()).toEqual(repaired);
    const valid = evidence([created(5, 0), created(6, 20, 5), extinct(5, 20), extinct(6, 30)]);
    expect(Ecosystem.load(JSON.stringify(valid)).save()).toEqual(valid);
    const unknownParent = evidence([created(6, 20, 2), extinct(6, 30)]);
    expect(Ecosystem.load(JSON.stringify(unknownParent)).save()).toEqual(unknownParent);
  });

  it('F5 enforces same-tick positions and one-missing watermark-prefix deductions', () => {
    const valid = [created(5, 10), created(6, 10, 5), extinct(5, 10), extinct(6, 20)];
    const saved = evidence(valid);
    expect(Ecosystem.load(JSON.stringify(saved)).save()).toEqual(saved);
    rejects(evidence([valid[1], valid[0], valid[2], valid[3]]));
    rejects(evidence([valid[0], valid[2], valid[1], valid[3]]));
    const parent = knownSummary(5, 10, 10),
      child = knownSummary(6, 10, 20, 5);
    const beforeParent = evidence(
      [created(5, 10), extinct(5, 10), extinct(6, 20)],
      [child, parent],
      10,
    );
    expect(summaryById(beforeParent, 6)).toMatchObject({ parentId: 5, createdTick: 10 });
    rejects(beforeParent);
    const detached = structuredClone(beforeParent);
    Object.assign(summaryById(detached, 6), { origin: 'manual', parentId: null });
    expect(Ecosystem.load(JSON.stringify(detached)).save()).toEqual(detached);
    const afterExtinction = evidence(
      [created(6, 10, 5), extinct(6, 20)],
      [knownSummary(5, 0, 10), child],
      10,
    );
    expect(summaryById(afterExtinction, 5)).toMatchObject({ createdTick: 0, extinctTick: 10 });
    rejects(afterExtinction);
    const unrelated = structuredClone(afterExtinction);
    Object.assign(summaryById(unrelated, 6), { origin: 'manual', parentId: null });
    const childEvent = unrelated.lineageArchive.events.find(
      (event) => event.kind === 'created' && event.id === 6,
    )!;
    expect(childEvent).toMatchObject({ kind: 'created', id: 6, parentId: 5 });
    Object.assign(childEvent, { origin: 'manual', parentId: null });
    expect(Ecosystem.load(JSON.stringify(unrelated)).save()).toEqual(unrelated);
    for (const events of [
      [created(6, 10, 5), extinct(5, 10), extinct(6, 20)],
      [extinct(5, 10), extinct(6, 20)],
      [extinct(6, 20)],
    ]) {
      const candidate = evidence(events, [parent, child], 10);
      expect(Ecosystem.load(JSON.stringify(candidate)).save()).toEqual(candidate);
    }
  });

  it('F6 preserves sparse IDs, unknown legacy creation and event-only extinct prefixes', () => {
    const parent: LineageSummary = {
      ...knownSummary(5, 0, 30),
      origin: 'legacy-unknown',
      createdTick: null,
      peakKind: 'since-origin',
      genomeStatus: 'legacy-unknown',
      foundingGenome: null,
      admittedTick: 30,
    };
    const saved = evidence(
      [created(999_999_998, 20, 5), extinct(5, 30), extinct(999_999_998, 40)],
      [knownSummary(999_999_998, 20, 40, 5), parent],
    );
    saved.nextSpecies = 1_000_000_000;
    saved.lineageArchive.originKind = 'legacy-import';
    const eventOnly = evidence(
      [created(999_999_998, 20, 5), extinct(5, 30), extinct(999_999_998, 40)],
      [parent],
    );
    eventOnly.nextSpecies = 1_000_000_000;
    eventOnly.lineageArchive.originKind = 'legacy-import';
    expect(Ecosystem.load(JSON.stringify(eventOnly)).save()).toEqual(eventOnly);
    const world = Ecosystem.load(JSON.stringify(saved)),
      control = reload(world);
    for (const candidate of [world, control]) {
      candidate.spawn(genome(), 1, 1);
      candidate.step();
    }
    expect(world.save()).toEqual(control.save());
    expect(world.nextSpecies).toBe(1_000_000_001);
    expect(() => reload(world)).toThrow('ecosystem');
    const impossible = structuredClone(saved);
    const parentRow = summaryById(impossible, 5);
    expect(parentRow).toMatchObject({
      origin: 'legacy-unknown',
      admittedTick: 30,
      extinctTick: 30,
    });
    expect(summaryById(impossible, 999_999_998)).toMatchObject({ createdTick: 20, parentId: 5 });
    Object.assign(parentRow, { extinctTick: 10, admittedTick: 10 });
    const parentEvent = impossible.lineageArchive.events.find((event) => event.id === 5)!;
    expect(parentEvent).toEqual(extinct(5, 30));
    parentEvent.tick = 10;
    impossible.lineageArchive.events.sort((first, second) => first.tick - second.tick);
    impossible.lineageArchive.summaries.sort(
      (first, second) => first.admittedTick - second.admittedTick,
    );
    rejects(impossible);
    const unrelated = structuredClone(impossible);
    Object.assign(summaryById(unrelated, 999_999_998), { origin: 'manual', parentId: null });
    const childEvent = unrelated.lineageArchive.events.find(
      (event) => event.kind === 'created' && event.id === 999_999_998,
    )!;
    expect(childEvent).toMatchObject({ kind: 'created', id: 999_999_998, parentId: 5 });
    Object.assign(childEvent, { origin: 'manual', parentId: null });
    expect(Ecosystem.load(JSON.stringify(unrelated)).save()).toEqual(unrelated);
  });
});

describe('archive field and genotype validation', () => {
  it('rejects contradictory metadata, counts, ordering, origins and retained-event facts', () => {
    const world = empty();
    world.spawn(genome(), 1, 1);
    world.spawn(genome(), 2, 1);
    const base = world.save();
    const changes: ((file: any) => void)[] = [
      (file) => file.lineageArchive.living.reverse(),
      (file) => file.lineageArchive.living.push(file.lineageArchive.living[0]),
      (file) => file.lineageArchive.living.pop(),
      (file) => (file.lineageArchive.living[0].liveCount = 2),
      (file) => (file.lineageArchive.living[0].peakCount = 1601),
      (file) => (file.lineageArchive.living[0].extinctTick = 0),
      (file) => (file.lineageArchive.living[0].createdTick = null),
      (file) => (file.lineageArchive.living[0].origin = 'legacy-unknown'),
      (file) => (file.lineageArchive.living[0].origin = 'founder'),
      (file) => (file.lineageArchive.living[0].parentId = 1),
      (file) => (file.lineageArchive.living[0].peakKind = 'unknown'),
      (file) => (file.lineageArchive.summaries[0].peakCount = 2),
      (file) => (file.lineageArchive.summaries[0].admittedTick = -1),
      (file) => (file.lineageArchive.summaries[0].foundingGenome.preference = 2),
      (file) => (file.lineageArchive.summaries[0].genomeStatus = 'legacy-unknown'),
      (file) => (file.lineageArchive.summaries[0].foundingGenome.tempo = 3),
      (file) => (file.lineageArchive.events[0].origin = 'mutation'),
      (file) => (file.lineageArchive.events[0].parentId = 1),
      (file) => (file.lineageArchive.events[0].origin = 'legacy-unknown'),
      (file) => (file.lineageArchive.events[0] = extinct(file.organisms[0].species, 0)),
      (file) => file.lineageArchive.events.shift(),
      (file) => (file.lineageArchive.summariesPruned = true),
      (file) => (file.lineageArchive.eventsPruned = true),
    ];
    for (const change of changes) {
      const invalid = structuredClone(base);
      change(invalid);
      rejects(invalid);
    }
    const pruned = evidence([]);
    for (const watermark of [-1, 1, null, 0.5]) {
      const invalid = structuredClone(pruned);
      invalid.lineageArchive.eventsEvictedThroughTick = watermark;
      rejects(invalid);
    }
    const dates = evidence([], [knownSummary(5, 0, 0)]);
    summaryById(dates, 5).admittedTick = 1;
    rejects(dates);
    for (const parentId of [6, 7]) {
      const invalid = evidence([created(6, 0, parentId), extinct(6, 0)]);
      rejects(invalid);
    }
  });
  it('rejects every missing/extra record key and malformed bounded collections', () => {
    const world = empty();
    const placed = world.spawn(genome(), 1, 1)!;
    world.kill(placed, 'manual');
    const base = world.save();
    const targets = [
      (file: any) => file.lineageArchive,
      (file: any) => file.lineageArchive.summaries[0],
      (file: any) => file.lineageArchive.summaries[0].foundingGenome,
      (file: any) => file.lineageArchive.summaries[0].foundingGenome.cells[0],
      (file: any) => file.lineageArchive.events[0],
      (file: any) => file.lineageArchive.events[1],
    ];
    for (const target of targets)
      for (const key of [...Object.keys(target(base)), 'unknown']) {
        const invalid = structuredClone(base);
        if (key === 'unknown') target(invalid)[key] = true;
        else delete target(invalid)[key];
        rejects(invalid);
      }
    const livingWorld = empty();
    livingWorld.spawn(genome(), 1, 1);
    for (const key of [...Object.keys(livingWorld.lineageSnapshot().living[0]), 'extra']) {
      const invalid: any = livingWorld.save();
      if (key === 'extra') invalid.lineageArchive.living[0][key] = 1;
      else delete invalid.lineageArchive.living[0][key];
      rejects(invalid);
    }
    for (const change of [
      (file: any) => (file.lineageArchive = null),
      (file: any) => (file.lineageArchive = []),
      (file: any) => (file.lineageArchive.version = 2),
      (file: any) => (file.lineageArchive.originKind = 'invented'),
      (file: any) => (file.lineageArchive.originTick = 1),
      (file: any) => (file.lineageArchive.summariesPruned = 1),
      (file: any) => (file.lineageArchive.eventsPruned = 'true'),
      (file: any) => (file.lineageArchive.eventsEvictedThroughTick = 0),
      (file: any) => (file.lineageArchive.living = Array(1601).fill({})),
      (file: any) => (file.lineageArchive.summaries = Array(257).fill({})),
      (file: any) => (file.lineageArchive.events = Array(513).fill({})),
      (file: any) => (file.lineageArchive.events[0] = null),
      (file: any) => (file.lineageArchive.events[1].kind = 'death'),
      (file: any) => (file.lineageArchive.events[0].tick = -1),
      (file: any) => (file.lineageArchive.events[0].id = 1e9),
      (file: any) => file.lineageArchive.events.push(file.lineageArchive.events[1]),
      (file: any) => file.lineageArchive.events.unshift(file.lineageArchive.events[0]),
      (file: any) => (file.lineageArchive.summaries[0].id = 1.5),
      (file: any) => (file.lineageArchive.summaries[0].liveCount = 1),
      (file: any) => (file.lineageArchive.summaries[0].peakCount = 0),
      (file: any) => (file.lineageArchive.summaries[0].origin = 'mutation'),
      (file: any) => (file.lineageArchive.summaries[0].peakKind = 'since-origin'),
      (file: any) => (file.lineageArchive.summaries[0].extinctTick = null),
      (file: any) => (file.lineageArchive.summaries[0].foundingGenome = null),
      (file: any) => (file.lineageArchive.summaries[0].foundingGenome.cells = []),
      (file: any) => (file.lineageArchive.summaries[0].genomeStatus = 'pruned'),
      (file: any) => file.lineageArchive.summaries.push(file.lineageArchive.summaries[0]),
      (file: any) => (file.lineageArchive.summaries = []),
    ]) {
      const invalid = structuredClone(base);
      change(invalid);
      rejects(invalid);
    }
  });

  it('requires homogeneous known groups even after detail pruning, but preserves unknown legacy variants', () => {
    const world = empty();
    const parent = world.spawn(genome(), 1, 1)!;
    world.spawn(genome(), 2, 1, parent.species);
    const current = world.save();
    current.organisms[1].genome.tempo = 3;
    rejects(current);
    const legacy = Ecosystem.load(JSON.stringify(legacyV5(current)));
    expect(legacy.spawn({ ...genome(), tempo: 3 }, 3, 1, parent.species)).toBeDefined();
    expect(reload(legacy).save()).toEqual(legacy.save());
    for (let position = 0; position < 256; position++)
      world.spawn(genome(), position % WIDTH, Math.floor(position / WIDTH) + 10);
    const pruned = world.save();
    pruned.organisms[1].genome.tempo = 3;
    rejects(pruned);
    const mismatch = empty();
    mismatch.spawn(genome(), 1, 1);
    const invalid = mismatch.save();
    invalid.organisms[0].genome.preference = 0.2;
    rejects(invalid);
    const detached = legacy.lineageSnapshot();
    for (const organism of [...legacy.organisms.values()]) legacy.kill(organism, 'manual');
    expect(legacy.lineageSnapshot().summaries[0]).toMatchObject({
      origin: 'legacy-unknown',
      extinctTick: 0,
    });
    expect(detached.living[0].liveCount).toBe(3);
    expect(reload(legacy).save()).toEqual(legacy.save());
  });
});

describe('bounded observed lineage lifecycle', () => {
  it('keeps clone counts after detail eviction and re-admits only on actual final extinction', () => {
    const world = empty(),
      first = world.spawn(genome(), 1, 1)!;
    const second = world.spawn(genome(), 2, 1, first.species)!;
    for (let position = 0; position < 256; position++)
      world.spawn(genome(), position % WIDTH, Math.floor(position / WIDTH) + 10);
    const before = world.lineageSnapshot();
    expect(before.summaries.some((row) => row.id === first.species)).toBe(false);
    const third = world.spawn(genome(), 3, 1, first.species, first)!;
    world.kill(first, 'manual');
    expect(world.lineageSnapshot().summaries).toEqual(before.summaries);
    expect(world.lineageSnapshot().living[0]).toMatchObject({ liveCount: 2, peakCount: 3 });
    world.kill(second, 'age');
    world.kill(third, 'energy');
    expect(world.lineageSnapshot().summaries.at(-1)).toMatchObject({
      id: first.species,
      peakCount: 3,
      liveCount: 0,
      genomeStatus: 'pruned',
      foundingGenome: null,
    });
    expect(reload(world).save()).toEqual(world.save());
    const legacy = Ecosystem.load(JSON.stringify(legacyV5(world.save())));
    const oldest = [...legacy.organisms.values()][0];
    legacy.spawn(genome(), 5, 5);
    legacy.step();
    legacy.kill(oldest, 'manual');
    expect(legacy.lineageSnapshot().summaries.at(-1)).toMatchObject({
      id: oldest.species,
      genomeStatus: 'legacy-unknown',
      admittedTick: 1,
      extinctTick: 1,
    });
    expect(reload(legacy).save()).toEqual(legacy.save());
  });

  it('accepts the last valid tick/allocator endpoints without hiding the existing numeric continuation limit', () => {
    const file = legacyV5(empty().save());
    file.tick = 1_000_000_000;
    file.nextSpecies = 999_999_999;
    file.nextId = 999_999_999;
    file.telemetry.originTick = file.tick;
    file.telemetry.adaptationOriginTick = file.tick;
    file.telemetry.pending.fromTick = file.tick;
    const world = Ecosystem.load(JSON.stringify(file));
    const placed = world.spawn(genome(), 1, 1)!;
    expect(placed.species).toBe(999_999_999);
    expect(placed.id).toBe(999_999_999);
    expect(world.nextSpecies).toBe(1_000_000_000);
    expect(world.nextId).toBe(1_000_000_000);
    expect(reload(world).save()).toEqual(world.save());
    world.step();
    world.kill(placed, 'manual');
    expect(world.tick).toBe(1_000_000_001);
    expect(world.lineageSnapshot().summaries[0]).toMatchObject({
      createdTick: 1_000_000_000,
      extinctTick: 1_000_000_001,
    });
    expect(() => reload(world)).toThrow('ecosystem');
  });
  it.each([2, 3, 4, 5, 6, 7, 8])(
    'preserves uninterrupted ecology, order and permitted extensions across v%s boundaries',
    (version) => {
      for (const tick of [29, 30, 59, 60, 89])
        for (const populated of [true, false]) {
          const setup = empty(),
            first = setup.spawn(genome(), 20, 20)!;
          setup.spawn({ ...genome(), preference: 0.8 }, 40, 40);
          setup.spawn(genome(), 60, 60, first.species);
          const initial = legacyV5(setup.save());
          initial.random = -123456789;
          initial.organisms = [initial.organisms[1], initial.organisms[2], initial.organisms[0]];
          (initial.settings as any).extension = { nested: ['λ', { value: 7 }] };
          for (const organism of initial.organisms) {
            (organism as any).extension = { ordered: [3, 2, 1] };
            (organism.genome as any).extension = { nested: ['retained'] };
            (organism.genome.cells[0] as any).extension = 'cell';
            organism.ancestry = [organism.species, organism.species];
            organism.energy = 100;
          }
          const source = Ecosystem.load(JSON.stringify(initial));
          advance(source, tick);
          if (!populated)
            for (const organism of [...source.organisms.values()]) source.kill(organism, 'manual');
          const saved = source.save(),
            v5 = legacyV5(saved);
          const { telemetry: _telemetry, interventions: _interventions, ...old } = v5;
          const file =
            version === 2
              ? { ...old, version: 2, lineageArchive: { untrusted: 'ignored' } }
              : version === 3
                ? legacyV3(saved)
                : version === 4
                  ? legacyV4(saved)
                  : version === 5
                    ? v5
                    : version === 6
                      ? legacyV6(saved)
                      : version === 7
                        ? legacyV7(saved)
                        : legacyV8(saved);
          const migrated = Ecosystem.load(JSON.stringify(file));
          const physical = ({
            lineageArchive: _archive,
            telemetry: _history,
            interventions: _manual,
            ...state
          }: WorldFile) => state;
          expect(physical(migrated.save())).toEqual(physical(saved));
          expect(migrated.lineageSnapshot()).toMatchObject({
            originKind: version === 8 ? saved.lineageArchive.originKind : 'legacy-import',
            originTick: version === 8 ? saved.lineageArchive.originTick : tick,
            events: version === 8 ? saved.lineageArchive.events : [],
          });
          if (populated) {
            expect(migrated.lineageSnapshot().living.map((row) => row.id)).toEqual([5, 6]);
            expect(migrated.lineageSnapshot().summaries.map((row) => row.id)).toEqual([6, 5]);
            expect(
              migrated
                .lineageSnapshot()
                .living.every(
                  (row) =>
                    row.createdTick === null &&
                    row.parentId === null &&
                    row.peakKind === 'since-origin',
                ),
            ).toBe(true);
          }
          if (version >= 4) expect(migrated.save().telemetry).toEqual(saved.telemetry);
          if (version >= 5) expect(migrated.save().interventions).toEqual(saved.interventions);
          const roundtrip = reload(migrated);
          for (const world of [source, migrated, roundtrip]) advance(world, 61);
          expect(physical(migrated.save())).toEqual(physical(source.save()));
          expect(migrated.save()).toEqual(roundtrip.save());
          const latest = migrated.save().telemetry.samples.at(-1)!;
          expect(latest).toEqual(
            source.save().telemetry.samples.find((sample) => sample.tick === latest.tick),
          );
          if (version >= 4) expect(migrated.save().telemetry).toEqual(source.save().telemetry);
          if (version >= 5)
            expect(migrated.save().interventions).toEqual(source.save().interventions);
        }
    },
  );
  it('measures a 1600x16/eight-ancestor/180-sample/128-intervention saturated archive', () => {
    const start = performance.now();
    const world = empty();
    world.nextId = 999_998_000;
    world.nextSpecies = 999_998_000;
    const body: Genome = {
      ...genome(),
      cells: Array.from({ length: 16 }, (_, cell) => ({
        x: cell % 4,
        y: Math.floor(cell / 4),
        type: (3 + (cell % 6)) as 3 | 4 | 5 | 6 | 7 | 8,
      })),
    };
    let parent = world.spawn(body, 0, 0)!;
    for (let transition = 0; transition < 8; transition++) {
      const child = world.spawn(body, transition % 2 ? 0 : 4, 0, undefined, parent)!;
      world.kill(parent, 'manual');
      parent = child;
    }
    for (let position = 1; position < LIMIT; position++) {
      const child = world.spawn(
        {
          ...body,
          preference: ((position % 10) + 0.12345678901234568) / 10,
          tolerance: 0.3456789012345679,
          tempo: 12,
          behavior: { version: 1 as const, mode: 'legacy' as const },
        },
        (position % 60) * 4,
        Math.floor(position / 60) * 4,
        undefined,
        parent,
      )!;
      expect(child).toBeDefined();
    }
    for (const organism of world.organisms.values()) organism.energy = 80000.12345678901;
    world.births = 999_999_999;
    world.deaths = 999_999_999;
    advance(world, 30);
    for (let entry = 0; entry < 131; entry++) world.changeSettings({ nutrients: entry % 2 });
    const constructionMs = performance.now() - start;
    const snapshotStart = performance.now(),
      saved = world.save(),
      snapshotMs = performance.now() - snapshotStart;
    const sample = saved.telemetry.samples[0];
    saved.tick = 5400;
    saved.telemetry.samples = Array.from({ length: 180 }, (_, interval) => ({
      ...structuredClone(sample),
      fromTick: interval * 30,
      tick: (interval + 1) * 30,
    }));
    saved.telemetry.pending.fromTick = 5400;
    const serializationStart = performance.now(),
      text = JSON.stringify(saved),
      serializationMs = performance.now() - serializationStart;
    const loadStart = performance.now(),
      restored = Ecosystem.load(text),
      loadMs = performance.now() - loadStart;
    expect(restored.save()).toEqual(saved);
    expect(saved.organisms).toHaveLength(LIMIT);
    expect(
      saved.organisms.every(
        (organism) => organism.genome.cells.length === 16 && organism.ancestry.length === 8,
      ),
    ).toBe(true);
    expect(saved.lineageArchive.living).toHaveLength(1600);
    expect(saved.lineageArchive.summaries).toHaveLength(256);
    expect(
      saved.lineageArchive.summaries.every((row) => row.foundingGenome?.cells.length === 16),
    ).toBe(true);
    expect(saved.lineageArchive.events).toHaveLength(512);
    expect(saved.interventions.entries).toHaveLength(128);
    expect(saved.telemetry.samples).toHaveLength(180);
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(bytes(saved)).toBeLessThan(2_500_000);
    const before = JSON.stringify(world.lineageSnapshot());
    world.save();
    world.frame();
    world.measurements();
    expect(JSON.stringify(world.lineageSnapshot())).toBe(before);
    console.info(
      'LINEAGE_SIZE_MEASUREMENTS',
      JSON.stringify({
        fixture:
          'Real 1600x16 bodies with eight actual lineage transitions, one real boundary repeated in 180 explicit payload intervals; not a 5400-tick trajectory',
        bytes: bytes(saved),
        archiveBytes: bytes(saved.lineageArchive),
        livingBytes: bytes(saved.lineageArchive.living),
        summaryBytes: bytes(saved.lineageArchive.summaries),
        eventBytes: bytes(saved.lineageArchive.events),
        constructionMs,
        snapshotMs,
        serializationMs,
        loadMs,
        node: process.version,
        platform: platform(),
        architecture: process.arch,
        cpus: cpus().length,
        memoryBytes: totalmem(),
      }),
    );
  });
  it('records the genuine founder and detached ordered founding fields without extensions', () => {
    const world = new Ecosystem();
    const saved = world.save();
    expect(saved.version).toBe(10);
    expect(saved.nextSpecies).toBe(5);
    expect(saved.lineageArchive).toMatchObject({
      version: 1,
      originKind: 'fresh',
      originTick: 0,
      summariesPruned: false,
      eventsPruned: false,
      eventsEvictedThroughTick: null,
      living: [
        {
          id: 1,
          origin: 'founder',
          createdTick: 0,
          parentId: null,
          liveCount: 1,
          peakCount: 1,
          peakKind: 'lifetime',
          extinctTick: null,
        },
      ],
      events: [{ kind: 'created', id: 1, tick: 0, origin: 'founder', parentId: null }],
    });
    expect(saved.lineageArchive.summaries[0].foundingGenome).toEqual(saved.organisms[0].genome);
    const copy = world.lineageSnapshot();
    copy.living[0].peakCount = 99;
    copy.summaries[0].foundingGenome!.cells[0].type = 8;
    copy.events[0].tick = 9;
    saved.organisms[0].genome.preference = 0;
    expect(world.save()).toEqual(reload(world).save());
    expect(world.lineageSnapshot()).not.toEqual(copy);
  });

  it('implements the complete public caller matrix before direction draws or insertion', () => {
    const world = empty();
    const original = world.save();
    for (const id of [1, 2, 3, 4, 5, 100]) {
      expect(world.spawn(genome(), 1, 1, id)).toBeUndefined();
      expect(world.save()).toEqual(original);
    }
    const parent = world.spawn(genome(), 10, 10, undefined, undefined, 2)!;
    expect(parent.rotation).toBe(2);
    const clone = world.spawn(genome(), 20, 20, parent.species, parent)!;
    expect(clone.generation).toBe(1);
    expect(clone.ancestry).toEqual([]);
    expect(world.spawn(genome(), 30, 30, parent.species)).toBeDefined();
    expect(world.lineageSnapshot().events).toHaveLength(1);
    expect(world.lineageSnapshot().living[0]).toMatchObject({ liveCount: 3, peakCount: 3 });
    const stable = world.save();
    for (const candidate of [
      () => world.spawn({ ...genome(), preference: 0.2 }, 40, 40, parent.species),
      () => world.spawn({ ...genome(), tempo: 3 }, 40, 40, parent.species, parent),
      () => world.spawn(genome(), 40, 40, parent.species + 1, parent),
      () => world.spawn(genome(), 40, 40, parent.species, structuredClone(parent)),
    ]) {
      expect(candidate()).toBeUndefined();
      expect(world.save()).toEqual(stable);
    }
    const derived = world.spawn(genome(), 40, 40, undefined, parent)!;
    expect(derived.ancestry).toEqual([parent.species]);
    expect(world.lineageSnapshot().living[1]).toMatchObject({
      origin: 'mutation',
      parentId: parent.species,
    });
    expect(derived.species).not.toBe(parent.species);
    expect(world.births).toBe(0);
    expect(parent.children).toBe(0);
    const foreign = structuredClone(parent);
    const before = world.save();
    expect(world.spawn(genome(), 50, 50, undefined, foreign)).toBeUndefined();
    expect(world.save()).toEqual({ ...before, nextSpecies: before.nextSpecies + 1 });
    world.kill(derived, 'manual');
    const extinct = world.save();
    expect(world.spawn(genome(), 40, 40, derived.species)).toBeUndefined();
    expect(world.save()).toEqual(extinct);
    world.kill(parent, 'age');
    expect(world.lineageSnapshot().living[0].liveCount).toBe(2);
    expect(world.lineageSnapshot().events.at(-1)).toMatchObject({
      kind: 'extinct',
      id: derived.species,
    });
    expect(reload(world).save()).toEqual(world.save());
  });

  it('preserves blocked/default allocator holes and full-population direction side effects', () => {
    const world = empty();
    world.walls[0] = 1;
    const before = world.save(),
      random = new Random(1);
    random.state = before.random;
    random.int(4);
    expect(world.spawn(genome(), 0, 0)).toBeUndefined();
    expect(world.save()).toEqual({
      ...before,
      random: random.state,
      nextSpecies: before.nextSpecies + 1,
    });
    for (let position = 0; position < LIMIT; position++)
      expect(
        world.spawn(genome(), position % WIDTH, Math.floor(position / WIDTH) + 1),
      ).toBeDefined();
    const full = world.save();
    expect(world.spawn(genome(), 100, 100)).toBeUndefined();
    expect(world.save()).toEqual({ ...full, nextSpecies: full.nextSpecies + 1 });
    expect(world.lineageSnapshot().living).toHaveLength(LIMIT);
    expect(world.lineageSnapshot().summaries).toHaveLength(256);
    expect(world.lineageSnapshot().events).toHaveLength(512);
    expect(reload(world).save()).toEqual(world.save());
    const oldest = [...world.organisms.values()][0];
    world.kill(oldest, 'manual');
    expect(world.lineageSnapshot().summaries.at(-1)).toMatchObject({
      id: oldest.species,
      liveCount: 0,
      genomeStatus: 'pruned',
      foundingGenome: null,
      extinctTick: 0,
    });
    expect(reload(world).save()).toEqual(world.save());
  });

  it('keeps independent convergence, eight transitions and three same-tick ring wraps', () => {
    const world = empty();
    let parent = world.spawn(genome(), 1, 1)!;
    const first = parent.species;
    for (let generation = 0; generation < 12; generation++) {
      const child = world.spawn(genome(), generation + 2, 1, undefined, parent)!;
      world.kill(parent, 'energy');
      parent = child;
    }
    expect(parent.ancestry).toHaveLength(8);
    expect(new Set(parent.ancestry).size).toBe(8);
    world.kill(parent, 'manual');
    for (let iteration = 0; iteration < 1025; iteration++) {
      const placed = world.spawn(genome(), 1, 1)!;
      world.kill(placed, 'manual');
    }
    const snapshot = world.lineageSnapshot();
    expect(snapshot).toMatchObject({
      living: [],
      summariesPruned: true,
      eventsPruned: true,
      eventsEvictedThroughTick: 0,
    });
    expect(snapshot.summaries).toHaveLength(256);
    expect(snapshot.events).toHaveLength(512);
    expect(snapshot.events[0].kind).toBe('created');
    expect(snapshot.events.at(-1)?.kind).toBe('extinct');
    const restored = reload(world);
    expect(restored.save()).toEqual(world.save());
    for (const candidate of [world, restored]) {
      const before = candidate.save();
      expect(candidate.spawn(genome(), 1, 1, first)).toBeUndefined();
      expect(candidate.save()).toEqual(before);
      candidate.spawn(genome(), 1, 1);
      candidate.step();
    }
    expect(restored.save()).toEqual(world.save());
  });

  it('observes actual changed/clonal births and deaths with a separate 180-tick archive control', () => {
    const observed = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0.8 });
    const control = new Ecosystem(
      { ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0.8 },
      true,
      { lineage: false },
    );
    for (const world of [observed, control]) {
      const parent = [...world.organisms.values()][0];
      parent.age = 32;
      parent.energy = 100;
      world.spawn(genome(), 10, 10)!.energy = 0;
    }
    for (let tick = 0; tick < 180; tick++) {
      if (tick === 45) {
        observed.shock('cold');
        control.shock('cold');
      }
      observed.step();
      control.step();
      expect(beforeArchive(observed.save())).toEqual(beforeArchive(control.save()));
    }
    expect(observed.births).toBeGreaterThan(0);
    expect(observed.deaths).toBeGreaterThan(0);
    expect(
      observed
        .lineageSnapshot()
        .events.some((event) => event.kind === 'created' && event.origin === 'mutation'),
    ).toBe(true);
    expect(observed.save().telemetry.samples).toHaveLength(6);
    expect(control.lineageSnapshot()).toMatchObject({
      originKind: 'legacy-import',
      originTick: 180,
      events: [],
    });
    expect(reload(control).save()).toEqual(control.save());
    expect(reload(observed).save()).toEqual(observed.save());
  });

  it.each([2, 3, 4, 5])(
    'migrates literal v%s without inventing history, then continues exactly',
    (version) => {
      const source = empty();
      const first = source.spawn(genome(), 20, 20)!;
      source.spawn({ ...genome(), tempo: 3 }, 30, 30);
      source.spawn(genome(), 40, 40, first.species);
      advance(source, 29);
      const saved = source.save();
      saved.organisms.reverse();
      const v5 = legacyV5(saved);
      const { telemetry: _telemetry, interventions: _interventions, ...old } = v5;
      const file =
        version === 2
          ? { ...old, version: 2 }
          : version === 3
            ? legacyV3(saved)
            : version === 4
              ? legacyV4(saved)
              : v5;
      expect(file).not.toHaveProperty('lineageArchive');
      const migrated = Ecosystem.load(JSON.stringify(file));
      expect(migrated.lineageSnapshot()).toMatchObject({
        originKind: 'legacy-import',
        originTick: 29,
        events: [],
      });
      expect(migrated.lineageSnapshot().summaries[0]).toMatchObject({
        id: saved.organisms[0].species,
        foundingGenome: null,
        genomeStatus: 'legacy-unknown',
      });
      expect(migrated.save().organisms).toEqual(saved.organisms);
      const continued = reload(migrated);
      for (const world of [migrated, continued]) advance(world, 31);
      expect(continued.save()).toEqual(migrated.save());
    },
  );
});

it('projects a detached selected founding baseline without changing the complete world', () => {
  const world = empty();
  world.changeTerrain('clear');
  const parent = world.spawn(genome(), 10, 10)!;
  const before = world.save();
  const baseline = world.presentation(parent.id).selectedBaseline!;
  expect(baseline).toEqual({
    lineageId: parent.species,
    relation: 'own-lineage',
    genome: parent.genome,
    status: 'retained',
  });
  baseline.genome!.cells[0].type = 3;
  expect(world.save()).toEqual(before);
  expect(world.presentation().selectedBaseline).toBeUndefined();
  const legacy = Ecosystem.load(JSON.stringify(legacyV7(before)));
  expect(legacy.presentation(parent.id).selectedBaseline).toMatchObject({
    genome: null,
    status: 'legacy-unknown',
  });
});
