# Setup and operation

[Project index](README.md)

## Play

Open the [live preview](https://89.116.28.65.sslip.io/evolab/) in a current browser.
Evolution starts immediately with one central creature. Every tab runs an
independent world locally; it does not share organism state with other visitors.

- Inspect an organism to open its anatomy, energy, temperature preference and ancestry.
- Copy an inspected organism or click a body in **Common bodies** to open the designer, edit its
  connected body, choose a preferred temperature, and select **Place in world**.
- Paint food, walls or erasure with the toolbar. Brush radius appears beside the active tool.
  Erasing any part of an organism removes its whole body.
- Pan with the Pan tool, scroll to zoom, and use Fit to restore the camera.
- Pause, then single-step, to inspect state changes closely. The step control is
  disabled while the world is running.
- Toggle temperature view and introduce cold snaps, heatwaves or nutrient blooms.
- Mutation, nutrient rain and climate pressure settings apply immediately.
  Reseeding replaces the world with a fresh one-creature start using the selected seed/settings.
- Save a world before leaving; reloading otherwise starts from seed 42 again.

Keyboard shortcuts: Space pauses/resumes; I inspects; H pans; F paints food; W
paints walls; E erases; P plants the current design. Shortcuts are inactive while
typing in an input or while help is open. Camera and UI state are not saved.

## Local development

Requires Node.js 24+, npm, and a current browser with module workers, typed arrays,
Canvas 2D, dialogs and `structuredClone`.

```sh
git clone https://github.com/JustinasLa/EvoLab.git
cd EvoLab
npm ci
npm run dev
```

Open the printed URL, normally `http://localhost:5173`. Development and preview
scripts bind to all interfaces. Append `-- --host 127.0.0.1` for loopback only.

```sh
npm run build
npm run preview
```

The complete static application is in `dist/`, including fonts and worker code.
Serve it over HTTP/HTTPS. Relative asset paths support subdirectory hosting.
Do not open the build with `file://`: module workers require a web origin.
CI uploads the static build as `evolab-web`.

## Host preview

The server preview uses an isolated user service serving only a static build,
with the existing HTTPS proxy routing `/evolab/` to its loopback listener. The
shared root site is a separate route. Runtime deployment state is local to the
preview host and is not committed. A feature branch can be previewed before its
PR merges; check the PR for the proposed source.

## Limits and troubleshooting

- World saves are version 2 and at most 2.5 MB. Older champion exports are not
  cellular ecosystems and are rejected.
- A paused world still accepts editing and inspection. Resume to see ecological
  consequences play out. A single step is available only while paused.
- Reduced population or extinction can be a real outcome. Introduce food, place
  an organism, reduce climate pressure, or reseed to try another scenario.
- Simulation is CPU work in a background worker. Pause before leaving a run in a
  background tab. No fixed tick-throughput claim is made for every device.
- A worker failure is shown in the sidebar. Reload if the worker cannot recover.
- Use `npm run format` before committing and `npm run format:check` to verify.
