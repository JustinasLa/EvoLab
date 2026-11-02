import {
  WIDTH,
  index,
  positions,
  type Perception,
  type PerceptionRay,
  type Organism,
  clamp,
} from './model';

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

export function neuralInputs(
  organism: Organism,
  habitat: Habitat,
  rays?: PerceptionRay[],
): number[] {
  const inputs = [
    0,
    0,
    0,
    0,
    clamp(organism.energy / (organism.genome.cells.length * 3 + 9), 0, 1),
    organism.neuralBlocked ? 1 : 0,
  ];
  scanSight(organism, habitat, undefined, inputs, rays);
  return inputs;
}

function scanSight(
  organism: Organism,
  habitat: Habitat,
  trace?: Perception,
  inputs?: number[],
  rays?: PerceptionRay[],
): number {
  const observedRays = trace?.rays ?? rays;
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
      ray: PerceptionRay | undefined = observedRays
        ? { eye, origin, heading, cells: [], stop: 'range', reaction: null }
        : undefined;
    if (ray) observedRays!.push(ray);
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
