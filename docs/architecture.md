# Architecture

[Project index](README.md)

## Modules

| File               | Responsibility                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/model.ts`     | Types, settings, seeded random numbers, genome generation and mutation, strict champion import validation |
| `src/physics.ts`   | Course geometry, physical construction, fixed-step trials, fitness and recorded poses                     |
| `src/evolution.ts` | Population initialization, ranking, elite selection and offspring                                         |
| `src/worker.ts`    | One background evaluation loop, yielding after every creature                                             |
| `src/view.ts`      | Interface markup, scene rendering, and fitness chart                                                      |
| `src/main.ts`      | Controls, run lifecycle, messages, replay selection, and file operations                                  |

TypeScript is checked in strict mode. Vite creates separate page and worker
bundles. Planck runs in the worker at runtime; the main thread draws recorded
body positions at animation-frame cadence. No physics simulation runs in the
render loop.

## Message lifecycle

The page sends `start` with validated settings, an optional validated founder,
and an increasing run ID. `pause` and `resume` control evaluation. The worker
posts progress after each candidate and a generation result after selection.
Every response carries its run ID so stale messages cannot populate a restarted
experiment.

Evaluation yields through a timer after each candidate, allowing control messages
to be processed. Pausing takes effect after the current candidate finishes.
Repeated resumes share one queued callback. A caught evaluation exception stops
the loop and reports its message; a browser worker error is also shown in the UI.

Fitness-only candidate evaluations do not record frames. Only the champion is
re-evaluated for a recording, with a pose every third physics step (20 fps).
Playback consumes these poses; a new generation never cuts a replay short.

## Bounded state and files

The page retains eight recent generation champions and 240 chart points. Chart
entries omit recordings. A selected replay can outlive the recent archive until
selection changes. The worker replaces its candidate results and population every
generation. Workers are terminated when their view is disposed.

Champion JSON has version `1`, settings, and one genome. Imports validate size,
version, setting ranges, identifiers, topology, and every motor/body number.
Imported values never become HTML. A load begins a fresh experiment; this is not a
full simulation checkpoint.

The application stores no browser database, cookies, or analytics. Downloads are
explicitly requested. All runtime assets, including fonts, are served locally.

## Extending the simulation

Change body/controller rules in `model.ts` and physical construction together.
Keep imported ranges in sync with mutation bounds. Changes to fitness, evaluation
duration, or physics versions can invalidate score comparisons; treat old
champions as new founders rather than carrying forward old scores. If changing
the portable file format, introduce an explicit version and conversion policy.
