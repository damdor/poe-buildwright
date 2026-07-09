# 2026-07-02 — CDN mining breakthrough: no game install needed

The plan was to build the miner against a local PoE2 install on the
Bazzite box. Today that constraint dissolved: **GGG's patch CDN serves
every bundle publicly**, and the whole chain now runs live from the
Arch dev machine.

What landed:

- **`crates/ooz_sys`** — vendored zao/ooz (decode-only via
  `-DOOZ_BUILD_DLL=1`, zero source patches). Kills the multi-week
  Oodle porting project in an afternoon: Kraken, Mermaid, Hydra,
  Leviathan all decode. The hand-port survives behind the
  `oodle-port` feature as a someday-replacement. License reality
  check: ooz is *not* public domain — kraken.cpp is GPL-3.0-or-later
  and lzna/bitknit are formally unlicensed. Private repo + never
  distributing miner binaries makes this fine; VENDOR.md has the
  full analysis and escape hatches. *(Update, pre-open-sourcing:
  the sources were removed from the repo entirely — build.rs now
  fetches them from zao/ooz at a pinned, hash-verified commit, so the
  public repo distributes neither the GPL nor the unlicensed files.)*
- **`data_miner::fetch`** — patch-server handshake
  (`patch.pathofexile2.com:13060`, `[0x01, 0x06]` → UTF-16LE CDN base
  URL) + curl-based version-keyed cache. Protocol verified by live
  wire capture before implementation.
- **`data_miner::index`** — full `_.index.bin` parser: bundle/file
  records, nested path-spec bundle, the alternating-phase path
  generator, and Murmur seed recovery by inverting the hash
  finalizer. Against the live `4.5.4.1.3` index: 61,605 bundles,
  4,201,992 files, 4,201,987 paths resolved (~3 s warm, end to end).
- **`cdn` CLI** — `info` / `index` / `find` / `get`. Proof shot:
  `cdn get data/balance/passiveskills.datc64` pulls one 5.5 MB table
  out of a single bundle fetch.

Strategic consequences:

- Patch-day updates no longer wait on Steam or PoB: the miner can
  pull new data minutes after GGG flips the CDN. The
  detect → fetch → mine → diff → deploy loop is now realistic to
  automate.
- The Bazzite install is demoted to fallback/offline source.
- Old CDN versions 404 immediately after a patch — archive every
  mined patch in `data/parsed/<patch>/` forever, because there is no
  re-fetching the past.

Next: `.datc64` reader + dat-schema loader, then the tree/skills/items
extractors and DDS→WebP art. Also noted: CDN version `4.5.4.1.3` maps
to marketing `0.5.4` — provenance manifests should record both.
