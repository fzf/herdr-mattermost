#!/usr/bin/env bash
# One-time Mattermost setup for herdr-mattermost. Run on the Mattermost host
# (or anywhere mmctl --local can reach the server's local socket).
#
#   MMCTL="docker exec mattermost mmctl --local" ./scripts/setup-bot.sh home
#
# Creates bot "herdr", generates its access token, adds it to the team, and
# prints the token to put in MM_TOKEN.
set -euo pipefail
TEAM="${1:?usage: setup-bot.sh <team-name>}"
BOT="${BOT_NAME:-herdr}"
MMCTL="${MMCTL:-mmctl --local}"

if ! $MMCTL bot list --json 2>/dev/null | grep -q "\"username\": *\"$BOT\""; then
  $MMCTL bot create "$BOT" --display-name "$BOT" --description "herdr agent bridge" >/dev/null
  echo "created bot @$BOT"
else
  echo "bot @$BOT already exists"
fi
$MMCTL team users add "$TEAM" "$BOT" >/dev/null 2>&1 || true
echo "added @$BOT to team $TEAM"
TOKEN=$($MMCTL token generate "$BOT" "herdr-mattermost $(date +%F)" --json | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' | head -1)
echo
echo "MM_TOKEN=$TOKEN"
echo
echo "Next: invite the bot to each channel you want watched (/invite @$BOT) and put 'herdr:' in the channel header."
