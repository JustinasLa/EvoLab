# Spatial event capture

Spatial event capture records where reproductive births, deaths, feeding and
stinger transfers actually happen. The simulation worker records events as they
occur. Nothing is inferred later from the organisms that are still alive. This is
artificial-life evidence, not a calibrated biological measurement.

## Turning it on

Open **Ecosystem → Spatial event capture** and tick **Capture spatial births,
deaths, feeding and attacks**. Capture is off for every new tab.

- Enabling starts a fresh pending window at the current world tick. Earlier events
  are unknown.
- Unticking discards all captured evidence. Ticking again starts afresh at the
  tick where you enabled it.
- Reset (reseeding) and a successful world import discard evidence. If capture
  stays ticked, it restarts at the new world's tick and reports that a world
  replacement cleared earlier evidence. A rejected import keeps the current world
  and its evidence.
- Pausing, single-step inspection, panel changes, habitat rendering on/off and
  visibility changes never add, close or reset windows. Only completed logical
  ticks and manual erasures change the evidence.
- Evidence lives only in the worker for this session. It is not in world saves,
  checkpoints or measurement downloads, and there is no version change to any of
  those formats.

## Bins and windows

| Property  | Value                                                                                   |
| --------- | --------------------------------------------------------------------------------------- |
| Bin size  | 16 × 16 world tiles                                                                     |
| Bin grid  | ⌈240 / 16⌉ × ⌈156 / 16⌉ = 15 × 10 = 150 bins; the bottom row is 12 tiles tall (partial) |
| Bin index | `row × 15 + column`, with `column = ⌊x / 16⌋` and `row = ⌊y / 16⌋`                      |
| Window    | Nonoverlapping, 300 logical ticks, aligned to multiples of tick 0                       |
| Retention | Six completed windows plus the pending one; the oldest is evicted                       |

A window `(from, to]` contains ecological events from ticks `from + 1` through
`to`. Manual erasures made while the world is paused at tick `t` belong to the
window that holds tick `t + 1`. A window closes when its last tick completes. The
first window is partial when capture starts between boundaries, and the panel
labels it **Complete, partial**. The pending window reports how many ticks it has
covered so far. After an eviction, the panel names the tick where retained
evidence starts.

## Event locations

All positions are the engine's wrapped coordinates, so an event at the right or
bottom edge never lands in a bin outside the world.

| Channel                              | Location                                          | Unit                   |
| ------------------------------------ | ------------------------------------------------- | ---------------------- |
| Births                               | Offspring origin on a successful reproductive birth | events                 |
| Starvation / age deaths              | Organism origin when it dies                      | events                 |
| Manual removals                      | Organism origin when Erase removes it             | events                 |
| Feedings, food energy                | The eating mouth cell (not the food tile)         | events, energy units   |
| Stinger transfers, drained / gained  | The contacted target tile (not the stinger cell)  | events, energy units   |

Planting a design is not a birth. Manual removals are kept separate from
ecological deaths. A stinger contact counts only when it moves energy. Armored
targets, and nutrient-cycle victims that have no energy left, are not counted.
Energy is the engine's abstract energy unit. Feeding energy is the actual mouth
gain. Drained and gained energy are the victim's actual loss and the attacker's
actual gain, which differ. Each window also keeps running totals, summed in event
order. Over the same ticks they equal the telemetry ledgers: births, deaths by
cause, `mouthsGained`, `stingsDrained` and `stingsGained`.

## Bounds and cost

Storage is fixed by the world size: seven windows × (150 bins × 9 channels + 9
totals) × 8 bytes = 76,104 bytes of `Float64Array`. Recording an event costs one
bin lookup and at most three array additions. A window rotation once every 300
ticks clears and reuses the evicted buffer (1,359 values). Capture draws no random
numbers, changes no update order and evaluates no extra senses. Complete world
continuations with capture on and off are identical.

The page receives only a bin-free summary per window: totals and the number of
bins that hold any event. Per-bin maps, overlays and regional tables are later
steps of the spatial observatory.
