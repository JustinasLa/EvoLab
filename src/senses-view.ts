import { integer, type Genome } from './model';
import { newController } from './neural';
import { newSenses } from './senses';

export const SENSE_LABELS = [
  'Food proximity',
  'Wall proximity',
  'Visible body proximity',
  'Visible stinger proximity',
  'Energy / reproduction threshold',
  'Previous blocked action',
  'Local temperature',
  'Front temperature',
  'Left temperature',
  'Right temperature',
];

export function sensesEditor(genome: Genome): string {
  if (!genome.controller) return '';
  const senses = genome.senses;
  return `<fieldset><legend>Evolving local senses (experimental)</legend><label><input type="checkbox" data-sense="enabled"${senses ? ' checked' : ''}>Enable expanded senses — resets neural parameters</label><p>Changing this opt-in replaces the network with an all-zero resting controller. Existing organisms are never converted.</p>${senses ? `<label>Eye orientation<select data-sense="orientation">${['Forward', 'Right', 'Backward', 'Left'].map((label, value) => `<option value="${value}"${senses.orientation === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label>Eye range<input type="number" min="1" max="8" step="1" data-sense="range" value="${senses.range}"></label><label>Cardinal field of view<select data-sense="fov">${([1, 3, 4] as const).map((value) => `<option value="${value}"${senses.fov === value ? ' selected' : ''}>${value === 1 ? 'One forward ray' : value === 3 ? 'Three rays (180° span)' : 'Four rays (360° span)'}</option>`).join('')}</select></label><label><input type="checkbox" data-sense="temperature"${senses.temperature ? ' checked' : ''}>Paid local temperature sensor</label><p>All eyes share these inherited traits. Rays begin at actual body cells; walls, self, other bodies and food stop sight. Only visible stinger cells signal stingers. Cost per evaluation: 0.001 × eyes × rays × range, even when occluded. Temperature samples the first ordered body cell and its front/left/right neighbors for 0.032 energy; disabled means unavailable and zero thermal cost. No global gradients or promised migration. Each birth mutation gate also mutates one bounded sensor trait.</p>` : ''}</fieldset>`;
}

export function editSenses(genome: Genome, key: string, value: number | boolean): Genome | null {
  if (!genome.controller) return null;
  if (key === 'enabled' && typeof value === 'boolean') {
    const copy = structuredClone(genome);
    copy.controller = newController(value ? 2 : 1);
    if (value) copy.senses = newSenses();
    else delete copy.senses;
    return copy;
  }
  if (!genome.senses) return null;
  if (
    (key === 'temperature' && typeof value === 'boolean') ||
    (key === 'orientation' && integer(value, 0, 3)) ||
    (key === 'range' && integer(value, 1, 8)) ||
    (key === 'fov' && [1, 3, 4].includes(value as number))
  ) {
    const copy = structuredClone(genome);
    Object.assign(copy.senses!, { [key]: value });
    return copy;
  }
  return null;
}

export function sensesStatus(genome: Genome): string {
  const senses = genome.senses;
  return senses
    ? `Neural controller v2 — 10 inputs, 4 hidden, 4 actions. Eyes: orientation ${senses.orientation} quarter turns, range ${senses.range}, ${senses.fov} cardinal rays. Vision costs 0.001 × eye count × range × rays per evaluation. Local temperature ${senses.temperature ? 'enabled: four paid samples, 0.032 energy' : 'unavailable: zero thermal cost'}. Evaluation costs 0.02, motor attempts 0.03. Last perception retains actual sampled rays and temperatures, not a fresh evaluation.`
    : '';
}
