# Architecture

[Project index](README.md)

## Modules

| File               | Responsibility                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `src/model.ts`     | Types, bounded genomes, connectivity, seeded random numbers, mutation and climate           |
| `src/ecosystem.ts` | Occupancy, feeding, movement, birth/death, climate pressure, painting and world persistence |
| `src/worker.ts`    | One yielding simulation loop, commands, snapshots, saves and inspection                     |
| `src/view.ts`      | Interface markup, pixel rendering, camera transforms, anatomy previews and charts           |
| `src/main.ts`      | Pointer/keyboard controls, designer, file operations, frame display and worker lifecycle    |

Strict TypeScript is built with Vite into separate page and worker bundles. The
engine uses a logical cellular grid, with no rigid-body physics library or model
service. Typed arrays store food, walls and occupied organism IDs. A map stores
living organisms in a stable update order.

## Simulation and rendering

The worker advances 1, 4 or 12 logical ticks per scheduled batch, yielding between
batches. Speed labels are tick multipliers; their wall-clock throughput depends
on the machine. The renderer consumes snapshots independently of simulation
speed, drawing only when something changes.

A snapshot contains functional-cell colors, occupant IDs, climate state, aggregate
statistics, five dominant lineages, and the selected organism if alive. The pixel
and ID buffers are transferred to the page. Background evaluation never calls
Canvas APIs. Rendering uses a small offscreen pixel buffer enlarged with nearest
neighbor sampling, preserving crisp cellular shapes at every zoom.

The page rejects messages from stale run IDs after a reset or import. Repeated
resume commands share one pending callback. Pause takes effect after the current
batch; inspection, painting and environmental changes still work while paused.
Single-step advances exactly one logical tick while paused. A failed import
retains the existing world and reports an error.

The camera is local view state. Pointer positions are converted through the same
scale and offset used for drawing. Changing zoom, panning, or inspecting never
changes the engine state. The anatomy designer validates connected structure and
numeric limits before placement.

## Interface

The habitat is the main workspace. Tool controls sit outside the drawing area,
so they do not obscure organisms or intercept painting. Painting exposes radius
controls in the tool strip; inspection, pan and planting show their own short
instruction. Playback and world files remain in the top bar.

The interface adapts the Even Hub companion-app hierarchy: 12 px screen margins,
16 px card insets, 6 px card and control radii, segmented tabs and tools, and
separate cards for population, bodies, climate and settings. EvoLab retains its
existing dark surfaces, lime accent, functional-cell colors and original pixel
icons. Rounded UI containers do not round the habitat cells or anatomy editor.
The type hierarchy uses a local Arial/Helvetica/system sans-serif fallback;
FK Grotesk Neue is not bundled or implied. DM Mono remains on world IDs, tick
readouts and slider values. No runtime font service is used.

Body previews fit their connected anatomy into the available space instead of reserving a fixed
nine-cell canvas. Common bodies can be copied directly into the designer. Clicking
an organism opens its inspector; copying its anatomy folds the inspector away to
make room for the connected-body editor. Placing a design brings the habitat back
into view, including on phones.

On desktop the control panel scrolls independently. On phones it follows the
habitat; the habitat keeps the world's aspect ratio without empty vertical bands.
The UI does not add a marketing header or explanatory cards around the simulation.

## World saves

Version-2 JSON contains settings, counters, random state, active climate event,
food, walls and complete living-organism records. Imports are limited to 2.5 MB.
Validation rejects invalid coordinates, topology, duplicate IDs, collisions,
invalid versions, unbounded arrays, or invalid numeric fields before replacing
the running world. Food under an imported wall is normalized away.

Saved worlds are explicit downloads; there is no automatic browser persistence.
The population limit is 1,600, the anatomy limit is 16 cells, ancestry retains eight
lineage transitions, chart history retains 180 samples, and the sidebar lists five
dominant lineages. Extinct lineages are not retained in a global unbounded log.

All runtime assets and fonts are served by the same origin. There are no accounts,
analytics or runtime external requests. Saving sends no world data to a server.
