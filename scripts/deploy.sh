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
./bw js

# ---- fixture-data guard -----------------------------------------------------
# `./bw fixture` regenerates viewer/ artifacts (agent grounding data,
# planner.html) from the committed toy tree. Deploying those to
# production once served agents "Alpha/Beta/Fixture Might" as real
# game data — the exact failure this guard exists to make impossible.
if grep -q '"Fixture' viewer/assets/agent/nodes.json 2>/dev/null \
   || grep -q '"Fixture Might"' viewer/planner.html 2>/dev/null; then
  echo "ERROR: viewer/ contains FIXTURE data (bw fixture output)." >&2
  echo "       Re-render from real data before deploying:" >&2
  echo "       ./bw render --tree-dir data/parsed/<patch>/tree" >&2
  echo "       and restore viewer/assets/agent/*.json for that patch." >&2
  exit 1
fi

# ---- agent metadata ---------------------------------------------------------
# capabilities.json (feature discovery) + support_compat.json
# (precomputed support pairings) — generated fresh per deploy.

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

# ---- rendered-tree frame guard ---------------------------------------------
# planner.html is generated and intentionally gitignored. Validate the actual
# artifact about to be uploaded, not merely the renderer source, so a stale or
# partial sprites.tsv can never silently deploy bare node icons again.
echo "==> Verifying planner node-frame coverage ..."
"$NODE_BIN" scripts/verify_planner_frames.mjs

# ---- agent metadata (needs node, so generated here) ------------------------
"$NODE_BIN" scripts/gen_agent_meta.mjs --game poe2
"$NODE_BIN" scripts/gen_agent_meta.mjs --game poe1

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
# Run wrangler FROM viewer/ — Pages discovers the Functions directory
# relative to the working directory, so deploying "viewer/" from the
# repo root uploaded viewer/functions/ as static files and never
# registered /agent/* or /live/* as Functions (the first agent audit
# found /agent/validate returning the homepage).
DEPLOY_LOG=$(mktemp)
(cd viewer && npx --yes wrangler@latest pages deploy . \
  --project-name="$POE2_PROJECT_NAME" \
  --branch=main \
  "${COMMIT_FLAGS[@]}") | tee "$DEPLOY_LOG"

# ---- post-deploy smoke tests -------------------------------------------------
# "Agent-facing docs need ruthless deploy-time tests" — the agent
# surface is verified against the deployment URL on every deploy.
DEPLOY_URL=$(grep -oE 'https://[a-z0-9]+\.[a-z0-9-]+\.pages\.dev' "$DEPLOY_LOG" | head -1)
rm -f "$DEPLOY_LOG"
if [ -n "$DEPLOY_URL" ]; then
  echo "==> Smoke-testing agent surface on $DEPLOY_URL"
  # First Functions activation on a fresh deployment routinely lags
  # 30-90s (observed on every deploy this month) — poll up to 2min
  # before judging, so the verdict below means something.
  sleep 8
  tries=0
  while [ $tries -lt 8 ]; do
    vt=$(curl -s -o /dev/null -w "%{content_type}" "$DEPLOY_URL/agent/validate")
    case "$vt" in application/json*) break ;; esac
    tries=$((tries + 1))
    echo "    (functions not ready yet — retry $tries/8 in 15s)"
    sleep 15
  done
  fail=0
  classes=$(curl -sf "$DEPLOY_URL/assets/agent/nodes.json" | "$NODE_BIN" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).classes.length))' 2>/dev/null || echo 0)
  if [ "$classes" -lt 6 ]; then echo "FAIL: nodes.json has $classes classes (fixture data or missing)"; fail=1; else echo "  ok: nodes.json ($classes classes)"; fi
  vt=$(curl -s -o /dev/null -w "%{content_type}" "$DEPLOY_URL/agent/validate")
  case "$vt" in application/json*) echo "  ok: /agent/validate answers JSON";; *) echo "FAIL: /agent/validate content-type: $vt"; fail=1;; esac
  bt=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$DEPLOY_URL/agent/build")
  if [ "$bt" = "204" ]; then echo "  ok: /agent/build routed"; else echo "FAIL: /agent/build OPTIONS -> $bt"; fail=1; fi
  ct=$(curl -s -o /dev/null -w "%{http_code}" "$DEPLOY_URL/assets/agent/capabilities.json")
  if [ "$ct" = "200" ]; then echo "  ok: capabilities.json served"; else echo "FAIL: capabilities.json -> $ct"; fail=1; fi
  if [ "$fail" = "1" ]; then
    echo "ERROR: agent-surface smoke tests FAILED on $DEPLOY_URL — do not promote/announce this deploy." >&2
    exit 1
  fi
else
  echo "WARNING: could not parse deployment URL from wrangler output; smoke tests skipped." >&2
fi

cat <<EOF

Deploy complete: commit ${GIT_SHA:0:12}
Provenance: /assets/deploy_meta.json on the deployment.
EOF
