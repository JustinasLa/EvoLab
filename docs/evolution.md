# How evolution works

[Project index](README.md)

## Body and controller

A creature is a connected tree of 3–10 rectangular rigid bodies. New random
creatures begin with 4–7. Every segment after the root names an earlier segment as
its parent, so cycles and disconnected limbs cannot occur. Segment-to-segment
collisions are disabled; every segment collides with the terrain.

Each joint has a bounded motor and angle limits. A sinusoidal controller supplies
a desired angle, and proportional feedback converts its error into motor speed.
The genome contains length, thickness, attachment angle, oscillation frequency,
phase, amplitude, and torque. The root's initial angle is always zero.

Mutation independently perturbs these values with the configured probability,
within fixed bounds. It can add a new leaf or remove the final leaf. Changes to
body shape and controller happen together; no pretrained model or scripted gait
is involved. Movement is constrained by Planck's rigid-body physics, not biological
muscle anatomy.

## Trials and fitness

Every candidate gets a fresh world with identical gravity and terrain. The body
is positioned just above the floor and allowed to settle for 36 fixed steps.
The start position is then measured using the body's mass-weighted center.

The trial lasts eight seconds at 60 fixed physics steps per second. Fitness is:

```text
mean forward displacement during the final second
  − 0.0002 × accumulated absolute motor work
```

Motor work is estimated from joint torque times angular velocity, integrated
over time. It is a small regularizer, not a calibrated metabolism. Using average
late displacement discourages one lucky last-frame jump. Measuring from the
settled center avoids awarding extra starting reach to a larger body.

If the root falls below −6 m the trial ends. A fall before the final second earns
no positive displacement reward and still pays its motor-work penalty. A later
fall can retain already accumulated final-second progress; this is a toy fitness
function, not a proof against all physics exploits. The visible travelled
distance is final displacement, which differs from energy-adjusted fitness.

## Selection

Candidates are ranked by fitness. The best two are retained unchanged. Most new
creatures are mutated descendants sampled uniformly from the top quarter (at
least three parents); one fresh random creature provides continuing exploration.

An imported founder is retained unchanged as the first member of the new initial
population. Other initial members are mutated descendants. Later generations use
normal selection and the random wildcard.

The seed drives a bounded 32-bit Mulberry32 generator. Identical settings and seed
reproduce a run in the same runtime. Floating-point and physics-engine differences
mean bit-identical results across browser versions and devices are not promised.

## Environments

- **Meadow:** one flat floor from −20 m to 110 m.
- **Steps:** the meadow plus 18 low obstacles, with repeating heights.
- **Gaps:** a starting platform ending at 8 m, then twelve separated platforms.

Course geometry is fixed. The world seed controls creatures and mutation, not
terrain generation. Gravity ranges from 1.6 to 20 m/s². Settings changes start
a new run because fitness from different environments is not comparable.

There is no crossover, neural network, food chain, reproduction inside the
physical world, or claim of realistic biological evolution in this version.
