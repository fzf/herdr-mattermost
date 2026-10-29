#!/usr/bin/env bash
# One-time Mattermost setup for herdr-mattermost. Run on the Mattermost host.
#
#   MM_URL=https://chat.example.org MMCTL="docker exec mattermost mmctl --local" \
#     ./scripts/setup-bot.sh <team-name> <admin-username>
#
# mmctl's local mode cannot create bots, so the script mints a temporary
# access token for <admin-username> (local mode can do that), creates the bot
# over the REST API with it, revokes the temporary token, then generates the
# bot's own token and adds the bot to the team. Prints MM_TOKEN at the end.
set -euo pipefail
TEAM="${1:?usage: setup-bot.sh <team-name> <admin-username>}"
ADMIN="${2:?usage: setup-bot.sh <team-name> <admin-username>}"
BOT="${BOT_NAME:-herdr}"
MMCTL="${MMCTL:-mmctl --local}"
MM_URL="${MM_URL:-http://localhost:8065}"
MM_URL="${MM_URL%/}"

json_field() { # json_field <key>  — first string value for key from stdin
  sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -1
}

if $MMCTL user list --json 2>/dev/null | grep -q "\"username\": *\"$BOT\""; then
  echo "bot @$BOT already exists"
else
  TMP_JSON=$($MMCTL token generate "$ADMIN" "herdr-mattermost setup (temporary)" --json)
  TMP_TOKEN=$(echo "$TMP_JSON" | json_field token)
  TMP_ID=$(echo "$TMP_JSON" | json_field id)
  trap '$MMCTL token revoke "$TMP_ID" >/dev/null 2>&1 || true' EXIT
  code=$(curl -s -o /tmp/herdr-bot-create.json -w '%{http_code}' -X POST "$MM_URL/api/v4/bots" \
    -H "Authorization: Bearer $TMP_TOKEN" -H "Content-Type: application/json" \
    -d "{\"username\":\"$BOT\",\"display_name\":\"$BOT\",\"description\":\"herdr agent bridge\"}")
  if [ "$code" != "201" ]; then
    echo "bot create failed (HTTP $code): $(cat /tmp/herdr-bot-create.json)" >&2
    exit 1
  fi
  echo "created bot @$BOT"
fi

$MMCTL team users add "$TEAM" "$BOT" >/dev/null 2>&1 || true
echo "added @$BOT to team $TEAM"
TOKEN=$($MMCTL token generate "$BOT" "herdr-mattermost $(date +%F)" --json | json_field token)
echo
echo "MM_TOKEN=$TOKEN"
echo
echo "Next: invite the bot to each channel you want watched (/invite @$BOT) and put 'herdr:' in the channel header."
