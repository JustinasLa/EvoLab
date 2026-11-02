# Optional nutrient cycle

This artificial-life rule set is opt-in at confirmed reseeding only. Existing
worlds and ordinary new worlds remain disabled. There is no mid-world enable,
disable, nutrient rain, population rescue, or replenishment. No new cell type is
added: passive decay is the minimal first slice; evolved decomposer capabilities
are deferred rather than represented by an uncosted energy source.

## Matter and energy contract (rules version 1)

- One nutrient unit (N) is abstract conserved matter, not energy. Initialization
  assigns four N to every grid position, including walls. The founder withdraws
  one N per body cell. The total endowment is exactly 149,760 N.
- Mineral N and detritus N are separate unsigned integer planes. Each food cell
  holds one N and 2.2 energy units (E). Each living body cell holds one N. There
  are no hidden organism nutrient reserves. Their four pools sum to the original
  endowment, even after editing, movement, extinction and wall regeneration.
- Leaves receive ordinary sunlight energy only while their actual rotated,
  wrapped cell has mineral N. Successful ordinary food trials withdraw one N
  there and cost 2.25 E: 2.2 stored in adjacent food and 0.05 dissipated for
  uptake/synthesis. Trials cannot overwrite food. Climate, shade and existing
  random trial/direction order remain intact. Disabled rules use the exact
  legacy energy, food, corpse and random paths.
- Body construction withdraws one mineral N from every prospective cell; the
  complete footprint must afford it before any withdrawal. Reproduction retains
  the existing parental energy transfer and two-E construction loss. Explicit
  manual placement grants the normal initial energy but still costs local N.
- Mouths transfer food's 2.2 E and return its one N at the mouth position. Food
  displaced by movement, placement, walls or erasure becomes local detritus,
  losing its stored energy. Corpses deposit exactly one detritus N per body cell;
  remaining organism energy is lost, not converted to free food. Repeat removal
  cannot duplicate deposits. Food painting spends local mineral N and is an
  explicit manual energy grant, never an automatic nutrient grant.
- Every 32 ticks, each non-wall cell mineralizes at most one detritus N, with no
  energy gain. Then disjoint neighboring pairs transfer one mineral N down a
  gradient of at least two N. The four successive phases are even/odd horizontal
  and even/odd vertical pairs. Edges wrap; walls block decay/transport and retain
  their matter until cleared. Occupancy does not insulate soil. No RNG is used.
- Enabled organisms retain at most 1,000 E each; excess is dissipated. Stings
  cannot withdraw more positive energy than a victim holds, and retain 26% of
  the withdrawal. The rest is lost. Total stored energy is bounded by
  `1,000 * population limit + 2.2 * grid size`; decomposition creates no energy.

## Observation and persistence

Resource views expose both planes, pool totals in N, current stored energy in E,
and the latest completed tick's energy balance (before + sunlight = after +
dissipation). This balance excludes manual actions between ticks; the following
tick starts from their actual resulting energy. It is not a lifetime cumulative
counter. Full fields and bounded last-tick accounting are saved. Import validates
dimensions, values, exact keys, matter conservation, food/terrain/body conflicts,
energy bounds and accounting before adopting the candidate world. Legacy worlds
migrate to disabled rules without initialization or changed random state.

Comparisons use declared seeds, identical terrain, fixed horizons and complete
saved-state reproducibility checks. Report actual depletion, recycling, energy
and population outcomes; do not promise coexistence, adaptation or biological
realism. Empty worlds continue mineralization when explicitly stepped/run.
