import { WIDTH, HEIGHT, integer, index, type HabitatFrame } from './model';
import { activeRefugeUnits, localTemperature } from './refuges';
import {
  ARMOR_SHADE_UPKEEP,
  combinedShadeUnits,
  type BiologicalShadeSummary,
  type BiologicalShadeExposure,
} from './biological-shade';

export const biologicalShadeMarkup =
  () => `<details><summary>Biological shade (experimental)</summary>
<label><input id="biological-shade-next" type="checkbox">Enable armor-cast shade on next reseed</label>
<p>Only confirmed Reset applies this choice. Living armor casts 4 units onto itself and its four cardinal neighbors, wrapping, capped at 16. Add painted and biological shade, capped at 16; each unit removes 1/16 of light. Only biological units cool temperature by 0.01 each, added to painted temperature before clamping.</p>
<p>Armor costs its normal anatomy/material and upkeep plus 0.008 E per cell per tick. Cooling may help hot bodies and harm cold bodies; shading reduces leaf energy and food. No guaranteed cooperation. The whole tick uses start-of-tick bodies; movement, birth and death affect the next tick. There is no residue or constructed terrain.</p>
<p id="biological-shade-summary">Disabled: no biological habitat effects.</p>
<p>Current boundary exposure below is not earlier metabolic dose. Light/temperature overlays include biological effects on empty tiles; bodies keep functional colors. Paint remains separately editable and is never overwritten.</p>
<label for="biological-shade-x">Habitat column</label><input id="biological-shade-x" type="number" min="0" max="239" step="1" value="120">
<label for="biological-shade-y">Habitat row</label><input id="biological-shade-y" type="number" min="0" max="155" step="1" value="78"><p id="biological-shade-cell"></p>
</details>`;

export function biologicalShadeDescription(
  summary: BiologicalShadeSummary | undefined,
  tick: number,
): string {
  return summary
    ? `Tick ${tick}: source = ${summary.armorCells} living armor cells; ${summary.affectedCells} affected tiles, maximum ${summary.maximumUnits}/16 biological attenuation, ${summary.sumUnits} summed units. Additional maintenance ${summary.armorCells * ARMOR_SHADE_UPKEEP} E/tick. Current bodies, not historical dose.`
    : 'Disabled: no biological habitat effects.';
}

export function biologicalShadeInspection(exposure: BiologicalShadeExposure | undefined): string {
  return exposure
    ? `Biological source: living armor (self and neighbors). Anchor ${exposure.anchorUnits}/16 biological shade; cooling −${exposure.anchorUnits / 100}. Own armor ${exposure.armorCells}, additional upkeep ${exposure.armorCells * ARMOR_SHADE_UPKEEP} E/tick. Across ${exposure.leafCells} leaves: ${exposure.biologicalLeafUnits} biological and ${exposure.paintedLeafUnits} active painted attenuation units before per-leaf saturation. Current boundary exposure, not last metabolism.`
    : 'Biological shade disabled; no biological cooling or maintenance.';
}

export function biologicalShadeTile(
  frame: HabitatFrame | undefined,
  column: number,
  row: number,
): string {
  if (!integer(column, 0, WIDTH - 1) || !integer(row, 0, HEIGHT - 1))
    return 'Choose an in-bounds whole-number tile.';
  if (!frame) return 'Waiting for a habitat frame.';
  const position = index(column, row),
    biological = frame.biologicalShade?.units[position] ?? 0,
    painted = frame.shadeHabitats.enabled ? frame.shadeHabitats.units[position] : 0,
    thermal = activeRefugeUnits(frame.thermalRefuges, column, row),
    temperature = localTemperature(
      column,
      row,
      frame.stats.tick,
      frame.climate,
      frame.offset,
      frame.thermalRefuges,
      biological,
    );
  return `Displayed tick ${frame.stats.tick} · (${column}, ${row}): living armor ${biological}/16 biological shade, painted ${painted}/16 active (${frame.shadeHabitats.units[position]}/16 stored); combined transmission ${(16 - combinedShadeUnits(painted, biological)) / 16}. Biological cooling −${biological / 100}; painted temperature ${thermal / 100}; normalized temperature ${temperature}.`;
}
