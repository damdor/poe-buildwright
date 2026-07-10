#!/usr/bin/env bash
# Idempotent installer for the JS-build toolchain: esbuild + Deno,
# platform-detected, pinned, integrity-verified.
#
# Fetches per-platform binaries from their canonical sources and drops
# them into tools/bin/. Re-running is a no-op once installed. Every
# artifact must match the SHA-512 pinned in tools/CHECKSUMS or the
# install is refused.
#
# Sources:
#   • esbuild — the npm registry, used strictly as a CDN (no `npm`
#     CLI, no package.json, no node_modules, no postinstall scripts).
#     Evan Wallace publishes prebuilt binaries only there; source
#     builds would need a Go toolchain.
#   • Deno — GitHub release zips (single static binary embedding tsc;
#     the typecheck needs no node and no package manager).
#
# What we explicitly do NOT do:
#   • Run `npm install`. No transitive deps fetched. No lockfile.
#   • Execute anything from the archives (no postinstall hooks).
#
# Usage:
#   tools/setup.sh              # install if missing
#   tools/setup.sh --verify     # check installed binaries respond
#   tools/setup.sh --reinstall  # nuke + reinstall regardless

set -euo pipefail

cd "$(dirname "$0")"
CHECKSUMS_FILE="$PWD/CHECKSUMS"
BIN_DIR="$PWD/bin"
mkdir -p "$BIN_DIR"

MODE="install"
case "${1:-}" in
  --verify)    MODE="verify" ;;
  --reinstall) MODE="reinstall" ;;
  "")          MODE="install" ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

# ---- platform detection ----------------------------------------------------
case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "ERROR: unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "ERROR: unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
PLATFORM="$os-$arch"

# sha512_base64 <file> — SHA-512 in the base64 encoding npm uses for
# `integrity` (the "sha512-" prefix stripped). openssl's own base64
# is used because `base64 -w` isn't portable to macOS.
sha512_base64() {
  openssl dgst -sha512 -binary "$1" | openssl base64 -A
}

# install_one <name> <version> <url> <expected_sha512_b64>
install_one() {
  local name=$1 version=$2 url=$3 want=$4
  local archive
  archive=$(mktemp)
  echo "==> fetching $name@$version ($PLATFORM)"
  curl --fail --silent --show-error --location --output "$archive" "$url"
  local got
  got=$(sha512_base64 "$archive")
  if [ "$got" != "$want" ]; then
    echo "ERROR: $name@$version integrity check failed" >&2
    echo "  expected: $want" >&2
    echo "  got:      $got" >&2
    rm -f "$archive"
    exit 1
  fi
  echo "    integrity OK"

  case "$name" in
    esbuild)
      # The @esbuild/<platform> tarball lays out as package/bin/esbuild.
      # We want only that one binary, not the surrounding scaffolding.
      local tmpdir
      tmpdir=$(mktemp -d)
      tar -xzf "$archive" -C "$tmpdir" --strip-components=2 package/bin/esbuild
      mv "$tmpdir/esbuild" "$BIN_DIR/esbuild"
      chmod +x "$BIN_DIR/esbuild"
      rm -rf "$tmpdir"
      echo "    installed → tools/bin/esbuild ($($BIN_DIR/esbuild --version))"
      ;;
    deno)
      # The release zip contains the single `deno` binary.
      local tmpdir
      tmpdir=$(mktemp -d)
      unzip -q -o "$archive" -d "$tmpdir" deno
      mv "$tmpdir/deno" "$BIN_DIR/deno"
      chmod +x "$BIN_DIR/deno"
      rm -rf "$tmpdir"
      echo "    installed → tools/bin/deno ($($BIN_DIR/deno --version | head -1))"
      ;;
    *)
      echo "ERROR: unknown tool '$name' in CHECKSUMS" >&2
      rm -f "$archive"
      exit 1
      ;;
  esac
  rm -f "$archive"
}

# verify_one <name>
# Note: we can't recover the archive SHA from the installed binary
# (scaffolding was stripped), so verify-mode checks the binary exists
# and runs --version. Use --reinstall to re-verify against the network.
verify_one() {
  local name=$1
  if [ ! -x "$BIN_DIR/$name" ]; then
    echo "MISSING: tools/bin/$name" >&2
    return 1
  fi
  echo "  $name: $($BIN_DIR/$name --version | head -1)"
}

# Read CHECKSUMS and act on the lines for this platform.
matched=0
while IFS= read -r line; do
  case "$line" in
    ""|"#"*) continue ;;
  esac
  # shellcheck disable=SC2086
  set -- $line
  name=$1; platform=$2; version=$3; url=$4; integrity=$5
  [ "$platform" = "$PLATFORM" ] || continue
  matched=$((matched + 1))
  case "$MODE" in
    verify)
      verify_one "$name"
      ;;
    reinstall)
      install_one "$name" "$version" "$url" "$integrity"
      ;;
    install)
      if [ -x "$BIN_DIR/$name" ]; then
        echo "==> $name already installed"
      else
        install_one "$name" "$version" "$url" "$integrity"
      fi
      ;;
  esac
done < "$CHECKSUMS_FILE"

if [ "$matched" -eq 0 ]; then
  echo "ERROR: no CHECKSUMS entries for platform $PLATFORM" >&2
  exit 1
fi

echo ""
echo "Toolchain ready ($PLATFORM)."
echo "  • esbuild: $BIN_DIR/esbuild"
echo "  • deno:    $BIN_DIR/deno"
