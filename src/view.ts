import {
  WIDTH,
  HEIGHT,
  COLORS,
  CELL_NAMES,
  temperature,
  type HabitatFrame,
  type WorldPresentation,
  type Genome,
  type Organism,
} from './model';
export interface Camera {
  zoom: number;
  x: number;
  y: number;
}
export interface Viewport {
  scale: number;
  left: number;
  top: number;
  width: number;
  height: number;
}
export function viewport(canvas: HTMLCanvasElement, camera: Camera): Viewport {
  const width = canvas.clientWidth || 900,
    height = canvas.clientHeight || 650;
  const scale = Math.min(width / WIDTH, height / HEIGHT) * camera.zoom;
  return {
    scale,
    left: (width - WIDTH * scale) / 2 + camera.x,
    top: (height - HEIGHT * scale) / 2 + camera.y,
    width,
    height,
  };
}
export function point(
  canvas: HTMLCanvasElement,
  camera: Camera,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const view = viewport(canvas, camera),
    cx = Math.floor((x - view.left) / view.scale),
    cy = Math.floor((y - view.top) / view.scale);
  return cx >= 0 && cx < WIDTH && cy >= 0 && cy < HEIGHT ? { x: cx, y: cy } : null;
}
export function draw(
  canvas: HTMLCanvasElement,
  buffer: HTMLCanvasElement,
  frame: HabitatFrame,
  camera: Camera,
  thermal: boolean,
  selected: number,
): void {
  const ctx = canvas.getContext('2d')!,
    b = buffer.getContext('2d')!;
  const v = viewport(canvas, camera),
    ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = v.width * ratio;
  canvas.height = v.height * ratio;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = '#090f16';
  ctx.fillRect(0, 0, v.width, v.height);
  buffer.width = WIDTH;
  buffer.height = HEIGHT;
  const pixels = b.createImageData(WIDTH, HEIGHT);
  const palette = COLORS.map((hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]);
  for (let i = 0; i < frame.cells.length; i++) {
    let color = palette[frame.cells[i]];
    if (thermal && frame.cells[i] === 0) {
      const t = temperature(
        i % WIDTH,
        Math.floor(i / WIDTH),
        frame.stats.tick,
        frame.climate,
        frame.offset,
      );
      color = [
        Math.round(9 + t * 37),
        Math.round(18 + (1 - Math.abs(t - 0.5) * 2) * 13),
        Math.round(20 + (1 - t) * 40),
      ];
    }
    const p = i * 4;
    pixels.data[p] = color[0];
    pixels.data[p + 1] = color[1];
    pixels.data[p + 2] = color[2];
    pixels.data[p + 3] = 255;
  }
  b.putImageData(pixels, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buffer, v.left, v.top, WIDTH * v.scale, HEIGHT * v.scale);
  if (selected) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < frame.ids.length; i++)
      if (frame.ids[i] === selected)
        ctx.strokeRect(
          v.left + (i % WIDTH) * v.scale - 1,
          v.top + Math.floor(i / WIDTH) * v.scale - 1,
          v.scale + 2,
          v.scale + 2,
        );
  }
  ctx.strokeStyle = '#26313a';
  ctx.lineWidth = 1;
  ctx.strokeRect(v.left - 0.5, v.top - 0.5, WIDTH * v.scale + 1, HEIGHT * v.scale + 1);
}
export function genomeSvg(genome: Genome, size = 52): string {
  const xs = genome.cells.map((c) => c.x),
    ys = genome.cells.map((c) => c.y),
    left = Math.min(...xs),
    top = Math.min(...ys),
    width = Math.max(...xs) - left + 1,
    height = Math.max(...ys) - top + 1,
    side = Math.max(width, height) + 2;
  return `<svg width="${size}" height="${size}" viewBox="${left - (side - width) / 2} ${top - (side - height) / 2} ${side} ${side}" shape-rendering="crispEdges" aria-hidden="true">${genome.cells.map((c) => `<rect x="${c.x}" y="${c.y}" width=".88" height=".88" fill="${COLORS[c.type]}"/>`).join('')}</svg>`;
}
export function organismHtml(o: Organism | null, frame: WorldPresentation): string {
  if (!o)
    return `<div class="empty-inspector">${genomeSvg(
      {
        cells: [
          { x: 0, y: 0, type: 4 },
          { x: 1, y: 0, type: 3 },
          { x: 0, y: 1, type: 5 },
        ],
        preference: 0.5,
        tolerance: 0.2,
        tempo: 3,
      },
      72,
    )}<p>Click any organism to inspect it.</p></div>`;
  const temp = temperature(o.x, o.y, frame.stats.tick, frame.climate, frame.offset);
  return `<div class="specimen-preview"><div class="anatomy">${genomeSvg(o.genome, 104)}</div><div><strong>Organism ${o.id}</strong><span>Lineage #${o.species}</span><span>Generation ${o.generation}</span></div></div><dl class="specimen-facts"><div><dt>Energy</dt><dd>${o.energy.toFixed(1)}</dd></div><div><dt>Age</dt><dd>${o.age} ticks</dd></div><div><dt>Offspring</dt><dd>${o.children}</dd></div><div><dt>Cells</dt><dd>${o.genome.cells.length}</dd></div><div><dt>Local temperature</dt><dd>${Math.round(temp * 40)}°</dd></div><div><dt>Preferred</dt><dd>${Math.round(o.genome.preference * 40)}° ±${Math.round(o.genome.tolerance * 40)}°</dd></div></dl><p class="ancestry" title="Lineage ancestry">${[...o.ancestry, o.species].map((s) => `#${s}`).join(' → ')}</p><button id="copy-organism" class="secondary wide">Edit this organism</button><button id="export-organism-blueprint" class="secondary wide">Export organism blueprint</button>`;
}
const icon = (path: string): string =>
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
const inspectIcon = icon('M2 1h7v2H2zm-2 2h2v7H0zm9 0h2v7H9zM2 10h7v2H2zm8 1h2v2h-2zm2 2h2v2h-2z'),
  panIcon = icon(
    'M7 0h2v3h2v2H9v2h2V5h2v2h3v2h-3v2h-2V9H9v2h2v2H9v3H7v-3H5v-2h2V9H5v2H3V9H0V7h3V5h2v2h2V5H5V3h2z',
  ),
  foodIcon = icon('M2 2h4v4H2zm8 1h4v4h-4zM5 10h4v4H5z'),
  wallIcon = icon('M1 1h6v6H1zm8 0h6v6H9zM1 9h6v6H1zm8 0h6v6H9z'),
  eraseIcon = icon('M7 1h5v2h2v5h-2v2h-2v2H8v2H3v-2H1V7h2V5h2V3h2zM3 8v3h2v1h2l2-2-4-4z'),
  plantIcon = icon('M6 0h4v6h6v4h-6v6H6v-6H0V6h6z');
