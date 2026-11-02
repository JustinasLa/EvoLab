# Biological habitat: passive armor shade

## Opt-in contract

Only passive body-cast shade is implemented for issue #74. Protective substances,
terrain construction and new cell types are deferred. This is an artificial-life
rule, not calibrated radiation or a promise of cooperation.

- A new/reseeded world opts in explicitly; defaults and all predecessor imports
  stay disabled. The reseed confirmation freezes the choice. There is no mid-world
  toggle. A strict versioned mode is saved independently of manual fields.
- Every living armor cell casts four shade units onto itself and its four cardinal
  neighbors (Manhattan radius one), in world coordinates after body rotation.
  All five positions wrap. Walls do not block this local field.
- Contributions add regardless of lineage and saturate at 16 units. Painted light
  attenuation and biological attenuation add, capped at 16; neither source alters
  the other's stored values, capacity, history or enabled flag.
- Each biological unit also subtracts 0.01 normalized temperature. Add this signed
  offset and the enabled painted temperature offset to the existing climate
  expression before its single clamp. Painted shade alone never cools.
- Freeze the biological field from living bodies at the start of each logical
  tick, before organism updates. All organisms use that same field for the entire
  tick: anchor temperature for metabolism, each actual leaf cell for light. Moves,
  rotations, births, deaths and erasures affect the next tick's field. No residue,
  diffusion, accumulation across ticks or persistent biological matrix exists.
- Paused inspection and frames derive the field from current boundary bodies.
  They describe current exposure, not retrospective metabolic dose. Save/reload
  reconstructs the exact next-tick field from complete bodies and the mode.
- Every armor cell already occupies a bounded anatomy slot and pays baseline
  body upkeep (and one finite nutrient unit when that optional cycle is enabled).
  Enabled shade additionally costs 0.008 energy per armor cell per tick, recorded
  within upkeep, never as extra intake or material. It emits no material. Death
  follows existing rules; nutrient biomass returns only through existing detritus.
- Cooling can reduce heat stress for self or neighbors; light loss reduces leaf
  energy/food trials, cold stress can increase, and armor maintenance costs energy.
  Descendants receive no special benefit, energy subsidy or cooperation guarantee.
- Work is bounded by one 37,440-cell plane and at most 1,600 × 16 × 5 contributions
  per reconstruction. No ecological random draws are added. Disabled ecology uses
  the exact prior temperature, energy and food-trial arithmetic and update order.

## Persistence and presentation

World18, cellular rules10 and measurement11 add this opt-in to the world17 nutrient
baseline. Reconcile these envelopes against current main at serial integration;
concurrent reserved-energy, life-history and sensory paths must remain intact.
No genome or blueprint version change is needed. Native saves
must contain exactly `{version: 1, enabled: boolean}` for biological shade; reject
unknown/missing fields and future versions before replacement. Older saves ignore
previously unowned root extensions of that name and receive disabled mode.

Present biological mode, source (living armor), extent, summed/saturated magnitude,
cost and timing separately from painted shade and temperature. Selected-organism
and tile inspection report biological units/cooling alongside painted units and
combined light. Measurement metadata describes current boundary exposure, not a
historical biological field. Existing telemetry records actual energy changes.

## Verification coverage

`test/biological-shade.test.ts` covers hot/cold self and neighbor consequences, light and food
costs, maintenance, finite-material conservation, overlap/saturation, rotations,
wrapping, movement/death/birth timing, disabled identity and strict migrations.
Worker/UI fixtures and `test/browser/biological-shade.spec.ts` cover opt-in/reset cancellation, source inspection, exact
pause/step, save/reload, failed import and detached frame ownership. Standard full
checks and `test/long-run/biological-shade.spec.ts` soak/throughput verification require the coordinator's grants. A focused pass is not full acceptance.
