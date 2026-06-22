#!/usr/bin/env bash
# Bring up the standalone Hindsight memory server and block until it is healthy.
# pico does not manage this; run it once on the deployment host. The container is
# restart:unless-stopped, so it survives reboots without re-running this. First
# start downloads embedding/cross-encoder models, so allow several minutes.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env.hindsight ]; then
  echo "missing .env.hindsight — copy .env.hindsight.example and set HINDSIGHT_API_LLM_API_KEY" >&2
  exit 1
fi

docker compose up -d --wait --wait-timeout 900 hindsight
echo "hindsight healthy at http://hindsight:8888 (omp) / http://127.0.0.1:8888 (host)"
