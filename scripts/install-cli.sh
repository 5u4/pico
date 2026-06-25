#!/usr/bin/env bash
# Host-side installer for the `pico` CLI front-end (`pico chat` / `pico bind`).
#
# This is SEPARATE from install.sh (the Docker Discord deployment). It builds the
# `pico` binary natively and installs it to ~/.local/bin, and makes sure the Bun
# omp-host the CLI drives is dependency-installed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PICO_CLI_PREFIX:-$HOME/.local}"
OMP_HOST="${PICO_OMP_HOST:-$HOME/.pico/agent/omp-host/host.ts}"

die() { echo "error: $*" >&2; exit 1; }

command -v cargo >/dev/null 2>&1 || die "cargo not found — install Rust: https://rustup.rs"
command -v bun >/dev/null 2>&1 || die "bun not found — install Bun: https://bun.sh (pico chat drives the omp-host via Bun)"

echo "→ installing pico CLI to $PREFIX/bin/pico"
cargo install --path "$REPO_DIR/crates/cli" --root "$PREFIX" --force

# The CLI spawns the omp-host (the pinned omp SDK) via Bun. It resolves the host
# entry from $PICO_OMP_HOST, defaulting to ~/.pico/agent/omp-host/host.ts.
HOST_DIR="$(dirname "$OMP_HOST")"
if [ -f "$HOST_DIR/package.json" ]; then
  echo "→ bun install in $HOST_DIR"
  (cd "$HOST_DIR" && bun install)
else
  echo "→ bun install in $REPO_DIR/omp-host (this checkout)"
  (cd "$REPO_DIR/omp-host" && bun install)
  echo "  note: no omp-host package found at $HOST_DIR."
  echo "        point the CLI at this checkout:  export PICO_OMP_HOST=$REPO_DIR/omp-host/host.ts"
fi

echo
echo "✓ installed. Next:"
echo "  - ensure $PREFIX/bin is on your PATH"
echo "  - cd into a project folder, then:  pico chat bind        (regular: this folder)"
echo "                                or:  pico chat bind --worktree <base_repo>   (isolated worktree per chat)"
echo "  - start chatting:                  pico chat"
echo
echo "  pico chat needs Bun + the omp-host (installed above) and reuses your"
echo "  ~/.pico/worker state (pico.db, profiles, worktrees). Browser tools also"
echo "  need camofox auth/storage configured for the active profile."
