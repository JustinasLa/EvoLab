# Single-blueprint assay fixtures

Step 1 of the organism testing bench (issue #98). It defines what an assay
of one inherited design is: four versioned fixtures, a validated recipe format,
budgets and trial outcomes. A trial runner exists for engine tests and for the
bench (#99). This step adds no user interface, worker messages, result export or
mutation sensitivity (#100). Assays never edit the sandbox, the library or the
source blueprint. They don't produce a fitness score, rank designs, redesign
anything or promise success.

This is artificial life, not a calibrated biological test.

## Subject

- The subject is the exact text of a standalone organism blueprint (format 1–8,
  at most 16 KiB). It is parsed by the normal blueprint validator, so it carries
  only inherited data: anatomy, temperature traits, tempo, behavior, and any
  opted-in controller, senses, mutation propensity, life history or dormancy
  traits. An organism's energy, age, reserves, position or observed decisions
  are not blueprint fields, so the recipe can't contain them. Neural weights are
  inherited genotype; EvoLab has no lifetime learning.
- The recipe records the blueprint's UTF-8 byte count and SHA-256. Both must
  match the stored text.
- A blueprint that carries preserved opaque traits (`legacyExtensions` on the
  genome or a cell) is rejected. The engine would carry those traits without
  running them, so a trial would silently drop part of the design.
- Each trial places one subject at (120, 78), rotation 0, with the ordinary
  placement grant of 8 + cell count energy. Its initial facing comes from the
  trial seed. A placement never moves to a free spot: if the footprint is
  blocked, the trial is `blocked-initialization`.

## Fixtures (version 1)

Every fixture runs with mutation probability 0 and a uniform climate (strength
0, so local temperature is 0.5 before events). Organisms still age, pay upkeep,
eat, reproduce and die under the ordinary rules. Mutation propensity can still
drift at birth for designs that opt into it. Pellets are 2.2 energy each.

| Fixture               | Terrain                                     | Food at tick 0                                                              | Other                                                                                                  | Modes                                 |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `limited-food`        | Open field                                  | 72 pellets on a 4-cell lattice in (104–136, 62–94), none inside (116–124, 74–82) | Producer food rate 0: leaves still photosynthesise but make no food                                    | Nutrient cycle, biological shade      |
| `thermal-exposure`    | Open field                                  | The same 72 pellets                                                         | Heatwave (+0.32, 900 ticks) at tick 0, cold snap (−0.32, 900 ticks) at tick 1800, both recorded as interventions | Nutrient cycle only                   |
| `obstacle-navigation` | Chambered refuges, terrain seed 98 (1,212 walls) | 126 pellets on a 6-cell lattice in the two neighbouring chambers only       | The subject starts in the centre of chamber (91–149, 53–103) and must pass a 5-cell doorway to reach food | Nutrient cycle, biological shade      |
| `stinger-contact`     | Open field                                  | The same 72 pellets                                                         | One fixed antagonist: a stationary one-cell stinger (preference 0.5, tolerance 0.3) east of the subject's easternmost cell | Nutrient cycle, biological shade      |

- The thermal fixture rejects biological shade because armor-cast cooling
  would change its declared exposure.
- The antagonist is an ordinary organism. It pays upkeep, ages and can
  reproduce if stinging funds it. Its stinger drains 2.5 energy every fourth
  tick from any adjacent non-armor cell, so an unarmored stationary subject can
  die within a few dozen ticks, while armor on the touching cell blocks it.
  Its descendants never count as subject lineage.
- Each fixture declares what #99 will measure: subject survival tick, energy
  ledger, offspring and living lineage descendants at the horizon for every
  fixture, plus food eaten/remaining (limited food), stressed ticks (thermal),
  first neighbouring-chamber entry and food eaten (navigation), and stings
  received and energy drained (stinger).
- A fixture's provenance is its id, version and the SHA-256 of its complete
  definition. A recipe whose fixture version or digest differs from this
  runtime's is rejected.

## Material and energy accounting

The initialization record lists the subject's (and antagonist's) id, lineage,
position, facing, energy and cell count, the wall count, the pellet count and
energy, and the total initial energy.

With the finite nutrient cycle, the world starts from the normal 149,760 N
endowment (4 N per cell). Each body cell and each pellet takes 1 N from its own
cell, so the total stays 149,760 N. The record states the remaining minerals,
food debit and body debit. Without the cycle, the legacy rules apply: food and
bodies need no nutrient.

## Recipe format and budgets

```json
{
  "format": "evolab-drift-assay-recipe",
  "version": 1,
  "rules": { "id": "evolab-drift-cellular", "version": 13, "worldVersion": 21 },
  "subject": { "blueprint": "<exact blueprint text>", "bytes": 312, "sha256": "…" },
  "fixtures": [{ "id": "limited-food", "version": 1, "sha256": "…" }],
  "seeds": [1, 2],
  "horizonTicks": 1800,
  "ecology": { "nutrientCycle": false, "biologicalShade": false }
}
```

- 1–4 distinct fixtures and 1–4 distinct unsigned 32-bit seeds. Trials are
  every fixture × seed pair, fixture by fixture.
- 1–3,600 ticks per trial. The issue allows 5,000, but the existing comparison
  horizon (3,600) is tighter and applies.
- At most 28,800 planned engine ticks in total, the existing seeded-batch
  budget. For example, 4 fixtures × 4 seeds × 1,800 ticks fits, and 1,801 ticks
  doesn't.
- Recipes are at most 106,496 bytes.
- The plan reports trial count, ticks per trial, total ticks and a memory
  preflight: an upper estimate for the one active trial engine (17 bytes per
  cell for every plane, plus three 2.5 MB world-size allowances), the encoded
  recipe and 2 KiB per trial endpoint, checked against a 16 MB budget. This is
  an estimate, not a measurement.
- Rejections name a problem class: `format`, `blueprint`, `unsupported` or
  `budget`.

## Trial outcomes

Each trial ends in exactly one of these states. There is no combined score.

- `horizon`: the declared tick was reached and the subject lineage is alive.
- `extinct`: no organism of the subject lineage remains. The trial stops at
  that tick.
- `blocked-initialization`: the subject, antagonist or a pellet couldn't be
  placed exactly as declared. No ticks run.
- `unsupported`: the recipe was declared under different experiment rules or
  world format. It isn't run under substitute rules. Controllers and senses
  this runtime doesn't know already fail blueprint validation.
- `cancelled`: stopped by request before its endpoint.

Each endpoint records the fixture, seed, tick, reason, whether the original
subject is alive, how many subject-lineage organisms and organisms in total are
alive, and the SHA-256 of the complete world save at that tick (`null` when no
world was built). The subject lineage starts with the subject's lineage id. A
new lineage joins it when its parent lineage, the last entry of its ancestry,
is already in it. This bookkeeping only reads organisms. It draws no random
numbers and doesn't change outcomes: a bare engine stepped from the initial
checkpoint with the same scheduled events reaches the same save hash.

Trials advance at most 12 ticks per call and yield after 8 ms, like the existing
comparison runner.
