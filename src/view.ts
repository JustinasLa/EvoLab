import type { Course, Generation, Trial } from './model';
import { terrain } from './physics';

export function drawScene(
  canvas: HTMLCanvasElement,
  trial: Trial | undefined,
  frame: number,
  course: Course,
): void {
  const ctx = canvas.getContext('2d')!;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth || 900;
  const height = canvas.clientHeight || 420;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.scale(ratio, ratio);
  const scale = Math.min(66, width / 10);
  const pose = trial?.frames[Math.min(frame, trial.frames.length - 1)];
  const focus = pose ? pose[0] : 0;
  const camera = Math.max(-3, focus - (width / scale) * 0.36);
  const floor = height * 0.72;
  const x = (v: number): number => (v - camera) * scale;
  const y = (v: number): number => floor - v * scale;
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#142b25');
  sky.addColorStop(1, '#203c30');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#d8e5be0b';
  ctx.lineWidth = 1;
  for (let i = Math.floor(camera); i < camera + width / scale + 1; i++) {
    ctx.beginPath();
    ctx.moveTo(x(i), 0);
    ctx.lineTo(x(i), height);
    ctx.stroke();
  }
  for (let i = 0; i < height / scale; i++) {
    ctx.beginPath();
    ctx.moveTo(0, floor - i * scale);
    ctx.lineTo(width, floor - i * scale);
    ctx.stroke();
  }
  ctx.fillStyle = '#d4ed8809';
  ctx.beginPath();
  ctx.arc(width * 0.82, height * 0.24, 70, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(width * 0.82, height * 0.24, 100, 0, Math.PI * 2);
  ctx.fill();
  for (const t of terrain(course)) {
    ctx.fillStyle = '#294938';
    ctx.fillRect(
      x(t.x - t.width / 2),
      y(t.y + t.height / 2),
      t.width * scale,
      t.height * scale + height,
    );
    ctx.strokeStyle = '#c3d98f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x(t.x - t.width / 2), y(t.y + t.height / 2));
    ctx.lineTo(x(t.x + t.width / 2), y(t.y + t.height / 2));
    ctx.stroke();
  }
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#a8baa0';
  for (let i = Math.floor(camera / 5) * 5; i < camera + width / scale; i += 5) {
    ctx.fillText(`${i} m`, x(i) + 5, floor + 23);
    ctx.fillRect(x(i), floor + 7, 1, 5);
  }
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = '#d4ed8840';
  ctx.beginPath();
  ctx.moveTo(x(0), 30);
  ctx.lineTo(x(0), floor);
  ctx.stroke();
  ctx.setLineDash([]);
  if (pose && trial) {
    for (const [i, g] of trial.genome.genes.entries()) {
      ctx.save();
      ctx.translate(x(pose[i * 3]), y(pose[i * 3 + 1]));
      ctx.rotate(-pose[i * 3 + 2]);
      ctx.shadowColor = '#00000040';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 7;
      ctx.fillStyle = `hsl(${trial.genome.hue} 48% ${i === 0 ? 75 : 64}%)`;
      ctx.strokeStyle = '#e5f5c9';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(
        (-g.length / 2) * scale,
        -g.width * scale,
        g.length * scale,
        g.width * 2 * scale,
        g.width * scale,
      );
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.fillStyle = '#eff3db';
      ctx.beginPath();
      ctx.arc((-g.length / 2) * scale + 3, 0, 3.5, 0, Math.PI * 2);
      ctx.fill();
      if (i === 0) {
        ctx.fillStyle = '#182c24';
        ctx.beginPath();
        ctx.arc(g.length * scale * 0.22, -g.width * scale * 0.2, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(g.length * scale * 0.22 + 1, -g.width * scale * 0.2 - 1, 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  } else {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#d5dfc5';
    ctx.font = 'italic 24px Georgia, serif';
    ctx.fillText('A little chaos is taking shape…', width / 2, height * 0.42);
    ctx.textAlign = 'left';
  }
}

export function chart(
  canvas: HTMLCanvasElement,
  history: Pick<Generation, 'index' | 'best' | 'median'>[],
): void {
  const ctx = canvas.getContext('2d')!;
  const width = (canvas.width = canvas.clientWidth || 600);
  const height = (canvas.height = 120);
  ctx.clearRect(0, 0, width, height);
  const min = Math.min(0, ...history.map((g) => g.median));
  const max = Math.max(1, ...history.map((g) => g.best));
  const y = (v: number): number => height - 14 - ((v - min) / (max - min)) * (height - 28);
  ctx.strokeStyle = '#d6d9c9';
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(width, y(0));
  ctx.stroke();
  for (const key of ['median', 'best'] as const) {
    ctx.beginPath();
    ctx.lineWidth = key === 'best' ? 2.5 : 1.5;
    ctx.strokeStyle = key === 'best' ? '#3c7151' : '#b3b99d';
    history.forEach((g, i) => {
      const px = 4 + (i / Math.max(1, history.length - 1)) * (width - 8);
      if (i === 0) ctx.moveTo(px, y(g[key]));
      else ctx.lineTo(px, y(g[key]));
    });
    ctx.stroke();
  }
}

export const markup = `
<header class="topbar"><a class="brand" href="./" aria-label="EvoLab home"><span class="brand-symbol">✳</span> EvoLab<span class="brand-dot">.</span></a><span class="topnote">AN EXERCISE IN NATURAL SELECTION</span><a class="source" href="https://github.com/JustinasLa/EvoLab" target="_blank" rel="noreferrer">Source ↗</a></header>
<main>
  <section class="intro"><div><p class="eyebrow">SMALL CREATURES. QUESTIONABLE DECISIONS.</p><h1>Life finds a <em>weird</em> way.</h1><p class="lede">A few joints, a little mutation, and absolutely no idea how to walk.<br class="desktop-break"> Let evolution figure it out.</p></div><div class="run-state"><span class="status-dot"></span><span id="status" role="status">Starting experiment</span></div></section>
  <div class="lab-grid">
    <section class="experiment" aria-label="Evolution experiment">
      <div class="arena"><div class="arena-bar"><span><span class="tiny-dot"></span> THE PROVING GROUND</span><span id="habitat-label">MEADOW / EARTH</span></div><canvas id="world" role="img" aria-label="Replay of the selected creature moving through its habitat"></canvas><div class="arena-bottom"><span id="specimen">Finding our first survivor…</span><span id="replay-label">8 SECOND TRIAL</span></div></div>
      <div class="transport"><button id="pause" class="button dark">Ⅱ Pause evolution</button><label class="speed-label">Replay <select id="speed" aria-label="Replay speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label><button id="follow" class="text-button" hidden>Follow latest ↗</button><span id="progress-text">Preparing population</span></div>
      <div class="metrics"><div><span class="metric-label">GENERATION</span><strong id="generation">000</strong></div><div><span class="metric-label">BEST FITNESS <span title="Forward progress minus a small motor-energy cost">ⓘ</span></span><strong id="best">—</strong></div><div><span class="metric-label">POPULATION</span><strong id="population">24<span> creatures</span></strong></div><div><span class="metric-label">BODY VARIANTS</span><strong id="diversity">—</strong></div></div>
      <section class="progress-panel"><div class="section-heading"><h2>A little better. Eventually.</h2><div class="legend"><span>● Best</span><span>● Median</span></div></div><canvas id="chart" role="img" aria-label="Best and median fitness by generation"></canvas><p id="chart-description" class="small">Every generation gets the same course and eight seconds to make its case.</p></section>
      <section class="specimens"><div class="section-heading"><h2>The survivors</h2><span class="small">REVISIT A GENERATION</span></div><div id="survivors" class="survivor-list"><p class="small">Your first champion will be here shortly.</p></div></section>
    </section>
    <aside class="settings" aria-label="Experiment settings"><div class="section-heading"><h2>Play god. A little.</h2><span class="setting-icon">⚙</span></div><p class="small settings-description">Change the world. See what adapts.<br>New settings start a fresh population.</p>
      <fieldset><legend>THE HABITAT</legend><div class="course-options"><button type="button" data-course="meadow" aria-pressed="true"><span>〰</span> Meadow</button><button type="button" data-course="steps" aria-pressed="false"><span>⌁</span> Steps</button><button type="button" data-course="gaps" aria-pressed="false"><span>⊔</span> Gaps</button></div></fieldset>
      <label class="range-label" for="gravity">GRAVITY <output id="gravity-value">9.81 m/s²</output></label><input id="gravity" type="range" min="1.6" max="20" step="0.01" value="9.81"><div class="range-ends"><span>Moon-ish</span><span>Heavy stuff</span></div>
      <label class="range-label" for="mutation">MUTATION <output id="mutation-value">18%</output></label><input id="mutation" type="range" min="0.05" max="0.6" step="0.01" value="0.18"><div class="range-ends"><span>Small nudges</span><span>Embrace chaos</span></div>
      <div class="field-row"><label>POPULATION<select id="population-setting"><option value="12">12 creatures</option><option value="24" selected>24 creatures</option><option value="48">48 creatures</option></select></label><label for="seed">WORLD SEED<input id="seed" type="number" min="0" max="4294967295" step="1" value="42" required></label></div>
      <button id="restart" class="button restart">Begin new experiment <span>↗</span></button><p id="pending" class="small pending" aria-live="polite">Same seed. Same settings. Same starting creatures.</p>
      <div class="notebook"><span class="eyebrow">FIELD NOTES / 001</span><p>Nobody taught them to walk.</p><p class="small">Bodies and motor rhythms mutate. The best two survive unchanged; their offspring compete with one fresh wildcard.</p></div>
      <div class="file-actions"><button id="export" class="text-button" disabled>↓ Save champion</button><button id="import" class="text-button">↑ Load champion</button><input id="file" type="file" accept="application/json,.json" hidden></div><p id="notice" class="small notice" role="status"></p>
    </aside>
  </div>
  <details class="how"><summary>A quick note on the science</summary><p>Each creature is a tree of rigid body segments connected by motor-driven joints. Evolution changes its proportions, limb count, joint angles, strength, and movement rhythm. Fitness rewards forward progress with a small energy penalty. Trials use fixed physics steps; this is an evolutionary toy, not a model of biological evolution. The arena replays completed trials while the next generation is evaluated in a background worker. Pause stops evaluation; replays keep playing. Changing environments starts a new fitness comparison.</p></details>
</main><footer><span>Made of physics, persistence, and happy accidents.</span><a href="https://github.com/JustinasLa/EvoLab/tree/main/docs">The lab notebook ↗</a></footer>`;
