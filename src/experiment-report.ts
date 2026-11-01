import type { ComparisonResult, ComparisonSample } from './experiment-model';

export const COMPARISON_METRICS = {
  population: 'Population (living organisms)',
  births: 'Births (lifetime cumulative)',
  deaths: 'Deaths (lifetime cumulative)',
  meanPreference: 'Mean temperature preference (normalized)',
  meanTolerance: 'Mean temperature tolerance (normalized width)',
  stressedFraction: 'Measured stressed fraction (0–1)',
} as const;
export type ComparisonMetric = keyof typeof COMPARISON_METRICS;
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag: string, attributes: Record<string, string | number>, text = '') {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  element.textContent = text;
  return element;
}
export function renderComparisonReport(
  destination: HTMLElement,
  result: ComparisonResult,
  metric: ComparisonMetric,
): void {
  const label = COMPARISON_METRICS[metric];
  const plot = svg('svg', {
    viewBox: '0 0 280 180',
    role: 'img',
    'aria-label': `${label}; shared axes for control and treatment. Exact values in the following table.`,
  });
  const maximum = Math.max(
    1,
    ...result.control.samples.map((s) => s[metric] ?? 0),
    ...result.treatment.samples.map((s) => s[metric] ?? 0),
  );
  const start = result.sourceTick,
    end = result.plan.horizonTick;
  const x = (tick: number) => 48 + ((tick - start) / (end - start)) * 220;
  const y = (value: number) => 140 - (value / maximum) * 120;
  plot.append(
    svg('path', { d: 'M48,20V140H268', class: 'comparison-axis' }),
    svg('text', { x: 44, y: 24, 'text-anchor': 'end' }, maximum.toPrecision(3)),
    svg('text', { x: 44, y: 144, 'text-anchor': 'end' }, '0'),
    svg('text', { x: 48, y: 158 }, String(start)),
    svg('text', { x: 268, y: 158, 'text-anchor': 'end' }, String(end)),
    svg('text', { x: 158, y: 176, 'text-anchor': 'middle' }, 'Logical tick'),
  );
  for (const branch of ['control', 'treatment'] as const) {
    let path = '',
      connected = false;
    for (const sample of result[branch].samples) {
      const value = sample[metric];
      if (value === null) {
        connected = false;
        continue;
      }
      const px = x(sample.tick),
        py = y(value);
      path += `${connected ? 'L' : 'M'}${px},${py}`;
      connected = true;
      plot.append(
        branch === 'control'
          ? svg('circle', { cx: px, cy: py, r: 2, class: 'comparison-control' })
          : svg('path', { d: `M${px},${py - 3}l3,6h-6Z`, class: 'comparison-treatment' }),
      );
    }
    plot.append(svg('path', { d: path, class: `comparison-${branch} comparison-line` }));
  }
  const table = document.createElement('table');
  const caption = table.createCaption();
  caption.textContent = `${label} · exact retained observations`;
  const heading = table.createTHead().insertRow();
  for (const label of ['Tick', 'Control', 'Treatment']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    heading.append(th);
  }
  const format = (sample: ComparisonSample): string =>
    sample[metric] === null
      ? sample.population === 0
        ? 'Undefined (extinct)'
        : 'Missing observation'
      : `${sample[metric]}${metric === 'population' && sample.population === 0 ? ' (extinct)' : ''}`;
  const body = table.createTBody();
  for (const [i, sample] of result.control.samples.entries()) {
    const row = body.insertRow();
    for (const value of [String(sample.tick), format(sample), format(result.treatment.samples[i])])
      row.insertCell().textContent = value;
  }
  destination.replaceChildren(plot, table);
}
