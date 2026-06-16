# syntax=docker/dockerfile:1
#
# pico in a container: carries the Rust toolchain (the supervisor builds and
# deploys the worker at runtime from the bind-mounted repo) plus `omp`, the
# coding agent the worker spawns. State lives on volumes, not in the image —
# see docker-compose.yml and docker/seed.sh.
FROM rust:1-bookworm

# git: build.rs embeds the commit sha, and omp shells out to it in repos.
# ripgrep + ca-certificates: omp's search and its TLS to Discord/model providers.
# curl + unzip: the bun installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# omp ships as a bun-run Node CLI. Pin bun for reproducible images, and omp to
# the host's version so the seeded `agent.db` auth schema matches (keep the omp
# pin in sync with docker/seed.sh).
ENV BUN_INSTALL=/root/.bun
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14" \
 && /root/.bun/bin/bun add -g @oh-my-pi/pi-coding-agent@16.0.1

# Build cache (CARGO_HOME registry + target) lands on the /build volume so deps
# survive container recreation; the worker omp spawns is found on /root/.bun/bin.
ENV PATH=/root/.bun/bin:$PATH \
    CARGO_HOME=/build/cargo \
    CARGO_TARGET_DIR=/build/target

COPY docker/entrypoint.sh /usr/local/bin/pico-entrypoint
RUN chmod +x /usr/local/bin/pico-entrypoint

WORKDIR /workspace/pico
ENTRYPOINT ["pico-entrypoint"]
