import { describe, expect, it } from 'vitest';
import { createComparison } from '../src/experiments';
import { Ecosystem } from '../src/ecosystem';
import { DEFAULTS } from '../src/model';
import {
  COMPARISON_METRICS,
  renderComparisonReport,
  type ComparisonMetric,
} from '../src/experiment-report';

function result() {
  const world = new Ecosystem(DEFAULTS);
  const runner = createComparison(JSON.stringify(world.save()), {
    intervention: 'cold',
    treatmentTick: 0,
    horizonTick: 31,
  });
  while (runner.advance(() => 0).tick < 31) {}
  const result = runner.result();
  runner.dispose();
  return result;
}
describe('paired measurement chart and exact table', () => {
  it('uses common tick/value axes, explicit units, dash/glyph distinctions and exact values for every metric', () => {
    const output = result(),
      target = document.createElement('div');
    for (const metric of Object.keys(COMPARISON_METRICS) as ComparisonMetric[]) {
      renderComparisonReport(target, output, metric);
      expect(target.querySelector('caption')?.textContent).toContain(COMPARISON_METRICS[metric]);
      expect(target.querySelectorAll('tbody tr')).toHaveLength(3);
      expect(target.querySelector('tbody tr')?.textContent).toContain(
        String(output.control.samples[0][metric]),
      );
      expect(target.querySelector('svg')?.getAttribute('aria-label')).toContain('shared axes');
      expect(target.querySelectorAll('.comparison-line')).toHaveLength(2);
      expect(target.querySelectorAll('circle')).toHaveLength(3);
      expect(target.querySelector('.comparison-treatment')?.tagName).toBe('path');
    }
  });
  it('breaks paths for missing measurements and distinguishes them from extinct undefined traits', () => {
    const output = result(),
      target = document.createElement('div');
    for (const branch of [output.control, output.treatment]) {
      branch.samples[1].meanPreference = null;
      branch.samples[1].population = 0;
    }
    renderComparisonReport(target, output, 'meanPreference');
    expect(target.textContent).toContain('Undefined (extinct)');
    expect(
      target.querySelector('.comparison-control.comparison-line')?.getAttribute('d')?.match(/M/g),
    ).toHaveLength(2);
    output.control.samples[1].population = 1;
    renderComparisonReport(target, output, 'meanPreference');
    expect(target.textContent).toContain('Missing observation');
    renderComparisonReport(target, output, 'population');
    expect(target.textContent).toContain('0 (extinct)');
  });
});
