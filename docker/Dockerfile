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

# Camoufox: opt-in per-profile anti-detection browser. The worker spawns this
# Node daemon (`camofox-browser`) on demand for profiles with `[browser] enabled`,
# and leaves it dormant otherwise. Needs Node 22 + Firefox runtime libs + xvfb +
# a prebaked Camoufox binary. Versions are PINNED on purpose: @askjo/camofox-browser
# floats its deps (`camoufox-js ">=0.10.0"`, `playwright-core "^1.58.0"`) which drift
# to incompatible releases — newer camoufox-js makes `VirtualDisplay.get()` async
# (Firefox gets `DISPLAY=[object Promise]`) and newer playwright-core sends a Juggler
# viewport schema Camoufox 135 rejects. These are the package's committed-lockfile
# versions: camoufox-js 0.10.2 + playwright-core 1.59.1 → Camoufox 135.0.1-beta.24.
ARG CAMOFOX_BROWSER_VERSION=1.11.2
ARG CAMOUFOX_JS_VERSION=0.10.2
ARG PLAYWRIGHT_CORE_VERSION=1.59.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libx11-xcb1 libxcomposite1 \
      libxcursor1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
      libxtst6 libegl1-mesa libgl1-mesa-dri libgbm1 xvfb fonts-liberation \
      fonts-noto-color-emoji fontconfig \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
# Global-install the server, then pin the two drifting deps to the lockfile
# versions, then prebake the Camoufox binary (camoufox-js 0.10.2 fetches
# 135.0.1-beta.24) into /root/.cache/camoufox so runtime never downloads it.
RUN npm install -g @askjo/camofox-browser@${CAMOFOX_BROWSER_VERSION} \
 && CAMOFOX_DIR="$(npm root -g)/@askjo/camofox-browser" \
 && ( cd "$CAMOFOX_DIR" && npm install --no-audit --no-fund \
        camoufox-js@${CAMOUFOX_JS_VERSION} playwright-core@${PLAYWRIGHT_CORE_VERSION} ) \
 && node "$CAMOFOX_DIR/node_modules/camoufox-js/dist/__main__.js" fetch \
 && npm cache clean --force

COPY docker/entrypoint.sh /usr/local/bin/pico-entrypoint
RUN chmod +x /usr/local/bin/pico-entrypoint

WORKDIR /workspace/pico
ENTRYPOINT ["pico-entrypoint"]
