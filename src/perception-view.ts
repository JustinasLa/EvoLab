import { WIDTH, type Perception } from './model';

const headings = ['north', 'east', 'south', 'west'];
// Travel headings in the ecology use E/S/W/N, unlike body rotations.
const travel = ['east', 'south', 'west', 'north'];
export function perceptionHtml(trace: Perception | null, tick: number): string {
  if (!trace)
    return '<p>No retained perception. Select an active organism with an eye and motor, then let it reach an eligible movement tick. Paused inspection never reconstructs earlier sight. Death or a different selection clears this observation.</p>';
  const chosen =
    trace.chosenEye === null
      ? 'No non-ignored candidate; retained travel heading'
      : `Eye ${trace.chosenEye} selected`;
  return `<p>Last perception at tick ${trace.tick}; current observation tick ${tick}${trace.tick < tick ? ' — historical' : ''}. Pre-movement rays; the habitat may since have changed.</p><p>${chosen}: ${travel[trace.direction]}. Translation ${trace.moved ? 'accepted' : 'blocked'}; final travel ${travel[trace.finalDirection]}, body faces ${headings[trace.finalRotation]}. A blocked attempt can change heading and rotate after sensing.</p><p>Overlay: cyan visited cells, orange first occlusion, white chosen eye/direction. Only the selected organism is retained.</p><ol>${trace.rays.map((ray) => `<li>Eye ${ray.eye} from (${ray.origin % WIDTH},${Math.floor(ray.origin / WIDTH)}), facing ${headings[ray.heading]}: ${ray.cells.length} visited; ${ray.stop === 'range' ? 'range exhausted' : `occluded by ${ray.stop}`}${ray.reaction ? `; ${ray.reaction}` : ''}${ray.eye === trace.chosenEye ? '; chosen' : ''}.</li>`).join('')}</ol>`;
}

// Each visited wrapped cell is drawn separately, so crossing an edge never
// produces a spurious world-wide segment. Coordinates share the habitat camera.
export function drawPerception(
  ctx: CanvasRenderingContext2D,
  trace: Perception,
  left: number,
  top: number,
  scale: number,
): void {
  ctx.lineWidth = 1.5;
  for (const ray of trace.rays) {
    ctx.strokeStyle = '#58bce5';
    for (const p of ray.cells)
      ctx.strokeRect(left + (p % WIDTH) * scale, top + Math.floor(p / WIDTH) * scale, scale, scale);
    if (ray.stop !== 'range') {
      const p = ray.cells[ray.cells.length - 1];
      ctx.strokeStyle = '#edae57';
      ctx.strokeRect(left + (p % WIDTH) * scale, top + Math.floor(p / WIDTH) * scale, scale, scale);
    }
    if (ray.eye === trace.chosenEye) {
      const x = left + ((ray.origin % WIDTH) + 0.5) * scale,
        y = top + (Math.floor(ray.origin / WIDTH) + 0.5) * scale,
        [dx, dy] = [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ][trace.direction],
        endX = x + dx * scale * 0.4,
        endY = y + dy * scale * 0.4;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(endX, endY);
      ctx.lineTo(
        endX - dx * scale * 0.2 + dy * scale * 0.15,
        endY - dy * scale * 0.2 - dx * scale * 0.15,
      );
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - dx * scale * 0.2 - dy * scale * 0.15,
        endY - dy * scale * 0.2 + dx * scale * 0.15,
      );
      ctx.stroke();
    }
  }
}
