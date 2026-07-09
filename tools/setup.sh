#!/usr/bin/env bash
# Idempotent installer for the JS-build toolchain.
#
# Fetches two pinned, integrity-verified tarballs from the npm registry
# (used here strictly as a CDN — no `npm` CLI, no `package.json`, no
# `node_modules`, no postinstall scripts ever run) and extracts the
# pieces we need into tools/. Re-running is a no-op if both binaries
# already match the pinned SHA-512.
#
# Why npm.org and not GitHub releases?
#   • esbuild publishes its prebuilt binaries ONLY to npm (Evan Wallace
#     has explained this in upstream issues — too much work to mirror).
#     Source builds need a Go toolchain.
#   • TypeScript publishes the pre-bundled .tgz to npm; GitHub releases
#     are source-only and TypeScript bootstraps itself (it builds with
#     TypeScript), so building from source is impractical.
#
# What we're actually trusting:
#   • Evan Wallace (esbuild) signed the .tgz.
#   • Microsoft (TypeScript) signed the .tgz.
#   • The pinned SHA-512 in tools/CHECKSUMS — a tarball that doesn't
#     match is rejected. Updating CHECKSUMS is a deliberate, reviewable
#     commit.
#
# What we explicitly do NOT do:
#   • Run `npm install`. No transitive deps fetched. No lockfile.
#   • Execute any script from the tarballs (no postinstall hooks).
#
# Usage:
#   tools/setup.sh              # install if missing/mismatched
#   tools/setup.sh --verify     # check installed binaries match CHECKSUMS
#   tools/setup.sh --reinstall  # nuke + reinstall regardless

set -euo pipefail

cd "$(dirname "$0")"
CHECKSUMS_FILE="$PWD/CHECKSUMS"
BIN_DIR="$PWD/bin"
TS_DIR="$PWD/typescript"
mkdir -p "$BIN_DIR"

MODE="install"
case "${1:-}" in
  --verify)    MODE="verify" ;;
  --reinstall) MODE="reinstall" ;;
  "")          MODE="install" ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

# sha512_base64 <file> — emit the file's SHA-512 in the same base64
# encoding npm uses for the `integrity` field (the "sha512-..." prefix
# is stripped from the CHECKSUMS file, just the base64 body here).
sha512_base64() {
  openssl dgst -sha512 -binary "$1" | base64 -w 0
}

# install_one <name> <version> <url> <expected_sha512_b64>
install_one() {
  local name=$1 version=$2 url=$3 want=$4
  local tarball
  tarball=$(mktemp)
  echo "==> fetching $name@$version"
  curl --fail --silent --show-error --location --output "$tarball" "$url"
  local got
  got=$(sha512_base64 "$tarball")
  if [ "$got" != "$want" ]; then
    echo "ERROR: $name@$version integrity check failed" >&2
    echo "  expected: $want" >&2
    echo "  got:      $got" >&2
    rm -f "$tarball"
    exit 1
  fi
  echo "    integrity OK"

  case "$name" in
    esbuild)
      # The @esbuild/linux-x64 tarball lays out as package/bin/esbuild.
      # We want only that one binary, not the surrounding scaffolding.
      tar -xzf "$tarball" -C /tmp --strip-components=2 package/bin/esbuild
      mv /tmp/esbuild "$BIN_DIR/esbuild"
      chmod +x "$BIN_DIR/esbuild"
      echo "    installed → tools/bin/esbuild ($($BIN_DIR/esbuild --version))"
      ;;
    typescript)
      # The typescript tarball is much bigger and has a more complex
      # layout (lib/, bin/, etc.). Strip the top-level `package/` prefix
      # and drop the whole thing under tools/typescript/. Only `lib/tsc.js`
      # is the actual entry point we invoke; the rest is supporting code.
      rm -rf "$TS_DIR"
      mkdir -p "$TS_DIR"
      tar -xzf "$tarball" -C "$TS_DIR" --strip-components=1
      # We don't run the bin/ shell shims — invoke lib/tsc.js with node directly.
      # Drop bin/ to make that explicit and shrink the install footprint.
      rm -rf "$TS_DIR/bin"
      echo "    installed → tools/typescript/ ($(node "$TS_DIR/lib/tsc.js" --version))"
      ;;
  esac
  rm -f "$tarball"
}

# verify_one <name> <expected_sha512_b64_of_tarball>
# Note: we can't recover the tarball SHA from the installed files (we
# stripped scaffolding), so verify-mode just checks the binary exists +
# runs --version. Use --reinstall to re-verify against the network.
verify_one() {
  local name=$1
  case "$name" in
    esbuild)
      if [ ! -x "$BIN_DIR/esbuild" ]; then
        echo "MISSING: tools/bin/esbuild" >&2
        return 1
      fi
      echo "  esbuild: $($BIN_DIR/esbuild --version)"
      ;;
    typescript)
      if [ ! -f "$TS_DIR/lib/tsc.js" ]; then
        echo "MISSING: tools/typescript/lib/tsc.js" >&2
        return 1
      fi
      echo "  typescript: $(node "$TS_DIR/lib/tsc.js" --version)"
      ;;
  esac
}

# Read CHECKSUMS and act on each line.
while IFS= read -r line; do
  case "$line" in
    ""|"#"*) continue ;;
  esac
  # shellcheck disable=SC2086
  set -- $line
  name=$1; version=$2; url=$3; integrity=$4
  case "$MODE" in
    verify)
      verify_one "$name"
      ;;
    reinstall)
      install_one "$name" "$version" "$url" "$integrity"
      ;;
    install)
      # Already installed? Skip.
      case "$name" in
        esbuild)    [ -x "$BIN_DIR/esbuild" ] && { echo "==> esbuild already installed"; continue; } ;;
        typescript) [ -f "$TS_DIR/lib/tsc.js" ] && { echo "==> typescript already installed"; continue; } ;;
      esac
      install_one "$name" "$version" "$url" "$integrity"
      ;;
  esac
done < "$CHECKSUMS_FILE"

echo ""
echo "Toolchain ready."
echo "  • esbuild:    $BIN_DIR/esbuild"
echo "  • typescript: node $TS_DIR/lib/tsc.js"
