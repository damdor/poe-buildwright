#!/usr/bin/env bash
# Deploys viewer/ to Cloudflare Pages.
#
# Reads credentials from .cloudflare.env (gitignored). Uses a portable Node
# binary cached in ~/.cache/poe2-deploy/ so nothing is installed system-wide.
# Wrangler is fetched fresh by npx each run from that sandboxed Node.

set -euo pipefail

cd "$(dirname "$0")/.."

# ---- load credentials ------------------------------------------------------
if [ ! -f .cloudflare.env ]; then
  echo "ERROR: .cloudflare.env not found." >&2
  echo "       cp .cloudflare.env.example .cloudflare.env and fill in values." >&2
  exit 1
fi
set -a; . ./.cloudflare.env; set +a
: "${CLOUDFLARE_API_TOKEN:?missing in .cloudflare.env}"
: "${CLOUDFLARE_ACCOUNT_ID:?missing in .cloudflare.env}"
: "${POE2_PROJECT_NAME:?missing in .cloudflare.env}"

# ---- sanity check the build artifact --------------------------------------
if [ ! -f viewer/planner.html ]; then
  echo "ERROR: viewer/planner.html is missing. Regenerate first:" >&2
  echo "       cargo run --release -p tree_render --bin tree_render -- \\" >&2
  echo "         --tree-dir data/parsed/tree_render --output viewer/planner.html" >&2
  exit 1
fi

# ---- build all JS bundles --------------------------------------------------
# esbuild produces viewer/assets/{planner,wizard_chrome,step_summary,share_codec}.js
# from the .ts sources. These outputs are gitignored — deploy must build them
# fresh so a checkout-then-deploy never serves stale artefacts.
if [ ! -x tools/bin/esbuild ]; then
  echo "==> Installing JS toolchain (tools/setup.sh) ..."
  tools/setup.sh
fi
echo "==> Building JS bundles ..."
scripts/build_js.sh

# ---- portable Node (one-time download) ------------------------------------
NODE_VER="v22.11.0"
NODE_ROOT="$HOME/.cache/poe2-deploy"
NODE_DIR="$NODE_ROOT/node-$NODE_VER-linux-x64"
NODE_TARBALL="$NODE_ROOT/node-$NODE_VER.tar.xz"

if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "==> Downloading portable Node $NODE_VER (~30 MB) to $NODE_ROOT ..."
  mkdir -p "$NODE_ROOT"
  curl -fSL --retry 3 -o "$NODE_TARBALL" \
    "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"
  tar -xJf "$NODE_TARBALL" -C "$NODE_ROOT"
  rm -f "$NODE_TARBALL"
fi
export PATH="$NODE_DIR/bin:$PATH"

# ---- create the Pages project if it doesn't exist yet ---------------------
# Wrangler's `pages deploy` errors out if the project isn't already created.
CF_API="https://api.cloudflare.com/client/v4"
proj_status=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$POE2_PROJECT_NAME")
if [ "$proj_status" = "404" ]; then
  echo "==> Project $POE2_PROJECT_NAME not found — creating it ..."
  resp=$(curl -sS \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"name\":\"$POE2_PROJECT_NAME\",\"production_branch\":\"main\"}" \
    "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects")
  if [ "$(echo "$resp" | jq -r '.success')" != "true" ]; then
    echo "ERROR: failed to create project:" >&2
    echo "$resp" | jq . >&2
    exit 1
  fi
fi

# ---- deploy ----------------------------------------------------------------
# Wrangler reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from env.
# --commit-dirty=true skips the "uncommitted changes" prompt.
echo "==> Deploying viewer/ to Cloudflare Pages project: $POE2_PROJECT_NAME"
npx --yes wrangler@latest pages deploy viewer/ \
  --project-name="$POE2_PROJECT_NAME" \
  --branch=main \
  --commit-dirty=true

cat <<EOF

Deploy complete. URL: https://$POE2_PROJECT_NAME.pages.dev

Next step: run scripts/setup_access.sh to gate the site with Cloudflare Access
(only required once per project). Open the URL only AFTER Access is configured,
to avoid leaking a publicly-reachable URL to certificate-transparency scrapers.
EOF
