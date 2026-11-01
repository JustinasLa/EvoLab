import { describe, expect, it } from 'vitest';
import {
  classifyRecord,
  createLibrary,
  encodeRecord,
  libraryCandidate,
  type LibraryEntry,
} from '../src/library';
import { parseBlueprint, serializeBlueprint } from '../src/blueprint';
import { storedSensoryGenome, baselineFixtures } from './fixtures/sensory-legacy';
import { libraryHarness } from './fixtures/library';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';

describe('independent blueprint versions in local collection records', () => {
  it('keeps genuine blueprint1 original strings and exact CAS tokens across reads and no-op renames', async () => {
    const native = libraryHarness();
    const token = JSON.stringify(
      { recordVersion: 1, revision: 7, blueprint: baselineFixtures['blueprint1.json'] },
      null,
      1,
    );
    native.values.set(first, token);
    const library = createLibrary({ factory: () => native.factory, randomId: () => second });
    const entry = (await library.list()).rows[0] as LibraryEntry;
    expect(entry.kind).toBe('valid');
    expect(entry.blueprint).toEqual(parseBlueprint(baselineFixtures['blueprint1.json']));
    expect(entry.blueprint.version).toBe(4);
    expect(entry.token).toBe(token);
    expect(await library.read(entry)).toEqual(entry);
    expect(native.values.get(first)).toBe(token);
    await library.mutate({ type: 'rename', entry, name: entry.blueprint.name });
    expect(native.values.get(first)).toBe(token);
    await library.mutate({ type: 'duplicate', entry });
    expect(native.values.get(first)).toBe(token);
    const duplicate = classifyRecord(second, native.values.get(second)) as LibraryEntry;
    expect(duplicate.blueprint).toEqual(entry.blueprint);
    expect(JSON.parse(JSON.parse(duplicate.token).blueprint).version).toBe(4);
    native.values.set(first, token + ' ');
    await expect(library.read(entry)).rejects.toMatchObject({ code: 'conflict' });
    expect(native.values.get(first)).toBe(token + ' ');
    library.dispose();
  });

  it('retains complete evolved tables and decoded opaque payload through create/read/duplicate/rename/export', async () => {
    const native = libraryHarness(),
      genome = storedSensoryGenome();
    const library = createLibrary({
      factory: () => native.factory,
      randomId: (() => {
        const ids = [first, second];
        return () => ids.shift()!;
      })(),
    });
    const candidate = libraryCandidate(genome, 'Full inherited data', 'literal metadata', {
      captureTick: 90,
    });
    expect(await library.list()).toEqual({ count: 0, rows: [] });
    await library.mutate({ type: 'create', candidate });
    let entry = (await library.list()).rows[0] as LibraryEntry;
    expect(entry.blueprint.genome).toEqual(genome);
    expect((await library.read(entry)).blueprint.genome).toEqual(genome);
    await library.mutate({ type: 'duplicate', entry });
    const duplicate = classifyRecord(second, native.values.get(second)) as LibraryEntry;
    expect(duplicate.blueprint.genome).toEqual(genome);
    await library.mutate({ type: 'rename', entry, name: 'Renamed' });
    entry = classifyRecord(first, native.values.get(first)) as LibraryEntry;
    expect(entry.blueprint.genome).toEqual(genome);
    expect(parseBlueprint(serializeBlueprint(entry.blueprint)).genome).toEqual(genome);
    expect(JSON.parse(entry.token).blueprint).toBe(serializeBlueprint(entry.blueprint));
    entry.blueprint.genome.cells[0].type = 8;
    expect(
      (classifyRecord(first, native.values.get(first)) as LibraryEntry).blueprint.genome,
    ).toEqual(genome);
    library.dispose();
  });

  it('keeps future blueprints read-only and distinguishes malformed supported blueprint2', async () => {
    const native = libraryHarness(),
      candidate = libraryCandidate(storedSensoryGenome(), 'Future', '');
    const envelope = JSON.parse(encodeRecord(candidate, 1));
    const future = JSON.stringify({
      ...envelope,
      blueprint: JSON.stringify({ ...candidate.blueprint, version: 5 }),
    });
    native.values.set(first, future);
    const library = createLibrary({ factory: () => native.factory });
    const row = (await library.list()).rows[0];
    expect(row.kind).toBe('unsupported');
    await expect(library.mutate({ type: 'repair', entry: row as any })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(native.values.get(first)).toBe(future);
    const invalid = JSON.parse(envelope.blueprint);
    delete invalid.genome.behavior.reactions.dangerous;
    expect(
      classifyRecord(first, JSON.stringify({ ...envelope, blueprint: JSON.stringify(invalid) }))
        .kind,
    ).toBe('damaged');
    library.dispose();
  });
});
