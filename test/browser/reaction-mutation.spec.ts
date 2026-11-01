import { expect, test } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, type Genome, type WorldFile } from '../../src/model';
import {
  assertNativeStreams,
  attachWorld,
  nativeDownload,
  nativeSummary,
  registerNativeEvidence,
} from './sensory-evidence';

registerNativeEvidence();

test('native seeded active births retain real inherited reaction differences and complete continuation', async ({
  page,
}, info) => {
  const reference = new Ecosystem({ ...DEFAULTS, climate: 0, nutrients: 0, mutation: 0.4 }, false),
    genome: Genome = {
      cells: [{ x: 0, y: 0, type: 3 }],
      preference: 0.5,
      tolerance: 0.2,
      tempo: 5,
      behavior: {
        version: 2,
        mode: 'evolved',
        reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
      },
    };
  const parent = reference.spawn(genome, 60, 60)!;
  parent.age = 32;
  parent.energy = 40;
  reference.random.state = 7;
  const fixture = JSON.stringify({ ...reference.save(), version: 11 });
  await page.goto('/');
  await expect(page.locator('#population')).not.toHaveText('—');
  await page.locator('#file').setInputFiles({
    name: 'native-world11.json',
    mimeType: 'application/json',
    buffer: Buffer.from(fixture),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
  await page.locator('#step').click();
  const saved: WorldFile = JSON.parse((await nativeDownload(page)).toString('utf8'));
  while (reference.tick < saved.tick) reference.step();
  expect(saved).toEqual(reference.save());
  expect(saved.version).toBe(12);
  expect(saved.births).toBeGreaterThanOrEqual(1);
  const mutation = saved.lineageArchive.summaries.find((summary) => summary.origin === 'mutation')!;
  expect(mutation.parentId).toBe(parent.species);
  expect(mutation.foundingGenome!.behavior).not.toEqual(genome.behavior);
  expect(saved.telemetry.pending.energy.reproductionSpent).toBeGreaterThan(0);
  await page.locator('#step').click();
  reference.step();
  expect(JSON.parse((await nativeDownload(page)).toString('utf8'))).toEqual(reference.save());
  await attachWorld(info, 'reaction-mutation-independent-reference.json', reference.save());
  assertNativeStreams(page, 2);
  expect((await nativeSummary(page)).pending).toEqual([]);
});
