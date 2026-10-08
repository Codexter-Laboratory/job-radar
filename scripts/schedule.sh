#!/usr/bin/env bash
# Runs `npm run daily` every day at 09:30 local time from this machine.
# Usage: ./scripts/schedule.sh          install
#        ./scripts/schedule.sh remove   uninstall
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NPM="$(command -v npm)"
LINE="30 9 * * * cd \"$DIR\" && PATH=\"$(dirname "$NPM"):\$PATH\" \"$NPM\" run daily >> \"$DIR/output/cron.log\" 2>&1"

current="$(crontab -l 2>/dev/null | grep -v 'job-radar-daily' || true)"
if [ "${1:-}" = "remove" ]; then
  printf '%s\n' "$current" | crontab -
  echo "Removed."
  exit 0
fi
mkdir -p "$DIR/output"
printf '%s\n%s # job-radar-daily\n' "$current" "$LINE" | crontab -
echo "Installed: daily at 09:30. Log: $DIR/output/cron.log"
