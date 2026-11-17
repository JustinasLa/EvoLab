# Neural ablation masks

Neural ablation asks whether one decision depends on one part of a tiny
controller. This page defines what a mask is and how masked inference behaves.
It is the first step of the neural ablation experiments. Running
control/treatment pairs and choosing masks in the interface come in later
steps, so this release adds no new control. This is artificial life: a mask
shows dependence in one scene, not what a neuron "means".

## Supported controller

Only the fixed feed-forward controller version 1 is supported: six inputs,
four hidden neurons and four outputs, with 40 weights and 8 biases in −4…4.
Expanded-senses controllers (version 2) are rejected. So are any future
recurrent, learning or sensory versions, until their own contracts define
state and sensor meaning. Nothing is converted to fit.

## Mask types

A treatment branch carries exactly one mask.

| Kind         | Index | Effect                                                                                       |
| ------------ | ----- | -------------------------------------------------------------------------------------------- |
| `input`      | 0–5   | That observation is read as 0 by all four hidden neurons.                                    |
| `connection` | 0–39  | That one weighted contribution is removed. The rest of the network is unchanged.             |
| `hidden`     | 0–3   | That neuron's activation is forced to 0 after activation, so its bias is removed with its inputs. |

Connections follow the weight layout that inference reads:

- **0–23: input → hidden.** Hidden neuron `⌊i / 6⌋` reads input `i mod 6`.
- **24–39: hidden → output.** With `j = i − 24`, output `⌊j / 4⌋` reads hidden
  neuron `j mod 4`.

Outputs are `rest`, `forward`, `left` and `right`. They cannot be masked.

## Decisions, ties and costs

Masked inference uses the same function the engine uses. Hidden and output
sums are clamped to −1…1. The first highest output wins, in the order rest,
forward, left, right. There is no special fallback to rest. Inputs must be
the six real observations, each a finite value in 0…1.

A mask changes which action is chosen, never what it costs. Both branches pay
0.02 E for every evaluation. They also pay 0.03 E for a non-rest action when the
body has a motor. Version-1 controllers have no separate sensing cost, so a
masked organism is never cheaper to run. Inference draws no random numbers.

## Recipe

A mask is stored only in its own versioned experiment recipe (at most
1,024 bytes). It never enters a genome, world, blueprint, checkpoint or
library entry:

```json
{
  "format": "evolab-drift-neural-ablation",
  "version": 1,
  "controllerVersion": 1,
  "target": { "scope": "organism", "organismId": 42 },
  "mask": { "kind": "hidden", "index": 2 }
}
```

The reader rejects:

- unknown or missing fields;
- other recipe or controller versions;
- a list of masks;
- output or bias masks;
- indices outside the ranges above.

## Target scope

The mask applies only to the selected organism, through a private masked copy
of its controller. Its genome stays unchanged. Its offspring inherit that
unmasked controller and are labeled **descendants**. Their births and deaths
stay countable, so their outcomes can still be measured. When the target dies,
the intervention ends for good. Only living descendants are tracked, so the
record stays within the population limit.
