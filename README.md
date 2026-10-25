# EvoLab

> Give life a few joints and see what happens.

EvoLab is a browser playground where strange little creatures evolve their own
bodies and movement. Start an experiment, watch the survivors learn to tumble,
crawl, or occasionally walk, then change the world and see what adapts.

## Features

- **Physical creatures** — rigid body segments and motor-driven joints move through a real 2D physics simulation; there are no walking animations.
- **Evolving bodies and movement** — limb counts, proportions, joint angles, strength, and movement rhythms mutate between generations.
- **Three habitats** — a flat meadow, low steps, and separated platforms challenge different ways of moving.
- **Your own experiments** — adjust gravity, mutation, population size, and the random seed, then begin a fresh run.
- **Champion replays** — watch complete trials while evolution runs in the background, change replay speed, and revisit the last eight generations.
- **Portable survivors** — save a champion as JSON and load it later to found a new population.
- **A visible learning curve** — compare the best and median fitness over the latest 240 generations.
- **Runs in your browser** — no account, server-side simulation, telemetry, or runtime service is required; fonts are bundled locally.

## Documentation

[Project documentation](docs/README.md)

Technical documentation is maintained in this repository's [docs](docs/README.md)
folder, using the TF-Minecraft project-guide structure.

## Tests and coverage

With Node.js 24 or newer installed:

```sh
npm ci
npm run test:coverage
npm run build
npx playwright install chromium
npm run test:browser
```

Vitest runs real Planck physics trials, seeded evolution, mutation and import
validation, worker lifecycle tests, and UI tests with a mocked canvas. CI enforces
**100% line coverage across every production TypeScript file, with no file
exclusions**. Branch and statement coverage are reported separately. Coverage
reports are written to `coverage/` and uploaded by CI.

Playwright checks the built application in desktop and mobile Chromium, including
real worker evaluation, animated canvas replays, pause/resume, habitat changes,
champion downloads and imports, layout overflow, and absence of external network
requests. Its reports are written to `playwright-report/` and `test-results/`.
These checks do not establish cross-browser physics identity, biological realism,
or performance on every device. See [testing](docs/testing.md) for scope and limits.

## License

Copyright (c) 2026 Justinas Launikonis. Licensed under the [Artistic License 2.0](LICENSE). Third-party dependencies retain their own licenses.
