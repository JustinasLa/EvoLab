import type { NutrientSummary } from './nutrients';

export const nutrientMarkup = () => `<details><summary>Nutrient cycle (experimental)</summary>
<label><input id="nutrient-next" type="checkbox">Enable finite nutrient cycle on next reseed</label>
<p>Applies only after confirming Reset. No mid-world toggle or replenishment. Legacy worlds stay unchanged. Four N per cell initially; one N per food/body cell. Leaves need local mineral N for sunlight and spend one N + 2.25 E per food (2.2 E stored). Bodies spend one N per cell. Corpses become detritus, not free food. Passive decay and paired transport occur every 32 ticks, wrapping at edges; walls trap matter. No decomposer cell is added.</p>
<p>Manual Food and placement grant energy explicitly but must afford local N. Organisms cap at 1,000 E. These are artificial-life rules, not biological predictions.</p>
<p id="nutrient-summary">Disabled: legacy food and corpse rules.</p>
<label for="nutrient-layer">Resource field</label><select id="nutrient-layer"><option value="none">Ordinary habitat</option><option value="minerals">Mineral N</option><option value="detritus">Detritus N</option></select>
<p>Resource colors include occupied cells and walls: black = zero, brighter = more, saturating at 16 N. Exact wrapped tile values below refer to the displayed frame, not necessarily the latest observation.</p>
<label for="nutrient-x">Resource column</label><input id="nutrient-x" type="number" min="0" max="239" step="1" value="120">
<label for="nutrient-y">Resource row</label><input id="nutrient-y" type="number" min="0" max="155" step="1" value="78"><p id="nutrient-cell"></p>
</details>`;

export function nutrientDescription(summary: NutrientSummary | undefined, tick: number): string {
  if (!summary) return 'Disabled: legacy food and corpse rules.';
  const budget = summary.budget;
  return `Tick ${tick} · mineral ${summary.minerals} N · detritus ${summary.detritus} N · food ${summary.food} N · biomass ${summary.biomass} N · total ${summary.total}/${summary.initial} N · stored ${summary.energy.toFixed(6)} E. ${budget ? `Last completed tick ${budget.tick}: ${budget.before.toFixed(6)} E before + ${budget.sunlight.toFixed(6)} E sunlight = ${budget.after.toFixed(6)} E after + ${budget.dissipated.toFixed(6)} E dissipated. Excludes manual actions between ticks; not lifetime counters.` : 'No completed tick energy budget yet.'}`;
}
