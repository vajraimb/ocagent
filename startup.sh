#!/bin/sh
set -eu
cd /workspace
if command -v opam >/dev/null 2>&1; then
  eval "$(opam env)"
fi
export OCAGENT_DURABLE_ROOT="${OCAGENT_DURABLE_ROOT:-/workspace/var/ocagent-durable}"
export OCAGENT_FETCH_URL="${OCAGENT_FETCH_URL:-http://127.0.0.1:8765/spec}"
if ! curl -sf -o /dev/null --max-time 1 "$OCAGENT_FETCH_URL"; then
  node scripts/spec-fixture.mjs >>/tmp/spec-fixture.log 2>&1 &
fi
node scripts/preview.mjs stop || true
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
