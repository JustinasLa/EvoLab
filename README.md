# EvoLab / Drift

> A cellular ecosystem with inherited climate adaptation.

EvoLab is an open-ended cellular ecosystem. Organisms eat, grow, move, reproduce,
mutate and die in a shared world. There is no assigned fitness score: successful
lineages spread by surviving and producing descendants.

**[Enter the world](https://89.116.28.65.sslip.io/evolab/)**

## Features

- **Event bookmarks** — opt-in, bounded lineage-extinction, population-drop and first-observed-trait journals, with isolated checkpoint replay verified against original complete saves; never an inferred history or an automatic sandbox restore.

- **Living cellular organisms** — mouths, leaves, motors, stingers, armor and eyes combine into bodies that feed, compete and evolve.
- **Drifting climates** — warm and cold zones move through the habitat; temperature preference and tolerance pass to offspring and can mutate.
- **Adaptation with a tradeoff** — broad temperature tolerance costs more energy, while specialists are cheaper in favorable habitats.
- **Plant-fed food chain** — leaves produce food in neighboring free cells; there is no random food seeding or rainfall.
- **Shape the habitat** — manually paint food, build barriers, erase patches, and introduce heatwaves or cold snaps.
- **Seeded terrain** — preview Open field, Porous ridges or Chambered refuges; confirm a one-founder reset or explicitly clear/regenerate walls while protecting life and disclosing food removal.
- **Painted temperature refuges** — explicitly enable experimental warm/cool dabs that alter real climate upkeep and photosynthesis; keep inactive paint, erase temperature separately, and save bounded fields with manual provenance.
- **Painted shade habitats** — explicitly enable bounded Shade, Lighten and Erase dabs that scale real leaf energy and food production together; inspect current leaf light separately from temperature and chart measured energy gains and costs.
- **Design your own life** — draw connected organisms, choose their preferred temperature, and place them directly in the ecosystem.
- **Directional eye reactions** — start a new active design with inherited chase, flee or ignore responses to food, walls and organisms; forward sight respects body rotation, occlusion and real movement costs.
- **Optional neural controllers** — explicitly enable a small inherited network in the designer; real forward sight, energy and blocked-action feedback drive resting, movement or turning, with evaluation and action energy costs. Existing organisms retain their steering rules.
- **Inspect inherited sight** — active reactions can mutate at birth; inspect the selected organism’s actual last rays, occlusions and chosen direction with its observation tick.
- **Mutation controls** — retain legacy birth mutation by default or opt into relative weights for anatomy, climate traits, tempo and active reactions; apply drafts explicitly and save their manual history.
- **Keep inherited designs** — standalone blueprints preserve complete anatomy, traits and reactions; existing passive designs and ordinary presets retain legacy steering.
- **Inspect the survivors** — follow population, dominant lineages, anatomy, energy, offspring and recent lineage ancestry.
- **Measure ecological roles** — open Measured ecological roles to observe actual photosynthesis, food intake and stinger transfers in fixed 300-tick windows, with mixed strategies, bounded lineage/interaction tables and explicit unknown food origins. Session-only evidence resets on world replacement and is not part of world saves or measurement exports.
- **Explore at your pace** — pan, zoom, pause, single-step, and change simulation speed independently of rendering.
- **Run deliberately** — choose an exact tick target, pause or cancel it, disable habitat rendering, and observe measured throughput and honest image freshness.
- **Keep whole worlds** — save and restore terrain, every organism, counters, settings and random-generator state.
- **Compare checkpoint climates** — fork one complete world into isolated control and heatwave/cold-snap branches, apply treatment at an exact tick, compare tick-aligned population, births/deaths, traits and stress on shared axes, and export/replay bounded recipes without editing the sandbox.
- **Compare independent seeds** — run bounded single-founder batches with explicit burn-in, paired climate/shade/mutation presets, per-seed outcomes and empirical paired differences; export complete plans and checkpoints, replay completed evidence, and disclose failures, cancellation and extinction without counting replays as new replicates.

EvoLab uses an original cellular simulation and interface. It is artificial life,
not a calibrated biological model.

## Tests and coverage

With Node.js 24 or newer installed:

```sh
npm ci
npm run format:check
npm run test:coverage
npm run build
npx playwright install chromium
npm run test:browser
```

Vitest tests real ecosystem behavior, inheritance and climate stress, mutation
bounds, complete world restoration, worker controls and UI interactions. CI
requires **100% line coverage across all production TypeScript, with no file
exclusions**. Branch and statement coverage are reported separately; HTML and
LCOV reports are written to `coverage/` and uploaded by CI.

Source-attributed historical world fixtures check full-state continuation and
reversible preservation of opaque genome and cell data. Version-1 reaction tables
are tested as permanently passive metadata. Explicit active designs have separate
real-engine scenes for occlusion, deterministic ties, food acquisition, funded
reproduction, threat retreat and movement costs, plus complete blueprint/world
round trips and native designer, keyboard and local-library checks. Active birth
mutation tests cover bounded reaction transitions and real inherited differences;
selected-perception tests compare exact engine continuations with observation,
rendering and selection changes, including death and rejected imports.

Neural fixtures check bounded 6–4–4 controllers, detached birth mutation, real
energy and reproduction tradeoffs, strict world/blueprint/library persistence,
and exact worker controls. The reaction perception overlay does not trace neural
decisions; neural activity inspection is separate follow-up work. Run
`npm run bench:neural` for contextual populated-world throughput and deterministic
checkpoint continuation receipts in `.scratch/long-run/`, without timing thresholds
or claims of universal neural superiority.

Playwright exercises the built application in desktop and mobile Chromium,
including real workers, population changes, inspection, organism design, painting,
camera controls and world downloads/imports. Reports are written to
`playwright-report/` and `test-results/`. These checks do not establish biological
realism, cross-browser identity, or performance on every device.

Native sensory-data cases retain download bytes and resource receipts, exercise
populated-load resumption followed by explicit Pause, and compare exact Step
endpoints at every speed with independent engine continuations. Mobile checks
use Chromium emulation, not physical-device certification.

Checkpoint comparison checks cover same-runtime control/control identity, exact
treatment boundaries, equal bounded horizons, extinction, cancellation and
delayed-import ownership. Recipe checks cover complete checkpoint retention, strict bounds and invalid/incomplete input, observed-result verification on replay, and phone-readable measurement tables. They verify orchestration against the same ecosystem
engine, not an independent ecological implementation or a statistical claim.

The separate long-run job runs on every PR and main push, alongside the unchanged
mandatory checks above:

```sh
npm run test:soak
npm run bench:ecosystem
```

The soak corpus advances seeds 1 and 42 from one founder (42 also retains opaque
payloads) and seed 123 from a disclosed foodless mouth-only starvation fixture,
through 100,000 real ticks each. It never rescues or reseeds extinction. Population
and counters are checked every tick; full anatomy, energy/trait, identity,
occupancy and retained-history bounds are checked every 1,000 ticks and at
checkpoint boundaries. Eleven complete Save/reload checkpoints per seed each
continue 137 ticks against the uninterrupted world, including telemetry boundaries
and eviction. Receipts retain actual extinction/saturation, population traces,
complete-state hashes, source hashes, hardware/runtime and measured duration in
`.scratch/long-run/`; CI uploads them. Finite runs in one runtime do not prove
infinite stability or cross-runtime identity.

Throughput uses two warmups and five measurements per fixture, with 600 ticks
each. Empty, initially 64-organism and 1,600-organism fixtures have separate
population ranges and complete deterministic endpoints. These are direct engine
measurements with real telemetry and lineage recording; browser/worker scheduling,
rendering, varied anatomies and hardware can differ. Setup, serialization and
assertions stay outside timing, and there is no wall-clock pass/fail threshold.

The complete three-seed corpus took 430.22 seconds locally;
the separate throughput command took 5.46 seconds. This run
used Node 24.22.1, Linux x64 and an eight-logical-CPU AMD EPYC
host. Shared-host timings are contextual, not performance guarantees. The
preceding mandatory hosted job took 827 of its 900 seconds, leaving 73 seconds.
The complete corpus therefore has its own CI job. Formatting, full production-line
coverage and build run separately from the complete desktop/mobile browser suite;
the **Build and test** gate requires both jobs to succeed, including when either
fails, is cancelled or is skipped. Each workload retains a 15-minute job timeout.
The complete browser command, four workers, assertion deadlines, latency limits,
coverage discovery and thresholds remain unchanged.

## License

Copyright (c) 2026 Justinas Launikonis. Licensed under the [Artistic License 2.0](LICENSE). Third-party dependencies retain their own licenses.
