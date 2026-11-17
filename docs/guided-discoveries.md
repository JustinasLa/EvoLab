# Guided-discovery recipes

EvoLab / Drift ships a fixed catalog of three question-led investigations
(`src/discovery-catalog.ts`). Each recipe declares its starting worlds, seed,
settings, intervention tick, horizon and the measurements it reports. The
recipes use existing ecology and existing experiment interventions only. They
add no ecological rule, and this release has no navigation UI. They never
replace, edit or advance the sandbox world.

Each recipe is a deterministic fixed-seed illustration. It is not evidence
across independent runs and does not name a winning design. Use the independent
seed batches before generalizing.

## The three recipes

| Recipe                      | Question                                                                                | Branches (start, intervention)                                                            | Intervention tick | Horizon |
| --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------- | ------- |
| `climate-shock-specialists` | Which temperature preferences and tolerances remain among producers after a heatwave?   | `control` (thermal-mix, none); `heatwave` (thermal-mix, +0.32 heat for 900 ticks)          | 600               | 2400    |
| `armor-stinger-contact`     | Do grazers with an extra armor cell keep a larger grazer share when stingers are present? | `with-stingers` (stingers, none); `without-stingers` (no-stingers, none)                  | 0 (no event)      | 1200    |
| `leaf-mouth-shade`          | How do producers, mouth-only grazers and food respond when central producers are shaded? | `control` (producers-grazers, none); `shade` (producers-grazers, full shade disk r=8)     | 300               | 1800    |

All three use seed 42, an open field, mutation 0.12, nutrients 5 and climate
0.8. The finite nutrient cycle, biological shade, refuges, painted shade and
mutation weights start disabled. A starting world is built from an empty world
by painting the declared food disks and then placing the declared passive
legacy designs. Placement uses the engine's own `spawn`. The armor recipe
compares two starting states that differ only by two stinger predators, so it
applies no event; its declared intervention tick is 0.

### Recorded fixed-seed endpoints

These come from the real engine (Node.js 24, V8) and are pinned with hashes in
`src/discovery-evidence.ts`.

- **Heatwave:** the control ends with 26 producers, mean preference 0.58 and
  mean tolerance 0.20. The heatwave branch falls to 2 producers by tick 1800.
  Both carry preference 0.7 and tolerance 0.45, the warm, broadly tolerant
  founder design.
- **Armor:** at tick 300, 5 of 23 grazers carry armor with stingers present
  and 6 of 27 without. Both branches have lost them by tick 600. The final counts are 1 of 13
  grazers with stingers and 0 of 2 without. In this seed, armor shows no
  lasting advantage; mutation also produces stingers in the predator-free
  branch.
- **Shade:** the control ends with 87 leaf bearers and 48 grazers. In the
  shaded branch the grazers die out by tick 1200 while producers outside the
  disc recover to 28.

## Measurements

`observeDiscovery(world)` reads one tick-aligned observation. It reads only and
draws no random numbers.

- `population`, `births`, `deaths` and `food`.
- `meanPreference`, `meanTolerance` and `stressedFraction`, the same values the
  checkpoint comparison samples.
- `leafBearers`: organisms with at least one leaf cell.
- `grazers`: organisms with a mouth but no leaf or stinger.
- `armoredGrazers`: grazers that carry armor.
- `stingerBearers`: organisms with at least one stinger cell.

Samples are taken every 30 ticks plus the horizon, as in checkpoint comparisons.
An intervention applies when a branch is at the intervention tick, before that
tick's step. This matches `createComparison`. The tests check that shared-start
recipes produce the same final checkpoints and samples through that existing
code path.

## Format, bounds and validation

`validateDiscoveryRecipe` is a pure structural validator, and
`readDiscoveryRecipe` parses text first. Format `evolab-drift-discovery`
version 1 requires:

- exact fields, a slug ID, a revision, and bounded title, question, controls,
  outcomes and limitations;
- rules provenance (`evolab-drift-cellular`, experiment rules version and world
  version);
- one or two starting states and one or two distinct branches, with every
  starting state used;
- the recipe seed in every starting state's settings;
- at most 8 food disks (radius 1–16), at most 6 complete passive legacy designs
  (no active reactions, neural controllers or optional traits) and at most 32
  placements;
- a horizon of at most 3600 ticks (the comparison limit, stricter than the
  10,000-tick discovery cap), with the intervention tick before the horizon;
- at most 64 KiB of recipe JSON.

Each starting state records its tick (0), population, UTF-8 byte length and
SHA-256. Each branch records a reference from the real engine: runtime, sample
count, the SHA-256 of all samples, the endpoint observation, any extinction
(tick and age/energy cause) and the SHA-256 of the final checkpoint.

`buildDiscoveryStart` rebuilds a starting state in a fresh engine. It rejects
the result unless the bytes, SHA-256 and population match the record and the
checkpoint reloads completely. `discoveryBudget` preflights one session: two
engines, up to 2 × 3600 engine ticks, 2 × 121 samples, and the recipe plus its
starting checkpoints plus two 2.5 MB final checkpoints. That total must stay
within the existing experiment recipe limit of about 15.2 MB.

The catalog holds exactly three recipes and is deeply frozen.
`validateDiscoveryCatalog` enforces the count and unique IDs.

## Legitimate outcomes

`classifyDiscoveryBranch` reports one of:

- `completed`: the branch reached its horizon with living organisms.
- `extinct`: every organism died. Evidence is kept, and there is no rescue.
- `incomplete`: the branch stopped before its horizon, for example after
  cancellation.
- `unsupported-rules`: the recipe was recorded for different experiment rules
  or a different world version. It is not built or run.
- `missing-evidence`: samples are absent, misaligned or inconsistent. Nothing is
  inferred.

## Regenerating evidence

A change to the ecosystem rules or the world version makes the catalog report
`unsupported-rules`, and the endpoint tests fail. After such a change, update
`RULES` in the catalog, bump each recipe `revision`, and run:

```sh
EVOLAB_REGENERATE_DISCOVERY=1 npx vitest run test/discovery-recipes.test.ts
npx prettier --write src/discovery-evidence.ts
```

## Limitations

This is artificial life, not a biological model. One seed in one runtime shows
what can happen; it does not establish frequencies, causes or cross-runtime
identity. Mutation changes anatomy and traits during every run, so anatomy
counts describe the living organisms, not fixed lineages.
