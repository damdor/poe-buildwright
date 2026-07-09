# 2026-07-03 — Operational CLI + deferred UX punch list

## Context from the last session (2026-07-02)

Big day: CDN mining works end-to-end (fetch → index → extract a real
`.datc64` from GGG's public CDN, no install), the 0.5 tree-art
regression is fixed (webp sprite sheets), masteries are no longer
hover targets, and we have GGG's exact mastery-lighting model parsed
from live tables. All committed + pushed. Deploy is blocked only on a
fresh Cloudflare API token (the old one is invalid — user action).

## This session: the operational CLI

Decision (user + me aligned): retire the Python/Lua/shell script pile
in favour of a single well-polished Rust operational CLI, `buildwright`.
Rationale: the native miner already replaces the extraction scripts on
the roadmap; a Makefile would just codify an ecosystem we're deleting.
Fewer runtime deps (drop python + magick + unzstd + lua), one audited
locked-toolchain binary, patch-day = one command. See the scripts
inventory + disposition in `docs/ops-cli-plan.md`.

Two operator scenarios the CLI must serve (from the user):

1. **Pre-release / preview** — imperfect data before a patch ships, so
   people can theorycraft during peak hype. Prefer pulling GGG's own
   preview the way other tools do; fall back to PoB2-fork / poedb2 or
   hand-entered overlays. Data is badged non-authoritative.
2. **Post-release / first-party** — our own CDN mining: detect → fetch
   → mine → render → verify → deploy, endlessly repeatable.

## Deferred UX punch list (do later — not lost)

Full detail: `docs/ux-polish-punchlist-addendum.md`. Already shipped:
the silent-flash-message fix (#1). Remaining, prioritized by the two
USPs (tree feel + timeline):

- **Zoom is one-way** — min-zoom clamp (0.05) is 3× full-fit (0.0165)
  and the `#zoomfit` button doesn't exist in the HTML. Add a fit
  control; loosen the clamp. **(S — best effort/impact)**
- **Capture chips only say "1–7"** — communicate "passives + gems
  (+ gear later)"; per-chip counts / mini gem icons / reserved dimmed
  gear slot. **(M — the timeline story)**
- **Editing while viewing a frozen snapshot lands in the wrong
  capture** (reproduced). Needs an explicit rule + feedback. **(M)**
- **Allocated build near-invisible at overview zoom** — clamp
  allocated-edge width in screen px. **(M/L)**
- **Full-fit overscan** — emitted bounds ~44 % larger than node
  extents; fit to extents. **(M)**
- **Gem icons** — `skill_catalogue.json` already carries icon paths
  for ~800/901 gems + colour fallback; 24 px in picker rows, 20 px in
  the strip, 14 px on chips. **(M)**
- **No visible replay state while scrubbing** — "current" chip stays
  gold in history. **(S/M)**
- Still-true from the first audit: mobile breakage, `--wc-muted`
  contrast, token drift across the 4 token copies. **(S–M)**

Verify-on-real-GPU: the teal cluster glow showed a hard rectangular
sprite edge in two headless shots — flag, not confirmed bug.
