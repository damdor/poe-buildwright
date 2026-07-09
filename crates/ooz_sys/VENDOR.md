# Vendored sources

## ooz (Oodle decompressor)

- Upstream: <https://github.com/zao/ooz> — the PoE-tooling-maintained
  fork of <https://github.com/powzix/ooz> (chosen over upstream for
  Linux/CMake support and the simde portability layer).
- Commit: `ff5aeb9e45e362e8d6bb1199aa82406285dd2a18`
- Files (fetched at build, not committed): `vendor/{kraken.cpp,bitknit.cpp,lzna.cpp,stdafx.h}`
- **License: GPL-3.0-or-later — with a wrinkle.** Only `kraken.cpp`
  carries a license header (GPL-3.0-or-later, Copyright 2016 Powzix).
  `lzna.cpp` and `bitknit.cpp` have **no header at all** and neither
  powzix's repo nor zao's fork ships a LICENSE file, so those two
  files are formally unlicensed (see powzix/ooz issue #10, open since
  2016 with no author response). Note docs/native-data-miner.md
  originally said "public domain" — wrong on every count.
  Consequences: these sources are NOT distributable by this repo, so
  **they are not in it** — build.rs fetches each file from zao/ooz at
  the pinned commit (SHA-256 verified) into the gitignored vendor/
  dir at first build. Every user downloads the sources themselves
  directly from upstream; this repo distributes only the recipe.
  Binaries linking this crate are GPL at best and must not be
  distributed either — the mining pipeline is build-it-yourself by
  design. If binary distribution ever matters, the clean alternatives
  are (a) the `oodle_loader` pattern from trumank/repak (MIT/Apache
  wrapper that downloads Epic's officially-distributed Oodle SDK
  binaries at runtime, SHA-256-pinned), or (b) finishing our
  pure-Rust port.
- Modifications: **none**. The decode-only build is achieved with
  `-DOOZ_BUILD_DLL=1` (build.rs), which compiles out the CLI half of
  kraken.cpp (`#if !OOZ_BUILD_DLL` … EOF) — same as upstream's
  `libooz` CMake target.

## simde (SIMD portability headers)

- Upstream: <https://github.com/simd-everywhere/simde> (MIT), pinned by
  zao/ooz as a submodule.
- Commit: `dd0b662fd8cf4b1617dbbb4d08aa053e512b08e4`
- Files: `vendor/simde/` — only the 14 headers reachable from
  `#include <simde/x86/sse2.h>` (verified with `g++ -E -H`), not the
  full ~20 MiB tree.
- Modifications: none.

## Updating

1. Clone zao/ooz + its simde submodule, note both commit hashes.
2. Re-copy the file lists above; re-run `g++ -E -H` to catch any new
   simde transitive includes.
3. Update the hashes here and run `cargo test -p ooz_sys` with
   `OOZ_SYS_TESTDATA` pointing at a powzix/ooz `testdata/` checkout.
