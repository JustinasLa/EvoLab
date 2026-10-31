import {
  CELL_NAMES,
  COLORS,
  PREFERENCE_ENDPOINTS,
  TELEMETRY_CAPACITY,
  TELEMETRY_INTERVAL_TICKS,
  type AcceptedTelemetrySource,
  type TelemetrySample,
  type InterventionEntry,
} from './model';

type View = 'population' | 'food' | 'adaptation';
export type TelemetryViewInput =
  | { status: 'unavailable' }
  | { status: 'pending'; commandId: number }
  | {
      status: 'accepted';
      runId: number;
      replacementId: number;
      currentTick: number;
      currentRevision: number;
      source: AcceptedTelemetrySource | null;
    };
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
    manualSelect = get<HTMLSelectElement>('telemetry-intervention'),
    manualSummary = get('telemetry-intervention-summary'),
    manualDetails = get('telemetry-intervention-details'),
    plots = get('telemetry-plots'),
    details = get('telemetry-details'),
    status = get('telemetry-status'),
    summary = get('telemetry-summary');
  let source: AcceptedTelemetrySource | undefined,
    sourceKey = '',
    selectedTick: number | null = null,
    selectedSequence: number | null = null,
    dirty = true,
    disposed = false,
    renderedWidth = 0;
  let replacementId: number | undefined,
    currentTick = 0,
    currentRevision = 0;
  function emptyText(): string {
    if (!source) return 'No telemetry source received for this world; history not yet known.';
    const boundary =
      (Math.floor(source.tick / TELEMETRY_INTERVAL_TICKS) + 1) * TELEMETRY_INTERVAL_TICKS;
    return `Received history was empty at source tick ${source.tick}. ${
      currentTick < boundary
        ? `Next recording boundary after this observation is ${boundary}, if those ticks complete; Step or an allowed Resume is deliberate.`
        : `Current tick ${currentTick} has reached/passed boundary ${boundary}; awaiting newer telemetry observations. Later recorded samples may not yet be received.`
    }`;
  }
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
  const changeManual = (): void => {
    selectedSequence = manualSelect.value === 'latest' ? null : Number(manualSelect.value);
    status.textContent =
      selectedSequence === null
        ? 'Following latest retained manual action.'
        : `Selected manual action ${selectedSequence}.`;
    invalidate();
  };
  manualSelect.addEventListener('change', changeManual);
  const observer =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => {
          if (Math.max(180, Math.floor(plots.getBoundingClientRect().width)) !== renderedWidth)
            invalidate();
        });
  observer?.observe(section);

  function table(caption: string, rows: [string, string][], destination = details): void {
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
    destination.append(table);
  }
  function manualDetail(): void {
    manualDetails.replaceChildren();
    const state = source!.interventions,
      entries = state.entries,
      entry = entries.find((row) => row.sequence === selectedSequence) ?? entries.at(-1),
      samples = source!.telemetry.samples,
      start = samples.length === 1 ? samples[0].fromTick : samples[0]?.tick,
      end = samples.at(-1)?.tick,
      evicted = state.totalEntries - entries.length;
    manualSummary.textContent = `${entries.length} of at most 128 manual entries retained; ${evicted} evicted${evicted ? ` through tick ${state.evictedThroughTick}` : ''}. ${state.originKind === 'legacy-import' ? `Earlier actions/settings before import at completed tick ${state.originTick} are unknown.` : 'Logging starts before the first ecological tick.'} Applied portions only, not a causal or replay history. ${start === undefined ? 'No sampled time axis yet.' : `${entries.filter((row) => row.lastTick < start).length} entirely before, ${entries.filter((row) => row.firstTick > end!).length} after the sampled domain; ${entries.filter((row) => (row.firstTick < start && row.lastTick >= start) || (row.firstTick <= end! && row.lastTick > end!)).length} crossing its edges. Same-tick actions are after that completed sample boundary.`}`;
    if (!entry) return;
    const rows: [string, string][] = [
      ['Origin', 'Manual'],
      ['Sequence', String(entry.sequence)],
      ['Kind', entry.kind],
      [
        'Effect time',
        entry.firstTick === entry.lastTick
          ? `After completed tick ${entry.firstTick}; applied portion only`
          : `After completed ticks ${entry.firstTick}–${entry.lastTick}; applied portions only`,
      ],
    ];
    if (entry.kind === 'paint')
      rows.push(
        ['Tool', entry.detail.tool],
        ['Radius', String(entry.detail.radius)],
        ['First successful anchor', `${entry.detail.first.x}, ${entry.detail.first.y}`],
        ['Last successful anchor', `${entry.detail.last.x}, ${entry.detail.last.y}`],
        ['Successful commands', String(entry.detail.successfulCommands)],
        [
          'Net changed brush cells, summed per command (not unique area)',
          String(entry.detail.changedBrushCells),
        ],
        ['Whole organisms manually removed', String(entry.detail.removedOrganisms)],
      );
    else if (entry.kind === 'placement') {
      rows.push(['Meaning', 'Deliberate placement, not reproductive birth']);
      for (const [field, value] of Object.entries(entry.detail)) rows.push([field, String(value)]);
    } else if (entry.kind === 'settings') {
      for (const [field, change] of Object.entries(entry.detail.changes))
        rows.push([field, `${change!.before} → ${change!.after}`]);
    } else if (entry.kind === 'terrain') {
      rows.push(
        ['Wall action', entry.detail.action],
        ['Recipe before', JSON.stringify(entry.detail.before)],
        ['Recipe after', JSON.stringify(entry.detail.after)],
        ['Walls added', String(entry.detail.addedWalls)],
        ['Walls removed', String(entry.detail.removedWalls)],
        ['Food removed beneath new walls', String(entry.detail.removedFood)],
        ['Candidate walls protected by living cells', String(entry.detail.protectedCells)],
        [
          'Interpretation',
          'Net cell counts, not a replay. Terrain history before the first retained wall action is unknown. Saved/edited cells are authoritative.',
        ],
      );
    } else if (entry.kind === 'refuge-mode') {
      rows.push(
        [
          'Painted temperature mode',
          `${entry.detail.before ? 'ON' : 'OFF'} → ${entry.detail.after ? 'ON' : 'OFF'}`,
        ],
        ['Rules version', String(entry.detail.rulesVersion)],
      );
    } else if (entry.kind === 'refuge-paint') {
      rows.push(
        ['Tool', entry.detail.tool],
        ['Signed units per dab', String(entry.detail.units)],
        ['Radius', String(entry.detail.radius)],
        ['Rules version', String(entry.detail.rulesVersion)],
        ['First effective anchor', `${entry.detail.first.x}, ${entry.detail.first.y}`],
        ['Last effective anchor', `${entry.detail.last.x}, ${entry.detail.last.y}`],
        ['Effective commands', String(entry.detail.successfulCommands)],
        ['Changed cells summed, not unique area', String(entry.detail.changedBrushCells)],
        [
          'Interpretation',
          'Manual applied portions; offset history before retained edits is unknown; not a replay.',
        ],
      );
    } else if (entry.kind === 'refuge-clear') {
      rows.push(
        ['Painted temperature cells removed', String(entry.detail.removedCells)],
        ['Rules version', String(entry.detail.rulesVersion)],
        ['Meaning', 'Mode unchanged; life, food and walls preserved.'],
      );
    } else
      rows.push(
        ['Climate shock', entry.detail.kind],
        [
          'Before stored event',
          `offset ${entry.detail.before.offset}; until ${entry.detail.before.until}`,
        ],
        [
          'After stored event',
          `offset ${entry.detail.after.offset}; until ${entry.detail.after.until}`,
        ],
      );
    table(`Manual ${entry.kind} #${entry.sequence}`, rows, manualDetails);
  }
  function manualStrip(plot: HTMLElement, width: number, start: number, end: number): void {
    const prefix = `telemetry-manual-${plots.children.length}`,
      svg = svgElement('svg', {
        viewBox: `0 0 ${width} 48`,
        role: 'img',
        'aria-labelledby': `${prefix}-title ${prefix}-description`,
      }),
      plotWidth = width - 64,
      x = (tick: number): number => 50 + ((tick - start) / (end - start)) * plotWidth,
      bucketWidth = Math.max(12, plotWidth / 32),
      groups = new Map<number, InterventionEntry[]>();
    svg.classList.add('telemetry-manual-strip');
    svg.append(
      svgElement('title', { id: `${prefix}-title` }, 'Manual action after completed tick'),
      svgElement(
        'desc',
        { id: `${prefix}-description` },
        'Applied portions only; not a measurement or continuous effects.',
      ),
    );
    const entries = source!.interventions.entries;
    for (const entry of entries) {
      if (entry.lastTick < start || entry.firstTick > end) continue;
      const bucket = Math.min(
        31,
        Math.floor((x(Math.max(start, entry.firstTick)) - 50) / bucketWidth),
      );
      const group = groups.get(bucket) ?? [];
      group.push(entry);
      groups.set(bucket, group);
    }
    for (const group of groups.values()) {
      const first = group[0],
        lastTick = Math.max(...group.map((entry) => entry.lastTick)),
        firstX = x(Math.max(start, first.firstTick)),
        lastX = x(Math.min(lastTick, end)),
        anchor = first.firstTick >= start ? `M${firstX},11l4,4l-4,4l-4,-4Z ` : '',
        mark = svgElement('path', {
          d: `${anchor}M${firstX},15H${lastX}`,
          class: 'telemetry-manual-density',
          'data-first-tick': first.firstTick,
          'data-last-tick': lastTick,
          'data-anchor-tick': first.firstTick >= start ? first.firstTick : 'none',
          'data-clipped-first-tick': Math.max(start, first.firstTick),
          'data-clipped-last-tick': Math.min(lastTick, end),
          'data-count': group.length,
          'stroke-dasharray': '3 2',
        });
      mark.append(
        svgElement(
          'title',
          {},
          `Manual density indicator: ${group.length} entries, sequences ${first.sequence}–${group.at(-1)!.sequence}, after completed ticks ${first.firstTick}–${lastTick}; not continuous effects or measurements${first.firstTick < start || lastTick > end ? '; clipped for drawing only, continues beyond plotted domain' : ''}.`,
        ),
      );
      svg.append(mark);
    }
    const selected = entries.find((entry) => entry.sequence === selectedSequence) ?? entries.at(-1);
    if (selected && selected.lastTick >= start && selected.firstTick <= end) {
      const firstX = x(Math.max(start, selected.firstTick)),
        lastX = x(Math.min(end, selected.lastTick)),
        highlight = svgElement('path', {
          d: `M${firstX},9V23M${firstX},16H${lastX}M${lastX},9V23`,
          class: 'telemetry-selection',
          'data-manual-sequence': selected.sequence,
        });
      highlight.append(
        svgElement(
          'title',
          {},
          `Selected manual #${selected.sequence}: actual successful ticks ${selected.firstTick}–${selected.lastTick}; applied portions only${selected.firstTick < start || selected.lastTick > end ? '; clipped for drawing only, continues beyond edge' : ''}.`,
        ),
      );
      svg.append(highlight);
    }
    svg.append(svgElement('text', { x: 50, y: 42 }, '◇ Manual after tick; not a measurement'));
    plot.append(svg);
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
    manualStrip(plot, width, start, end);
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
    manualDetail();
    const samples = source.telemetry.samples,
      latest = samples.at(-1);
    if (!latest) {
      plots.append(element('p', emptyText()));
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
    update(input: TelemetryViewInput): void {
      if (disposed) return;
      if (input.status === 'pending') {
        summary.textContent = `Previous accepted world; awaiting validation of command ${input.commandId}.`;
        return;
      }
      if (input.status === 'unavailable') {
        source = undefined;
        replacementId = undefined;
        selectedTick = null;
        selectedSequence = null;
        sourceKey = '';
        plots.replaceChildren();
        details.replaceChildren();
        manualDetails.replaceChildren();
        manualSelect.replaceChildren(new Option('No retained manual actions', 'latest'));
        manualSelect.disabled = true;
        manualSummary.textContent = 'No active world; manual history unknown.';
        summary.textContent = 'No active world; history unknown.';
        sampleSelect.replaceChildren(new Option('No source received', 'latest'));
        sampleSelect.disabled = true;
        status.textContent = '';
        invalidate();
        return;
      }
      const replaced = replacementId !== input.replacementId;
      if (replaced) {
        selectedTick = null;
        selectedSequence = null;
        sourceKey = '';
        source = undefined;
        status.textContent = '';
        plots.replaceChildren();
        details.replaceChildren();
        manualDetails.replaceChildren();
        manualSelect.replaceChildren(new Option('No retained manual actions', 'latest'));
        manualSelect.disabled = true;
        manualSummary.textContent = 'Waiting for authoritative manual history.';
      }
      replacementId = input.replacementId;
      currentTick = input.currentTick;
      currentRevision = input.currentRevision;
      source = input.source ?? undefined;
      if (!source) {
        summary.textContent = `World tick ${currentTick} (revision ${currentRevision}). ${emptyText()}`;
        sampleSelect.replaceChildren(new Option('No source received', 'latest'));
        sampleSelect.disabled = true;
        return;
      }
      const telemetry = source.telemetry,
        samples = telemetry.samples,
        first = samples[0],
        last = samples.at(-1),
        manual = source.interventions,
        latestManual = manual.entries.at(-1),
        key = `${replacementId}/${telemetry.originTick}/${telemetry.adaptationOriginTick}/${samples.length}/${first?.tick}/${last?.tick}/${manual.originTick}/${manual.originKind}/${manual.totalEntries}/${latestManual?.sequence}/${latestManual?.kind === 'paint' || latestManual?.kind === 'refuge-paint' ? latestManual.detail.successfulCommands : ''}`;
      summary.textContent = `World tick ${currentTick} (revision ${currentRevision}); telemetry source observed at tick ${source.tick} (revision ${source.revision}); ${last ? `last received recorded sample tick ${last.tick}; received retained ticks ${first!.tick}–${last.tick}; ${samples.length} of at most ${TELEMETRY_CAPACITY} samples` : emptyText()}. ${source.tick < currentTick || source.revision < currentRevision ? 'Observation/transport lag: later observations may not yet be received. ' : ''}Pending accounting is as of source tick ${source.tick}, revision ${source.revision}. Samples every ${TELEMETRY_INTERVAL_TICKS} completed ticks. No synthetic initial, latest or extinction point.`;
      if (!last) {
        const paragraph = plots.querySelector('p');
        if (paragraph) paragraph.textContent = emptyText();
      }
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
      if (
        selectedSequence !== null &&
        !manual.entries.some((entry) => entry.sequence === selectedSequence)
      ) {
        const evicted = selectedSequence;
        selectedSequence = manual.entries[0]?.sequence ?? null;
        status.textContent = `Manual sequence ${evicted} is no longer retained; showing ${selectedSequence === null ? 'latest when available' : `sequence ${selectedSequence}`}.`;
      }
      manualSelect.replaceChildren(
        new Option(
          manual.entries.length ? 'Latest retained manual action' : 'No retained manual actions',
          'latest',
        ),
        ...manual.entries.map(
          (entry) =>
            new Option(
              `Manual ${entry.kind} #${entry.sequence}; after tick ${entry.firstTick}${entry.lastTick !== entry.firstTick ? `–${entry.lastTick}` : ''}`,
              String(entry.sequence),
            ),
        ),
      );
      manualSelect.disabled = manual.entries.length === 0;
      manualSelect.value = selectedSequence === null ? 'latest' : String(selectedSequence);
      invalidate();
    },
    render,
    dispose(): void {
      disposed = true;
      source = undefined;
      selectedTick = null;
      sourceKey = '';
      replacementId = undefined;
      observer?.disconnect();
      viewSelect.removeEventListener('change', changeView);
      sampleSelect.removeEventListener('change', change);
      manualSelect.removeEventListener('change', changeManual);
    },
  };
}
