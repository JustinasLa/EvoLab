import { test, expect } from '@playwright/test';
import { finalizeFortyEvidence, salvageFortyFailure } from './forty-control-fixture';

for (const failAt of ['snapshot', 'write', 'rename', 'attach', 'invalidate-browser', 'endpoint']) {
  test(`forty-control finalization remains incomplete on interrupted ${failAt}`, async () => {
    const original = new Error(`interrupted ${failAt}`);
    const artifacts: { status: string }[] = [];
    const events: string[] = [];
    let endpoint: unknown;
    const phase = async (name: string) => {
      events.push(name);
      if (name === failAt) throw original;
    };
    await expect(
      finalizeFortyEvidence({
        checkpoint: async () => {
          await phase('snapshot');
          artifacts.push({ status: 'incomplete' }); // Potential surviving tmp file.
          await phase('write');
          artifacts.push({ status: 'incomplete' }); // Potential surviving renamed checkpoint.
          await phase('rename');
          return 'provisional-sha256';
        },
        attach: () => phase('attach'),
        invalidateBrowser: () => phase('invalidate-browser'),
        finish: () => {
          events.push('endpoint');
          throw original;
        },
        publish: (value) => {
          endpoint = value;
        },
      }),
    ).rejects.toBe(original);
    expect(events.at(-1)).toBe(failAt);
    expect(artifacts.every((artifact) => artifact.status === 'incomplete')).toBe(true);
    expect(endpoint).toBeUndefined();
  });
}

test('forty-control endpoint binds provisional evidence after all measured awaits', async () => {
  const events: string[] = [];
  let endpoint: unknown;
  await finalizeFortyEvidence({
    checkpoint: async () => {
      events.push('checkpoint');
      return 'provisional-sha256';
    },
    attach: async () => {
      events.push('attach');
    },
    invalidateBrowser: async () => {
      events.push('invalidate-browser');
    },
    finish: () => {
      events.push('endpoint');
      return 119999;
    },
    publish: (value) => {
      endpoint = value;
      events.push('synchronous-annotation');
    },
  });
  expect(events).toEqual([
    'checkpoint',
    'attach',
    'invalidate-browser',
    'endpoint',
    'synchronous-annotation',
  ]);
  expect(endpoint).toEqual({
    status: 'measured-endpoint-reached',
    acceptanceElapsedMs: 119999,
    evidenceSHA256: 'provisional-sha256',
  });
});

test('forty-control outer salvage retains original error across partial persistence and receipt failure', async () => {
  const original = new Error('original stream/deadline failure');
  const secondary: { phase: string; error: string }[] = [];
  const events: string[] = [];
  let receipt: unknown;
  await expect(
    salvageFortyFailure(
      original,
      [
        {
          phase: 'cleanup',
          run: async () => {
            events.push('cleanup');
            throw new Error('close failed');
          },
        },
        {
          phase: 'partial-one',
          run: async () => {
            events.push('partial-one');
            throw new Error('ENOSPC');
          },
        },
        {
          phase: 'partial-two',
          run: async () => {
            events.push('partial-two');
          },
        },
        {
          phase: 'receipt',
          run: async () => {
            receipt = [...secondary];
            events.push('receipt');
            throw new Error('EACCES');
          },
        },
      ],
      secondary,
    ),
  ).rejects.toBe(original);
  expect(events).toEqual(['cleanup', 'partial-one', 'partial-two', 'receipt']);
  expect(secondary.map(({ phase }) => phase)).toEqual(['cleanup', 'partial-one', 'receipt']);
  expect(receipt).toEqual(secondary.slice(0, 2));
  expect(secondary[1].error).toContain('ENOSPC');
  expect((original as Error & { reportingErrors: unknown }).reportingErrors).toEqual(secondary);
});
