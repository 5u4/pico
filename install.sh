#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/5u4/pico.git"
AGENT_DIR="$HOME/.pico/agent"

die() { echo "error: $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git not found — install git first"
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "'docker compose' not available — install the Docker Compose v2 plugin"

if [ -e "$AGENT_DIR" ]; then
  echo "→ pico already installed at $AGENT_DIR; ensuring it's up"
  cd "$AGENT_DIR"
  docker compose up -d
else
  echo "→ cloning pico into $AGENT_DIR"
  git clone "$REPO_URL" "$AGENT_DIR"
  cd "$AGENT_DIR"
  echo "→ building and starting pico (first run compiles in-container; this takes a while)…"
  docker compose up -d --build
fi

echo "✓ pico is up. Follow logs:  (cd $AGENT_DIR && docker compose logs -f)"
