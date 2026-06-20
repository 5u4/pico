#!/usr/bin/env bash
set -euo pipefail

REPO=/root/.pico/agent
cd "$REPO"

git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$REPO" \
  || git config --global --add safe.directory "$REPO"

if ! command -v omp >/dev/null 2>&1; then
  echo "[entrypoint] installing omp (latest)…"
  bun add -g @oh-my-pi/pi-coding-agent
fi

echo "[entrypoint] building pico-supervisor + pico-worker (release; first run pulls deps)…"
cargo build --release -p pico-supervisor -p pico-worker

SUP=/build/target/release/pico-supervisor
WORKER=/build/target/release/pico-worker
CURRENT=/root/.pico/supervisor/slots/current

ln -sf "$SUP" /usr/local/bin/pico-supervisor
ln -sf "$WORKER" /usr/local/bin/pico-worker

echo "[entrypoint] starting supervisor daemon…"
"$SUP" &
SUP_PID=$!

shutdown() { trap - TERM INT; kill -TERM "$SUP_PID" 2>/dev/null || true; wait "$SUP_PID" 2>/dev/null || true; exit 0; }
trap shutdown TERM INT

ready=
for _ in $(seq 1 150); do
  if "$SUP" status >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$SUP_PID" 2>/dev/null || { echo "[entrypoint] supervisor exited before becoming ready"; wait "$SUP_PID"; exit 1; }
  sleep 0.2
done
[ -n "$ready" ] || { echo "[entrypoint] supervisor never became ready; aborting"; kill "$SUP_PID" 2>/dev/null || true; wait "$SUP_PID" 2>/dev/null || true; exit 1; }

if [ -e "$CURRENT" ]; then
  echo "[entrypoint] supervisor is restoring the current slot"
else
  echo "[entrypoint] no current slot; deploying freshly-built worker…"
  "$SUP" deploy "$WORKER" || echo "[entrypoint] deploy failed; supervisor stays up (check logs under ~/.pico)"
fi

wait "$SUP_PID"
