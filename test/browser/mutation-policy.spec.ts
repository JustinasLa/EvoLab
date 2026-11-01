import { expect, test, type Page } from '@playwright/test';
import { Ecosystem } from '../../src/ecosystem';
import { DEFAULTS, founder, type WorldFile } from '../../src/model';
import { MUTATION_CHANNELS, weightedMutation } from '../../src/mutation';
import {
  nativeDownload,
  registerNativeEvidence,
  attachWorld,
  nativeSummary,
} from './sensory-evidence';
registerNativeEvidence();
const saved = async (page: Page): Promise<WorldFile> =>
  JSON.parse((await nativeDownload(page)).toString('utf8'));
async function load(page: Page, file: WorldFile) {
  await page
    .locator('#file')
    .setInputFiles({
      name: 'policy-world.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });
  await expect(page.locator('#notice')).toContainText('World restored');
  if ((await page.locator('#run-state').textContent()) === 'LIVE')
    await page.locator('#pause').click();
  await expect(page.locator('#run-state')).toHaveText('PAUSED');
}
for (const channel of ['preference', 'reactions'] as const)
  test(`native weighted ${channel} controls persist, isolate real births and retain complete rejected-import continuation`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await expect(page.locator('#population')).not.toHaveText('—');
    const empty = new Ecosystem({ ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 }, false);
    await load(page, empty.save());
    await page.locator('#ecosystem-tab').click();
    await page.locator('#mutation-controls summary').click();
    const before = await saved(page);
    await page.locator('#mutation-mode').focus();
    await page.locator('#mutation-mode').press('End');
    await expect(page.locator('#mutation-mode')).toHaveValue('weighted');
    for (const key of MUTATION_CHANNELS)
      await page.locator(`#mutation-weight-${key}`).fill(key === channel ? '100' : '0');
    expect(await saved(page)).toEqual(before);
    await page.locator('#mutation-apply').focus();
    await page.locator('#mutation-apply').press('Space');
    await expect(page.locator('#mutation-status')).toContainText('Confirmed policy: Weighted');
    const configured = await saved(page),
      policy = weightedMutation();
    for (const key of MUTATION_CHANNELS) policy.weights[key] = key === channel ? 100 : 0;
    expect(configured.mutationPolicy).toEqual(policy);
    empty.changeMutationPolicy(policy);
    expect(configured).toEqual(empty.save());
    for (const width of [320, 390, 800, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      for (const input of await page.locator('.mutation-weights input').all()) {
        const box = (await input.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    const reference = new Ecosystem(
        { ...DEFAULTS, mutation: 0.4, nutrients: 0, climate: 0 },
        false,
      ),
      genome = founder(0);
    genome.cells = [
      { x: 0, y: 0, type: 3 },
      { x: 1, y: 0, type: 7 },
      { x: 2, y: 0, type: 7 },
    ];
    genome.behavior = {
      version: 2,
      mode: 'evolved',
      reactions: { food: 'chase', wall: 'flee', harmless: 'ignore', dangerous: 'flee' },
    };
    reference.changeMutationPolicy(configured.mutationPolicy);
    const parent = reference.spawn(genome, 60, 60)!;
    parent.age = 32;
    parent.energy = 40;
    reference.random.state = 7;
    await load(page, reference.save());
    await page.locator('#step').click();
    const birth = await saved(page);
    while (reference.tick < birth.tick) reference.step();
    expect(birth).toEqual(reference.save());
    expect(birth.births).toBeGreaterThan(0);
    const child = birth.organisms.find((o) => o.generation === 1)!;
    expect(child).toBeTruthy();
    const restored = structuredClone(child.genome);
    if (channel === 'preference') restored.preference = genome.preference;
    else restored.behavior = genome.behavior;
    expect(restored).toEqual(genome);
    expect(child.genome[channel === 'preference' ? 'preference' : 'behavior']).not.toEqual(
      genome[channel === 'preference' ? 'preference' : 'behavior'],
    );
    expect(birth.telemetry.pending.energy.reproductionSpent).toBeGreaterThan(0);
    const bad = structuredClone(birth);
    if (bad.mutationPolicy.mode !== 'weighted') throw new Error('test policy');
    bad.mutationPolicy.weights.add = -1;
    await page
      .locator('#file')
      .setInputFiles({
        name: 'invalid-policy.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(bad)),
      });
    await expect(page.locator('#notice')).toContainText('Invalid mutation policy');
    expect(await saved(page)).toEqual(birth);
    await page.locator('#step').click();
    reference.step();
    expect(await saved(page)).toEqual(reference.save());
    await page.locator('#mutation-weight-' + channel).fill('0');
    await page.locator('#mutation-apply').click();
    await expect(page.locator('#mutation-status')).toContainText('Confirmed policy: Weighted');
    const disabled = await saved(page);
    expect(disabled.mutationPolicy).toEqual({
      ...policy,
      weights: Object.fromEntries(MUTATION_CHANNELS.map((key) => [key, 0])),
    });
    await load(page, disabled);
    await expect(page.locator('#mutation-weight-' + channel)).toHaveValue('0');
    expect((await saved(page)).mutationPolicy).toEqual(disabled.mutationPolicy);
    await attachWorld(info, 'native-policy-birth.json', birth);
    await attachWorld(info, 'native-policy-disabled.json', disabled);
    await info.attach('native-policy-evidence.json', {
      body: JSON.stringify(await nativeSummary(page)),
      contentType: 'application/json',
    });
  });
