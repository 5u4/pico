#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/5u4/pico.git"
AGENT_DIR="$HOME/.pico/agent"

die() { echo "error: $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git not found — install git first"
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "'docker compose' not available — install the Docker Compose v2 plugin"
compose_ver=$(docker compose version --short 2>/dev/null | sed 's/^v//')
[ -n "$compose_ver" ] && [ "$(printf '%s\n%s\n' "2.24.0" "$compose_ver" | sort -V | head -n1)" = "2.24.0" ] \
  || die "docker compose >= 2.24.0 required (found ${compose_ver:-unknown}); the hindsight service uses optional env_file syntax"

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
