#!/usr/bin/env bash
# Build the planner + wizard JS bundles using vendored esbuild.
#
# Inputs (all TS):
#   crates/tree_render/assets/planner/_main.ts   — ES-module entry; pulls in
#                                                  the 20 numbered planner
#                                                  files via import statements
#   viewer/assets/wizard_chrome.ts               — wizard chrome (classic <script>)
#   viewer/assets/step_summary.ts                — summary page (classic <script>)
#   viewer/assets/share_codec.ts                 — share-link codec (classic <script>)
#   viewer/assets/index_page.ts                  — landing-page glue
#   viewer/assets/share_page.ts                  — share-link receiver
#
# Outputs (per entry, IIFE-bundled):
#   viewer/assets/planner.js
#   viewer/assets/wizard_chrome.js
#   viewer/assets/step_summary.js
#   viewer/assets/share_codec.js
#   viewer/assets/index_page.js
#   viewer/assets/share_page.js
#
# Why a single shell script and not the Rust build:
#   • Iteration: edit a .ts, re-run this, refresh browser. No `cargo run`.
#   • Watching: `tools/bin/esbuild --watch` would daemonize and rebuild on
#     save. For now we go single-shot; daemon-mode is opt-in via --watch.
#   • Cargo orchestration: the Rust build invokes this script via build.rs
#     so `cargo run -p tree_render` does the right thing without extra steps.

set -euo pipefail
cd "$(dirname "$0")/.."

ESBUILD="$PWD/tools/bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  echo "ERROR: $ESBUILD not found. Run tools/setup.sh first." >&2
  exit 1
fi

WATCH=""
if [ "${1:-}" = "--watch" ]; then
  WATCH="--watch"
fi

# Common flags
#   --bundle          resolve imports, produce one output file per entry
#   --format=iife     wrap in (function(){...})() so symbols don't leak
#   --target=es2022   browsers we support (matches tsconfig)
#   --sourcemap=linked emit .js.map next to .js so devtools can locate the
#                     original .ts in the bundled output
#   --log-level=info  prints input/output sizes per build, useful in CI
COMMON_FLAGS="--bundle --format=iife --target=es2022 --sourcemap=linked --log-level=info $WATCH"

PLANNER_DIR="crates/tree_render/assets/planner"
VIEWER_DIR="viewer/assets"

# ------------------------------------------------------------------
# Planner bundle. _main.ts imports every other planner module; esbuild
# walks the import graph and emits one IIFE per entry.
# ------------------------------------------------------------------
if [ ! -f "$PLANNER_DIR/_main.ts" ]; then
  echo "ERROR: $PLANNER_DIR/_main.ts not found — the planner entry point" >&2
  echo "       was deleted. Restore it from git history; the build can't" >&2
  echo "       work out the module graph without it." >&2
  exit 1
fi
echo "==> bundling planner (entry: _main.ts)"
"$ESBUILD" "$PLANNER_DIR/_main.ts" \
  --outfile="$VIEWER_DIR/planner.js" \
  $COMMON_FLAGS

# ------------------------------------------------------------------
# Wizard chrome / step_summary / share_codec / page-specific scripts
# — each loaded as a separate <script src=> in the HTML pages, each
# its own IIFE (so the browser loads them independently).
# ------------------------------------------------------------------
for name in wizard_chrome share_codec index_page share_page; do
  if [ ! -f "$VIEWER_DIR/$name.ts" ]; then
    echo "ERROR: $VIEWER_DIR/$name.ts not found" >&2
    exit 1
  fi
  echo "==> bundling $name (entry: $name.ts)"
  "$ESBUILD" "$VIEWER_DIR/$name.ts" \
    --outfile="$VIEWER_DIR/$name.js" \
    $COMMON_FLAGS
done

echo ""
echo "JS build complete."
