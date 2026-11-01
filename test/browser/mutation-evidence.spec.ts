import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, positions, type WorldFile } from '../../src/model';
import { nativeDownload, registerNativeEvidence, attachWorld } from './sensory-evidence';
registerNativeEvidence();
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
async function restore(page: Page, file: WorldFile) {
  await page.locator('#file').setInputFiles({
    name: 'birth-evidence.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}
for (const blocked of [false, true])
  test(`native birth archive retains ${blocked ? 'failed placement' : 'actual parent-child'} evidence and exact continuation`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await expect(page.locator('#population')).not.toHaveText('—');
    await page.locator('#pause').click();
    const reference = new Ecosystem({ ...DEFAULTS, mutation: 0, nutrients: 0, climate: 0 }, false);
    const parent = reference.spawn(
      {
        cells: [{ x: 0, y: 0, type: 7 }],
        preference: 0.5,
        tolerance: 0.3,
        tempo: 5,
        behavior: { version: 1, mode: 'legacy' },
      },
      60,
      60,
    )!;
    parent.age = 32;
    parent.energy = 100;
    if (blocked) {
      reference.walls.fill(1);
      for (const i of positions(parent)) reference.walls[i] = 0;
    }
    await restore(page, reference.save());
    await page.locator('#step').click();
    const actual = await saved(page);
    while (reference.tick < actual.tick) reference.step();
    expect(actual).toEqual(reference.save());
    const event = actual.lineageArchive.events.find((e) => e.kind === 'reproduction')!;
    expect(event).toMatchObject({
      kind: 'reproduction',
      id: parent.species,
      parentOrganismId: parent.id,
      parentGenome: parent.genome,
      outcome: blocked ? 'failed-placement' : 'born-clone',
    });
    if (event.kind !== 'reproduction') throw new Error('Missing reproductive evidence');
    if (blocked) {
      expect(event.childGenome).toBeNull();
      expect(actual.births).toBe(0);
      expect(actual.telemetry.pending.energy.reproductionSpent).toBe(0);
    } else expect(event.childGenome).toEqual(parent.genome);
    await page.locator('#ecosystem-tab').click();
    await page.locator('#lineage-heading').click();
    await expect(page.locator('#birth-detail')).toContainText(
      blocked ? 'Failed placement' : 'Clone birth',
    );
    await expect(page.locator('#birth-detail svg')).toHaveCount(blocked ? 1 : 2);
    if (blocked)
      await expect(page.locator('#birth-detail')).toContainText(
        'No child genome or inherited delta exists',
      );
    expect(await saved(page)).toEqual(actual);
    const invalid = structuredClone(actual);
    invalid.lineageArchive.events.find((e) => e.kind === 'reproduction')!.tick = actual.tick + 1;
    await page.locator('#file').setInputFiles({
      name: 'invalid-event.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(invalid)),
    });
    await expect(page.locator('#notice')).toContainText('Invalid ecosystem lineage archive');
    expect(await saved(page)).toEqual(actual);
    await restore(page, actual);
    const resumed = await saved(page);
    while (reference.tick < resumed.tick) reference.step();
    expect(resumed).toEqual(reference.save());
    await page.locator('#step').click();
    reference.step();
    expect(await saved(page)).toEqual(reference.save());
    await attachWorld(info, 'retained-birth-evidence.json', actual);
  });
