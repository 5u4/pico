FROM rust:1-bookworm

# System packages (installed as root at build time).
RUN apt-get update \
     && apt-get install -y --no-install-recommends \
     git ripgrep ca-certificates curl unzip jq python3 python3-venv build-essential pkg-config \
     && rm -rf /var/lib/apt/lists/*

# sccache (pinned), baked as the rustc-wrapper for pico's own cargo builds. Static-musl
# release binary, arch-detected, to /usr/local/bin. Baked not fetched-at-runtime: it is the
# repo .cargo/config.toml rustc-wrapper, so a missing binary would fail every pico cargo build.
ARG SCCACHE_VERSION=v0.16.0
RUN arch="$(uname -m)" \
     && tarball="sccache-${SCCACHE_VERSION}-${arch}-unknown-linux-musl" \
     && curl -fsSL "https://github.com/mozilla/sccache/releases/download/${SCCACHE_VERSION}/${tarball}.tar.gz" -o /tmp/sccache.tar.gz \
     && tar -xzf /tmp/sccache.tar.gz -C /tmp \
     && install -m 0755 "/tmp/${tarball}/sccache" /usr/local/bin/sccache \
     && rm -rf /tmp/sccache.tar.gz "/tmp/${tarball}" \
     && sccache --version

# Docker CLI (system-wide).
RUN install -m 0755 -d /etc/apt/keyrings \
     && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
     && chmod a+r /etc/apt/keyrings/docker.asc \
     && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
     > /etc/apt/sources.list.d/docker.list \
     && apt-get update \
     && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
     && rm -rf /var/lib/apt/lists/*

# Node.js LTS (system-wide) — runtime for the worker-spawned camofox-browser daemon
# (its bin has a `#!/usr/bin/env node` shebang). NodeSource 22.x satisfies the
# package's `engines: node >=22`.
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc \
     && chmod a+r /etc/apt/keyrings/nodesource.asc \
     && echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main" \
     > /etc/apt/sources.list.d/nodesource.list \
     && apt-get update \
     && apt-get install -y --no-install-recommends nodejs \
     && rm -rf /var/lib/apt/lists/*

# Camoufox (anti-detection Firefox) runtime deps for the camofox-browser daemon:
# the system libraries the engine binary dynamically links (incl. GL/EGL/GBM for
# WebGL) plus the Xvfb virtual display it runs headful inside, and fonts. The
# ~650 MB engine binary itself is NOT baked — the worker fetches it lazily into a
# persistent cache on the first browser-enabled startup (see camofox-fetch-engine).
RUN apt-get update \
     && apt-get install -y --no-install-recommends \
     xvfb fonts-liberation fonts-noto-color-emoji fontconfig \
     libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libxrender1 libxss1 \
     libegl1-mesa libgl1-mesa-dri libgbm1 \
     libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxtst6 \
     && rm -rf /var/lib/apt/lists/*

# camofox-browser CLI, version-pinned. The bundled camoufox-js regressed (a broken
# virtual-display path → `[object Promise]`); camoufox-js 0.10.2 + playwright-core
# 1.59.1 is the known-good combo. `CAMOFOX_SKIP_DOWNLOAD=1` skips only the engine
# download (native deps like better-sqlite3 still build); camofox-fetch-engine pulls
# the engine via the pinned camoufox-js lazily at runtime instead.
ARG CAMOFOX_BROWSER_VERSION=1.11.2
ARG CAMOUFOX_JS_VERSION=0.10.2
ARG PLAYWRIGHT_CORE_VERSION=1.59.1
RUN CAMOFOX_SKIP_DOWNLOAD=1 npm install -g @askjo/camofox-browser@${CAMOFOX_BROWSER_VERSION} \
     && CDIR="$(npm root -g)/@askjo/camofox-browser" \
     && ( cd "$CDIR" && npm install --no-audit --no-fund --ignore-scripts \
        camoufox-js@${CAMOUFOX_JS_VERSION} playwright-core@${PLAYWRIGHT_CORE_VERSION} ) \
     && printf '#!/bin/sh\nexec node "%s/node_modules/camoufox-js/dist/__main__.js" fetch "$@"\n' "$CDIR" \
        > /usr/local/bin/camofox-fetch-engine \
     && chmod +x /usr/local/bin/camofox-fetch-engine \
     && npm cache clean --force

# Interactive-login VNC stack for the camofox-browser `vnc` plugin: x11vnc attaches to
# Camoufox's Xvfb, noVNC + websockify (port 6080) expose it so a human can log into
# sites / solve CAPTCHAs by hand; procps backs the plugin's Xvfb-display detection.
RUN apt-get update \
     && apt-get install -y --no-install-recommends \
     x11vnc novnc python3-websockify procps \
     && rm -rf /var/lib/apt/lists/*

# Adapt the camofox-browser `vnc` plugin for pico's unprivileged (non-root) container:
# (1) it ships disabled in camofox.config.json and the plugin allowlist ignores
#     ENABLE_VNC unless the config lists it enabled — flip it on; (2) vnc-watcher.sh
#     writes websockify/x11vnc logs under /var/log, which the `pico` user cannot write —
#     redirect them to /tmp so the watcher doesn't die and noVNC actually starts.
RUN CDIR="$(npm root -g)/@askjo/camofox-browser" \
     && jq '.plugins.vnc.enabled = true' "$CDIR/camofox.config.json" > "$CDIR/camofox.config.json.tmp" \
     && mv "$CDIR/camofox.config.json.tmp" "$CDIR/camofox.config.json" \
     && sed -i 's#/var/log/#/tmp/#g' "$CDIR/plugins/vnc/vnc-watcher.sh"

# Non-root user. UID/GID overridable to match a host user when bind mounts need it.
ARG PICO_UID=1000
ARG PICO_GID=1000
RUN groupadd -g "$PICO_GID" pico \
     && useradd -m -u "$PICO_UID" -g "$PICO_GID" -s /bin/bash pico

# Every writable path (toolchains, caches, build output, supervisor state) lives
# under pico's home and is pico-owned in the image. That is what lets the container
# run fully unprivileged with no startup chown: a freshly-created named volume
# mounted onto one of these dirs inherits the dir's pico:pico ownership.
# No global CARGO_TARGET_DIR: it would force EVERY cargo in the container —
# including unrelated projects the agent builds in a bound channel — into one
# target dir (the env overrides a project's own .cargo/config.toml). pico builds
# instead scope their target dir explicitly (entrypoint startup, /update,
# /dev-deploy) or via the entrypoint-written ~/.pico/agent/.cargo/config.toml.
ENV HOME=/home/pico \
     BUN_INSTALL=/home/pico/.bun \
     CARGO_HOME=/home/pico/.cache/build/cargo \
     SCCACHE_DIR=/home/pico/.cache/build/sccache \
     SCCACHE_CACHE_SIZE=20G
RUN curl -fsSL https://bun.sh/install | bash \
     && curl -LsSf https://astral.sh/uv/install.sh | sh \
     && mkdir -p /home/pico/.cache/build /home/pico/.pico/supervisor /home/pico/.local/bin \
     && chown -R pico:pico /home/pico

ENV PATH=/home/pico/.bun/bin:/home/pico/.local/bin:$PATH

COPY docker/entrypoint.sh /usr/local/bin/pico-entrypoint
RUN chmod +x /usr/local/bin/pico-entrypoint

# Run as the unprivileged user. docker.sock access is granted by compose `group_add`
# (the socket's group), so no in-container privilege is ever required.
USER pico
WORKDIR /home/pico/.pico/agent
ENTRYPOINT ["pico-entrypoint"]
