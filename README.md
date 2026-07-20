# poe-buildwright

An unofficial, non-commercial, fan-made **build planner for Path of
Exile 2 — and the original Path of Exile's passive tree** — rendered
with the games' own art. PoE2 gets the full toolkit: skill gems with
real per-level numbers, gear, leveling snapshots, a scrubable
timeline, a typeset Build Guide, and `.build` files the game reads
directly. PoE1 gets its real current-league tree with GGG-exact presentation
(in-place ascendancy circles, attribute totals, pick-one notables),
planned from the same one-page planner.

Built **agent-first**: any AI assistant that can browse can create a
working build here (via [`/llms.txt`](viewer/llms.txt) and the
`#agent=` URL contract) or turn a finished build into a written
leveling guide — no login, no API key.

> This product isn't affiliated with or endorsed by Grinding Gear
> Games in any way. All Path of Exile 2 game content, images, and
> materials are trademarks and copyrights of Grinding Gear Games —
> and are **not** distributed in this repository. The data pipeline
> regenerates everything locally from GGG's own CDN.

## How it's built

Two halves, one repo:

1. **A first-party data pipeline** (Rust): mines GGG's public CDN for
   the game's own `.datc64` tables, stat-description files, and DDS
   art; shapes them into versioned, hash-manifested TSV datasets; and
   bakes the JSON catalogues the site serves. No third-party data
   sources except GGG's own
   [skilltree export](https://github.com/grindinggear/poe2-skilltree-export)
   and Path of Building's pinned unique-item recipes (the one thing
   GGG ships no table for).
2. **A static site** (TypeScript, zero frameworks): a WebGL2 passive
   tree, overlay panels for gems/gear/snapshots, and the Build Guide.
   Everything is plain esbuild-bundled TS served as static files —
   the only server-side code is two small Cloudflare Pages Functions.

```
crates/
  data_miner/    CDN client, bundle index, .datc64 reader, DDS/PNG,
                 stat-description (.csd) renderer, dataset shapers
  buildwright/   the ops CLI — mine / shape / sprites / skill-stats /
                 catalogues / manifest / verify / render / serve / js
  tree_render/   emits planner.html (TREE blob + bundled planner JS)
  serve/         tiny static file server for local dev
  json/, hash/   self-contained JSON + SHA-256 (no external deps)
viewer/          the static site (planner assets, wizard pages,
                 Cloudflare Pages Functions, llms.txt, agent data)
docs/            design docs + data contracts + dev diary
```

## Quickstart

Prereqs: Rust (stable) and optionally Chromium (headless screenshot
checks). The JS toolchain (esbuild + Deno, pinned and hash-verified,
any of macOS/Linux × arm64/x64) installs itself into `tools/bin/` via
`tools/setup.sh` — no npm, no node.

Everything runs through one discoverable ops CLI — `./bw` (a thin
wrapper around `cargo run -p buildwright`). Run it bare for the full
menu with grouped commands and per-command help:

```sh
./bw                  # the menu: every operation, grouped + explained
./bw help <command>   # detailed help for any command

./bw update-native    # one command: mine GGG's CDN → shape datasets →
                      # sprites → catalogues → manifest (~minutes)
./bw serve            # the site on http://127.0.0.1:8000

# No PoE2 install? `./bw fixture` renders a committed toy tree with
# procedural placeholder art — a fully working planner, zero game data.
```

Every derived dataset is integrity-manifested (`./bw manifest` writes
SHA-256s, `./bw verify` gates hashes + referential completeness), so a
patch re-mine is diffable and repeatable.

## For AI agents

- [`viewer/llms.txt`](viewer/llms.txt) — the entry point: the
  `#agent=` build-plan URL contract, grounding data endpoints
  (`/assets/agent/*`), and the validation endpoint.
- PoE1: same contract on `/planner-poe1.html`, grounded by
  `/assets/poe1-agent/*` — see the
  [PoE1 primer](viewer/assets/poe1-agent/primer.md) (point budgets,
  the %-life-on-tree rule, suppression, defence layers) and two
  worked examples modeled on poe.ninja meta builds.
- The Summary of a finished build is embedded on the planner as
  chronological JSON ("Copy for agent" in the Build Guide) with
  writing hints for producing a human leveling guide.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
GitHub issues are also the contact channel for anything else
(including takedown or licensing requests).

## License

Site code and original content © Damdor, licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md): free for any
noncommercial use; commercial use requires permission. Game content
remains © Grinding Gear Games and is not covered by (or contained in)
this repository.
