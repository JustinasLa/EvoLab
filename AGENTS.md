# EvoLab / Drift

## Project

An original cellular ecosystem inspired by The Life Engine, with drifting climate
and inherited temperature adaptation. Read `docs/README.md`, `docs/evolution.md`
and `docs/architecture.md` before changing behavior. Keep unrelated production
services and private assets out of this standalone project.

## Implementation

- Use strict TypeScript and the pinned Vite toolchain. The engine is cellular;
  the retired locomotion evaluator and rigid-body library must not return.
- Keep engine logic in the worker, seeded random state and fixed logical ticks.
  Preserve yielding, pause, single-step and stale-run message rejection.
- Validate imported worlds completely before replacement. Preserve bounded
  topology, IDs, coordinates, population, ancestry and chart history.
- Let survival and reproduction drive selection. Climate adaptation must affect
  real energy and reproduction; do not manufacture winners or metric changes.
- Keep view transforms separate from ecosystem state. Use the same transform
  for drawing and pointer coordinates. Pause must still permit editing/inspection.
- Describe limitations honestly: this is artificial life, not a biological model.

## Verification

Run `npm run format:check`, `npm run test:coverage`, `npm run build` and
`npm run test:browser`. CI requires 100% production TypeScript line coverage with
no file exclusions. Do not weaken thresholds, skip checks, or replace real
engine behavior tests with mocks. Browser checks use the built application.
Retire tests only when their feature is intentionally retired; replace their
behavior coverage for the current system.

## Documentation and Git

Keep README order: title/tagline and introduction, Features, optional short
context, Documentation, Tests and coverage, License last. Feature bullets use
`**Name** — description.` Technical manuals belong in `docs/`. Update them with
behavior changes. Keep logs, temporary captures and diaries out of maintained
source; use ignored `.scratch/` for session artifacts.

Commit and push logical milestones regularly; open a draft PR early. Use feature
branches and squash PRs against protected `main`. Do not bypass protection or
force-push main. Keep agent/vendor branding, generated-by footers and assistant
attribution out of product content, documentation, commits and PR descriptions.
Preserve actual upstream attribution and license notices.