const cellDescriptions = [
  'Eats adjacent food',
  'Uses light to produce energy and food',
  'Moves and rotates the body',
  'Drains adjacent unarmored organisms',
  'Protects the contacted cell',
  'Senses nearby food, walls and organisms',
];
export const markup = `
<main class="workspace">
  <section class="world-stage" aria-label="Living ecosystem">
    <div class="habitat"><canvas id="world" aria-label="Interactive ecosystem. Choose a tool, then click or drag in the world." tabindex="0"></canvas></div>
  </section>
  <aside class="sidebar" aria-label="Ecosystem controls">
  <header class="topbar">
  <a class="brand" href="./" aria-label="EvoLab / Drift">${genomeSvg(
    {
      cells: [
        { x: 0, y: 0, type: 4 },
        { x: 1, y: 0, type: 3 },
        { x: 0, y: 1, type: 5 },
        { x: 1, y: 1, type: 4 },
      ],
      preference: 0.5,
      tolerance: 0.2,
      tempo: 3,
    },
    32,
  )}<strong>EvoLab<span> / drift</span></strong></a>
  <div class="simulation-controls"><button id="pause" class="primary" title="Pause or resume (Space)">Ⅱ Pause</button><button id="step" disabled title="Advance one tick while paused" aria-label="Advance one tick while paused">${icon('M2 2h2v12H2zm4 0h2v2h2v2h2v4h-2v2H8v2H6z')}</button><label><span>Speed</span><select id="speed" aria-label="Simulation speed"><option value="1">1×</option><option value="4" selected>4×</option><option value="12">12×</option></select></label></div>
  <label class="extinction-preference" for="pause-on-extinction"><input id="pause-on-extinction" type="checkbox" checked aria-describedby="extinction-help"><span>Pause on extinction<small id="extinction-help">On by default; applies to this tab.</small></span></label>
  <p id="extinction-summary" role="status" aria-live="polite" hidden></p>
  <div class="render-controls"><label for="render-habitat"><input id="render-habitat" type="checkbox" checked>Render habitat</label><button id="refresh-habitat" class="secondary">Refresh habitat</button></div>
  <p id="render-pending" class="muted"></p>
  <div class="target-controls"><label for="target-tick">Absolute target tick<input id="target-tick" type="number" min="0" max="1000000000" step="1" required aria-describedby="target-help"></label><button id="run-to-tick" class="secondary">Run to tick</button><button id="cancel-target" class="secondary" disabled>Cancel target</button></div>
  <p id="target-help" class="muted">Accelerated complete ticks, yielding in bounded batches. Pause suspends; Cancel pauses and discards the target.</p>
  <progress id="target-progress" aria-label="Actual target progress" hidden></progress><p id="target-details"></p><p id="target-status" role="status" aria-live="polite"></p>
  <p id="tick-rate" class="muted">Measured ticks/s: measuring…</p><p id="habitat-freshness">No habitat received.</p>
  </header>
  <div class="panel-scroll">
  <section class="world-controls" aria-label="World tools and status">
    <div class="world-heading"><div class="world-label"><span class="live-dot"></span><span id="world-label">WORLD 0042</span><span id="run-state">LIVE</span></div><div class="zoom-controls"><button id="zoom-out" title="Zoom out">−</button><button id="fit" title="Fit world">Fit</button><button id="zoom-in" title="Zoom in">+</button></div></div>
    <div class="tool-dock" role="toolbar" aria-label="World tools"><button data-tool="inspect" aria-pressed="true" title="Inspect organism (I)">${inspectIcon}<span>Inspect</span><kbd>I</kbd></button><button data-tool="pan" aria-pressed="false" title="Pan world (H)">${panIcon}<span>Pan</span><kbd>H</kbd></button><button data-tool="food" aria-pressed="false" title="Paint nutrients (F)">${foodIcon}<span>Food</span><kbd>F</kbd></button><button data-tool="wall" aria-pressed="false" title="Paint walls (W)">${wallIcon}<span>Wall</span><kbd>W</kbd></button><button data-tool="erase" aria-pressed="false" title="Erase life and terrain (E)">${eraseIcon}<span>Erase</span><kbd>E</kbd></button><button data-tool="plant" aria-pressed="false" title="Place designed organism (P)">${plantIcon}<span>Plant</span><kbd>P</kbd></button></div>
    <div class="tool-options"><span id="tool-hint">Click an organism to inspect its cells.</span><label id="brush-control" hidden for="brush">Radius<input id="brush" type="range" min="0" max="8" step="1" value="2"><output id="brush-value">2 cells</output></label></div>
    <div class="world-bottom"><span id="tick">TICK 0</span><span id="world-count">Seeding life…</span><span class="world-size">240 × 156 cells · wrapped edges</span></div>
  </section>
  <div class="tabs" role="tablist" aria-label="Simulation panels"><button id="ecosystem-tab" data-tab="ecosystem" role="tab" aria-controls="ecosystem-panel" aria-selected="true">Ecosystem</button><button id="organism-tab" data-tab="organism" role="tab" aria-controls="organism-panel" aria-selected="false">Organism</button></div>
      <div id="ecosystem-panel" class="panel" role="tabpanel" aria-labelledby="ecosystem-tab">
        <section class="population-section"><div class="section-caption"><h2>Population now</h2><span id="generation">GEN 0</span></div><div class="population-number"><strong id="population">—</strong><span id="species-count">— lineages</span></div><dl class="vital-stats"><div><dt>Lifetime reproductive births</dt><dd id="births">0</dd></div><div><dt>Lifetime deaths (including manual)</dt><dd id="deaths">0</dd></div><div><dt>Food cells now</dt><dd id="food-count">0</dd></div></dl></section>
        <section id="telemetry" aria-labelledby="telemetry-heading"><h2 id="telemetry-heading">Recorded ecosystem observations</h2><label for="telemetry-view">Telemetry view</label><select id="telemetry-view"><option value="population">Population &amp; events</option><option value="food">Food &amp; body cells</option><option value="adaptation">Thermal adaptation</option></select><label for="telemetry-sample">Recorded sample</label><select id="telemetry-sample" disabled><option value="latest">No recorded samples</option></select><p id="telemetry-summary"></p><p id="telemetry-status" role="status" aria-live="polite"></p><div class="measurement-downloads"><button id="measurements-json" type="button">Download measurements JSON</button><button id="measurements-csv" type="button">Download measurements CSV</button></div><p>Retained worker observations only, not a complete run or replay file. CSV text cells carry a reversible s: prefix.</p><label for="telemetry-intervention">Manual intervention</label><select id="telemetry-intervention" disabled><option value="latest">No retained manual actions</option></select><p id="telemetry-intervention-summary"></p><div id="telemetry-intervention-details"></div><div id="telemetry-plots"></div><div id="telemetry-details"></div></section>
        <section class="lineage-section"><div class="section-caption"><h2>Common bodies</h2><span title="Choose a body to edit its anatomy">Click to edit</span></div><div id="lineages" class="lineages"><p class="muted">Waiting for life…</p></div></section>
        <section class="climate-section"><div class="section-caption"><h2>Climate</h2><button id="thermal" class="secondary" aria-pressed="false">Show temperature</button></div><div class="world-weather"><strong id="weather">Drifting climate</strong><span id="season">Vernal drift</span></div><div class="temperature-key"><span>0°</span><i></i><span>40°</span></div><label class="slider-label" for="climate">Climate pressure<output id="climate-value">80%</output></label><input id="climate" type="range" min="0" max="1" step="0.05" value="0.8"><div class="events"><button data-shock="cold">${icon('M7 0h2v4h2V2h2v2h-2v2H9v1h3V5h2v2h2v2h-2v2h-2V9H9v2h2v2h2v2h-2v-2H9v3H7v-3H5v2H3v-2h2v-2h2V9H4v2H2V9H0V7h2V5h2v2h3V6H5V4H3V2h2v2h2z')}Cold snap</button><button data-shock="heat">${icon('M6 0h4v2H6zM2 2h2v2H2zm10 0h2v2h-2zM4 4h8v8H4zM0 6h2v4H0zm14 0h2v4h-2zM2 12h2v2H2zm10 0h2v2h-2zm-6 2h4v2H6z')}Heatwave</button></div></section>
        <details class="world-settings"><summary>World settings</summary><label class="slider-label" for="mutation">Mutation rate<output id="mutation-value">12%</output></label><input id="mutation" type="range" min="0" max="0.4" step="0.01" value="0.12"><label class="slider-label" for="nutrients">Leaf food chance<output id="nutrients-value">5%</output></label><input id="nutrients" type="range" min="0" max="20" step="1" value="5"><label class="seed-label" for="seed">World seed<input id="seed" type="number" min="0" max="4294967295" step="1" required value="42"></label><button id="reset" class="secondary wide">Reseed world</button></details>
      </div>
      <div id="organism-panel" class="panel" role="tabpanel" aria-labelledby="organism-tab" hidden><details id="specimen-details" class="specimen-section"><summary>Selected organism</summary><div id="inspector"></div></details><section class="designer-section"><div class="section-caption"><h2>Build a body</h2><button id="clear-design" class="quiet">Reset</button></div><div id="cell-palette" class="cell-palette">${CELL_NAMES.map((name, i) => `<button data-cell="${i + 3}" aria-pressed="${i === 1}" title="${name}: ${cellDescriptions[i]}"><i style="--cell:${COLORS[i + 3]}"></i>${name}</button>`).join('')}</div><p id="cell-description" class="muted">${cellDescriptions[1]}</p><div id="editor" class="editor" aria-label="Organism anatomy editor"></div><p id="design-note" class="muted">Use 1–16 cells, connected edge to edge.</p><label class="slider-label" for="preference">Preferred temperature<output id="preference-value">20°</output></label><input id="preference" type="range" min="0" max="1" step="0.025" value="0.5">
      <div class="blueprint-fields"><label for="blueprint-name">Blueprint name</label><input id="blueprint-name" type="text" maxlength="80" required><label for="blueprint-description">Description</label><textarea id="blueprint-description" maxlength="1000" rows="3"></textarea></div>
      <div class="blueprint-actions"><button id="import-blueprint">Import blueprint</button><button id="export-blueprint">Export blueprint</button></div><input id="blueprint-file" type="file" accept="application/json,.json" hidden>
      <p class="muted">Importing edits only this design. Choose Place in world, then click the habitat to create a new organism.</p><button id="plant-design" class="primary wide">Place in world</button></section></div>
    <footer><nav aria-label="World files and help"><button id="save" title="Download this world">Save world</button><button id="load" title="Open a saved world">Load world</button><button id="help" title="How this world works">Help</button><a href="https://github.com/JustinasLa/EvoLab" target="_blank" rel="noreferrer">Source</a></nav><input id="file" type="file" accept="application/json,.json" hidden><details class="legend"><summary>Cell legend &amp; shortcuts</summary><div class="cell-legend">${CELL_NAMES.map((name, i) => `<span title="${cellDescriptions[i]}"><i style="--cell:${COLORS[i + 3]}"></i>${name}</span>`).join('')}<span><i style="--cell:${COLORS[1]}"></i>Food</span><span><i style="--cell:${COLORS[2]}"></i>Wall</span></div><p class="footer-note">Space: pause · Scroll: zoom<br>I / H / F / W / E / P: select tools</p></details></footer>
  </div>
    <p id="notice" role="status"></p>
  </aside>
</main>
<dialog id="help-dialog"><button id="close-help" class="dialog-close" aria-label="Close help">×</button><h1>EvoLab / Drift</h1><p>Organisms eat, move, reproduce, mutate, and die. Successful descendants spread through survival and reproduction.</p><p>Climate zones drift across the habitat. Each organism inherits a preferred temperature and tolerance. Wider tolerance costs energy.</p><ul><li>Inspect a body, or click a common body to edit it.</li><li>Choose Food, Wall or Erase and drag to paint.</li><li>Choose a cell type, draw a connected body, then place it in the world.</li><li>Scroll to zoom; use Pan to drag. Space pauses; I / H / F / W / E / P select tools.</li><li>Save your world before leaving. Reloading starts fresh.</li></ul><p>Pause on extinction is on by default for this tab. Your choice survives reseed and world loads; reloading restores ON. It stops at the first extinct logical tick, or immediately after manual last-organism erasure, without resetting or replenishing life.</p><p>The summary records the final removal tick and cause: energy exhaustion, age limit or manual erasure. An imported empty world's original cause is unavailable. Food, walls and charts remain. Inspect, edit, save and Step stay usable while paused; Step advances exactly one tick, even when empty. Placing an organism does not resume playback.</p><p>To run an empty world, turn off Pause on extinction and then press Resume. Turning it off alone never resumes. Rejected world files retain the current world and playback; their display refresh adds no chart samples.</p><p>Render habitat controls automatic snapshots, not evolution or telemetry. Off/hidden images can be stale; explicit visible Refresh and paused editing/Step/inspection can request one current image. Run to tick accelerates yielding batches, not logical ticks. Pause suspends a target; Cancel pauses and discards it. Measured ticks/s counts actual completed ticks over monotonic elapsed time, including scheduling. Speed is ticks per batch, not ticks/s. Hidden tabs may be throttled, suspended or discarded. A costly complete tick cannot be interrupted; timing gaps are unknown and never subtracted. Throughput depends on this machine and browser.</p><p class="muted">An original cellular simulation; temperature uses an abstract 0–40° scale, not a biological model.</p></dialog>`;
