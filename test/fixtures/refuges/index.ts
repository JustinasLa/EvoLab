import { assertLegacyLifeHistory } from '../life-history';
import { syntheticHistoricalWorld } from '../sensory-legacy';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Ecosystem as AcceptedEcosystem } from './accepted-source/ecosystem';
import type { WorldFileV6, WorldFile } from '../../../src/model';

const provenance = JSON.parse(readFileSync('test/fixtures/refuges/provenance.json', 'utf8'));
let captured: Record<string, string> | undefined;
const decoded = new Map<string, string>();

export function fixtureText(name: string): string {
  const retained = decoded.get(name);
  if (retained !== undefined) return retained;
  if (!captured) {
    const archive = readFileSync('test/fixtures/refuges/accepted-capture.json.gz');
    assert.equal(createHash('sha256').update(archive).digest('hex'), provenance.archive.sha256);
    const container = JSON.parse(gunzipSync(archive).toString('utf8'));
    assert.equal(container.base, '28415e3339f24660da8f77e4ada8237a6bbce7ae');
    captured = container.files;
  }
  const record = provenance.files.find((file: { path: string }) => file.path === name);
  assert.ok(record, `Missing captured fixture ${name}`);
  const bytes = Buffer.from(captured![name], 'base64');
  assert.equal(bytes.length, record.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
  const text = bytes.toString('utf8');
  decoded.set(name, text);
  return text;
}

export const acceptedReference = (text: string): AcceptedEcosystem => AcceptedEcosystem.load(text);

export function predecessor(saved: WorldFile): WorldFileV6 {
  assertLegacyLifeHistory(saved);
  assert.deepEqual(saved.mutationPolicy, { version: 1, mode: 'legacy' });
  assert.ok(saved.interventions.entries.every((row) => row.kind !== 'mutation-policy'));
  const {
    lifeHistoryLog: _lifeHistoryLog,
    mutationPolicy: _policy,
    shadeHabitats: _shadeHabitats,
    thermalRefuges: _thermalRefuges,
    lineageArchive: _lineageArchive,
    ...retained
  } = saved;
  assert.ok(retained.interventions.entries.every((entry) => !entry.kind.startsWith('refuge-')));
  return {
    ...retained,
    organisms: syntheticHistoricalWorld(saved).organisms,
    version: 6,
    interventions: {
      ...retained.interventions,
      version: 2,
      entries: retained.interventions.entries as WorldFileV6['interventions']['entries'],
    },
  };
}

// Compare object boundaries without normalizing raw Infinity or signed zero.
// Iteration also preserves the captured deep-path coverage without recursion.
export function identicalRecords(actual: unknown, expected: unknown): void {
  const pending: [unknown, unknown][] = [[actual, expected]];
  while (pending.length) {
    const [left, right] = pending.pop()!;
    if (right && typeof right === 'object') {
      assert(left !== null && typeof left === 'object');
      assert.notEqual(left, right, 'Independent snapshots must be detached');
      assert.equal(Object.getPrototypeOf(left), Object.getPrototypeOf(right));
      const keys = Reflect.ownKeys(right);
      assert.deepEqual(Reflect.ownKeys(left), keys);
      for (const key of keys) {
        assert(Object.hasOwn(left, key));
        const actualProperty = Object.getOwnPropertyDescriptor(left, key)!;
        const expectedProperty = Object.getOwnPropertyDescriptor(right, key)!;
        for (const flag of ['enumerable', 'configurable', 'writable', 'get', 'set'] as const)
          assert.equal(actualProperty[flag], expectedProperty[flag]);
        pending.push([actualProperty.value, expectedProperty.value]);
      }
    } else assert(Object.is(left, right));
  }
}
