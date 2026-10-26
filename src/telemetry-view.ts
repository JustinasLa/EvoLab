import {
  CELL_NAMES,
  COLORS,
  PREFERENCE_ENDPOINTS,
  TELEMETRY_CAPACITY,
  TELEMETRY_INTERVAL_TICKS,
  type Frame,
  type TelemetrySample,
} from './model';

type View = 'population' | 'food' | 'adaptation';
interface Series {
  name: string;
  color: string;
  style: number;
  value: (sample: TelemetrySample) => number | null;
}
const DASHES = ['', '9 4', '4 3', '1 4', '9 3 1 3', '9 3 4 3'];
const GLYPHS = ['●', '■', '▲', '◆', '+', '×'];
const SVG = 'http://www.w3.org/2000/svg';
export const eventRate = (sample: TelemetrySample, count: number): number =>
  (count * TELEMETRY_INTERVAL_TICKS) / (sample.tick - sample.fromTick);
export const stressPercent = (sample: TelemetrySample): number | null =>
  sample.adaptation && sample.population
    ? (sample.adaptation.stressedOrganisms / sample.population) * 100
    : null;
const numberText = (value: number | null): string =>
  value === null ? 'Unavailable' : String(value);
const axisText = (value: number): string =>
  value >= 100000 ? value.toExponential(1) : String(Number(value.toPrecision(4)));
const rangeLabel = (bin: number): string =>
  `[${bin === 0 ? 0 : PREFERENCE_ENDPOINTS[bin - 1]}, ${PREFERENCE_ENDPOINTS[bin]}${bin === 9 ? ']' : ')'}`;
