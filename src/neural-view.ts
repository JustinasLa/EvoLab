import { WIDTH, type ControlState } from './model';
import { NEURAL_ACTIONS } from './neural';
import { NEURAL_HISTORY_LIMIT, type NeuralObservation } from './neural-observation';

const inputNames = [
  'Food proximity',
  'Wall proximity',
  'Harmless proximity',
  'Dangerous proximity',
  'Energy ratio',
  'Previous blocked action',
];
const directions = ['north', 'east', 'south', 'west'];
const number = (value: number): string => (Object.is(value, -0) ? '-0' : String(value));
const values = (items: number[]): string => items.map(number).join(', ');
const position = (cell: number): string => `(${cell % WIDTH},${Math.floor(cell / WIDTH)})`;
const unavailable =
  'Unavailable — capture is off, selection is changing, or the subscription is awaiting acknowledgement. Open this panel and select a neural organism; only future real evaluations can be observed.';

export function neuralHtml(observation: NeuralObservation | null, tick: number): string {
  if (!observation) return `<p>${unavailable}</p>`;
  const decision = observation.decisions.at(-1);
  const status = {
    'no-selection': 'Unavailable — no selected organism.',
    'non-neural':
      'Unavailable — this organism has no neural controller; reaction/legacy activity is not a neural evaluation.',
    'awaiting-evaluation':
      'Unavailable — no evaluation captured yet. Paused inspection never evaluates or reconstructs earlier activity. Step or resume to the next eligible tempo tick.',
    observed: 'Recorded actual activity.',
    dead: 'Stale — the selected organism is dead. Retained observations are historical, not current behavior.',
  }[observation.status];
  const introduction = `<p>${status} Current observation tick ${tick}; capture began at tick ${observation.fromTick}.</p><p>${observation.pruned ? `Pruned — older decisions were evicted; only the latest ${NEURAL_HISTORY_LIMIT} are retained.` : `At most ${NEURAL_HISTORY_LIMIT} decisions are retained; earlier pre-subscription or imported activity is unavailable.`}</p><p>Observed sequences, not causal explanations: connection weights, highlighted actions and subsequent meals are not proof of why a controller succeeded. Outcome energy includes other ecological processes, not an action reward.</p>`;
  if (!decision) return introduction;
  const controller = observation.controller!;
  const nodes = [
    ...inputNames.map((label, offset) => ({
      label,
      value: decision.inputs[offset],
      x: 45,
      y: 35 + offset * 42,
    })),
    ...decision.hidden.map((value, offset) => ({
      label: `Hidden ${offset + 1}`,
      value,
      x: 185,
      y: 60 + offset * 52,
    })),
    ...decision.outputs.map((value, offset) => ({
      label: NEURAL_ACTIONS[offset],
      value,
      x: 325,
      y: 60 + offset * 52,
    })),
  ];
  const connections = controller.weights.map((weight, offset) => ({
    weight,
    source: offset < 24 ? offset % 6 : 6 + ((offset - 24) % 4),
    target: offset < 24 ? 6 + Math.floor(offset / 6) : 10 + Math.floor((offset - 24) / 4),
  }));
  const edges = connections
    .map(
      ({ weight, source, target }) =>
        `<line x1="${nodes[source].x}" y1="${nodes[source].y}" x2="${nodes[target].x}" y2="${nodes[target].y}" class="${weight < 0 ? 'negative' : weight === 0 ? 'zero' : 'positive'}"><title>${nodes[source].label} to ${nodes[target].label}: weight ${number(weight)}</title></line>`,
    )
    .join('');
  const network = `<svg viewBox="0 0 370 290" role="img" aria-label="Observed six-input, four-hidden, four-output neural network at tick ${decision.tick}; selected action ${decision.action}. Diagram values rounded to two decimals; exact values and all connections follow in tables."><title>Actual last neural evaluation</title><desc>Solid edges have positive weights, dashed edges negative weights, dotted edges zero weights. Outlined output is the selected action, not a causal explanation.</desc>${edges}${nodes.map((node, offset) => `<g><circle cx="${node.x}" cy="${node.y}" r="20" class="${offset >= 10 && NEURAL_ACTIONS[offset - 10] === decision.action ? 'chosen' : ''}"/><text x="${node.x}" y="${node.y - 3}" text-anchor="middle">${offset < 6 ? `I${offset + 1}` : offset < 10 ? `H${offset - 5}` : `O${offset - 9}`}<tspan x="${node.x}" dy="13">${node.value.toFixed(2)}</tspan></text><title>${node.label}: ${number(node.value)}</title></g>`).join('')}<text x="45" y="280" text-anchor="middle">Inputs</text><text x="185" y="280" text-anchor="middle">Hidden</text><text x="325" y="280" text-anchor="middle">Actions</text></svg>`;
  const activity = `<table><caption>Exact recorded inputs and activations at tick ${decision.tick}</caption><thead><tr><th scope="col">Node</th><th scope="col">Value</th><th scope="col">Bias</th></tr></thead><tbody>${nodes.map((node, offset) => `<tr><th scope="row">${offset < 6 ? `I${offset + 1}` : offset < 10 ? `H${offset - 5}` : `O${offset - 9}`} · ${node.label}</th><td>${number(node.value)}</td><td>${offset < 6 ? 'Not applicable' : number(controller.biases[offset - 6])}</td></tr>`).join('')}</tbody></table>`;
  const weights = `<table><caption>All 40 inherited connection weights (no inferred importance)</caption><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Weight</th></tr></thead><tbody>${connections.map(({ source, target, weight }) => `<tr><th scope="row">${nodes[source].label}</th><td>${nodes[target].label}</td><td>${number(weight)}</td></tr>`).join('')}</tbody></table>`;
  const history = `<table><caption>Recent actual decisions, oldest first; input order: ${inputNames.join(', ')}. Hidden/output order matches the network. Subsequent mouths are measured after this evaluation and before the next, including feeding earlier in the next evaluation tick.</caption><thead><tr><th scope="col">Evaluation tick</th><th scope="col">Inputs / hidden / outputs</th><th scope="col">Observed perception</th><th scope="col">Action attempt and charged energy</th><th scope="col">Measured outcome window</th></tr></thead><tbody>${observation.decisions.map((row) => `<tr><th scope="row">${row.tick}</th><td>Inputs: ${values(row.inputs)}<br>Hidden: ${values(row.hidden)}<br>Outputs (rest, forward, left, right): ${values(row.outputs)}</td><td>${row.rays.length ? row.rays.map((ray) => `Eye ${ray.eye} at ${position(ray.origin)}, ${directions[ray.heading]}: ${ray.stop}; visited ${ray.cells.map(position).join(' → ')}`).join('<br>') : 'No eyes; four sensory inputs are zero.'}</td><td>${row.action}: ${row.result}. Evaluation ${number(row.evaluationCost)}; action ${number(row.actionCost)}; total ${number(row.evaluationCost + row.actionCost)} energy.<br>Before (${row.before.x},${row.before.y}), ${directions[row.before.rotation]}, energy ${number(row.before.energy)}; after (${row.after.x},${row.after.y}), ${directions[row.after.rotation]}, energy ${number(row.after.energy)}.</td><td>Through tick ${row.outcome.throughTick}, ${row.outcome.boundary}; energy ${number(row.outcome.energy)}. Subsequent mouth gain ${number(row.outcome.mouthsGained)}; last meal tick ${row.outcome.lastMealTick ?? 'none observed'}. Not causal attribution.</td></tr>`).join('')}</tbody></table>`;
  return `${introduction}<p>Organism ${observation.id}: last evaluated at tick ${decision.tick}${decision.tick < tick ? ' — stale/historical, not reevaluated for this view' : ' — current observation tick'}. Selected ${decision.action}; ${decision.result}. Actual incurred cost ${number(decision.evaluationCost + decision.actionCost)} energy (${number(decision.evaluationCost)} evaluation + ${number(decision.actionCost)} action). Rest or a missing motor has no action charge; blocked motor attempts still pay.</p><p>Inputs are food/wall/harmless/dangerous first-hit proximity (0–1), pre-evaluation energy divided by the reproduction threshold (clamped 0–1), and prior blocked-action feedback (0/1). Hidden and output activations clamp to [−1,1]. The largest output wins; ties use rest, forward, left, right order.</p>${network}${activity}${history}${weights}`;
}

