#!/usr/bin/env bash
# Persistent logged-in Chrome for platform onboarding (the add-platform skill).
#
# Run this ONCE, log into every platform you want to onboard, and LEAVE IT OPEN.
# - Persistent profile dir (survives restarts) → your logins are remembered.
# - Fixed remote-debugging port → Claude Code attaches over CDP each run.
# - Idempotent → re-running reuses the already-running instance.
#
# Claude Code attaches to this browser (via the chrome-devtools MCP, or Playwright
# connectOverCDP) and NEVER closes it — only disconnects — so it stays alive across
# every platform you onboard.
set -euo pipefail

PORT="${SCAFFOLD_CHROME_PORT:-9222}"
# Persistent — NOT /tmp (which is wiped on reboot). Logins live here.
PROFILE="${SCAFFOLD_CHROME_PROFILE:-$HOME/.lingent/scaffold-chrome-profile}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

# `login` mode: open the SAME persistent profile WITHOUT a remote-debugging port,
# so it is NOT flagged as automation and Google "Sign in with Google" works. Log
# into Google + all your platforms here, then QUIT this Chrome and run the script
# with no argument to relaunch in attach mode — the sessions persist in the profile
# and the automation just reuses them (no re-login, no Google block).
if [ "${1:-}" = "login" ]; then
  mkdir -p "${PROFILE}"
  echo "Opening persistent profile for HUMAN login (no debug port): ${PROFILE}"
  echo "  → Log into Google + your platforms, then QUIT this Chrome and run:  bash $0"
  exec "${CHROME}" --user-data-dir="${PROFILE}" --no-first-run --no-default-browser-check
fi

if curl -fsS "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "✓ Chrome already live on :${PORT} (profile: ${PROFILE}) — reuse it. Don't relaunch."
  exit 0
fi

mkdir -p "${PROFILE}"
echo "Launching persistent Chrome on :${PORT}, profile ${PROFILE} ..."
"${CHROME}" \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${PROFILE}" \
  --no-first-run --no-default-browser-check --no-default-browser-check \
  >/dev/null 2>&1 &

# Wait for the debug endpoint to come up.
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "✓ Chrome ready on :${PORT}."
    echo "  → Log into the platforms you want (Gitee / 语雀 / 飞书 / GitLab / Linear ...),"
    echo "    then tell Claude Code which ones are logged in. Keep this window OPEN."
    exit 0
  fi
  sleep 0.5
done
echo "✗ Chrome did not expose :${PORT} in time. Check CHROME_BIN / the port." >&2
exit 1
