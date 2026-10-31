import { test, expect } from '@playwright/test';
import type { ControlState } from '../../src/model';
import {
  finalizeFortyEvidence,
  salvageFortyFailure,
  snapshotFortyCommands,
} from './forty-control-fixture';

test('incremental command snapshots retain complete compact evidence and check cached epochs', async ({
  page,
}) => {
  await page.evaluate(() => {
    const fixture = (window.fortyFixture = {
      epoch: 'snapshot-test',
      active: true,
      deadline: Infinity,
      windowDeadline: Infinity,
      documentId: 'document',
      workerIds: ['worker'],
      commands: [],
      commandRevision: 0,
      commandRevisions: [],
      phase: null,
      expected: null,
      runId: 1,
      replacementId: 2,
      violation: null,
      samples: {},
      check(epoch) {
        if (epoch !== this.epoch || !this.active) throw new Error('Expired snapshot epoch.');
      },
      identity() {
        return {
          documentId: this.documentId,
          workerId: this.workerIds[0],
          workers: this.workerIds.length,
          runId: this.runId,
          replacementId: this.replacementId,
        };
      },
    });
    for (let sequence = 0; sequence < 2; sequence++) {
      fixture.commands.push({
        sequence,
        workerId: 'worker',
        operationId: `operation-${sequence}`,
        type: 'save',
        commandId: sequence + 1,
        runId: 1,
        postedAt: 10 + sequence,
      });
      fixture.commandRevisions.push(++fixture.commandRevision);
    }
  });
  const initial = await page.evaluate(snapshotFortyCommands, {
    epoch: 'snapshot-test',
    revision: null,
  });
  expect(initial.commands).toHaveLength(2);
  expect(initial.count).toBe(2);
  const retained = initial.commands!;
  expect(
    await page.evaluate(snapshotFortyCommands, {
      epoch: 'snapshot-test',
      revision: initial.revision,
    }),
  ).toEqual({ ...initial, commands: null });
  for (let sequence = 0; sequence < 2; sequence++) {
    const previous = await page.evaluate(() => window.fortyFixture.commandRevision);
    await page.evaluate((sequence) => {
      const fixture = window.fortyFixture;
      fixture.commands[sequence].terminal = {
        type: 'saved',
        operation: 'save',
        runId: 1,
        commandId: sequence + 1,
        receivedAt: 20 + sequence,
        state: { replacementId: 2, world: { stats: { tick: 30 + sequence } } } as ControlState,
        text: 'Complete native bytes are retained separately.',
      };
      fixture.commandRevisions[sequence] = ++fixture.commandRevision;
    }, sequence);
    const changed = await page.evaluate(snapshotFortyCommands, {
      epoch: 'snapshot-test',
      revision: previous,
    });
    expect(changed.commands).toHaveLength(1);
    expect(changed.commands![0]).toEqual({
      ...retained[sequence],
      terminal: {
        type: 'saved',
        operation: 'save',
        runId: 1,
        commandId: sequence + 1,
        receivedAt: 20 + sequence,
        replacementId: 2,
        tick: 30 + sequence,
      },
    });
    retained[sequence] = changed.commands![0];
    const complete = await page.evaluate(snapshotFortyCommands, {
      epoch: 'snapshot-test',
      revision: null,
    });
    expect(complete.commands).toEqual(retained);
    expect(complete.count).toBe(2);
  }
  const previous = await page.evaluate(() => window.fortyFixture.commandRevision);
  await page.evaluate(() => {
    const fixture = window.fortyFixture;
    fixture.commands.push({
      ...fixture.commands[1],
      sequence: 2,
      commandId: 3,
      terminal: undefined,
    });
    fixture.commandRevisions.push(++fixture.commandRevision);
  });
  const appended = await page.evaluate(snapshotFortyCommands, {
    epoch: 'snapshot-test',
    revision: previous,
  });
  expect(appended.commands).toEqual([
    { ...retained[1], sequence: 2, commandId: 3, terminal: undefined },
  ]);
  expect(appended.count).toBe(3);
  await expect(
    page.evaluate(snapshotFortyCommands, {
      epoch: 'obsolete',
      revision: await page.evaluate(() => window.fortyFixture.commandRevision),
    }),
  ).rejects.toThrow('Expired snapshot epoch.');
  await page.evaluate(() => {
    window.fortyFixture.active = false;
  });
  await expect(
    page.evaluate(snapshotFortyCommands, {
      epoch: 'snapshot-test',
      revision: appended.revision,
    }),
  ).rejects.toThrow('Expired snapshot epoch.');
});

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
