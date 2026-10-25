# Life, evolution and climate

[Project index](README.md)

## The habitat

The world is a 240 × 156 cell grid with wrapped boundaries. A creature leaving one
edge returns on the opposite edge. Food and mineral walls occupy independent
cells. A seeded starting population includes stationary producers, mobile
foragers and predators. Porous mineral ridges partition parts of the habitat.

Every organism occupies one or more connected cells. Bodies contain 1–16 cells,
with local coordinates between −4 and 4, and can rotate in quarter turns. The
occupied-cell grid prevents bodies from overlapping walls or other organisms.
Food can be displaced by movement or placement.

## Functional cells

| Cell    | Effect                                                                               |
| ------- | ------------------------------------------------------------------------------------ |
| Mouth   | Consumes adjacent food for energy                                                    |
| Leaf    | Gains energy from light and sometimes produces adjacent food                         |
| Motor   | Allows translation and rotation; movement uses energy                                |
| Stinger | Drains energy from adjacent organisms every fourth tick and recovers part of it      |
| Armor   | Protects the contacted cell against stingers                                         |
| Eye     | Helps a moving organism choose a direction from food, obstacles and nearby organisms |

Eyes scan the four cardinal directions up to five cells away. Predators favor
nearby organisms; other sighted movers avoid them. Unsighted movers occasionally
change direction randomly. Blocked movers choose a new direction and try a
quarter turn.

All bodies pay energy upkeep. Death occurs when energy is exhausted or the
organism exceeds `900 + 75 × body size` ticks. The dead body becomes food.
The simulation is an artificial ecology, not a calibrated biological model.

## Reproduction and mutation

An organism older than 30 ticks can reproduce when its energy exceeds
`3 × body size + 9`. Birth is attempted every eleventh age tick, with up to three
placement attempts. Offspring receive energy paid by their parent. A full world
or blocked placement can prevent reproduction. Population is capped at 1,600.

The mutation setting is the probability of mutation at birth. A mutation tries
to add, remove or change a functional cell. Changes retain connected, bounded
anatomy. Temperature preference, tolerance and movement tempo can mutate too.
There is no population ranking, scheduled generation replacement, crossover or
externally assigned fitness function.

A mutated birth starts a new lineage. Clonal descendants retain their lineage.
The inspector records up to eight preceding lineage transitions, excluding
repeated clonal generations. Species labels such as Bloom or Forager describe
anatomy, not a guaranteed diet or ecological role. Separately arising mutations
are tracked separately even if their shapes happen to match.

## The twist: drifting climate

Local temperature combines a moving horizontal band, a spatial vertical
variation and a seasonal oscillation. Climate pressure scales this variation.
The displayed 0–40° scale is an abstract visualization, not Celsius.

Organisms inherit a preferred temperature in `[0,1]` and tolerance in
`[0.12,0.6]`. Outside that tolerance, mismatch adds metabolic stress and reduces
photosynthesis. Higher tolerance has an upkeep cost even in comfortable
conditions, so generalists do not receive free resistance. Tolerance above 0.2
adds `0.025 × (tolerance − 0.2)` energy upkeep per cell per tick to the baseline
0.012. Climate stress adds `0.2 × mismatch` per cell per tick.

Cold snaps and heatwaves shift the local temperature by −0.32 or +0.32 for 900
simulation ticks. A nutrient bloom immediately scatters extra food. New climate
events replace the preceding temperature shift. These are real environmental
changes applied to the same world, not score adjustments or scripted winners.

## Repeatability

Seeded randomness and fixed logical ticks make identical states evolve
identically in the same runtime. Save files preserve random-generator state and
organism iteration order. Cross-browser or future-version bitwise identity is
not promised. The initial seed governs organisms, terrain and food placement.

The current cellular world format is version 2. The earlier locomotion simulator
and version-1 champion files are replaced; they are not imported as ecosystems.
