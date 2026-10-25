# Inspiration and third-party credits

[Project index](README.md)

EvoLab's source is copyright 2026 Justinas Launikonis, under Artistic License 2.0.
Dependencies retain their own licenses.

## Inspiration

[The Life Engine](https://thelifeengine.net/) by Max Robinson / Emergent Garden
inspired the open-ended ecosystem of organisms built from functional cells.
Its [source](https://github.com/MaxRobinsonTheGreat/EvolutionSimulatorV2) is a
separate GPL-3.0 project. EvoLab uses an original implementation and interface;
no upstream code, artwork, branding or other assets are copied. The drifting
climate, inherited temperature traits, tolerance tradeoff and world-file format
are implemented in this repository.

## Bundled assets

- [DM Sans](https://github.com/googlefonts/dm-fonts), SIL Open Font License 1.1,
  bundled through `@fontsource-variable/dm-sans`.
- [DM Mono](https://github.com/googlefonts/dm-mono), SIL Open Font License 1.1,
  bundled through `@fontsource/dm-mono`.

Complete font notices ship in `public/third-party.txt` and the static build.
The interface icons, organism previews and world rendering are drawn in code.
No external models, textures, TF assets or recorded player data are bundled.

Vite, TypeScript, Vitest, jsdom, Prettier and Playwright are development tools;
their packages contain their license notices. Exact dependencies are pinned in
`package-lock.json`. The retired rigid-body engine is no longer a dependency.
