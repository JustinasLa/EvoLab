# Optional inherited life histories

EvoLab / Drift supports three explicit, inherited integer traits, each bounded to
0–2. Genomes without `lifeHistory` retain their historical reproduction and age
rules and consume no additional mutation draws. Enable the traits in the organism
designer to create a strategy; evolution does not silently enable the mode.
This is artificial life, not a calibrated biological model or a prescribed winner.

## Costs and tradeoffs

For parent body size `n`, child body size `c`, maturity trait `m`, investment `i`
and maintenance `h`:

| Rule                        | Legacy genome         | Opted-in genome                                  |
| --------------------------- | --------------------- | ------------------------------------------------ |
| Reproductive maturity       | age greater than 30   | age greater than `15 + 15m`                      |
| Birth cadence               | age divisible by 11   | age divisible by `11 + 3h`                       |
| Child energy grant          | `1.5c + 3`            | `c(1 + 0.5i) + 2 + i`                            |
| Birth overhead              | 2 energy              | `4 − m` energy                                   |
| Age limit                   | `900 + 75n`           | `900 + 75n + 300h`                               |
| Additional recurring upkeep | none                  | `0.004hn` energy per tick                        |
| Birth energy threshold      | greater than `3n + 9` | greater than `grant(min(16,n+1)) + overhead + 1` |

The default explicit strategy is maturity1/investment1/maintenance0. Earlier
maturity increases overhead. Greater investment transfers more parent energy to
the child. Longer life requires recurring upkeep and a slower birth cadence.
The opted-in threshold reserves energy for the largest possible one-cell growth
mutation, overhead and one remaining energy unit. Normal body and climate costs
still apply. Death occurs when energy is exhausted or age exceeds the limit.

Successful reproduction transfers the child grant from the parent and charges
overhead exactly once. The **parent's** strategy determines payment even when a
child inherits a mutation. There are at most three spatial placement attempts in
the established draw order. Failed attempts pay no birth cost and grant nothing.
At the population cap the engine skips the entire reproduction attempt, including
its mutation and placement draws. Explicit manual planting follows the existing
editor initialization rules; it is not an ecological birth.

With the finite nutrient cycle enabled, an admitted child consumes one terrain
mineral per body cell. The complete footprint must pass placement and mineral
checks before any debit. Mineral-starved attempts pay neither minerals nor birth
energy. Maintenance and overhead contribute to measured energy dissipation.
Death returns body material to detritus, without creating food or energy. The
original nutrient conservation and finite-energy validators remain active.

## Inheritance and evidence

The ordinary mutation gate and anatomical mutation run first, followed by the
canonical neural mutation and independent propensity trial. Only opted-in genomes
whose ordinary gate passed then draw a life-history trait and a −1/+1 step, clamped
to0–2. That step consumes exactly two random draws, including a boundary no-op.
Weighted anatomical channels set to zero do not suppress this separate gated step.
No failed candidate is presented as an inherited child.

The designer exposes the bounded controls. Selected-organism inspection shows
maturity, cadence, threshold, grant, overhead, maintenance and age limit. Parent
and child evidence shows their values and deltas. The shared512-event birth ring
records actual parent payment, child grant, overhead, parent age, mutation gate,
channels and placement attempts. Retained birth exports use format2. Older events
without payments remain explicitly unknown.

A separate128-event life-history log records observed maturity and death outcomes
with logical tick, age, body size, strategy and organism/lineage identity. It also
sums actual maintenance expenditure, already included in ordinary upkeep. The
lineage explorer shows the latest12 outcomes; complete Save retains the entire
bounded log and pruning marker. Detailed lineage observations carry this log;
ordinary worker frames do not. Neither inspection nor logging changes RNG.

## Persistence and compatibility

World18 and blueprint6 own the optional life-history contract. World18 requires
both its life-history log and the nutrient field introduced in world17 (complete
pools or explicit null). Predecessor worlds receive an empty life-history log at
their imported tick; unobserved historical outcomes are not reconstructed.
World17 keeps its strict nutrient pool, overlap, neural state and energy checks.
World16/blueprint5 keep canonical neural semantics. Earlier opaque extension
carriers remain data and cannot activate a strategy.

Complete validation covers living organisms, extinct founding genomes, retained
birth pairs, identities, payments and the bounded outcome log before replacement.
Accepted traits and opaque metadata survive Save, import, blueprints and the local
library. Measurement format10 retains nutrient, neural and ecological-role costs;
experiment rules10 and world18 identify comparison and batch replay provenance.
Seeded batch replay still rejects a checkpoint that differs from its independent
seeded initialization. Dormancy is an independent extension, not a prerequisite.

## Verification scope

Focused tests cover all27 strategies, failed placement and the population cap,
mutation bounds/draw order, actual payments, terminal age outcomes, malformed
imports and complete restoration. Frozen full-save hashes preserve canonical
neural16 and nutrient17 trajectories, alongside earlier legacy ecology hashes.
Long-run acceptance covers contrasting strategies in four resource/climate
conditions, additional finite-nutrient trajectories, repeated complete restoration
and bounded-population throughput. These measurements do not rank strategies or
infer a universal winner. Required unit coverage and built-browser checks remain
part of release acceptance.
