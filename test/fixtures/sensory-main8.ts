import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { WorldFile } from '../../src/model';
import { restoreHistoricalWorld, restoreHistoricalGenome } from './sensory-legacy';

const provenance = JSON.parse(readFileSync('test/fixtures/sensory-main8-provenance.json', 'utf8'));
const archive = readFileSync('test/fixtures/sensory-main8.json.gz');
assert.equal(archive.length, provenance.archive.bytes);
assert.equal(createHash('sha256').update(archive).digest('hex'), provenance.archive.sha256);
const captured = JSON.parse(gunzipSync(archive).toString('utf8'));
assert.equal(captured.base, provenance.base);

// Genuine accepted world8 bytes, produced by the source hashes in provenance.
export function main8Fixture(name: string): string {
  const text = captured.files[name];
  assert.equal(Buffer.byteLength(text), provenance.files[name].bytes);
  assert.equal(createHash('sha256').update(text).digest('hex'), provenance.files[name].sha256);
  return text;
}

// Old archives deliberately retained only semantic anatomy/traits. The world9
// archive additionally retains the full passive genome, tested independently.
export function restoreMain8(saved: WorldFile) {
  const archive = structuredClone(saved.lineageArchive);
  for (const row of archive.summaries)
    if (row.foundingGenome) {
      const genome = restoreHistoricalGenome(row.foundingGenome);
      row.foundingGenome = {
        cells: genome.cells.map(({ x, y, type }) => ({ x, y, type })),
        preference: genome.preference,
        tolerance: genome.tolerance,
        tempo: genome.tempo,
      } as typeof row.foundingGenome;
    }
  const { shadeHabitats: _shadeHabitats, ...retained } = saved;
  return {
    ...retained,
    interventions: { ...saved.interventions, version: 3 },
    version: 8,
    organisms: restoreHistoricalWorld(saved).organisms,
    lineageArchive: archive,
  };
}
