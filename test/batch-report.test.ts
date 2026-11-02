import { expect, it } from 'vitest';
import { renderBatchReport } from '../src/batch-report';
import { createBatch } from '../src/experiment-batch';
import { batchPlan, batchResult } from './batch-fixture';

it('reports all real endpoints, paired differences and empirical outcome distributions', () => {
  const result = batchResult({
    seeds: [42],
    intervention: 'shade',
    durationTicks: 300,
    treatmentDelay: 0,
  });
  const root = document.createElement('div');
  renderBatchReport(root, result);
  expect(root.textContent).toContain('1/1 independent seed pairs complete');
  expect(root.textContent).toContain('control 0/1, treatment 1/1');
  expect(root.textContent).toContain('Undefined');
  expect(root.textContent).toContain('No uncertainty intervals');
  expect(root.textContent).toContain('distribution (n=0): undefined');
  expect(root.querySelectorAll('tbody tr')).toHaveLength(6);
  expect(root.querySelectorAll('svg path')).toHaveLength(2);
  expect(root.textContent).toContain('(energy)');
  result.runs[0].reproduced = true;
  result.runs[0].recipe!.control.extinction = { tick: null, cause: 'initially empty checkpoint' };
  renderBatchReport(root, result);
  expect(root.textContent).toContain('replayed');
  expect(root.textContent).toContain('empty at fork');
});
it('keeps incomplete and failed denominators explicit and renders error text without markup', () => {
  const runner = createBatch(batchPlan({ seeds: [1, 2, 3] })),
    result = runner.cancel();
  runner.dispose();
  result.runs[1].status = 'failed';
  result.runs[1].error = '<img src=x onerror=alert(1)>';
  const root = document.createElement('div');
  renderBatchReport(root, result);
  expect(root.textContent).toContain(
    '0/3 independent seed pairs complete; 1 failed, 1 cancelled, 1 not run',
  );
  expect(root.textContent).toContain('control 0/0, treatment 0/0');
  expect(root.textContent).toContain('<img src=x');
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelectorAll('tbody tr')).toHaveLength(3);
});
