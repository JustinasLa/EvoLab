# Testing and verification

[Project index](README.md)

## Commands

```sh
npm ci
npm run format:check
npm run test:coverage
npm run build
npx playwright install chromium
npm run test:browser
```

CI runs Ubuntu 24.04, Node 24 and the committed lockfile. TypeScript checking runs
before the Vite production build. V8 coverage includes all production
`src/**/*.ts` files and enforces 100% executable-line coverage without file
exclusions. Statement and branch coverage are reported separately. Reports are
written to `coverage/` and uploaded by CI.

## Behavior checks

- Real ecosystem updates exercise feeding, photosynthesis, starvation, aging,
  movement, sensors, predation, armor and reproduction.
- Mutation repeatedly checks connected anatomy and bounded inherited traits.
- Climate checks compare adapted versus mismatched organisms and the upkeep cost
  of broad tolerance, and verify event expiry without generating food.
- Food tests verify empty starting terrain, conversion of every dead body cell
  into food across rotations and wrapped edges, no random food scattering, local
  leaf production, wall and organism exclusion, disabling leaf production,
  eraser behavior, and preservation of food in imported saves.
- Seeded worlds match one another. Export/import tests restore complete state and
  check that both copies continue identically, including RNG and update order.
- New worlds and worker restarts begin with one founder, one lineage and zero
  births. Multiple seeds verify a clear central footprint; saved worlds with
  multiple organisms retain their full population when restored.
- Persistence rejects huge files, malformed versions, bad terrain, invalid anatomy,
  duplicate organism IDs and overlapping bodies.
- Worker tests cover pause, resume, single-step, speed, edits, inspection, errors,
  and failed-import recovery with no duplicate evaluation loop.
- UI tests exercise design, bounded history, tool selection, camera coordinates,
  shortcuts, help, import/export, stale messages and disposal. Canvas is a stand-in
  in these unit tests; visual correctness needs a real browser.

The earlier locomotion-trial implementation and its tests were retired together.
The coverage gate remains unchanged for the replacement ecosystem implementation.

## Browser checks

Playwright serves the production `dist/` build and exercises desktop and
mobile-sized Chromium (1280 × 800 desktop and iPhone 13 portrait). It runs actual workers and Canvas, verifies births, pause
and single-step availability, contextual brush controls, cell descriptions, climate events, inspection and anatomy copying, planting, food
and wall painting, erasure, camera controls, reseeding, help, keyboard shortcuts,
complete world downloads/imports and invalid-file recovery. The primary workflow
checks for page errors, external requests and horizontal page overflow.

Reports are written to `playwright-report/` and `test-results/`. CI uploads browser
reports, coverage and the static application. These checks do not prove biological
realism, Safari/Firefox support, infinite-run stability, cross-runtime bitwise
identity, or a fixed performance capacity.

## Repository workflow

Open feature PRs against protected `main`. The branch requires a PR, linear
history and squash merging, and rejects deletion and force pushes. Push logical
milestones regularly; use draft PRs while verification is incomplete. A repository-local
PR-size workflow labels changes. Update project guides with behavior changes;
keep raw logs and session captures in ignored `.scratch/` or PR discussion.
