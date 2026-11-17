# Optional energy reserves and dormancy

This artificial-life rule is an explicit per-genome opt-in. Founders, legacy
designs and organisms without the trait keep the exact predecessor energy,
random and update order. Dormancy is a strategy with real costs, not a
survival bonus: it cannot create energy, finance waking from nearby food or
rescue a population from extinction.

## Inherited traits (dormancy version 1)

| Trait                  | Bounds                            | Default |
| ---------------------- | --------------------------------- | ------- |
| Reserve capacity (E)   | 1–64                              | 24      |
| Sleep stress threshold | 0.01–1                            | 0.15    |
| Wake stress threshold  | 0–0.99, at least 0.01 below sleep | 0.05    |
| Sleep energy threshold | 0–16                              | 3       |
| Wake energy threshold  | at least sleep + 1, at most 64    | 10      |

Traits are copied unchanged to offspring. Ordinary mutation never adds,
removes or edits them. Living reserve state never inherits: every offspring
starts active with empty reserves and receives only the existing
parent-funded birth energy.

## Energy contract

Reserves supplement an organism's liquid energy; the two are never counted
twice. Each tick, before ordinary upkeep:

1. **Sleep check (active only).** An organism sleeps when climate stress is at
   or above its sleep threshold _or_ its liquid energy is at or below its sleep
   energy threshold, and only if liquid energy plus reserves exceed the entry
   cost of 0.2 E per cell.
2. **Maintenance (always).** Every enabled organism pays 0.001 E per cell plus
   0.0005 E per stored reserve unit.
3. **Wake check (dormant at the start of the tick only).** It wakes only when
   stress is at or below its wake threshold _and_ liquid energy plus reserves,
   after maintenance, cover the wake energy threshold plus the exit cost of
   0.3 E per cell. Waking withdraws enough reserve to reach that amount, then
   pays exit. At most one transition happens per tick.
4. **Storage (active only).** Liquid energy above the wake threshold is
   converted at up to 0.25 E input per cell per tick, 80% efficient, until
   capacity is reached. A sub-precision deposit that would round above its
   input is rejected before either account changes.

Withdrawals may fund a cost plus a one-unit liquid buffer; they move existing
energy and never create it. Upkeep for enabled organisms draws on reserves the
same way.

## Dormant behavior

Dormant upkeep is 20% of the ordinary climate-inclusive upkeep. Sleepers cannot
eat, photosynthesize, produce food, move, perceive, sting or reproduce, and
neural controllers skip inference and actions without clearing their
blocked-action observation. Inherited senses are not sampled while dormant, so
sleepers pay no eye or temperature-sensing cost. Sleepers still age, die of age or energy
exhaustion, occupy their footprint and keep cell-local armor and
vulnerability. Death discards stored reserves; corpses gain no extra food.

With optional life history, sleepers keep its age limit and record maturity
normally, and its inherited maintenance is paid in full while dormant (only the
ordinary climate-inclusive upkeep is reduced). Reserves can fund that
maintenance like any other upkeep.

With the optional nutrient cycle enabled, the 1,000 E per-organism cap counts
liquid energy plus reserves. Reserves hold energy only, not nutrient matter.
See [nutrient-cycle.md](nutrient-cycle.md).

## Observation and persistence

- The designer exposes the opt-in and all five traits; the paused inspector
  shows active or dormant state, current reserves and the thresholds.
- Telemetry intervals and the pending interval carry an optional reserve ledger:
  deposited, withdrawn, conversion loss, maintenance, entry, exit and discarded
  stores. These are separate from environmental intake and ordinary upkeep.
- Blueprint format 8 and the local library keep traits only. Native world
  format 20 keeps exact living reserves and dormant state and validates them
  completely before replacement. World 19 and earlier and blueprint 7 and
  earlier remain accepted without enabling dormancy; unrecognized reserve-named
  fields on organisms without the opt-in stay inert. Measurement format 12 and
  experiment rules 12 identify this composed ruleset.

## Limitations

The thresholds, efficiencies and costs are design constants for this
simulation, not calibrated biology. Stress and energy are the only sleep and
wake cues, and dormancy is a single on/off state.
