import {
  WIDTH,
  index,
  positions,
  type Perception,
  type PerceptionRay,
  type Organism,
  clamp,
} from './model';
import { EYE_CELL_COST, TEMPERATURE_SAMPLE_COST } from './senses';

interface Habitat {
  walls: Uint8Array;
  food: Uint8Array;
  occupied: Int32Array;
  organisms: Map<number, Organism>;
}
const headings = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;
const categories = ['dangerous', 'wall', 'harmless', 'food'] as const;

// Called only for eligible active, sighted motors. Eyes face with the body,
// independently of its travel heading. Own cells occlude without a reaction.
export function sensoryDirection(organism: Organism, habitat: Habitat, trace?: Perception): number {
  const behavior = organism.genome.behavior;
  if (behavior.mode !== 'evolved' || behavior.version !== 2) return organism.direction;
  return scanSight(organism, habitat, trace);
}

export function neuralInputs(organism: Organism, habitat: Habitat): number[] {
  const inputs = [
    0,
    0,
    0,
    0,
    clamp(organism.energy / (organism.genome.cells.length * 3 + 9), 0, 1),
    organism.neuralBlocked ? 1 : 0,
  ];
  scanSight(organism, habitat, undefined, inputs);
  return inputs;
}

export function expandedInputs(
  organism: Organism,
  habitat: Habitat,
  temperatureAt: (position: number) => number,
  trace?: Perception,
): NonNullable<Perception['senses']> {
  const senses = organism.genome.senses!,
    origins = positions(organism);
  const inputs = [
    0,
    0,
    0,
    0,
    clamp(organism.energy / (organism.genome.cells.length * 3 + 9), 0, 1),
    organism.neuralBlocked ? 1 : 0,
    0,
    0,
    0,
    0,
  ];
  const eyeCount = organism.genome.cells.filter((cell) => cell.type === 8).length;
  const available = [
    eyeCount > 0,
    eyeCount > 0,
    eyeCount > 0,
    eyeCount > 0,
    true,
    true,
    senses.temperature,
    senses.temperature,
    senses.temperature,
    senses.temperature,
  ];
  const offsets = senses.fov === 1 ? [0] : senses.fov === 3 ? [0, 3, 1] : [0, 3, 1, 2];
  for (const [eye, cell] of organism.genome.cells.entries()) {
    if (cell.type !== 8) continue;
    const origin = origins[eye];
    for (const offset of offsets) {
      const heading = (organism.rotation + senses.orientation + offset) % 4;
      const [dx, dy] = headings[heading];
      const ray: PerceptionRay | undefined = trace
        ? { eye, origin, heading, cells: [], stop: 'range', reaction: null }
        : undefined;
      if (ray) trace!.rays.push(ray);
      for (let distance = 1; distance <= senses.range; distance++) {
        const position = index(
          (origin % WIDTH) + dx * distance,
          Math.floor(origin / WIDTH) + dy * distance,
        );
        ray?.cells.push(position);
        const occupant = habitat.occupied[position];
        let channel: number;
        if (habitat.walls[position]) channel = 1;
        else if (occupant === organism.id) {
          if (ray) ray.stop = 'self';
          break;
        } else if (occupant) {
          const seen = habitat.organisms.get(occupant)!;
          channel = seen.genome.cells[positions(seen).indexOf(position)].type === 6 ? 3 : 2;
        } else if (habitat.food[position]) channel = 0;
        else continue;
        inputs[channel] = Math.max(inputs[channel], (senses.range + 1 - distance) / senses.range);
        if (ray) ray.stop = (['food', 'wall', 'body', 'stinger'] as const)[channel];
        break;
      }
    }
  }
  const temperatures: { position: number; value: number }[] = [];
  if (senses.temperature) {
    const origin = origins[0];
    for (const [input, offset] of [null, 0, 3, 1].entries()) {
      const [dx, dy] = offset === null ? [0, 0] : headings[(organism.rotation + offset) % 4];
      const position = index((origin % WIDTH) + dx, Math.floor(origin / WIDTH) + dy);
      const value = temperatureAt(position);
      inputs[6 + input] = value;
      temperatures.push({ position, value });
    }
  }
  return {
    inputs,
    available,
    temperatures,
    eyeCost: eyeCount * offsets.length * senses.range * EYE_CELL_COST,
    temperatureCost: temperatures.length * TEMPERATURE_SAMPLE_COST,
    action: 'rest',
  };
}

function scanSight(
  organism: Organism,
  habitat: Habitat,
  trace?: Perception,
  inputs?: number[],
): number {
  const behavior = organism.genome.behavior;
  const origins = positions(organism),
    heading = organism.rotation,
    [dx, dy] = headings[heading],
    candidates: {
      distance: number;
      category: number;
      eye: number;
      heading: number;
      flee: boolean;
    }[] = [];
  for (const [eye, cell] of organism.genome.cells.entries()) {
    if (cell.type !== 8) continue;
    const origin = origins[eye],
      ray: PerceptionRay | undefined = trace
        ? { eye, origin, heading, cells: [], stop: 'range', reaction: null }
        : undefined;
    if (ray) trace!.rays.push(ray);
    for (let distance = 1; distance <= 5; distance++) {
      const p = index((origin % WIDTH) + dx * distance, Math.floor(origin / WIDTH) + dy * distance),
        occupant = habitat.occupied[p];
      if (ray) ray.cells.push(p);
      let category: (typeof categories)[number];
      if (habitat.walls[p]) category = 'wall';
      else if (occupant === organism.id) {
        if (ray) ray.stop = 'self';
        break;
      } else if (occupant) {
        const seen = habitat.organisms.get(occupant)!;
        category = seen.genome.cells.some((part) => part.type === 6) ? 'dangerous' : 'harmless';
      } else if (habitat.food[p]) category = 'food';
      else continue;
      if (inputs) {
        const input = ['food', 'wall', 'harmless', 'dangerous'].indexOf(category);
        inputs[input] = Math.max(inputs[input], (6 - distance) / 5);
      }
      const reaction =
        !inputs && behavior.mode === 'evolved' ? behavior.reactions[category] : 'ignore';
      if (ray) {
        ray.stop = category;
        ray.reaction = reaction;
      }
      if (reaction !== 'ignore')
        candidates.push({
          distance,
          category: categories.indexOf(category),
          eye,
          heading,
          flee: reaction === 'flee',
        });
      break;
    }
  }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance || a.category - b.category || a.eye - b.eye || a.heading - b.heading,
  );
  const chosen = candidates[0];
  if (trace) trace.chosenEye = chosen?.eye ?? null;
  return chosen ? (chosen.heading + 3 + (chosen.flee ? 2 : 0)) % 4 : organism.direction;
}
