import type { BatchExport } from './batch-model';
import { COMPARISON_METRICS } from './experiment-report';

export function renderBatchReport(destination: HTMLElement, batch: BatchExport): void {
  destination.replaceChildren();
  const completed = batch.runs.filter((run) => run.recipe !== null);
  const paragraph = (text: string): void => {
    const element = document.createElement('p');
    element.textContent = text;
    destination.append(element);
  };
  paragraph(
    `${completed.length}/${batch.runs.length} independent seed pairs complete; ${batch.runs.filter((run) => run.status === 'failed').length} failed, ${batch.runs.filter((run) => run.status === 'cancelled').length} cancelled, ${batch.runs.filter((run) => run.status === 'pending').length} not run. ${completed.filter((run) => run.reproduced).length} replay checks, not additional replicates.`,
  );
  paragraph(
    `Extinction among completed pairs: control ${completed.filter((run) => run.recipe!.control.extinction !== null).length}/${completed.length}, treatment ${completed.filter((run) => run.recipe!.treatment.extinction !== null).length}/${completed.length}. Failed and incomplete runs are not survivors and are excluded from endpoint summaries.`,
  );
  paragraph(
    'Empirical outcomes for the listed seeds only, not a population estimate. No uncertainty intervals, significance tests, analysis RNG or winner scoring. Undefined extinct traits are omitted, not zero-filled. Differences are treatment minus control.',
  );
  const table = document.createElement('table');
  table.createCaption().textContent = 'Per-replicate endpoint results and paired differences';
  const heading = table.createTHead().insertRow();
  for (const text of ['Seed / status / tick', 'Metric', 'Control', 'Treatment', 'Difference']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = text;
    heading.append(cell);
  }
  const body = table.createTBody();
  for (const run of batch.runs) {
    if (!run.recipe) {
      const row = body.insertRow();
      row.insertCell().textContent = `${run.seed}: ${run.status} at tick ${run.tick}`;
      const cell = row.insertCell();
      cell.colSpan = 4;
      cell.textContent = run.error ?? 'No complete paired outcome retained.';
      continue;
    }
    for (const metric of Object.keys(COMPARISON_METRICS) as (keyof typeof COMPARISON_METRICS)[]) {
      const control = run.recipe.control.samples.at(-1)![metric],
        treatment = run.recipe.treatment.samples.at(-1)![metric];
      const row = body.insertRow();
      for (const text of [
        `${run.seed}: ${run.reproduced ? 'replayed' : 'complete'} at tick ${run.tick}`,
        COMPARISON_METRICS[metric],
        control ?? 'Undefined',
        treatment ?? 'Undefined',
        control === null || treatment === null ? 'Undefined' : treatment - control,
      ])
        row.insertCell().textContent = String(text);
    }
    paragraph(
      `Seed ${run.seed} extinction: ${(['control', 'treatment'] as const)
        .map((branch) => {
          const extinction = run.recipe![branch].extinction;
          return `${branch}: ${extinction ? `${extinction.tick === null ? 'empty at fork' : `tick ${extinction.tick}`} (${extinction.cause})` : 'alive at horizon'}`;
        })
        .join('; ')}.`,
    );
  }
  destination.append(table);
  for (const metric of Object.keys(COMPARISON_METRICS) as (keyof typeof COMPARISON_METRICS)[]) {
    const differences = completed
      .flatMap((run) => {
        const control = run.recipe!.control.samples.at(-1)![metric],
          treatment = run.recipe!.treatment.samples.at(-1)![metric];
        return control === null || treatment === null ? [] : [treatment - control];
      })
      .sort((left, right) => left - right);
    paragraph(
      `${COMPARISON_METRICS[metric]} paired-difference distribution (n=${differences.length}): ${differences.join(', ') || 'undefined'}.`,
    );
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 280 100');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    'Endpoint population distribution: circles control, triangles treatment. Exact values in the table.',
  );
  const maximum = Math.max(
    1,
    ...completed.flatMap((run) => [
      run.recipe!.control.samples.at(-1)!.population,
      run.recipe!.treatment.samples.at(-1)!.population,
    ]),
  );
  for (const [position, run] of completed.entries()) {
    for (const branch of ['control', 'treatment'] as const) {
      const population = run.recipe![branch].samples.at(-1)!.population,
        horizontal = 20 + (population / maximum) * 240,
        vertical = 12 + position * 10;
      const mark = document.createElementNS(svg.namespaceURI, 'path');
      mark.setAttribute(
        'd',
        branch === 'control'
          ? `M${horizontal - 2},${vertical}a2,2 0 1,0 4,0a2,2 0 1,0 -4,0`
          : `M${horizontal},${vertical - 3}l3,6h-6Z`,
      );
      mark.setAttribute('class', `comparison-${branch}`);
      svg.append(mark);
    }
  }
  paragraph(
    `Population distribution: horizontal axis 0–${maximum} organisms; each row is one completed seed pair. Circles: control; triangles: treatment.`,
  );
  destination.append(svg);
}
