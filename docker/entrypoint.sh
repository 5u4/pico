#!/usr/bin/env bash
# Build the supervisor + worker from the bind-mounted repo and run the
# supervisor. On first run (no slot yet) deploy the freshly-built worker;
# afterwards the supervisor restores its current slot on its own and code
# updates go through an explicit deploy, the same as on a host install.
set -euo pipefail

REPO=/workspace/pico
cd "$REPO"

# The repo is owned by the host user, not root; without this git refuses to read
# it ("dubious ownership") and build.rs silently embeds "+unknown". Add it only
# when absent so restarts don't pile up duplicate entries in /root/.gitconfig.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$REPO" \
  || git config --global --add safe.directory "$REPO"

echo "[entrypoint] building pico-supervisor + pico-worker (release; first run pulls deps)…"
cargo build --release -p pico-supervisor -p pico-worker

SUP=/build/target/release/pico-supervisor
WORKER=/build/target/release/pico-worker
CURRENT=/root/.pico/supervisor/slots/current

# Mirror the host install so in-container ops match the README
# (`pico-supervisor status`, `pico-supervisor deploy "$(command -v pico-worker)"`).
ln -sf "$SUP" /usr/local/bin/pico-supervisor
ln -sf "$WORKER" /usr/local/bin/pico-worker

echo "[entrypoint] starting supervisor daemon…"
"$SUP" &
SUP_PID=$!

# Wait until the supervisor actually answers — not just until its socket file
# exists. That file lives on the persistent volume, so a stale one from the
# previous container can be present before this supervisor has bound, and acting
# on the file alone races a deploy in ahead of the listener ("connection refused").
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
