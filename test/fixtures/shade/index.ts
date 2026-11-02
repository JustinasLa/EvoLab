import { assertLegacyLifeHistory } from '../life-history';
import { historicalArchive } from '../telemetry';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { WorldFile, WorldFileV9 } from '../../../src/model';

const provenance = JSON.parse(readFileSync('test/fixtures/shade/provenance.json', 'utf8'));
const archive = readFileSync('test/fixtures/shade/world9-capture.json.gz');
function verify(bytes: Buffer | string, receipt: { bytes: number; sha256: string }) {
  assert.equal(Buffer.byteLength(bytes), receipt.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
}
verify(archive, provenance.archive);
const payload = gunzipSync(archive);
verify(payload, provenance.payload);
const captured = JSON.parse(payload.toString('utf8'));
assert.equal(captured.base, provenance.base);
export const world9Cases: {
  seed: number;
  mutation: number;
  rotation: number;
  resumeTick: number;
  endpoints: Record<number, string>;
}[] = captured.cases;

export function world9Text(name: string): string {
  const text = captured.files[name];
  verify(text, provenance.files[name]);
  assert.equal(JSON.parse(text).version, 9);
  return text;
}

export function projectWorld9(saved: WorldFile): WorldFileV9 {
  assertLegacyLifeHistory(saved);
  assert.deepEqual(saved.mutationPolicy, { version: 1, mode: 'legacy' });
  assert.ok(saved.interventions.entries.every((row) => row.kind !== 'mutation-policy'));
  const {
    lifeHistoryLog: _lifeHistoryLog,
    mutationPolicy: _policy,
    shadeHabitats: _shadeHabitats,
    ...retained
  } = saved;
  assert.ok(retained.interventions.entries.every((row) => !row.kind.startsWith('shade-')));
  return {
    ...retained,
    version: 9,
    lineageArchive: historicalArchive(saved.lineageArchive),
    interventions: { ...retained.interventions, version: 3 } as WorldFileV9['interventions'],
  };
}