export function createNeuralView(root: HTMLElement, subscriptionChanged: () => void) {
  const specimen = root.querySelector<HTMLDetailsElement>('#specimen-details')!;
  const panel = root.querySelector<HTMLElement>('#organism-panel')!;
  const details = document.createElement('details');
  details.id = 'neural-inspector';
  details.innerHTML =
    '<summary>Neural activity and recent decisions</summary><p>Capture only while this panel is open and visible. Closing clears session history; saves never include it. The diagram has equivalent exact-value tables. Focus the data region to scroll with arrow keys.</p><div id="neural-data" role="region" aria-label="Neural activity data" tabindex="0"></div>';
  root.querySelector('#perception-observation')!.after(details);
  const content = details.querySelector<HTMLElement>('#neural-data')!;
  let pending = false;
  let rendered = '';
  const render = (html: string) => {
    if (rendered !== html) content.innerHTML = rendered = html;
  };
  const wanted = () =>
    details.open && specimen.open && !panel.hidden && document.visibilityState !== 'hidden';
  function clear() {
    render(neuralHtml(null, 0));
  }
  const toggle = () => {
    if (!wanted()) clear();
    subscriptionChanged();
  };
  details.addEventListener('toggle', toggle);
  specimen.addEventListener('toggle', toggle);
  clear();
  return {
    wanted,
    clear,
    pendingSelection(value: boolean) {
      pending = value;
      if (value) clear();
    },
    update(state: ControlState | undefined, epoch: number) {
      const observed = state?.neural;
      if (
        !wanted() ||
        pending ||
        !observed ||
        state.display.epoch !== epoch ||
        (state.selected
          ? state.selected.id !== observed.id
          : !['dead', 'no-selection'].includes(observed.status))
      ) {
        clear();
        return;
      }
      render(neuralHtml(observed, state.world.stats.tick));
    },
    dispose() {
      details.removeEventListener('toggle', toggle);
      specimen.removeEventListener('toggle', toggle);
      details.remove();
    },
  };
}
