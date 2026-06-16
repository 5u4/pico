#!/usr/bin/env bash
# Build the supervisor + worker from the bind-mounted repo, run the supervisor,
# and deploy the freshly-built worker when it differs from the live slot. On a
# plain restart with unchanged code the supervisor restores its current slot on
# its own, so we skip the redeploy (and the extra build slot it would stage).
set -euo pipefail

REPO=/workspace/pico
cd "$REPO"

# The repo is owned by the host user, not root; without this git refuses to read
# it ("dubious ownership") and build.rs silently embeds "+unknown".
git config --global --add safe.directory "$REPO" 2>/dev/null || true

echo "[entrypoint] building pico-supervisor + pico-worker (release; first run pulls deps)…"
cargo build --release -p pico-supervisor -p pico-worker

SUP=/build/target/release/pico-supervisor
WORKER=/build/target/release/pico-worker

# Mirror the host install so in-container ops match the README
# (`pico-supervisor status`, `pico-supervisor deploy "$(command -v pico-worker)"`).
ln -sf "$SUP" /usr/local/bin/pico-supervisor
ln -sf "$WORKER" /usr/local/bin/pico-worker
SOCK=/root/.pico/supervisor/pico.sock
CURRENT=/root/.pico/supervisor/slots/current

echo "[entrypoint] starting supervisor daemon…"
"$SUP" &
SUP_PID=$!

for _ in $(seq 1 150); do
  [ -S "$SOCK" ] && break
  kill -0 "$SUP_PID" 2>/dev/null || { echo "[entrypoint] supervisor exited before opening its socket"; wait "$SUP_PID"; exit 1; }
  sleep 0.2
done

if [ -e "$CURRENT" ] && cmp -s "$WORKER" "$CURRENT"; then
  echo "[entrypoint] worker matches the live slot; supervisor is restoring it"
else
  echo "[entrypoint] deploying freshly-built worker…"
  "$SUP" deploy "$WORKER" || echo "[entrypoint] deploy failed; supervisor stays up (check logs under ~/.pico)"
fi

wait "$SUP_PID"
