#!/usr/bin/env bash
set -euo pipefail

PICO_HOME="${HOME:-/home/pico}"
REPO="$PICO_HOME/.pico/agent"
BIN="$PICO_HOME/.local/bin"
# Shared cargo target for pico's OWN builds (this startup build + the worker's
# /update and /dev-deploy). Scoped here and never exported into the supervisor
# env, so unrelated projects the agent builds keep their own target dir. The
# .cargo/config.toml written below gives the agent's cargo in a pico worktree the
# same dir.
PICO_TARGET="$PICO_HOME/.cache/build/pico-target"

# Runs entirely as the unprivileged pico user (USER pico in the Dockerfile) — there
# is no root phase. Volume writability is guaranteed by the image (pico-owned dirs
# that fresh named volumes inherit) and docker.sock access by compose `group_add`.
cd "$REPO"

git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$REPO" \
  || git config --global --add safe.directory "$REPO"

# Point any cargo rooted in this repo (and the agent's worktrees of it) at the
# shared pico target dir. Absolute + container-specific → generated here,
# gitignored, never committed. New worktrees inherit it via the ambient-link hook.
mkdir -p "$REPO/.cargo"
cat > "$REPO/.cargo/config.toml" <<EOF
[build]
target-dir = "$PICO_TARGET"
EOF

if ! command -v omp >/dev/null 2>&1; then
  echo "[entrypoint] installing omp (latest)…"
  bun add -g @oh-my-pi/pi-coding-agent
fi

# Preflight: confirm we own our writable paths. The usual failure is a stale
# root-owned named volume carried over from the old root-based image — surface it
# with a fix instead of a cryptic EACCES deep inside cargo or the supervisor.
for d in "$PICO_TARGET" "$PICO_HOME/.pico/supervisor"; do
  mkdir -p "$d" 2>/dev/null || true
  if [ ! -w "$d" ]; then
    echo "[entrypoint] FATAL: $d is not writable by $(id -un) (uid $(id -u))." >&2
    echo "[entrypoint] Likely a stale root-owned volume from the old root-based image." >&2
    echo "[entrypoint] Reset it once on the host, then bring the stack back up:" >&2
    echo "[entrypoint]   docker compose down -v && docker compose up -d --build" >&2
    exit 1
  fi
done

# Preflight: if the docker socket is mounted, confirm this unprivileged user can
# actually reach it. Access is granted statically by compose `group_add`
# (DOCKER_GID, default 0 for OrbStack's root:root socket); a root:docker host has
# a non-zero gid. Test the socket perms directly — not `docker version`, which
# also fails when the daemon is merely down — so a group misconfig fails fast and
# actionably instead of as opaque permission errors later during deploy.
if [ -S /var/run/docker.sock ]; then
  if ! { [ -r /var/run/docker.sock ] && [ -w /var/run/docker.sock ]; }; then
    sock_gid="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo '?')"
    echo "[entrypoint] FATAL: /var/run/docker.sock not accessible to $(id -un) (groups: $(id -G))." >&2
    echo "[entrypoint] Its owning group is gid $sock_gid, which is not in this container's groups." >&2
    echo "[entrypoint] Set DOCKER_GID to that gid and recreate the service:" >&2
    echo "[entrypoint]   DOCKER_GID=$sock_gid docker compose up -d --force-recreate" >&2
    exit 1
  fi
fi

echo "[entrypoint] building pico-supervisor + pico-worker (release; first run pulls deps)…"
CARGO_TARGET_DIR="$PICO_TARGET" cargo build --release -p pico-supervisor -p pico-worker

SUP="$PICO_TARGET/release/pico-supervisor"
WORKER="$PICO_TARGET/release/pico-worker"
CURRENT="$PICO_HOME/.pico/supervisor/slots/current"

mkdir -p "$BIN"
ln -sf "$SUP" "$BIN/pico-supervisor"
ln -sf "$WORKER" "$BIN/pico-worker"

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
