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
- **Shape the habitat** — paint nutrients, build barriers, erase patches, and introduce blooms, heatwaves or cold snaps.
- **Design your own life** — draw connected organisms, choose their preferred temperature, and place them directly in the ecosystem.
- **Inspect the survivors** — follow population, dominant lineages, anatomy, energy, offspring and recent lineage ancestry.
- **Explore at your pace** — pan, zoom, pause, single-step, and change simulation speed independently of rendering.
- **Keep whole worlds** — save and restore terrain, every organism, counters, settings and random-generator state.

Inspired by [The Life Engine](https://thelifeengine.net/). EvoLab's implementation
and interface are original; no upstream code or assets are copied.

## Documentation

[Project documentation](docs/README.md)

Technical documentation is maintained in this repository's [docs](docs/README.md)
folder.

## Tests and coverage

With Node.js 24 or newer installed:

```sh
npm ci
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

Playwright exercises the built application in desktop and mobile Chromium,
including real workers, population changes, inspection, organism design, painting,
camera controls and world downloads/imports. Reports are written to
`playwright-report/` and `test-results/`. These checks do not establish biological
realism, cross-browser identity, or performance on every device. See
[testing](docs/testing.md) for scope and limits.

## License

Copyright (c) 2026 Justinas Launikonis. Licensed under the [Artistic License 2.0](LICENSE). Third-party dependencies retain their own licenses.
