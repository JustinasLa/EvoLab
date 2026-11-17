import { LIFE_TRAITS, lifeRules, type LifeHistoryLog } from './life-history';
import type { Genome, Organism } from './model';

export function lifeDescription(genome: Genome): string {
  const traits = genome.lifeHistory;
  if (!traits) return 'Legacy life history (disabled).';
  return LIFE_TRAITS.map((key) => `${key} ${traits[key]}`).join(', ');
}
export function lifeInspection(o: Organism): string {
  const rules = lifeRules(o.genome);
  return `<p>Life history: ${lifeDescription(o.genome)} Maturity requires age &gt;${rules.maturity} (${o.age > rules.maturity ? 'mature' : 'immature'}); birth cadence ${rules.cadence} age ticks; age limit ${rules.ageLimit} ticks. Energy must exceed ${rules.threshold}. Additional maintenance ${rules.maintenance} energy/tick, included in upkeep. A same-size child would receive ${rules.grant(o.genome.cells.length)} energy; successful birth overhead ${rules.overhead}, both parent-paid. Placement can fail; no payment then.</p>`;
}
export function lifeDiff(parent: Genome, child: Genome): string {
  return `<tr><th scope="row">life history</th><td>${lifeDescription(parent)}</td><td>${lifeDescription(child)}</td><td>${LIFE_TRAITS.map((key) => `${key}: ${parent.lifeHistory && child.lifeHistory ? child.lifeHistory[key] - parent.lifeHistory[key] : 'mode comparison'}`).join('; ')}</td></tr>`;
}
export function lifeLogHtml(log?: LifeHistoryLog): string {
  if (!log) return '<p>Open the lineage explorer to observe life-history outcomes.</p>';
  return `<p>Opted-in life histories: recording since tick ${log.originTick}; earlier outcomes unknown. Additional maintenance actually paid ${log.maintenanceSpent} energy (already included in upkeep). ${log.events.length}/128 maturity/death observations retained; ${log.eventsPruned ? 'older events pruned' : 'no events pruned'}. Showing the latest 12; complete retained observations are in Save world. Birth payments are in retained reproductive attempts below. These measurements do not rank strategies.</p><ul>${log.events
    .slice(-12)
    .reverse()
    .map(
      (event) =>
        `<li>Tick ${event.tick}: organism #${event.organismId}, lineage #${event.lineageId}, ${event.kind === 'mature' ? 'reached maturity' : `death (${event.kind})`} at age ${event.age}; maturity threshold ${15 + 15 * event.traits.maturity}, age limit ${900 + event.cells * 75 + event.traits.maintenance * 300}.</li>`,
    )
    .join('')}</ul>`;
}
