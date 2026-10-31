# EvoLab / Drift

> A cellular ecosystem with inherited climate adaptation.

EvoLab is an open-ended cellular ecosystem. Organisms eat, grow, move, reproduce,
mutate and die in a shared world. There is no assigned fitness score: successful
lineages spread by surviving and producing descendants.

**[Enter the world](https://89.116.28.65.sslip.io/evolab/)**

## Features

- **Living cellular organisms** — mouths, leaves, motors, stingers, armor and eyes combine into bodies that feed, compete and evolve.
- **Drifting climates** — warm and cold zones move through the habitat; temperature preference and tolerance pass to offspring and can mutate.
- **Adaptation with a tradeoff** — broad temperature tolerance costs more energy, while specialists are cheaper in favorable habitats.
- **Plant-fed food chain** — leaves produce food in neighboring free cells; there is no random food seeding or rainfall.
- **Shape the habitat** — manually paint food, build barriers, erase patches, and introduce heatwaves or cold snaps.
- **Seeded terrain** — preview Open field, Porous ridges or Chambered refuges; confirm a one-founder reset or explicitly clear/regenerate walls while protecting life and disclosing food removal.
- **Painted temperature refuges** — explicitly enable experimental warm/cool dabs that alter real climate upkeep and photosynthesis; keep inactive paint, erase temperature separately, and save bounded fields with manual provenance.
- **Design your own life** — draw connected organisms, choose their preferred temperature, and place them directly in the ecosystem.
- **Keep inherited designs** — standalone blueprints preserve complete anatomy, traits and stored reactions; reaction metadata is inactive and all steering still uses legacy rules.
- **Inspect the survivors** — follow population, dominant lineages, anatomy, energy, offspring and recent lineage ancestry.
- **Explore at your pace** — pan, zoom, pause, single-step, and change simulation speed independently of rendering.
- **Run deliberately** — choose an exact tick target, pause or cancel it, disable habitat rendering, and observe measured throughput and honest image freshness.
- **Keep whole worlds** — save and restore terrain, every organism, counters, settings and random-generator state.

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
reversible preservation of opaque genome and cell data. Stored reaction tables
are tested as permanently passive metadata, including inheritance and complete
blueprint/world round trips; no new perception or steering is enabled.

Playwright exercises the built application in desktop and mobile Chromium,
including real workers, population changes, inspection, organism design, painting,
camera controls and world downloads/imports. Reports are written to
`playwright-report/` and `test-results/`. These checks do not establish biological
realism, cross-browser identity, or performance on every device.

Native sensory-data cases retain download bytes and resource receipts, exercise
populated-load resumption followed by explicit Pause, and compare exact Step
endpoints at every speed with independent engine continuations. Mobile checks
use Chromium emulation, not physical-device certification.

## License

Copyright (c) 2026 Justinas Launikonis. Licensed under the [Artistic License 2.0](LICENSE). Third-party dependencies retain their own licenses.
