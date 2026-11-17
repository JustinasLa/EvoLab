import { lifeDiff } from './life-history-view';
import { perceptionHtml } from './perception-view';
import {
  CELL_NAMES,
  HEIGHT,
  WIDTH,
  type ControlState,
  type Genome,
  type Perception,
  type OrganismBaseline,
} from './model';
import { genomeSvg, organismHtml, viewport, type Camera } from './view';

export function genomeDiff(
  current: Genome,
  baseline?: OrganismBaseline,
  comparison: 'founding' | 'direct-parent' = 'founding',
): string {
  if (!baseline?.genome)
    return `<p>Baseline unavailable (${baseline?.status ?? 'unknown / pruned'}). No mutation history inferred.</p>`;
  const previous = baseline.genome;
  const cells = new Map(previous.cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const changes: string[] = [];
  for (const cell of current.cells) {
    const key = `${cell.x},${cell.y}`,
      old = cells.get(key);
    if (!old) changes.push(`Added ${CELL_NAMES[cell.type - 3]} at (${key})`);
    else if (old.type !== cell.type)
      changes.push(`(${key}): ${CELL_NAMES[old.type - 3]} → ${CELL_NAMES[cell.type - 3]}`);
    cells.delete(key);
  }
  for (const [key, cell] of cells) changes.push(`Removed ${CELL_NAMES[cell.type - 3]} at (${key})`);
  const traits = (['preference', 'tolerance', 'tempo'] as const)
    .map(
      (key) =>
        `<tr><th scope="row">${key}</th><td>${previous[key]}</td><td>${current[key]}</td><td>${current[key] - previous[key]}</td></tr>`,
    )
    .join('');
  const propensity = (genome: Genome) =>
    genome.mutationPropensity === undefined
      ? 'global (disabled)'
      : `inherited multiplier ${genome.mutationPropensity}`;
  const propensityRow = `<tr><th scope="row">mutation propensity</th><td>${propensity(previous)}</td><td>${propensity(current)}</td><td>${previous.mutationPropensity === undefined || current.mutationPropensity === undefined ? 'Mode or multiplier comparison' : current.mutationPropensity - previous.mutationPropensity}</td></tr>`;
  const describe = (genome: Genome) =>
    genome.behavior.mode === 'legacy'
      ? 'legacy'
      : `${genome.behavior.version === 2 ? 'active2' : 'evolved'}: food ${genome.behavior.reactions.food}, wall ${genome.behavior.reactions.wall}, harmless ${genome.behavior.reactions.harmless}, dangerous ${genome.behavior.reactions.dangerous}`;
  const beforeBehavior = describe(previous),
    afterBehavior = describe(current);
  const behavior =
    beforeBehavior === afterBehavior
      ? `Stored behavior unchanged (${afterBehavior}).`
      : `Stored behavior: ${beforeBehavior} → ${afterBehavior}.`;
  const direct = comparison === 'direct-parent';
  const origin = direct
    ? `Compared with the actual reproductive parent in lineage #${baseline.lineageId}. This retained pair describes this birth only.`
    : `Compared with ${baseline.relation === 'parent-lineage' ? 'parent lineage' : 'own lineage'} #${baseline.lineageId} founding genome. This is a retained endpoint comparison, not an individual parent or a sequence of mutations.`;
  return `<p>${origin}</p><div class="baseline-preview">${genomeSvg(previous, 72)}<span>${direct ? 'Actual parent anatomy' : 'Retained founding anatomy'}</span></div><ul>${(changes.length ? changes : ['Anatomy unchanged (local cell coordinates).']).map((change) => `<li>${change}</li>`).join('')}</ul><table><caption>Inherited traits (exact normalized values; tempo in ticks)</caption><thead><tr><th>Trait</th><th>${direct ? 'Parent' : 'Baseline'}</th><th>${direct ? 'Child' : 'Selected'}</th><th>Difference</th></tr></thead><tbody>${traits}${propensityRow}${lifeDiff(previous, current)}</tbody></table><p>${behavior} Both behavior1 modes remain inactive.</p><p>Accepted opaque metadata is outside this observed comparison.</p>`;
}

// Only accepted observations enter this page-owned state. One identity and one
// bounded last observation are retained; nothing is sent to the simulation.
export function createOrganismView(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  camera: Camera,
  changed: () => void,
) {
  const nodes = new Map<string, HTMLElement>();
  const get = <T extends HTMLElement>(id: string): T => {
    if (!nodes.has(id)) nodes.set(id, root.querySelector<HTMLElement>(`#${id}`)!);
    return nodes.get(id) as T;
  };
  for (const id of [
    'follow-organism',
    'release-follow',
    'follow-status',
    'specimen-details',
    'inspector',
    'organism-diff',
    'organism-observed',
    'perception-observation',
    'perception-enabled',
  ])
    get(id);
  const summary = get('specimen-details').querySelector<HTMLElement>('summary')!;
  const text = (id: string, value: string) => {
    if (get(id).textContent !== value) get(id).textContent = value;
  };
  const html = (id: string, value: string) => {
    if (get(id).innerHTML !== value) get(id).innerHTML = value;
  };
  const follow = get<HTMLButtonElement>('follow-organism'),
    release = get<HTMLButtonElement>('release-follow');
  let perception: Perception | null = null;
  const overlay = get<HTMLInputElement>('perception-enabled');
  overlay.addEventListener('change', changed);
  let replacement: number | undefined,
    live = 0,
    following = 0,
    followRevision = -1;
  let last: { id: number; tick: number; html: string; diff: string } | undefined;
  let anchor: { x: number; y: number } | undefined;
  let previousScale = 1;
  function controls() {
    const focused = document.activeElement;
    if (focused === follow && (!live || following === live)) {
      if (following) {
        release.disabled = false;
        release.focus();
      } else summary.focus();
    }
    if (focused === release && !following) {
      if (live) {
        follow.disabled = false;
        follow.focus();
      } else summary.focus();
    }
    follow.disabled = !live || following === live;
    release.disabled = !following;
    text(
      'follow-status',
      following
        ? `Following organism ${following}. Pan, zoom or Fit releases follow.`
        : 'Camera follow off.',
    );
  }
  function stop() {
    following = 0;
    anchor = undefined;
    controls();
  }
  function clear() {
    stop();
    live = 0;
    last = undefined;
    perception = null;
    html('perception-observation', perceptionHtml(null, 0));
    html('inspector', organismHtml(null, {} as ControlState['world']));
    text('organism-diff', '');
    text('organism-observed', '');
    controls();
  }
  function update(state: ControlState, renderNow = true) {
    const previousLive = live;
    if (replacement !== state.replacementId) {
      clear();
      replacement = state.replacementId;
    }
    const organism = state.selected;
    perception = organism && state.perception?.id === organism.id ? state.perception : null;
    html('perception-observation', perceptionHtml(perception, state.world.stats.tick));
    if (organism) {
      if (live !== organism.id) stop();
      live = organism.id;
      last = {
        id: live,
        tick: state.world.stats.tick,
        html: organismHtml(organism, state.world),
        diff: genomeDiff(organism.genome, state.world.selectedBaseline),
      };
      if (renderNow || previousLive !== live) {
        html('inspector', last.html);
        html('organism-diff', last.diff);
        text('organism-observed', `Observed at tick ${last.tick}.`);
      }
    } else {
      live = 0;
      stop();
      if (last) {
        if (get('organism-observed').textContent?.startsWith('Stale') !== true)
          html('inspector', last.html);
        get('inspector')
          .querySelectorAll('button')
          .forEach((button) => button.remove());
        html('organism-diff', last.diff);
        text(
          'organism-observed',
          `Stale — organism ${last.id} is no longer alive. Last observed at tick ${last.tick}; current observation tick ${state.world.stats.tick}. Follow stopped. Death occurred after the last observation; exact death tick is unknown here.`,
        );
      }
    }
    controls();
  }
  function followFrame(state: ControlState) {
    const organism = state.selected;
    if (
      !following ||
      !organism ||
      organism.id !== following ||
      state.replacementId !== replacement ||
      state.revision < followRevision
    )
      return;
    const scale = viewport(canvas, camera).scale;
    if (anchor) {
      camera.x *= scale / previousScale;
      camera.y *= scale / previousScale;
      camera.x -= (((organism.x - anchor.x + WIDTH / 2 + WIDTH) % WIDTH) - WIDTH / 2) * scale;
      camera.y -= (((organism.y - anchor.y + HEIGHT / 2 + HEIGHT) % HEIGHT) - HEIGHT / 2) * scale;
    } else {
      camera.x = (WIDTH / 2 - organism.x - 0.5) * scale;
      camera.y = (HEIGHT / 2 - organism.y - 0.5) * scale;
    }
    // Equivalent tiled coordinates keep camera state bounded over long runs.
    camera.x %= WIDTH * scale;
    camera.y %= HEIGHT * scale;
    camera.wrapped = true;
    previousScale = scale;
    anchor = { x: organism.x, y: organism.y };
    followRevision = state.revision;
  }
  const start = () => {
    if (!live) return;
    following = live;
    followRevision = -1;
    anchor = undefined;
    controls();
    changed();
  };
  follow.addEventListener('click', start);
  release.addEventListener('click', stop);
  controls();
  return {
    update,
    followFrame,
    perception: () => (overlay.checked ? perception : null),
    release: stop,
    clear,
    dispose() {
      clear();
      follow.removeEventListener('click', start);
      release.removeEventListener('click', stop);
      overlay.removeEventListener('change', changed);
    },
  };
}
