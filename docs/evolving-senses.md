# Evolving local senses — issue 70 contract

Explicit creation/import of a version-2 neural controller requires a version-1
`senses` genome record. No founder, preset, imported predecessor, mutation or
inspection automatically activates it. Controller1 remains exactly its six-input
historical network and historical eye classification, arithmetic and RNG. Passive
behavior1 and active reaction2 retain their literal old paths.

The inherited record has exactly `version:1`, `orientation:0..3` (integer body-local
quarter turns), `range:1..8` (integer), `fov:1|3|4`, and `temperature:boolean`.
All eyes share these traits. This is a discrete cardinal field of view, not a
continuous cone: one ray forward; three forward/left/right (180-degree span); or
four cardinal rays (360-degree span). Orientations add body rotation. Every ray
starts at its eye's actual rotated, wrapped body cell and excludes its origin.
Empty cells transmit; first wall, self, other body or food occludes, in that order.
Self produces no measurement. Other bodies report only the hit cell: visible
stinger or other body. No unseen stinger, global habitat, intent or threat label
is exposed. Maximum workload is 16 eyes × 4 rays × 8 cells = 512 visits.

Controller2 has ten inputs, four clamped hidden units and four clamped action
units, 56 weights and eight biases, bounded to [-4,4]. Inputs 0..5 are food,
wall, non-stinger body, visible stinger proximity, energy/reproduction threshold,
and previous blocked action. Proximity is (range+1-distance)/range, maximum over
declared rays. Inputs 6..9 are local normalized temperatures at the first ordered
body cell and its body-front, left and right neighbors. These are four direct
local samples, never a destination recommendation or a global gradient. Sampling
uses actual rotated/wrapped positions and the authoritative painted/event climate.
Disabled temperature supplies zero and explicit unavailable inspector evidence;
no climate function is called for it. No eyes means unavailable visual channels.

At the existing eligible neural tick, sample once before payment and action.
Charge 0.001 energy per provisioned eye ray/range cell, irrespective of occlusion,
plus 0.008 per thermal sample when enabled (0.032 total). These real payments join
upkeepSpent, in addition to existing 0.02 network evaluation and 0.03 motor-action
costs. Nonmotor controllers still evaluate/pay; rest still pays sensing/evaluation.
No new random draws occur on evaluation. Selection retains only the actual latest
evaluation's bounded rays, temperatures, availability and paid costs, not a second
evaluation. Inspection/drawing consumes no ticks, energy or random draws.

After a successful existing mutation gate and controller perturbation, opted-in
offspring additionally choose uniformly one of orientation/range/FOV/temperature,
then one alternative orientation/FOV, a range step of ±1 clamped to bounds,
or a temperature toggle (two draws). Temperature toggles consume the second
draw too. The existing gate, placement order and failed-attempt semantics remain.
Complete inherited records are detached. No mutation activates/deactivates the
controller version or removes sensing capability records. Bounds are validated,
not repaired during import. Mutation evidence includes its sensor channel.

World18 and blueprint6 own the expanded-senses contract; measurement11 and
experiment rules10 identify the composed ecology. Native nutrient world17 remains
importable with its required nutrient field, bounded energy, conserved matter and
literal controller1 behavior. Worlds16 and17 reject expanded sensing in living,
extinct founding and retained birth genomes rather than activating unknown fields.
Earlier formats retain their historical validation and encoded opaque extensions.
All native worlds require the complete nutrient field (null means disabled).
Blueprints store organism traits, not the world nutrient mode. Local libraries,
observations, journal/replay and isolated experiments preserve complete accepted
successor state; recipe provenance identifies its actual rules and world version.

Sensing costs reduce real organism energy and join upkeep telemetry. In enabled
nutrient worlds they also reduce stored energy and enter the existing completed
tick's dissipation balance; they neither add nor remove nutrient matter. Exhausted
organisms follow the selected world's ordinary corpse rule. Existing per-organism
energy caps, strict finite budgets, sunlight accounting and funded placement remain
unchanged. An overdrawn dying organism does not create negative stored energy.

Controlled tests distinguish orientation, range, FOV, first-hit occlusion,
body rotation and seams through actual engine observations, actions and costs.
Thermal scenes demonstrate local steering and blocked/no-progress outcomes rather
than guaranteed migration, survival or adaptation. The expanded-senses benchmark
retains complete deterministic endpoints for 64 and 1,600 initial organisms with
thermal sensing and nutrient ecology separately on/off. Dense bodies self-occlude;
this is bounded-population cost evidence, not a universal worst-case timing claim.
Populated ticks and actual starvation are disclosed separately from empty ticks.
This remains artificial life, not a calibrated biological model.
