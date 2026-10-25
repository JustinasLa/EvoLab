import {
  WIDTH,
  HEIGHT,
  COLORS,
  CELL_NAMES,
  temperature,
  type Frame,
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
  frame: Frame,
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
  ctx.fillStyle = '#080c12';
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
  return `<svg width="${size}" height="${size}" viewBox="-5 -5 10 10" aria-hidden="true">${genome.cells.map((c) => `<rect x="${c.x - 0.43}" y="${c.y - 0.43}" width=".86" height=".86" rx=".06" fill="${COLORS[c.type]}"/>`).join('')}</svg>`;
}
export function drawChart(canvas: HTMLCanvasElement, history: number[]): void {
  const ctx = canvas.getContext('2d')!;
  const w = (canvas.width = canvas.clientWidth || 250),
    h = (canvas.height = 70);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(10, ...history);
  ctx.beginPath();
  history.forEach((n, i) => {
    const x = (i / Math.max(1, history.length - 1)) * w,
      y = h - 6 - (n / max) * (h - 12);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#7edbaf';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
export function organismHtml(o: Organism | null, frame: Frame): string {
  if (!o)
    return '<p class="empty-inspector">Click any organism to see its anatomy, energy, and ancestry.</p>';
  const temp = temperature(o.x, o.y, frame.stats.tick, frame.climate, frame.offset);
  return `<div class="specimen-preview">${genomeSvg(o.genome, 86)}<div><strong>Organism ${o.id}</strong><span>Lineage ${o.species} · generation ${o.generation}</span></div></div><dl class="specimen-facts"><div><dt>Energy</dt><dd>${o.energy.toFixed(1)}</dd></div><div><dt>Age</dt><dd>${o.age} ticks</dd></div><div><dt>Offspring</dt><dd>${o.children}</dd></div><div><dt>Cells</dt><dd>${o.genome.cells.length}</dd></div><div><dt>Local temperature</dt><dd>${Math.round(temp * 40)}°</dd></div><div><dt>Preferred</dt><dd>${Math.round(o.genome.preference * 40)}° ±${Math.round(o.genome.tolerance * 40)}°</dd></div></dl><p class="ancestry">${[...o.ancestry, o.species].map((s) => `#${s}`).join(' → ')}</p><button id="copy-organism" class="secondary wide">Edit this organism ↗</button>`;
}
export const markup = `
<header class="topbar"><a class="brand" href="./"><svg width="23" height="23" viewBox="0 0 23 23" aria-hidden="true"><rect x="2" y="9" width="5" height="5" fill="#66db8b"/><rect x="9" y="2" width="5" height="5" fill="#edae57"/><rect x="9" y="9" width="5" height="5" fill="#66db8b"/><rect x="16" y="9" width="5" height="5" fill="#58bce5"/><rect x="9" y="16" width="5" height="5" fill="#66db8b"/></svg><strong>EvoLab</strong><span>DRIFT</span></a><span class="top-caption">AN OPEN-ENDED ARTIFICIAL ECOSYSTEM</span><nav><button id="help" title="How this world works">?</button><a href="https://github.com/JustinasLa/EvoLab" target="_blank" rel="noreferrer">Source ↗</a></nav></header>
<main class="workspace"><section class="world-stage" aria-label="Living ecosystem"><canvas id="world" aria-label="Interactive ecosystem. Choose a tool, then click or drag in the world." tabindex="0"></canvas><div class="world-label"><span class="live-dot"></span><span id="world-label">WORLD 0042</span><span id="run-state">LIVE</span></div><div class="world-weather"><span id="season">Vernal drift</span><strong id="weather">Drifting climate</strong></div><div class="zoom-controls"><button id="zoom-out" title="Zoom out">−</button><button id="fit" title="Fit world">Fit</button><button id="zoom-in" title="Zoom in">+</button></div><div class="world-bottom"><span id="tick">TICK 0</span><span id="world-count">Seeding life…</span></div><div class="tool-dock" role="toolbar" aria-label="World tools"><button data-tool="inspect" aria-pressed="true" title="Inspect organism (I)"><span>⌖</span><small>Inspect</small></button><button data-tool="pan" aria-pressed="false" title="Pan world (H)"><span>✥</span><small>Pan</small></button><i></i><button data-tool="food" aria-pressed="false" title="Paint nutrients (F)"><span class="food-icon">✦</span><small>Food</small></button><button data-tool="wall" aria-pressed="false" title="Paint walls (W)"><span>▦</span><small>Wall</small></button><button data-tool="erase" aria-pressed="false" title="Erase life and terrain (E)"><span>◩</span><small>Erase</small></button><button data-tool="plant" aria-pressed="false" title="Place designed organism (P)"><span class="plant-icon">✚</span><small>Plant</small></button></div></section>
<aside class="sidebar"><div class="simulation-controls"><button id="pause" class="primary" title="Pause or resume (Space)">Ⅱ Pause</button><label>Speed<select id="speed" aria-label="Simulation speed"><option value="1">1×</option><option value="4" selected>4×</option><option value="12">12×</option></select></label><button id="step" class="icon-button" title="Advance one tick while paused">▹</button></div><div class="tabs" role="tablist"><button data-tab="ecosystem" role="tab" aria-selected="true">Ecosystem</button><button data-tab="organism" role="tab" aria-selected="false">Organism</button></div>
<div id="ecosystem-panel" class="panel"><section class="population-section"><div class="section-caption"><span>POPULATION</span><span id="generation">GEN 0</span></div><div class="population-number"><strong id="population">—</strong><span id="species-count">— lineages</span></div><canvas id="chart" role="img" aria-label="Recent organism population"></canvas><div class="vital-stats"><span>↑ <b id="births">0</b> births</span><span>↓ <b id="deaths">0</b> deaths</span><span>✦ <b id="food-count">0</b> food</span></div></section>
<section><div class="section-caption"><span>DOMINANT LINEAGES</span><span>ALIVE</span></div><div id="lineages" class="lineages"><p class="muted">Waiting for the first inhabitants.</p></div></section>
<section class="climate-section"><div class="section-caption"><span>THE TWIST: A WORLD THAT DRIFTS</span></div><p class="muted">Warm and cold zones move. Temperature preferences are inherited. Survivors shape the next generation.</p><button id="thermal" class="secondary wide" aria-pressed="false">◒ Show temperature</button><div class="temperature-key"><span>Cold · 0°</span><i></i><span>40° · Hot</span></div><label class="slider-label" for="climate">Climate pressure<output id="climate-value">80%</output></label><input id="climate" type="range" min="0" max="1" step="0.05" value="0.8"><div class="events"><button data-shock="cold">❄ Cold snap</button><button data-shock="heat">☀ Heatwave</button><button data-shock="bloom">✦ Bloom</button></div></section>
<details class="world-settings"><summary>World settings</summary><label class="slider-label" for="mutation">Mutation rate<output id="mutation-value">12%</output></label><input id="mutation" type="range" min="0" max="0.4" step="0.01" value="0.12"><label class="slider-label" for="nutrients">Nutrient rain<output id="nutrients-value">5 / tick</output></label><input id="nutrients" type="range" min="0" max="20" step="1" value="5"><label class="slider-label" for="brush">Brush radius<output id="brush-value">2 cells</output></label><input id="brush" type="range" min="0" max="8" step="1" value="2"><label class="seed-label" for="seed">World seed<input id="seed" type="number" min="0" max="4294967295" step="1" required value="42"></label><button id="reset" class="secondary wide">↺ Reseed world</button></details>
</div>
<div id="organism-panel" class="panel" hidden><section><div class="section-caption"><span>UNDER THE MICROSCOPE</span></div><div id="inspector"><p class="empty-inspector">Click any organism to see its anatomy, energy, and ancestry.</p></div></section><section><div class="section-caption"><span>ORGANISM DESIGNER</span><button id="clear-design" class="quiet">Reset</button></div><p class="muted">Draw a connected body. Choose a cell, then click the grid.</p><div id="cell-palette" class="cell-palette">${CELL_NAMES.map((name, i) => `<button data-cell="${i + 3}" aria-pressed="${i === 1}" title="${name}"><i style="background:${COLORS[i + 3]}"></i>${name}</button>`).join('')}</div><div id="editor" class="editor" aria-label="Organism anatomy editor"></div><label class="slider-label" for="preference">Preferred temperature<output id="preference-value">20°</output></label><input id="preference" type="range" min="0" max="1" step="0.025" value="0.5"><button id="plant-design" class="primary wide">✚ Place in world</button><p id="design-note" class="muted">The organism will reproduce and mutate on its own.</p></section></div>
<div class="sidebar-bottom"><button id="save" class="quiet">↓ Save world</button><button id="load" class="quiet">↑ Load world</button><input id="file" type="file" accept="application/json,.json" hidden></div><p id="notice" role="status"></p></aside></main>
<footer><div class="cell-legend">${CELL_NAMES.map((name, i) => `<span title="${['Eats adjacent nutrients', 'Grows food using light', 'Enables movement', 'Drains adjacent unarmored organisms', 'Protects the contacted cell', 'Senses nearby food and organisms'][i]}"><i style="background:${COLORS[i + 3]}"></i>${name}</span>`).join('')}<span><i style="background:${COLORS[1]}"></i>Food</span></div><span class="footer-note">No assigned fitness. Just survival.</span></footer>
<dialog id="help-dialog"><button id="close-help" class="dialog-close" aria-label="Close help">×</button><span class="section-caption">WELCOME TO EVOLAB / DRIFT</span><h1>A small world.<br>An endless experiment.</h1><p>Organisms eat, move, reproduce, mutate, and die. No leaderboard chooses who breeds. Successful descendants simply occupy more of the world.</p><p><b>The twist:</b> climate zones drift across the habitat. Every organism inherits a preferred temperature and a tolerance range. Heatwaves and cold snaps change which bodies can thrive.</p><ul><li>Click an organism to inspect it or copy its anatomy into the designer.</li><li>Paint food, build barriers, erase patches, or design and place your own life.</li><li>Scroll to zoom; use Pan to drag. Space pauses; I / H / F / W / E / P select tools.</li><li>Save the whole world before leaving. Reloading otherwise starts fresh.</li></ul><p class="muted">Inspired by <a href="https://thelifeengine.net/" target="_blank" rel="noreferrer">The Life Engine</a>. An original cellular simulation; temperature is an abstract 0–40° scale, not a biological model.</p></dialog>`;
