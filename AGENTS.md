# EvoLab

## Project

A standalone browser evolution sandbox. Read `docs/README.md`,
`docs/evolution.md`, and `docs/architecture.md` before changing simulation behavior.
Do not connect this project to TF production services or copy private assets.

## Implementation

- Use strict TypeScript and the current pinned Planck/Vite toolchain.
- Keep physics deterministic within a runtime: seeded randomness and fixed steps.
- Keep expensive evaluation in the worker; yielding, pause, restart and stale-run
  message rejection must remain correct.
- Validate champion imports before constructing physics bodies. Preserve bounded
  topology, numeric ranges, recordings and chart history.
- Keep the product focused on experimentation. Describe scores and limitations
  honestly; a unit test is not evidence of biological realism or device capacity.

## Verification

Run `npm run test:coverage`, `npm run build`, and `npm run test:browser`.
CI enforces 100% line coverage across all production TypeScript, with no file
exclusions. Do not weaken thresholds, skip tests, or substitute mocked physics
for real physics tests to get a change through. Browser checks use the built app.
Test meaningful behavior, failure paths and lifecycle boundaries.

## Documentation and Git

Keep the README short: title and tagline, player-facing introduction, Features,
Documentation, Tests and coverage, then License last. Feature bullets use
`**Name** — description.` Technical details belong in `docs/`, not extra root
manuals. Update the relevant guides when behavior changes. Do not commit temporary
captures, raw logs, coverage output or implementation diaries.

Use feature branches and squash PRs against protected `main`. Keep linear history;
do not bypass protection or force-push main. Keep agent/vendor branding, generated
by footers, and assistant attribution out of source, documentation, commits, and
PR descriptions. Preserve actual upstream attribution and license notices.
