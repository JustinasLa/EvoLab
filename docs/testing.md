# Testing and verification

[Project index](README.md)

## Commands

```sh
npm ci
npm run test:coverage
npm run build
npx playwright install chromium
npm run test:browser
```

CI uses Ubuntu 24.04, Node 24, the committed npm lockfile, and Chromium installed
by the pinned Playwright package. The build runs TypeScript checking before Vite.

## Unit and integration scope

Vitest's V8 report includes every `src/**/*.ts` file. A global 100% executable-line
threshold is enforced without source-file exclusions. Statement, branch and
function coverage are reported but have no separate threshold. Tests live in
`test/`; coverage HTML, LCOV and JSON summaries are in `coverage/`.

- Real Planck trials check repeatability, motion, motor work, recording, gravity,
  and each terrain type.
- A seeded multi-generation run checks improving fitness and unchanged elites.
  It is a regression fixture, not a promise that every seed improves quickly.
- Repeated mutations validate body topology and numeric ranges through the same
  portable-file contract used by real imports.
- Worker tests exercise yielding, duplicate-resume prevention, pause, restart,
  and evaluation failures with real population evaluation where appropriate.
- UI tests check pending versus active settings, bounded history, uninterrupted
  replay selection, stale-response rejection, file operations, errors and cleanup.
  Their canvas context is a stand-in; they do not establish visual correctness.

## Real browser checks

Playwright serves the production `dist/` build, not the development source. Desktop
and mobile-sized Chromium runs exercise real module workers and Canvas 2D,
generation advancement, animated replay while paused, file downloads and imports,
settings changes, and horizontal layout bounds. The initial workflow also fails
on page errors or requests to external origins.

Reports are written to `playwright-report/`; traces on failure are in
`test-results/`. CI uploads these reports, unit coverage, and the static build.

The checks do not verify Safari or Firefox, physical mobile-device performance,
cross-runtime floating-point identity, unlimited-run stability, or biological
validity. No fixed generations-per-second or target fitness claim is made.

## Repository workflow

Work on a branch and open a pull request against `main`. The main-branch rules
require a PR, linear history, and squash merging, and reject branch deletion and
force pushes. CI should pass before merging. Update the project guides when
behavior changes; keep implementation diaries and raw output out of maintained
documentation. PR size labels use the shared TF-Minecraft action.
