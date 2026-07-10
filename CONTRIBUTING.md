# Contributing

Thanks for wanting to help! This is a non-commercial fan project —
keep that spirit: no monetization, no game-client interaction, no
unreleased/spoiler content.

**Maintenance expectations, honestly:** this is a spare-time fan
project, not the maintainer's day job. Issues and PRs are genuinely
welcome and will be read — but reviews happen when there's time and
energy, which may mean days or weeks, and some periods will be quiet.
If a patch drops and the data pipeline needs a re-mine, it'll happen
when it happens. Friendly nudges are fine; expectations of 24/7
support are not. Forks for personal use are always fair game under
the license.

## Licensing of contributions

By submitting a contribution you agree that:

- your contribution is licensed to the project under the same
  [PolyForm Noncommercial 1.0.0](LICENSE.md) terms as the rest of the
  code (inbound = outbound), and
- the maintainer may additionally grant **Grinding Gear Games** a
  license to your contribution for any purpose, including commercial
  use, free of charge — this project's standing promise (see the
  LICENSE.md preamble) is that GGG gets anything they ask for, and
  outside contributions must not be able to block that.

No copyright assignment; you keep ownership of your work.

## How changes land

- **Pull requests only.** Nothing merges to `master` directly; the
  branch is protected. Small, focused PRs with a clear "why" review
  fastest.
- **No CI.** There are deliberately no GitHub Actions here — verify
  locally before opening a PR: `cargo test --release`,
  `./bw typecheck`, and `./bw verify --patch <p>` if you touched the
  pipeline. State in the PR what you ran.
- **On AI-assisted contributions:** using an AI to help write a patch
  is fine — this project is agent-first, after all. What gets closed
  without review is *unverified volume*: auto-generated issues, bulk
  "fix" PRs nobody ran locally, or reports without a reproduction.
  One well-tested change beats ten speculative ones. If an AI wrote
  it, you still own it: run it, understand it, and say so.

## Zero-dependency philosophy

The workspace has no crates.io dependencies (beyond build-time `cc`)
and the TypeScript side has **no package manager at all** — no npm,
no package.json, no node_modules. esbuild and Deno arrive as pinned,
hash-verified binaries via `tools/setup.sh`. The full rationale is at
the top of `Cargo.toml`. PRs that introduce a dependency tree or a
package manager need an extraordinary justification and will
usually be declined.

## Ground rules

- **Never commit game data.** Everything mined from GGG's CDN
  (sprites, TSVs, baked catalogues) is gitignored on purpose — the
  repo ships code only, and each contributor regenerates data locally
  with `update-native`. If `git status` shows game assets, something
  is wrong; don't force-add them.
- **First-party or bust.** Data comes from GGG's CDN, GGG's own
  skilltree-export repo, or (for unique-item mod recipes only) Path of
  Building's pinned export. No scraping third-party wikis/databases.
- Secrets live in `.cloudflare.env` (gitignored; see the `.example`).
  Never print tokens in scripts or commit output.

## Dev loop

All operations go through the `./bw` CLI (run it bare for the menu):

```sh
./bw update-native   # once: mine + shape + bake everything
./bw serve           # http://127.0.0.1:8000

# after editing planner TS/CSS:
./bw typecheck       # deno strict
./bw js              # esbuild bundles
cargo build --release -p tree_render   # planner.css is include_str! — rebuild on CSS edits
./bw render --tree-dir data/parsed/0_5_native/tree

# after editing Rust shapers:
cargo test --release
./bw verify --patch 0_5_native
```

Gotchas the diary learned the hard way:

- `shape tree` rewrites `meta.tsv`, wiping the portrait rows that
  `sprites` appends — always re-run `sprites` before `render` after a
  tree reshape.
- `tree_render` embeds `planner.css` at build time (`include_str!`);
  a CSS edit needs a `cargo build -p tree_render` before `render`.
- Visual changes get verified with headless Chromium screenshots —
  see the harness pattern in the git history (an iframe page +
  `--headless=new --virtual-time-budget`).

## Where things live

- `docs/plan.md` — the architecture plan and data layout.
- `docs/native-data-miner.md` — the CDN mining pipeline in depth.
- `docs/build_contracts.md`, `docs/captures_data_model.md` — the plan
  format and snapshot model the UI persists.
- `docs/agent-builds.md` — the agent URL contract and grounding data.
- `docs/diary/` — dated engineering notes; the "why" behind odd code.

## Style

- Rust: match the existing handler style; datasets get provenance +
  a manifest entry; loud errors over silent partial output.
- TypeScript: strict (deno check); no frameworks, no deps — plain DOM
  and small modules with numeric prefixes for reading order.
- Comments explain constraints the code can't show, not narration.