function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  text?: string,
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgElement<Tag extends keyof SVGElementTagNameMap>(
  tag: Tag,
  attributes: Record<string, string | number> = {},
  text?: string,
): SVGElementTagNameMap[Tag] {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function marker(style: number, x: number, y: number, color: string): SVGElement {
  if (style === 0) return svgElement('circle', { cx: x, cy: y, r: 2.5, fill: color });
  const shapes = [
    '',
    `M${x - 2.5},${y - 2.5}h5v5h-5Z`,
    `M${x},${y - 3}l3,5h-6Z`,
    `M${x},${y - 3}l3,3l-3,3l-3,-3Z`,
    `M${x - 3},${y}h6M${x},${y - 3}v6`,
    `M${x - 3},${y - 3}l6,6M${x - 3},${y + 3}l6,-6`,
  ];
  return svgElement('path', {
    d: shapes[style],
    stroke: color,
    'stroke-width': 1.5,
    fill: style < 4 ? color : 'none',
  });
}

export function createTelemetryView(root: HTMLElement) {
  const get = <Type extends HTMLElement>(id: string): Type => root.querySelector<Type>(`#${id}`)!,
    section = get('telemetry'),
    viewSelect = get<HTMLSelectElement>('telemetry-view'),
    sampleSelect = get<HTMLSelectElement>('telemetry-sample'),
    plots = get('telemetry-plots'),
    details = get('telemetry-details'),
    status = get('telemetry-status');
  let source: Frame | undefined,
    sourceKey = '',
    selectedTick: number | null = null,
    dirty = true,
    disposed = false,
    renderedWidth = 0;
  const invalidate = (): void => {
    if (!disposed) dirty = true;
  };
  const change = (): void => {
    selectedTick = sampleSelect.value === 'latest' ? null : Number(sampleSelect.value);
    status.textContent =
      selectedTick === null
        ? 'Following latest recorded sample.'
        : `Selected tick ${selectedTick}.`;
    invalidate();
  };
  const changeView = (): void => {
    status.textContent = `View: ${viewSelect.selectedOptions[0].textContent}.`;
    invalidate();
  };
  viewSelect.addEventListener('change', changeView);
  sampleSelect.addEventListener('change', change);
  const observer =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => {
          if (Math.max(180, Math.floor(plots.getBoundingClientRect().width)) !== renderedWidth)
            invalidate();
        });
  observer?.observe(section);

  function table(caption: string, rows: [string, string][]): void {
    const table = element('table'),
      body = element('tbody'),
      head = element('thead'),
      header = element('tr');
    table.append(element('caption', caption));
    for (const label of ['Measurement', 'Recorded value']) {
      const cell = element('th', label);
      cell.scope = 'col';
      header.append(cell);
    }
    head.append(header);
    table.append(head, body);
    for (const [label, value] of rows) {
      const row = element('tr'),
        heading = element('th', label);
      heading.scope = 'row';
      row.append(heading, element('td', value));
      body.append(row);
    }
    details.append(table);
  }

  function figure(
    title: string,
    description: string,
    width: number,
    height: number,
  ): { figure: HTMLElement; svg: SVGSVGElement } {
    const figure = element('figure'),
      caption = element('figcaption', title),
      prefix = `telemetry-plot-${plots.children.length}`,
      svg = svgElement('svg', {
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-labelledby': `${prefix}-title ${prefix}-description`,
      });
    svg.append(
      svgElement('title', { id: `${prefix}-title` }, title),
      svgElement('desc', { id: `${prefix}-description` }, description),
    );
    figure.append(caption, svg);
    plots.append(figure);
    return { figure, svg };
  }

  function timeline(
    title: string,
    unit: string,
    series: Series[],
    samples: TelemetrySample[],
    selected: TelemetrySample,
    width: number,
    fixedMax?: number,
  ): void {
    const first = samples[0],
      last = samples.at(-1)!,
      start = samples.length === 1 ? first.fromTick : first.tick,
      end = last.tick,
      maximum =
        fixedMax ??
        Math.max(1, ...series.flatMap((item) => samples.map((sample) => item.value(sample) ?? 0))),
      plotWidth = width - 64,
      plotHeight = 128,
      x = (tick: number): number => 50 + ((tick - start) / (end - start)) * plotWidth,
      y = (value: number): number => 144 - (value / maximum) * plotHeight,
      { figure: plot, svg } = figure(
        title,
        `${unit} against logical ticks ${start} to ${end}. Points are recorded boundaries; connecting segments are visual guides, not extra measurements. Missing values break the line.`,
        width,
        180,
      );
    svg.dataset.startTick = String(start);
    svg.dataset.endTick = String(end);
    svg.append(svgElement('path', { d: `M50,16V144H${width - 14}`, class: 'telemetry-axis' }));
    for (const value of [0, maximum])
      svg.append(
        svgElement('text', { x: 46, y: y(value) + 4, 'text-anchor': 'end' }, axisText(value)),
      );
    const ticks =
      width >= 320 && samples.length > 2
        ? [start, samples[Math.floor(samples.length / 2)].tick, end]
        : [start, end];
    for (const [position, tick] of ticks.entries())
      svg.append(
        svgElement(
          'text',
          {
            x: x(tick),
            y: 161,
            'text-anchor':
              position === 0 ? 'start' : position === ticks.length - 1 ? 'end' : 'middle',
          },
          String(tick),
        ),
      );
    svg.append(
      svgElement('text', { x: 50, y: 12 }, unit),
      svgElement('text', { x: width - 14, y: 178, 'text-anchor': 'end' }, 'Logical tick'),
    );
    svg.append(
      svgElement('path', {
        d: `M${x(selected.tick)},16V144`,
        class: 'telemetry-selection',
        'stroke-dasharray': '2 3',
      }),
    );
    const legend = element('ul');
    legend.className = 'telemetry-legend';
    for (const item of series) {
      let path = '',
        connected = false;
      const marks = svgElement('g', { 'data-series': item.name });
      for (const sample of samples) {
        const value = item.value(sample);
        if (value === null) {
          connected = false;
          continue;
        }
        const horizontal = x(sample.tick),
          vertical = y(value),
          glyph = marker(item.style, horizontal, vertical, item.color);
        path += `${connected ? 'L' : 'M'}${horizontal},${vertical}`;
        connected = true;
        glyph.setAttribute('data-tick', String(sample.tick));
        glyph.setAttribute('data-value', String(value));
        marks.append(glyph);
      }
      svg.append(
        svgElement('path', {
          d: path,
          fill: 'none',
          stroke: item.color,
          'stroke-width': 1.5,
          'stroke-dasharray': DASHES[item.style],
        }),
        marks,
      );
      const values = samples.map(item.value).filter((value): value is number => value !== null),
        entry = element(
          'li',
          `${GLYPHS[item.style]} ${item.name}${DASHES[item.style] ? ' (dashed)' : ' (solid)'}; ${values.length ? `min ${axisText(Math.min(...values))}, max ${axisText(Math.max(...values))}` : 'unavailable'}`,
        );
      legend.append(entry);
    }
    plot.append(legend);
  }

  function render(): void {
    if (disposed || !source) return;
    const measuredWidth = plots.getBoundingClientRect().width;
    if (measuredWidth === 0) return;
    const width = Math.max(180, Math.floor(measuredWidth));
    if (!dirty && width === renderedWidth) return;
    dirty = false;
    renderedWidth = width;
    plots.replaceChildren();
    details.replaceChildren();
    const samples = source.telemetry.samples,
      latest = samples.at(-1);
    if (!latest) {
      plots.append(
        element(
          'p',
          `No recorded samples yet. Next sample after completed tick ${(Math.floor(source.stats.tick / TELEMETRY_INTERVAL_TICKS) + 1) * TELEMETRY_INTERVAL_TICKS}. Automatic progress may be paused; Step or an allowed Resume is deliberate.`,
        ),
      );
      return;
    }
    const selected = samples.find((sample) => sample.tick === selectedTick) ?? latest,
      rows: [string, string][] = [
        ['Sample tick', String(selected.tick)],
        [
          'Interval coverage',
          `Events recorded after boundary tick ${selected.fromTick} through completed tick ${selected.tick} (${selected.tick - selected.fromTick} ticks)`,
        ],
        ['Living organisms', String(selected.population)],
      ],
      view = viewSelect.value as View;
    if (view === 'population') {
      timeline(
        'Living population at sample tick',
        'Organisms',
        [{ name: 'Population', color: '#bde879', style: 0, value: (sample) => sample.population }],
        samples,
        selected,
        width,
      );
      timeline(
        'Recorded events per 30 logical ticks',
        'Events / 30 ticks',
        [
          {
            name: 'Reproductive births',
            color: '#bde879',
            style: 0,
            value: (sample) => eventRate(sample, sample.births),
          },
          {
            name: 'Natural terminal deaths',
            color: '#ed7085',
            style: 1,
            value: (sample) => eventRate(sample, sample.deaths.age + sample.deaths.energy),
          },
          {
            name: 'Manual removals',
            color: '#58bce5',
            style: 2,
            value: (sample) => eventRate(sample, sample.deaths.manual),
          },
        ],
        samples,
        selected,
        width,
      );
      for (const [label, count] of [
        ['Reproductive births', selected.births],
        ['Energy exhaustion deaths', selected.deaths.energy],
        ['Age limit deaths', selected.deaths.age],
        ['Manual removals', selected.deaths.manual],
      ] as const)
        rows.push([
          label,
          `${count} in ${selected.tick - selected.fromTick} ticks; ${eventRate(selected, count)} per 30 ticks`,
        ]);
      details.append(
        element(
          'p',
          'Death reasons are terminal conditions. Energy exhaustion does not prove predation. Placements are not reproductive births. Pending events are not completed samples.',
        ),
      );
    } else if (view === 'food') {
      timeline(
        'Food cells at sample tick',
        'Food cells',
        [{ name: 'Food cells', color: '#bde879', style: 0, value: (sample) => sample.food }],
        samples,
        selected,
        width,
      );
      timeline(
        'Living functional cells',
        'Body cells',
        CELL_NAMES.map((name, position) => ({
          name,
          style: position,
          color: COLORS[position + 3],
          value: (sample: TelemetrySample) => sample.cellCounts[position],
        })),
        samples,
        selected,
        width,
      );
      rows.push(
        ['Food cells', String(selected.food)],
        ...CELL_NAMES.map((name, position): [string, string] => [
          `${name} body cells`,
          String(selected.cellCounts[position]),
        ]),
      );
      for (const [label, field] of [
        ['Leaf energy gained', 'leavesGained'],
        ['Mouth energy gained', 'mouthsGained'],
        ['Gross sting energy gained', 'stingsGained'],
        ['Gross sting energy drained', 'stingsDrained'],
      ] as const)
        rows.push([`${label} over this interval`, String(selected.energy[field])]);
      details.append(
        element(
          'p',
          'Body composition is anatomy, not measured diet. Observed interval energy is separate from cell counts; gross sting transfer is not proven kills or a complete energy-conserving diet budget.',
        ),
      );
    } else {
      timeline(
        'Organism-weighted mean traits',
        'Normalized [0,1]',
        [
          {
            name: 'Preference',
            color: '#bde879',
            style: 0,
            value: (sample) => sample.meanPreference,
          },
          {
            name: 'Tolerance width',
            color: '#a38ae4',
            style: 1,
            value: (sample) => sample.meanTolerance,
          },
        ],
        samples,
        selected,
        width,
        1,
      );
      timeline(
        'Living organisms outside thermal tolerance',
        'Percent [0,100]',
        [{ name: 'Outside tolerance', color: '#ed7085', style: 0, value: stressPercent }],
        samples,
        selected,
        width,
        100,
      );
      rows.push(
        ['Mean preference (normalized)', numberText(selected.meanPreference)],
        ['Mean tolerance width', numberText(selected.meanTolerance)],
      );
      if (selected.adaptation) {
        const fraction = stressPercent(selected),
          { svg } = figure(
            `Preference distribution at tick ${selected.tick}`,
            `${selected.population} living organisms across 10 fixed preference bins. Stored preferences, organism-weighted.`,
            width,
            160,
          ),
          maximum = Math.max(1, ...selected.adaptation.preferenceBins),
          step = (width - 64) / 10;
        svg.append(svgElement('path', { d: `M50,16V124H${width - 14}`, class: 'telemetry-axis' }));
        svg.append(
          svgElement('text', { x: 50, y: 12 }, 'Organisms'),
          svgElement('text', { x: 46, y: 128, 'text-anchor': 'end' }, '0'),
          svgElement('text', { x: 46, y: 24, 'text-anchor': 'end' }, String(maximum)),
        );
        selected.adaptation.preferenceBins.forEach((count, bin) => {
          const height = (count / maximum) * 100;
          svg.append(
            svgElement('rect', {
              x: 50 + bin * step + 1,
              y: 124 - height,
              width: Math.max(1, step - 2),
              height,
              fill: '#bde879',
              'data-bin': bin,
              'data-count': count,
            }),
          );
          rows.push([`Preference ${rangeLabel(bin)}`, String(count)]);
        });
        svg.append(
          svgElement('text', { x: 50, y: 140 }, '0'),
          svgElement('text', { x: width - 14, y: 140, 'text-anchor': 'end' }, '1'),
          svgElement(
            'text',
            { x: width - 14, y: 156, 'text-anchor': 'end' },
            'Stored preference [0,1]',
          ),
        );
        rows.push([
          'Outside thermal tolerance',
          fraction === null
            ? 'No living organisms; stressed fraction undefined.'
            : `${selected.adaptation.stressedOrganisms} / ${selected.population} (${fraction.toFixed(1)}%)`,
        ]);
      } else
        details.append(
          element(
            'p',
            `Distribution and stressed count were not recorded for tick ${selected.tick} in this older save.`,
          ),
        );
      details.append(
        element(
          'p',
          'Stress is measured at surviving organisms’ post-tick anchors using the real climate and event. It is not earlier upkeep exposure, mortality risk or inferred from means. Tolerance is a width; temperature units are abstract, not Celsius. Legacy and empty-population gaps are unavailable, not zero.',
        ),
      );
    }
    table(`Selected sample at tick ${selected.tick}`, rows);
  }

  return {
    update(frame: Frame, run: number): void {
      if (disposed) return;
      source = frame;
      const telemetry = frame.telemetry,
        samples = telemetry.samples,
        first = samples[0],
        last = samples.at(-1),
        key = `${run}/${telemetry.originTick}/${telemetry.adaptationOriginTick}/${samples.length}/${first?.tick}/${last?.tick}`;
      get('telemetry-summary').textContent =
        `World tick ${frame.stats.tick}; ${last ? `latest sample tick ${last.tick}; retained ticks ${first!.tick}–${last.tick}; ${samples.length} of at most ${TELEMETRY_CAPACITY} samples` : 'no recorded samples'}. Samples every ${TELEMETRY_INTERVAL_TICKS} completed ticks. Current live values can differ after paused editing. No synthetic initial, latest or extinction point.`;
      if (key === sourceKey) return;
      sourceKey = key;
      if (selectedTick !== null && !samples.some((sample) => sample.tick === selectedTick)) {
        const evicted = selectedTick;
        selectedTick = first?.tick ?? null;
        status.textContent = `Tick ${evicted} is no longer retained; showing ${selectedTick === null ? 'latest when available' : `tick ${selectedTick}`}.`;
      }
      sampleSelect.replaceChildren(
        new Option(last ? 'Latest recorded sample' : 'No recorded samples', 'latest'),
        ...samples.map((sample) => new Option(`Tick ${sample.tick}`, String(sample.tick))),
      );
      sampleSelect.disabled = samples.length === 0;
      sampleSelect.value = selectedTick === null ? 'latest' : String(selectedTick);
      invalidate();
    },
    reset(): void {
      if (disposed) return;
      selectedTick = null;
      source = undefined;
      sourceKey = '';
      plots.replaceChildren();
      details.replaceChildren();
      get('telemetry-summary').textContent =
        'Waiting for the new world’s authoritative observations.';
      sampleSelect.replaceChildren(new Option('No recorded samples', 'latest'));
      sampleSelect.disabled = true;
      status.textContent = '';
      invalidate();
    },
    render,
    dispose(): void {
      disposed = true;
      source = undefined;
      observer?.disconnect();
      viewSelect.removeEventListener('change', changeView);
      sampleSelect.removeEventListener('change', change);
    },
  };
}
