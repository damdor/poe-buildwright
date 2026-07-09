#!/usr/bin/env bash
# Configures Cloudflare Access in front of the deployed Pages project.
# Creates a self-hosted Access application + an email allow-list policy.
#
# Prereq: in the Cloudflare dashboard, open "Zero Trust" once and complete
# the one-time team-name + Free-plan signup. After that, this script can
# manage Access via the API.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .cloudflare.env ]; then
  echo "ERROR: .cloudflare.env not found." >&2
  exit 1
fi
set -a; . ./.cloudflare.env; set +a
: "${CLOUDFLARE_API_TOKEN:?missing in .cloudflare.env}"
: "${CLOUDFLARE_ACCOUNT_ID:?missing in .cloudflare.env}"
: "${POE2_PROJECT_NAME:?missing in .cloudflare.env}"
: "${POE2_ALLOWED_EMAILS:?missing in .cloudflare.env}"

DOMAIN="${POE2_PROJECT_NAME}.pages.dev"
CF_API="https://api.cloudflare.com/client/v4"

api() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "$CF_API$path"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "$CF_API$path"
  fi
}

# ---- find or create the Access application --------------------------------
echo "==> Looking for existing Access app for $DOMAIN ..."
existing=$(api GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps?domain=$DOMAIN" \
  | jq -r '.result[]? | select(.domain == "'"$DOMAIN"'") | .id' | head -n1)

if [ -n "$existing" ]; then
  APP_ID="$existing"
  echo "    found existing app: $APP_ID"
else
  echo "==> Creating Access app ..."
  create_body=$(jq -n \
    --arg name "PoE2 Planner ($POE2_PROJECT_NAME)" \
    --arg domain "$DOMAIN" \
    '{name: $name, domain: $domain, type: "self_hosted",
      session_duration: "24h", auto_redirect_to_identity: false,
      allowed_idps: []}')
  resp=$(api POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" "$create_body")
  APP_ID=$(echo "$resp" | jq -r '.result.id // empty')
  if [ -z "$APP_ID" ]; then
    echo "ERROR: failed to create Access app." >&2
    echo "$resp" | jq . >&2
    exit 1
  fi
  echo "    created app: $APP_ID"
fi

# ---- build the email allow-list as a JSON array ---------------------------
emails_json=$(jq -nc --arg csv "$POE2_ALLOWED_EMAILS" \
  '[ $csv | split(",") | .[] | gsub("^\\s+|\\s+$"; "") | select(length > 0) | {email: {email: .}} ]')

echo "==> Allow-list emails:"
echo "$emails_json" | jq -r '.[].email.email | "    - " + .'

# ---- create or replace the allow policy -----------------------------------
echo "==> Replacing policy on app $APP_ID ..."

# Delete any pre-existing policies on this app so re-running the script is idempotent.
existing_policies=$(api GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$APP_ID/policies" \
  | jq -r '.result[]?.id')
for pid in $existing_policies; do
  api DELETE "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$APP_ID/policies/$pid" >/dev/null
done

policy_body=$(jq -nc \
  --argjson include "$emails_json" \
  '{name: "Allowed users", decision: "allow", include: $include, precedence: 1}')
resp=$(api POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$APP_ID/policies" "$policy_body")
ok=$(echo "$resp" | jq -r '.success')
if [ "$ok" != "true" ]; then
  echo "ERROR: failed to create policy." >&2
  echo "$resp" | jq . >&2
  exit 1
fi

cat <<EOF

Access configured.

Test it:
  1. Open https://$DOMAIN in an incognito window.
     You should see a Cloudflare Access email prompt, not the planner.
  2. Enter one of the allow-listed emails.
  3. Check inbox for a 6-digit PIN. Paste it, then the planner loads.

Bot-check:
  curl -sI https://$DOMAIN/ | head -5
  Should show 'cf-mitigated: challenge' or a 302 to a cloudflareaccess.com URL —
  proves bots / CT scrapers get the gate, not your assets.
EOF
