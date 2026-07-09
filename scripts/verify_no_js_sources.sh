#!/usr/bin/env bash
# Completeness invariant: this repo is TS-only.
#
# Every JS *source* file is gone. Only the 6 esbuild-bundled outputs
# under viewer/assets/ are allowed (they're gitignored as build
# artifacts but exist on disk locally and in deploys). This script
# catches a stray .js source slipping back in.
#
# Exit codes:
#   0 — clean (only allow-listed .js files present)
#   1 — found .js source files outside the allow-list
#
# Default mode prints findings without failing. --strict fails on any
# stray source; wire into CI for the invariant.

set -euo pipefail
cd "$(dirname "$0")/.."

STRICT=0
if [ "${1:-}" = "--strict" ]; then
  STRICT=1
fi

# Allow-list: files that are *expected* to be .js even after migration.
#   • viewer/assets/planner.js        — esbuild output of the planner bundle
#   • viewer/assets/wizard_chrome.js  — esbuild output of wizard_chrome.ts
#   • viewer/assets/step_summary.js   — esbuild output of step_summary.ts
#   • viewer/assets/share_codec.js    — esbuild output of share_codec.ts
#   • viewer/assets/*.js.map          — esbuild's source maps
ALLOW_REGEX='^viewer/assets/(planner|wizard_chrome|step_summary|share_codec|index_page|share_page)\.js(\.map)?$'

# Where to look. We skip data/, target/, tools/, viewer/assets/sprites/
# (icon PNGs), node_modules just in case, and the .git internals.
mapfile -t found < <(
  find . \
    -type f -name "*.js" \
    -not -path "./data/*" \
    -not -path "./target/*" \
    -not -path "./tools/*" \
    -not -path "./node_modules/*" \
    -not -path "./.git/*" \
    -not -path "./viewer/assets/sprites/*" \
    -not -path "./viewer/assets/skill_icons/*" \
    -not -path "./viewer/assets/gem_icons/*" \
    -not -path "./viewer/assets/item_icons/*" \
    | sed 's|^\./||' \
    | sort
)

unexpected=()
for f in "${found[@]}"; do
  if [[ ! "$f" =~ $ALLOW_REGEX ]]; then
    unexpected+=("$f")
  fi
done

if [ "${#unexpected[@]}" -eq 0 ]; then
  echo "OK: no .js source files outside the allow-list."
  echo "    allow-listed outputs present: ${#found[@]} files"
  exit 0
fi

echo "Found ${#unexpected[@]} .js source file(s) NOT in the allow-list:"
for f in "${unexpected[@]}"; do
  echo "  - $f"
done

if [ "$STRICT" = "1" ]; then
  echo ""
  echo "FAIL: --strict mode and unconverted .js sources present."
  exit 1
fi
echo ""
echo "Non-strict mode — migration in progress, treating as informational."
