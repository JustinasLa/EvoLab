import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, type Genome, type WorldFile } from '../../src/model';
import { MUTATION_CHANNELS, weightedMutation } from '../../src/mutation';
import { retainedBirthExport, type BirthEvent } from '../../src/mutation-evidence';
import { nativeDownload, registerNativeEvidence } from './sensory-evidence';
registerNativeEvidence();

for (const channel of [...MUTATION_CHANNELS, 'propensity', 'none'] as const)
  test(`native retained direct-parent inspection and export: ${channel}`, async ({
    page,
  }, info) => {
    let input: WorldFile | undefined, reference: Ecosystem | undefined;
    for (let i = 1; i <= 240; i++) {
      const world = new Ecosystem(
        { ...DEFAULTS, mutation: channel === 'propensity' ? 0 : 0.4, nutrients: 0, climate: 0 },
        false,
      );
      const policy = weightedMutation();
      for (const k of MUTATION_CHANNELS) policy.weights[k] = k === channel ? 1 : 0;
      world.changeMutationPolicy(policy);
      const genome: Genome = {
        cells: [
          { x: 0, y: 0, type: 7 },
          { x: 1, y: 0, type: 7 },
        ],
        preference: 0.5,
        tolerance: 0.3,
        tempo: 5,
        behavior: {
          version: 2,
          mode: 'evolved',
          reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
        },
        ...(channel === 'propensity' ? { mutationPropensity: 0 } : {}),
      };
      const parent = world.spawn(genome, 60, 60)!;
      parent.age = 32;
      parent.energy = 100;
      world.random.state = (i * 2654435761) >>> 0;
      const before = world.save();
      world.step();
      const event = world
        .lineageSnapshot()
        .events.find((e): e is BirthEvent => e.kind === 'reproduction')!;
      if (
        channel === 'none'
          ? event.outcome === 'born-no-op'
          : event.outcome === 'born-changed' && event.channels.includes(channel)
      ) {
        input = before;
        reference = world;
        break;
      }
    }
    expect(input).toBeDefined();
    await page.goto('/');
    await expect(page.locator('#population')).not.toHaveText('—');
    await page.locator('#pause').click();
    await page
      .locator('#file')
      .setInputFiles({
        name: 'pair.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(input)),
      });
    await expect(page.locator('#notice')).toContainText('World restored');
    if ((await page.locator('#run-state').textContent()) === 'LIVE')
      await page.locator('#pause').click();
    // Replacement can publish a running tick before Pause; keep the independent reference exact.
    const restored = JSON.parse((await nativeDownload(page)).toString()) as WorldFile;
    reference = Ecosystem.load(JSON.stringify(restored));
    await page.locator('#step').click();
    reference.step();
    const before = await nativeDownload(page);
    expect(JSON.parse(before.toString())).toEqual(reference.save());
    await page.locator('#ecosystem-tab').click();
    await page.locator('#lineage-heading').click();
    await expect(page.locator('#birth-detail')).toContainText('actual reproductive parent');
    await expect(page.locator('#birth-detail')).toContainText(
      channel === 'none' ? 'No-op mutation' : 'Changed offspring',
    );
    await expect(page.locator('#birth-detail')).not.toContainText('founding genome');
    await expect(page.locator('#birth-detail svg')).toHaveCount(2);
    await expect(page.locator('#birth-detail')).toContainText('preference');
    if (channel !== 'none') await expect(page.locator('#birth-detail')).toContainText(channel);
    const pending = page.waitForEvent('download');
    await page.locator('#birth-export').click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(`evolab-retained-births-tick-${reference.tick}.json`);
    const bytes = await readFile((await download.path())!);
    expect(JSON.parse(bytes.toString())).toEqual(
      retainedBirthExport(reference.lineageSnapshot(), reference.tick),
    );
    expect(await nativeDownload(page)).toEqual(before);
    await page.locator('#step').click();
    reference.step();
    expect(JSON.parse((await nativeDownload(page)).toString())).toEqual(reference.save());
    await info.attach('retained-pair-export.json', {
      body: bytes,
      contentType: 'application/json',
    });
  });
