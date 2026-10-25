# Setup and operation

[Project index](README.md)

## Requirements

- Node.js 24 or newer and npm. CI uses Node 24.
- A current browser with ES modules, module workers, Canvas 2D, `roundRect`, and
  `structuredClone`. No GPU compute or model downloads are required.

## Local development

```sh
git clone https://github.com/JustinasLa/EvoLab.git
cd EvoLab
npm ci
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. The development
and preview commands bind to all network interfaces so other devices can reach
them when the host's network permits it. For loopback only, append
`-- --host 127.0.0.1`.

## Build and serve

```sh
npm run build
npm run preview
```

`dist/` is a complete static build including the simulation worker and fonts.
Deploy its contents to a static web host. Vite uses relative asset paths, so
subdirectory hosting works. Serve over HTTP or HTTPS; opening `index.html` with
`file://` will not load the module worker reliably. The preview server is for
local checks, not a managed production service.

No hosting deployment is configured. CI uploads the built application as an
artifact; download and extract it, then serve the extracted directory over HTTP.

## Using the lab

The first experiment starts automatically with seed 42, 24 creatures, Earth
gravity, the meadow, and an 18% mutation probability per mutable parameter.

1. Watch the selected champion's eight-second trial. Its replay continues while
   the next generation is evaluated in a background worker.
2. Pause evolution to stop evaluating new candidates. Replay animation continues.
   Replay speed changes playback only; it does not alter trial physics.
3. Click a survivor to revisit a recent generation. **Follow latest** returns to
   automatic champion selection, which changes at replay boundaries.
4. Adjust habitat, gravity, mutation, population, or seed. These are pending
   values until **Begin new experiment** is pressed. Restarting clears history.
5. Save the selected champion to JSON. Loading a champion restores its experiment
   settings and starts a new population containing that creature and mutated
   descendants. It does not restore the old generation counter or full population.

Reloading the page starts over. There is no automatic persistence; export a
champion before closing a run you care about. At most eight champion recordings
and 240 chart entries are retained. A manually selected older replay remains
available until another replay is selected or the experiment restarts.

## Troubleshooting

- **Experiment stopped:** reload the page. A worker or physics failure is shown
  beside the file controls. Ensure scripts and workers are allowed by your host's
  content policy and serve the complete build from the same origin.
- **Slow generations:** reduce population to 12. Evaluation is CPU work in one
  worker; it can continue while the tab is in the background. Pause when finished.
- **A creature barely moves:** try another seed or allow more generations.
  Evolution is stochastic; no particular gait or target score is guaranteed.
- **An import is rejected:** use an exported version-1 champion, at most 32 KB.
  Arbitrary JSON, invalid topology, or unbounded motor values are not accepted.
