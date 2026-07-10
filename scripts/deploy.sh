#!/usr/bin/env bash
# Deploys viewer/ to Cloudflare Pages.
#
# Reads credentials from .cloudflare.env (gitignored). Wrangler is the
# project's one node dependency: a system node (>= 20) is used when
# present, otherwise a portable, platform-matched node is cached in
# ~/.cache/poe2-deploy/ (nothing installed system-wide).
#
# PROVENANCE: a deploy must be reproducible from git. The script
# refuses a dirty working tree (override for local experiments with
# --allow-dirty) and stamps the commit SHA + timestamp into
# viewer/assets/deploy_meta.json (gitignored), so the live site always
# answers "what code is this?" at /assets/deploy_meta.json.
#
# Usage:
#   scripts/deploy.sh                 # deploy HEAD (clean tree required)
#   scripts/deploy.sh --allow-dirty   # local experiment; stamped as dirty
#   scripts/deploy.sh --dry-run       # everything except the upload

set -euo pipefail

cd "$(dirname "$0")/.."

ALLOW_DIRTY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

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

# ---- provenance guard ------------------------------------------------------
GIT_SHA=$(git rev-parse HEAD)
GIT_DIRTY=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  GIT_DIRTY=1
fi
if [ "$GIT_DIRTY" = "1" ] && [ "$ALLOW_DIRTY" != "1" ]; then
  echo "ERROR: working tree has uncommitted changes." >&2
  echo "       A deploy must correspond to a commit — commit first, or" >&2
  echo "       use --allow-dirty for a local experiment (stamped as dirty)." >&2
  exit 1
fi

# ---- sanity check the build artifact --------------------------------------
if [ ! -f viewer/planner.html ]; then
  echo "ERROR: viewer/planner.html is missing. Regenerate first:" >&2
  echo "       ./bw render --tree-dir data/parsed/<patch>/tree" >&2
  exit 1
fi

# ---- build all JS bundles --------------------------------------------------
# esbuild produces the viewer/assets/*.js bundles from the .ts sources.
# These outputs are gitignored — deploy must build them fresh so a
# checkout-then-deploy never serves stale artefacts.
if [ ! -x tools/bin/esbuild ]; then
  echo "==> Installing JS toolchain (tools/setup.sh) ..."
  tools/setup.sh
fi
echo "==> Building JS bundles ..."
scripts/build_js.sh

# ---- deploy stamp -----------------------------------------------------------
# Written AFTER the bundle build so it can't be clobbered, gitignored
# so the tree stays clean. Served at /assets/deploy_meta.json.
DEPLOY_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{\n  "commit": "%s",\n  "dirty": %s,\n  "deployed_at": "%s"\n}\n' \
  "$GIT_SHA" "$([ "$GIT_DIRTY" = "1" ] && echo true || echo false)" "$DEPLOY_TIME" \
  > viewer/assets/deploy_meta.json
echo "==> Stamped viewer/assets/deploy_meta.json (${GIT_SHA:0:12}$([ "$GIT_DIRTY" = "1" ] && echo ', DIRTY'))"

# ---- node for wrangler ------------------------------------------------------
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version | sed 's/^v//; s/\..*//')
  if [ "$NODE_MAJOR" -ge 20 ]; then
    NODE_BIN=$(command -v node)
  fi
fi
if [ -z "$NODE_BIN" ]; then
  NODE_VER="v22.11.0"
  case "$(uname -s)" in
    Darwin) node_os="darwin" ;;
    Linux)  node_os="linux" ;;
    *) echo "ERROR: unsupported OS for portable node: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) node_arch="arm64" ;;
    x86_64|amd64)  node_arch="x64" ;;
    *) echo "ERROR: unsupported arch for portable node: $(uname -m)" >&2; exit 1 ;;
  esac
  NODE_ROOT="$HOME/.cache/poe2-deploy"
  NODE_DIR="$NODE_ROOT/node-$NODE_VER-$node_os-$node_arch"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "==> Downloading portable Node $NODE_VER ($node_os-$node_arch) to $NODE_ROOT ..."
    mkdir -p "$NODE_ROOT"
    tarball="$NODE_ROOT/node-$NODE_VER.tar.xz"
    curl -fSL --retry 3 -o "$tarball" \
      "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$node_os-$node_arch.tar.xz"
    tar -xJf "$tarball" -C "$NODE_ROOT"
    rm -f "$tarball"
  fi
  NODE_BIN="$NODE_DIR/bin/node"
  export PATH="$NODE_DIR/bin:$PATH"
fi
echo "==> node: $NODE_BIN ($($NODE_BIN --version))"

# ---- create the Pages project if it doesn't exist yet ---------------------
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
  if ! printf '%s' "$resp" | grep -q '"success": *true'; then
    echo "ERROR: failed to create project:" >&2
    printf '%s\n' "$resp" >&2
    exit 1
  fi
fi

# ---- deploy ----------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  echo "==> --dry-run: skipping wrangler upload. Would deploy commit ${GIT_SHA:0:12} to $POE2_PROJECT_NAME."
  exit 0
fi
echo "==> Deploying viewer/ to Cloudflare Pages project: $POE2_PROJECT_NAME"
COMMIT_FLAGS=(--commit-hash="$GIT_SHA")
if [ "$GIT_DIRTY" = "1" ]; then
  COMMIT_FLAGS+=(--commit-dirty=true)
fi
npx --yes wrangler@latest pages deploy viewer/ \
  --project-name="$POE2_PROJECT_NAME" \
  --branch=main \
  "${COMMIT_FLAGS[@]}"

cat <<EOF

Deploy complete: commit ${GIT_SHA:0:12} → https://$POE2_PROJECT_NAME.pages.dev
Provenance: /assets/deploy_meta.json on the deployment.
EOF
