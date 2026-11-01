import {
  WIDTH,
  HEIGHT,
  LIMIT,
  positions,
  cloneGenome,
  COLORS,
  CELL_NAMES,
  type HabitatFrame,
  type Frame,
  type WorldPresentation,
  type Genome,
  type Organism,
} from './model';
import { selectedLeafLight } from './shade';
import { activeRefugeUnits, localTemperature } from './refuges';
export interface Camera {
  wrapped?: boolean;
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
  if (camera.wrapped)
    return { x: ((cx % WIDTH) + WIDTH) % WIDTH, y: ((cy % HEIGHT) + HEIGHT) % HEIGHT };
  return cx >= 0 && cx < WIDTH && cy >= 0 && cy < HEIGHT ? { x: cx, y: cy } : null;
}
export function transformDesign(genome: Genome, action: 'rotate' | 'mirror'): Genome {
  const transformed = cloneGenome(genome);
  for (const cell of transformed.cells) {
    const { x, y } = cell;
    [cell.x, cell.y] = action === 'rotate' ? [-y, x] : [-x, y];
  }
  return transformed;
}
export interface PlacementGhost {
  positions: number[];
  blocked: boolean;
}
export function placementGhost(
  frame: HabitatFrame,
  genome: Genome,
  x: number,
  y: number,
): PlacementGhost {
  const footprint = positions({ genome, x, y, rotation: 0 });
  return {
    positions: footprint,
    blocked:
      frame.stats.population >= LIMIT ||
      footprint.some((i) => frame.cells[i] === 2 || frame.ids[i] !== 0),
  };
}
export function draw(
  canvas: HTMLCanvasElement,
  buffer: HTMLCanvasElement,
  frame: HabitatFrame,
  camera: Camera,
  thermal: boolean,
  selected: number,
  ghost?: PlacementGhost,
  highlighted: ReadonlySet<number> = new Set(),
  light = false,
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
      const t = localTemperature(
        i % WIDTH,
        Math.floor(i / WIDTH),
        frame.stats.tick,
        frame.climate,
        frame.offset,
        frame.thermalRefuges,
      );
      color = [
        Math.round(9 + t * 37),
        Math.round(18 + (1 - Math.abs(t - 0.5) * 2) * 13),
        Math.round(20 + (1 - t) * 40),
      ];
    }
    if (light && frame.cells[i] === 0) {
      const transmission = frame.shadeHabitats.enabled
        ? (16 - frame.shadeHabitats.units[i]) / 16
        : 1;
      color = [
        Math.round(9 + 80 * transmission),
        Math.round(15 + 75 * transmission),
        Math.round(22 + 48 * transmission),
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
  const tileWidth = WIDTH * v.scale,
    tileHeight = HEIGHT * v.scale;
  const columns = camera.wrapped
    ? [Math.floor(-v.left / tileWidth), Math.ceil((v.width - v.left) / tileWidth)]
    : [0, 1];
  const rows = camera.wrapped
    ? [Math.floor(-v.top / tileHeight), Math.ceil((v.height - v.top) / tileHeight)]
    : [0, 1];
  for (let row = rows[0]; row < rows[1]; row++) {
    for (let column = columns[0]; column < columns[1]; column++) {
      const left = v.left + column * tileWidth,
        top = v.top + row * tileHeight;
      ctx.drawImage(buffer, left, top, tileWidth, tileHeight);
      if (selected || highlighted.size) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        for (let i = 0; i < frame.ids.length; i++)
          if ((selected && frame.ids[i] === selected) || highlighted.has(frame.ids[i]))
            ctx.strokeRect(
              left + (i % WIDTH) * v.scale - 1,
              top + Math.floor(i / WIDTH) * v.scale - 1,
              v.scale + 2,
              v.scale + 2,
            );
      }
      ctx.strokeStyle = '#26313a';
      ctx.lineWidth = 1;
      ctx.strokeRect(left - 0.5, top - 0.5, WIDTH * v.scale + 1, HEIGHT * v.scale + 1);
      if (ghost) {
        ctx.fillStyle = ghost.blocked ? '#ed708580' : '#66db8b80';
        ctx.strokeStyle = ghost.blocked ? '#ed7085' : '#66db8b';
        for (const i of ghost.positions) {
          const x = left + (i % WIDTH) * v.scale,
            y = top + Math.floor(i / WIDTH) * v.scale;
          ctx.fillRect(x, y, v.scale, v.scale);
          ctx.strokeRect(x, y, v.scale, v.scale);
        }
      }
    }
  }
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
export function behaviorStatus(genome: Genome): string {
  return genome.behavior.mode === 'evolved'
    ? 'Stored reactions — inactive; steering uses legacy rules.'
    : 'Legacy behavior — steering uses legacy rules.';
}
export function organismHtml(
  o: Organism | null,
  frame:
    | WorldPresentation
    | Pick<Frame, 'stats' | 'climate' | 'offset' | 'thermalRefuges' | 'shadeHabitats'>,
): string {
  if (!o)
    return `<div class="empty-inspector">${genomeSvg(
      {
        behavior: { version: 1 as const, mode: 'legacy' as const },
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
  const temp =
      'anchorTemperature' in frame
        ? frame.anchorTemperature!
        : localTemperature(
            o.x,
            o.y,
            frame.stats.tick,
            frame.climate,
            frame.offset,
            frame.thermalRefuges,
          ),
    activeUnits =
      'anchorRefugeUnits' in frame
        ? frame.anchorRefugeUnits
        : activeRefugeUnits(frame.thermalRefuges, o.x, o.y);
  const exposure =
    'selectedLeafLight' in frame
      ? frame.selectedLeafLight
      : selectedLeafLight(frame.shadeHabitats, o);
  const lightText = exposure
    ? `Current leaf light: mean ${exposure.sumLightUnits / (16 * exposure.leafCells)} transmission; range ${exposure.minimumLightUnits}/16..${exposure.maximumLightUnits}/16 across ${exposure.leafCells} leaves. Post-movement exposure, not earlier metabolic gain.`
    : 'Current leaf light: no leaf cells.';
  return `<div class="specimen-preview"><div class="anatomy">${genomeSvg(o.genome, 104)}</div><div><strong>Organism ${o.id}</strong><span>Lineage #${o.species}</span><span>Generation ${o.generation}</span></div></div><dl class="specimen-facts"><div><dt>Energy</dt><dd>${o.energy.toFixed(1)}</dd></div><div><dt>Age</dt><dd>${o.age} ticks</dd></div><div><dt>Offspring</dt><dd>${o.children}</dd></div><div><dt>Cells</dt><dd>${o.genome.cells.length}</dd></div><div><dt>Local temperature</dt><dd>${Math.round(temp * 40)}°</dd></div><div><dt>Normalized anchor temperature</dt><dd>${temp}</dd></div><div><dt>Active local offset</dt><dd>${activeUnits > 0 ? '+' : ''}${activeUnits / 100} (${activeUnits} units)</dd></div><div><dt>Preferred</dt><dd>${Math.round(o.genome.preference * 40)}° ±${Math.round(o.genome.tolerance * 40)}°</dd></div></dl><p class="muted">${lightText}</p><p class="muted">${behaviorStatus(o.genome)}</p><p class="ancestry" title="Lineage ancestry">${[...o.ancestry, o.species].map((s) => `#${s}`).join(' → ')}</p><button id="copy-organism" class="secondary wide">Edit this organism</button><button id="export-organism-blueprint" class="secondary wide">Export organism blueprint</button>`;
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
      behavior: { version: 1 as const, mode: 'legacy' as const },
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
    <p id="placement-feedback" role="status" aria-live="polite"></p><button id="cancel-placement" hidden>Cancel placement (Esc)</button><div class="tool-options"><span id="tool-hint">Click an organism to inspect its cells.</span><label id="brush-control" hidden for="brush">Radius<input id="brush" type="range" min="0" max="8" step="1" value="2"><output id="brush-value">2 cells</output></label></div>
    <div class="world-bottom"><span id="tick">TICK 0</span><span id="world-count">Seeding life…</span><span class="world-size">240 × 156 cells · wrapped edges</span></div>
  </section>
  <div class="tabs" role="tablist" aria-label="Simulation panels"><button id="ecosystem-tab" data-tab="ecosystem" role="tab" aria-controls="ecosystem-panel" aria-selected="true">Ecosystem</button><button id="organism-tab" data-tab="organism" role="tab" aria-controls="organism-panel" aria-selected="false">Organism</button></div>
      <div id="ecosystem-panel" class="panel" role="tabpanel" aria-labelledby="ecosystem-tab">
        <section class="population-section"><div class="section-caption"><h2>Population now</h2><span id="generation">GEN 0</span></div><div class="population-number"><strong id="population">—</strong><span id="species-count">— lineages</span></div><dl class="vital-stats"><div><dt>Lifetime reproductive births</dt><dd id="births">0</dd></div><div><dt>Lifetime deaths (including manual)</dt><dd id="deaths">0</dd></div><div><dt>Food cells now</dt><dd id="food-count">0</dd></div></dl></section>
        <section id="telemetry" aria-labelledby="telemetry-heading"><h2 id="telemetry-heading">Recorded ecosystem observations</h2><label for="telemetry-view">Telemetry view</label><select id="telemetry-view"><option value="population">Population &amp; events</option><option value="food">Food &amp; body cells</option><option value="adaptation">Thermal adaptation</option><option value="energy">Measured energy flows</option></select><label for="telemetry-sample">Recorded sample</label><select id="telemetry-sample" disabled><option value="latest">No recorded samples</option></select><p id="telemetry-summary"></p><p id="telemetry-status" role="status" aria-live="polite"></p><div class="measurement-downloads"><button id="measurements-json" type="button">Download measurements JSON</button><button id="measurements-csv" type="button">Download measurements CSV</button></div><p>Retained worker observations only, not a complete run or replay file. CSV text cells carry a reversible s: prefix.</p><label for="telemetry-intervention">Manual intervention</label><select id="telemetry-intervention" disabled><option value="latest">No retained manual actions</option></select><p id="telemetry-intervention-summary"></p><div id="telemetry-intervention-details"></div><div id="telemetry-plots"></div><div id="telemetry-details"></div></section>
        <details id="lineage-explorer"><summary id="lineage-heading">Lineage explorer</summary><p class="muted">Lineage IDs track inheritance; anatomy categories describe bodies, not identity or fitness. Select a living lineage to outline its organisms; extinct selection keeps retained evidence available.</p><label for="lineage-search">Search lineage ID, anatomy or status</label><input id="lineage-search" type="search" maxlength="80"><p id="lineage-retention" class="muted"></p><p id="lineage-results" role="status">Open to request retained evidence.</p><p id="lineage-observed" class="muted"></p><ul id="lineage-rows" aria-label="Retained lineages"></ul><button id="lineage-clear" type="button">Clear lineage selection</button><section id="lineage-detail" aria-label="Selected lineage"></section></details>
        <section class="lineage-section"><div class="section-caption"><h2>Common bodies</h2><span title="Choose a body to edit its anatomy">Click to edit</span></div><div id="lineages" class="lineages"><p class="muted">Waiting for life…</p></div></section>
        <section class="climate-section"><div class="section-caption"><h2>Climate</h2><button id="thermal" class="secondary" aria-pressed="false">Show temperature</button></div><div class="world-weather"><strong id="weather">Drifting climate</strong><span id="season">Vernal drift</span></div><div class="temperature-key"><span>0°</span><i></i><span>40°</span></div><label class="slider-label" for="climate">Climate pressure<output id="climate-value">80%</output></label><input id="climate" type="range" min="0" max="1" step="0.05" value="0.8"><div class="events"><button data-shock="cold">${icon('M7 0h2v4h2V2h2v2h-2v2H9v1h3V5h2v2h2v2h-2v2h-2V9H9v2h2v2h2v2h-2v-2H9v3H7v-3H5v2H3v-2h2v-2h2V9H4v2H2V9H0V7h2V5h2v2h3V6H5V4H3V2h2v2h2z')}Cold snap</button><button data-shock="heat">${icon('M6 0h4v2H6zM2 2h2v2H2zm10 0h2v2h-2zM4 4h8v8H4zM0 6h2v4H0zm14 0h2v4h-2zM2 12h2v2H2zm10 0h2v2h-2zm-6 2h4v2H6z')}Heatwave</button></div></section>
        <section class="shade-section"><div class="section-caption"><h3>Painted shade habitats (experimental)</h3><button id="light" class="secondary" aria-pressed="false">Show light</button></div><label class="terrain-follow"><input id="shade-enabled" type="checkbox">Enable painted shade habitats</label><p class="muted">Artificial habitat rule, not a realistic sunlight model. Shade reduces actual leaf energy and leaf-food probability by the same factor. It does not cool temperature or discount upkeep. Off retains paint but applies full light; reseeding clears paint and disables shade.</p><div class="refuge-tools"><button data-tool="shade" data-shade-tool aria-pressed="false" disabled>Shade</button><button data-tool="lighten" data-shade-tool aria-pressed="false" disabled>Lighten</button><button data-tool="erase-shade" data-shade-tool aria-pressed="false" disabled>Erase shade</button></div><label class="slider-label" for="shade-intensity">Shade intensity<output id="shade-intensity-value">4 units</output></label><input id="shade-intensity" type="range" min="1" max="16" step="1" value="4"><p class="muted">One unit removes 1/16 of light. Additive wrapped dabs saturate at 16 units (darkness); radius 0–8. Lighten subtracts units; erase restores full light. Capacity 4096 nonzero cells, including stored paint while off; an over-capacity dab is rejected whole.</p><p id="shade-summary" class="muted"></p><p id="shade-pending" role="status"></p><button id="clear-shade" class="secondary wide">Clear painted shade</button><p class="muted">Clear preserves mode, life, food, walls and temperature paint. Light background: dark = 0/16, pale = 16/16 transmission. Objects retain their functional colors. Light and temperature backgrounds are separate; leaves sample their own rotated, wrapped cells before movement. See Measured energy flows for recorded actual gains and costs.</p></section>
        <section class="refuge-section"><h3>Painted temperature refuges (experimental)</h3><label class="terrain-follow"><input id="refuge-enabled" type="checkbox">Enable painted temperature refuges</label><p class="muted">Manual environment change. Painted offsets alter actual climate upkeep and photosynthesis, so they can change survival and funded reproduction. The scale is abstract, not Celsius. Off retains paint but ignores it. Reseeding clears paint and turns this option off. Walls do not insulate temperature.</p><div class="refuge-tools"><button data-tool="warm" data-refuge-tool aria-pressed="false" disabled>Warm</button><button data-tool="cool" data-refuge-tool aria-pressed="false" disabled>Cool</button><button data-tool="erase-temperature" data-refuge-tool aria-pressed="false" disabled>Erase temperature</button></div><label class="slider-label" for="refuge-intensity">Intensity<output id="refuge-intensity-value">4 units</output></label><input id="refuge-intensity" type="range" min="1" max="32" step="1" value="4"><p class="muted">Additive wrapped dabs; saturation ±32 units. One unit = 0.01 normalized temperature = 0.4 abstract display degrees. Radius 0–8; erase ignores intensity. At most 4096 nonzero cells; an over-capacity dab is rejected whole. Event cadence changes paint, not seeded randomness.</p><p id="refuge-summary" class="muted">Disabled · empty · 0/4096 nonzero cells · offsets 0..0 units · rules 1</p><p id="refuge-pending" role="status"></p><button id="clear-refuges" class="secondary wide">Clear painted temperature</button><p class="muted">Preserves mode, life, food and walls. Objects obscure the temperature background; organisms sample at their anchor. Post-movement inspection can differ from earlier metabolic exposure.</p></section>
        <details class="world-settings"><summary>World settings</summary><label class="slider-label" for="mutation">Mutation rate<output id="mutation-value">12%</output></label><input id="mutation" type="range" min="0" max="0.4" step="0.01" value="0.12"><label class="slider-label" for="nutrients">Leaf food chance<output id="nutrients-value">5%</output></label><input id="nutrients" type="range" min="0" max="20" step="1" value="5"><label class="seed-label" for="seed">World seed<input id="seed" type="number" min="0" max="4294967295" step="1" required value="42"></label>
        <div class="terrain-controls"><h3>Terrain</h3><label for="terrain-preset">Draft wall preset</label><select id="terrain-preset"><option value="open-field">Open field</option><option value="porous-ridges" selected>Porous ridges</option><option value="chambered-refuges">Chambered refuges</option></select><label class="terrain-follow"><input id="terrain-follow" type="checkbox" checked>Use world seed</label><label id="terrain-seed-label" for="terrain-seed" hidden>Terrain seed<input id="terrain-seed" type="number" min="0" max="4294967295" step="1" required value="42"></label><figure class="terrain-preview"><canvas id="terrain-preview" width="240" height="156" role="img" aria-labelledby="terrain-preview-caption"></canvas><figcaption id="terrain-preview-caption"></figcaption></figure><p id="terrain-committed" class="muted"></p><p id="terrain-draft-status" role="status"></p><button id="clear-walls" type="button" class="wide">Clear walls</button><p class="muted">Remove all walls; keep life and food.</p><button id="regenerate-walls" type="button" class="wide">Regenerate walls</button><p class="muted">Replaces walls; protects all living cells. Removes food only where new walls cover it. Actual walls may differ from the reset preview.</p></div>
        <button id="reset" class="secondary wide">Reseed world</button></details>
      </div>
      <div id="organism-panel" class="panel" role="tabpanel" aria-labelledby="organism-tab" hidden><details id="specimen-details" class="specimen-section"><summary tabindex="0">Selected organism</summary><div id="inspector"></div><div class="follow-controls"><button id="follow-organism" type="button" disabled>Follow selected organism</button><button id="release-follow" type="button" disabled>Release follow</button></div><p id="follow-status" role="status"></p><p id="organism-observed"></p><section id="organism-diff" aria-label="Inherited differences"></section></details><section class="designer-section"><div class="section-caption"><h2>Build a body</h2><button id="clear-design" class="quiet">Reset</button></div><div id="cell-palette" class="cell-palette">${CELL_NAMES.map((name, i) => `<button data-cell="${i + 3}" aria-pressed="${i === 1}" title="${name}: ${cellDescriptions[i]}"><i style="--cell:${COLORS[i + 3]}"></i>${name}</button>`).join('')}</div><p id="cell-description" class="muted">${cellDescriptions[1]}</p><div id="editor" class="editor" aria-label="Organism anatomy editor"></div><p id="behavior-status" class="muted"></p><p id="design-note" class="muted">Use 1–16 cells, connected edge to edge.</p><label class="slider-label" for="preference">Preferred temperature<output id="preference-value">20°</output></label><input id="preference" type="range" min="0" max="1" step="0.025" value="0.5">
      <div class="blueprint-fields"><label for="blueprint-name">Blueprint name</label><input id="blueprint-name" type="text" maxlength="80" required><label for="blueprint-description">Description</label><textarea id="blueprint-description" maxlength="1000" rows="3"></textarea></div>
      <div class="blueprint-actions"><button id="import-blueprint">Import blueprint</button><button id="export-blueprint">Export blueprint</button></div><input id="blueprint-file" type="file" accept="application/json,.json" hidden><p id="designer-file-status" class="muted" role="status"></p>
      <div class="design-transforms" role="group" aria-label="Transform design"><button id="rotate-design" title="Rotate clockwise (R)">Rotate ↻ (R)</button><button id="mirror-design" title="Mirror horizontally (M)">Mirror ↔ (M)</button></div><p class="muted">Importing edits only this design. Choose Place in world, then click the habitat to create a new organism.</p><button id="plant-design" class="primary wide">Place in world</button></section>
      <details id="local-library"><summary id="library-heading">Local organism library</summary><p id="library-count">Not opened · 100 physical entries maximum</p><p id="library-status" role="status" aria-live="polite"></p><p class="muted">Saved designs stay in this browser profile, subject to eviction or clearing. Duplicate names are allowed; local IDs identify entries. Other tabs may change this list; Refresh.</p><div class="library-actions"><button id="library-refresh">Refresh / Retry</button><button id="library-save">Save design to library</button><button id="library-import">Import into library</button></div><input id="library-file" type="file" accept="application/json,.json" hidden><ul id="library-rows"></ul><p id="library-selection" class="muted">No selected entry.</p><div class="library-actions"><button id="library-load" disabled>Load into designer…</button><button id="library-rename" disabled>Rename…</button><button id="library-duplicate" disabled>Duplicate</button><button id="library-export" disabled>Export blueprint</button><button id="library-delete" disabled>Delete…</button></div><section id="library-candidate" hidden><h3>Blueprint candidate copy</h3><p class="muted">A delayed write may already have committed. Refresh before retrying. Discard removes only this candidate copy, not stored entries.</p><p id="library-candidate-name"></p><div id="library-candidate-preview"></div><div class="library-actions"><button id="library-add">Add as new / Retry</button><button id="library-replace">Replace selected…</button><button id="library-export-candidate">Export candidate blueprint</button><button id="library-discard">Discard candidate copy</button></div></section><p class="muted">Blueprint exports omit local IDs, revisions and capture provenance. For unsupported or uninspectable storage, export valid entries first, then consider browser site-storage settings. Clearing site data can remove other origin data and cannot be undone.</p></details></div>
    <details id="local-checkpoints"><summary>Local world checkpoints</summary><p class="muted">Five explicit complete worlds in this browser profile. No automatic restore or sync. Browser clearing or eviction can remove them; download worlds for portable backups. Camera is separate and is not saved.</p><p id="checkpoint-usage">Not opened · five slots maximum</p><div class="blueprint-fields checkpoint-fields"><label for="checkpoint-slot">Checkpoint slot</label><select id="checkpoint-slot"><option value="1">Refresh to read slots</option></select><label for="checkpoint-name">Checkpoint name</label><input id="checkpoint-name" maxlength="80" value="Checkpoint"></div><div class="library-actions"><button id="checkpoint-refresh">Refresh checkpoints / Retry</button><button id="checkpoint-save">Save checkpoint</button><button id="checkpoint-restore">Restore checkpoint…</button><button id="checkpoint-delete">Delete checkpoint…</button></div><p id="checkpoint-status" role="status" aria-live="polite"></p></details>
    <details id="comparisons"><summary>Checkpoint climate comparison</summary><p>Fork a complete native Save into two isolated worlds. The open sandbox is never paused, edited or replaced. One heatwave/cold snap lasts 900 logical ticks and replaces any existing shift. Extinct branches continue empty to the same horizon; no rescue or fabricated winners.</p><label for="comparison-intervention">Treatment</label><select id="comparison-intervention"><option value="heat">Heatwave (+0.32)</option><option value="cold">Cold snap (−0.32)</option><option value="none">No intervention (control/control)</option></select><label for="comparison-duration">Horizon after checkpoint (1–3600 ticks)</label><input id="comparison-duration" type="number" min="1" max="3600" value="300"><label for="comparison-delay">Treatment after checkpoint (completed ticks; 0 = immediately)</label><input id="comparison-delay" type="number" min="0" max="3599" value="30"><p>Treatment applies after that completed logical tick, before its next tick. At most 121 tick-aligned population, cumulative births/deaths, trait and measured stress samples per branch; one comparison and one result retained, cleared on rerun, reset, import or cancellation. Each final complete checkpoint is limited to 2.5 MB. Samples include the initial state, every 30 ticks and the horizon. Same-runtime repeatability only; one run is not a biological or statistical claim.</p><div class="library-actions"><button id="comparison-start">Run comparison</button><button id="comparison-cancel" disabled>Cancel comparison</button><button id="comparison-control" disabled>Download control world</button><button id="comparison-treatment" disabled>Download treatment world</button><button id="comparison-recipe" disabled>Export experiment recipe</button><button id="comparison-import">Import and replay recipe</button><input id="comparison-file" type="file" accept="application/json,.json" hidden></div><p id="comparison-status" role="status" aria-live="polite"></p><p>One artificial-life run pair is not evidence of statistical significance or biological realism. No winner or score is assigned. Recipes embed a complete starting checkpoint (2.5 MB maximum), rules/format version, runtime, seed, exact intervention and horizon, and actual result samples. Recipe JSON is bounded to 15.2 MB including escaped checkpoint text. Replay requires the same rules/runtime and checks new observations against recorded values.</p><label for="comparison-metric">Compare measurement</label><select id="comparison-metric"><option value="population">Population</option><option value="births">Births (lifetime cumulative)</option><option value="deaths">Deaths (lifetime cumulative)</option><option value="meanPreference">Mean temperature preference</option><option value="meanTolerance">Mean temperature tolerance</option><option value="stressedFraction">Measured stressed fraction</option></select><p>Shared logical tick and value axes. Control: solid line / circles. Treatment: dashed line / triangles. Means weight living organisms equally. Stress is strictly positive temperature mismatch beyond tolerance, measured at surviving post-tick anchors; it can differ from earlier metabolic exposure. Extinct means and stress are undefined; missing values break lines. Exact values follow the chart.</p><div id="comparison-results"></div></details>
    <footer><nav aria-label="World files and help"><button id="save" title="Download this world">Save world</button><button id="load" title="Open a saved world">Load world</button><button id="help" title="How this world works">Help</button><a href="https://github.com/JustinasLa/EvoLab" target="_blank" rel="noreferrer">Source</a></nav><input id="file" type="file" accept="application/json,.json" hidden><details class="legend"><summary>Cell legend &amp; shortcuts</summary><div class="cell-legend">${CELL_NAMES.map((name, i) => `<span title="${cellDescriptions[i]}"><i style="--cell:${COLORS[i + 3]}"></i>${name}</span>`).join('')}<span><i style="--cell:${COLORS[1]}"></i>Food</span><span><i style="--cell:${COLORS[2]}"></i>Wall</span></div><p class="footer-note">Space: pause · Scroll: zoom<br>I / H / F / W / E / P: select tools · R: rotate design · M: mirror · Esc: cancel placement</p></details></footer>
  </div>
    <p id="notice" role="status"></p>
  </aside>
</main>
<dialog id="checkpoint-dialog" aria-labelledby="checkpoint-confirm-heading" aria-describedby="checkpoint-confirm-description"><h2 id="checkpoint-confirm-heading">Confirm checkpoint action</h2><p id="checkpoint-confirm-description"></p><div class="library-actions"><button id="checkpoint-cancel" autofocus>Cancel</button><button id="checkpoint-confirm">Confirm checkpoint action</button></div></dialog>
<dialog id="reset-dialog" aria-labelledby="reset-heading" aria-describedby="reset-description reset-payload"><h2 id="reset-heading">Replace this world?</h2><p id="reset-description">Living organisms, food, walls and recorded history will be discarded. Painted temperature will be cleared and disabled. The new world starts with one centered producer and no food. The live world may advance while this confirmation is open.</p><p id="reset-payload"></p><div class="reset-actions"><button id="cancel-reset" type="button" autofocus>Cancel</button><button id="confirm-reset" type="button">Reset world</button></div></dialog>
<dialog id="library-dialog" aria-labelledby="library-dialog-title"><h2 id="library-dialog-title"></h2><p id="library-dialog-description"></p><div id="library-dialog-preview"></div><label id="library-rename-label" for="library-rename-name" hidden>Exact new name</label><input id="library-rename-name" maxlength="80" hidden><p id="library-dialog-status" role="status"></p><div class="library-actions"><button id="library-cancel" autofocus>Cancel</button><button id="library-confirm">Confirm</button></div></dialog>
<dialog id="help-dialog"><button id="close-help" class="dialog-close" aria-label="Close help">×</button><h1>EvoLab / Drift</h1><p>Organisms eat, move, reproduce, mutate, and die. Successful descendants spread through survival and reproduction.</p><p>Climate zones drift across the habitat. Each organism inherits a preferred temperature and tolerance. Wider tolerance costs energy.</p><ul><li>Inspect a body, or click a common body to edit it.</li><li>Choose Food, Wall or Erase and drag to paint.</li><li>Choose a cell type, draw a connected body, then place it in the world.</li><li>Scroll to zoom; use Pan to drag. Space pauses; I / H / F / W / E / P select tools.</li><li>Save your world before leaving. Reloading starts fresh.</li></ul><p>Pause on extinction is on by default for this tab. Your choice survives reseed and world loads; reloading restores ON. It stops at the first extinct logical tick, or immediately after manual last-organism erasure, without resetting or replenishing life.</p><p>The summary records the final removal tick and cause: energy exhaustion, age limit or manual erasure. An imported empty world's original cause is unavailable. Food, walls and charts remain. Inspect, edit, save and Step stay usable while paused; Step advances exactly one tick, even when empty. Placing an organism does not resume playback.</p><p>To run an empty world, turn off Pause on extinction and then press Resume. Turning it off alone never resumes. Rejected world files retain the current world and playback; their display refresh adds no chart samples.</p><p>Render habitat controls automatic snapshots, not evolution or telemetry. Off/hidden images can be stale; explicit visible Refresh and paused editing/Step/inspection can request one current image. Run to tick accelerates yielding batches, not logical ticks. Pause suspends a target; Cancel pauses and discards it. Measured ticks/s counts actual completed ticks over monotonic elapsed time, including scheduling. Speed is ticks per batch, not ticks/s. Hidden tabs may be throttled, suspended or discarded. A costly complete tick cannot be interrupted; timing gaps are unknown and never subtracted. Throughput depends on this machine and browser.</p><p class="muted">An original cellular simulation; temperature uses an abstract 0–40° scale, not a biological model.</p></dialog>`;
