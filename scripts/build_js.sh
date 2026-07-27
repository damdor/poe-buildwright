#!/usr/bin/env bash
# Backward-compatible shim. The Rust buildwright CLI owns the complete
# entry-point/output map and invokes the pinned esbuild binary directly.
set -euo pipefail
cd "$(dirname "$0")/.."
exec ./bw js "$@"
