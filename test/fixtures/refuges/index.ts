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
  const { thermalRefuges: _thermalRefuges, ...retained } = saved;
  assert.ok(retained.interventions.entries.every((entry) => !entry.kind.startsWith('refuge-')));
  return {
    ...retained,
    version: 6,
    interventions: {
      ...retained.interventions,
      version: 2,
      entries: retained.interventions.entries as WorldFileV6['interventions']['entries'],
    },
  };
}
