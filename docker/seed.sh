#!/usr/bin/env bash
# Seed the pico-state and omp-state Docker volumes from this host's ~/.pico and
# ~/.omp, rewriting host absolute paths to their in-container equivalents.
#
#   ~/.pico/workers          -> volume pico-state at /root/.pico/workers
#   ~/.omp/agent/{agent.db,   -> volume omp-state at /root/.omp/agent/...
#     config.yml,rules}          (auth + settings only; not the blob cache)
#
# One-time, pre-first-`up` operation. Re-running OVERWRITES the volume copies
# with the host's — it reverts any in-container change (`/bind` edits to
# bindings.toml, omp's refreshed Copilot tokens in agent.db) back to the host
# versions; it is not a merge. The supervisor tree (~/.pico/supervisor) is NOT
# seeded: its build slots hold host-arch binaries and are rebuilt in the container.
set -euo pipefail

PICO_HOME="${PICO_HOME:-$HOME/.pico}"
OMP_HOME="${OMP_HOME:-$HOME/.omp}"
REPO_MOUNT="/workspace/pico"
# Host checkout compose bind-mounts at $REPO_MOUNT — derived from this script's
# own location, not hard-coded, so any checkout path still seeds.
REPO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Keep in sync with the omp pin in docker/Dockerfile.
OMP_PIN=16.0.1

WORKERS="$PICO_HOME/workers"
[ -d "$WORKERS" ] || { echo "no $WORKERS to seed" >&2; exit 1; }
[ -f "$OMP_HOME/agent/agent.db" ] || { echo "no $OMP_HOME/agent/agent.db (omp auth)" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 not found (needed for the omp auth snapshot)" >&2; exit 1; }
if command -v omp >/dev/null; then
  host_omp="$(omp --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  [ "$host_omp" = "$OMP_PIN" ] || echo "warning: host omp ${host_omp:-?} != pinned $OMP_PIN — seeded agent.db may not match the container's omp" >&2
fi

docker volume create pico-state >/dev/null
docker volume create omp-state >/dev/null

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# --- pico worker state -------------------------------------------------------
mkdir -p "$stage/pico"
cp -a "$WORKERS" "$stage/pico/workers"

# Escape a literal string for the pattern side of a sed `s#...#` (BRE
# metacharacters plus the `#` delimiter), so paths with `.`/`#`/etc. are matched
# literally rather than as a regex.
sed_escape() { printf '%s' "$1" | sed 's/[][\\.^$*#]/\\&/g'; }
src_re="$(sed_escape "$REPO_SRC")"
pico_re="$(sed_escape "$PICO_HOME")"

# config.toml (guild cwd) and bindings.toml (channel cwd) carry host paths.
# Rewrite every worker root, not just `default`.
for wt in "$stage/pico/workers"/*/; do
  for f in "$wt/config.toml" "$wt/bindings.toml"; do
    [ -f "$f" ] || continue
    tmp="$(mktemp)"
    sed -e "s#$src_re#$REPO_MOUNT#g" \
        -e "s#$pico_re#/root/.pico#g" \
        "$f" > "$tmp"
    mv "$tmp" "$f"
  done
done

# Only the repo ($REPO_MOUNT) and ~/.pico (/root/...) are reachable in the
# container. Warn about any cwd still pointing at an unmounted host path.
unmapped="$(grep -hoE 'cwd = "[^"]*"' "$stage/pico/workers"/*/*.toml 2>/dev/null \
  | grep -vE 'cwd = "(/workspace/pico|/root/)' || true)"
if [ -n "$unmapped" ]; then
  echo "warning: these cwd paths are not under the bind-mounted repo or /root/.pico" >&2
  echo "         and won't exist in the container — add a bind mount in docker-compose.yml:" >&2
  printf '%s\n' "$unmapped" | sort -u | sed 's/^/  /' >&2
fi

# --- omp auth + config (consistent snapshot via .backup; WAL may be mid-write) ---
mkdir -p "$stage/omp/agent"
sqlite3 "$OMP_HOME/agent/agent.db" ".backup '$stage/omp/agent/agent.db'"
cp -a "$OMP_HOME/agent/config.yml" "$stage/omp/agent/config.yml"
[ -d "$OMP_HOME/agent/rules" ] && cp -a "$OMP_HOME/agent/rules" "$stage/omp/agent/rules"

# --- load staged trees into the named volumes --------------------------------
docker run --rm -v pico-state:/v -v "$stage/pico":/src:ro busybox \
  sh -c 'cp -a /src/. /v/'
docker run --rm -v omp-state:/v -v "$stage/omp":/src:ro busybox \
  sh -c 'mkdir -p /v/agent && cp -a /src/agent/. /v/agent/'

echo "seeded pico-state ($(du -sh "$WORKERS" | cut -f1)) and omp-state (auth + config)."
