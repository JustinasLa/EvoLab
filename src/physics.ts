import { World, Vec2, Box, RevoluteJoint, type Body } from 'planck';
import { clamp, type Course, type Genome, type Settings, type Trial } from './model';

export const STEP = 1 / 60;
export const TRIAL_SECONDS = 8;
export interface Ground {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function terrain(course: Course): Ground[] {
  if (course === 'gaps')
    return [
      { x: -6, y: -0.5, width: 28, height: 1 },
      ...Array.from({ length: 12 }, (_, i) => ({ x: 13 + i * 7, y: -0.5, width: 4, height: 1 })),
    ];
  const floor = { x: 45, y: -0.5, width: 130, height: 1 };
  if (course === 'steps')
    return [
      floor,
      ...Array.from({ length: 18 }, (_, i) => ({
        x: 7 + i * 2.5,
        y: (0.2 + (i % 4) * 0.18) / 2,
        width: 1.6,
        height: 0.2 + (i % 4) * 0.18,
      })),
    ];
  return [floor];
}

function center(bodies: Body[]): number {
  const mass = bodies.reduce((sum, b) => sum + b.getMass(), 0);
  return bodies.reduce((sum, b) => sum + b.getPosition().x * b.getMass(), 0) / mass;
}

export function evaluate(genome: Genome, settings: Settings, record = true): Trial {
  const world = new World(Vec2(0, -settings.gravity));
  const ground = world.createBody();
  for (const t of terrain(settings.course))
    ground.createFixture(Box(t.width / 2, t.height / 2, Vec2(t.x, t.y)), { friction: 0.85 });
  const bodies: Body[] = [];
  const joints: RevoluteJoint[] = [];
  for (const [i, g] of genome.genes.entries()) {
    const parent = bodies[g.parent];
    const angle = i === 0 ? 0 : parent.getAngle() + g.angle;
    const pg = genome.genes[g.parent];
    const anchor =
      i === 0
        ? Vec2(0, 3)
        : Vec2(
            parent.getPosition().x + (Math.cos(parent.getAngle()) * pg.length) / 2,
            parent.getPosition().y + (Math.sin(parent.getAngle()) * pg.length) / 2,
          );
    const position =
      i === 0
        ? anchor
        : Vec2(
            anchor.x + (Math.cos(angle) * g.length) / 2,
            anchor.y + (Math.sin(angle) * g.length) / 2,
          );
    const body = world.createDynamicBody({
      position,
      angle,
      linearDamping: 0.12,
      angularDamping: 0.15,
    });
    body.createFixture(Box(g.length / 2, g.width), {
      density: 2,
      friction: 0.85,
      filterGroupIndex: -1,
    });
    bodies.push(body);
    if (i > 0)
      joints.push(
        world.createJoint(
          new RevoluteJoint(
            {
              enableMotor: true,
              maxMotorTorque: g.torque,
              motorSpeed: 0,
              enableLimit: true,
              lowerAngle: -1.45,
              upperAngle: 1.45,
            },
            parent,
            body,
            anchor,
          ),
        )!,
      );
  }
  const bottom = Math.min(
    ...bodies.map(
      (b, i) =>
        b.getPosition().y -
        (Math.abs(Math.sin(b.getAngle())) * genome.genes[i].length) / 2 -
        genome.genes[i].width,
    ),
  );
  for (const body of bodies)
    body.setPosition(Vec2(body.getPosition().x, body.getPosition().y - bottom + 0.06));
  // Recreate joint anchors after translation: moving all bodies equally preserves local anchors.
  for (let i = 0; i < 36; i++) world.step(STEP);
  const start = center(bodies);
  const frames: number[][] = [];
  let energy = 0;
  let distance = 0;
  let tailSum = 0;
  let tailCount = 0;
  for (let step = 0; step < TRIAL_SECONDS / STEP; step++) {
    for (const [j, joint] of joints.entries()) {
      const g = genome.genes[j + 1];
      const target = Math.sin(step * STEP * g.frequency * Math.PI * 2 + g.phase) * g.amplitude;
      joint.setMotorSpeed(clamp((target - joint.getJointAngle()) * 9, -10, 10));
      energy += Math.abs(joint.getMotorTorque(60) * joint.getJointSpeed()) * STEP;
    }
    world.step(STEP);
    distance = center(bodies) - start;
    if (step >= 420) {
      tailSum += distance;
      tailCount++;
    }
    if (record && step % 3 === 0)
      frames.push(bodies.flatMap((b) => [b.getPosition().x, b.getPosition().y, b.getAngle()]));
    if (bodies[0].getPosition().y < -6 || !Number.isFinite(distance)) break;
  }
  const progress = tailCount ? tailSum / tailCount : Math.min(distance, 0);
  const fitness = Number.isFinite(progress) ? progress - energy * 0.0002 : -100;
  return { genome, fitness, distance: Number.isFinite(distance) ? distance : 0, energy, frames };
}
