FROM rust:1-bookworm

RUN apt-get update \
     && apt-get install -y --no-install-recommends \
     git ripgrep ca-certificates curl unzip jq python3 python3-venv build-essential pkg-config \
     && rm -rf /var/lib/apt/lists/*

ARG CAMOFOX_BROWSER_VERSION=1.11.2
ARG CAMOUFOX_JS_VERSION=0.10.2
ARG PLAYWRIGHT_CORE_VERSION=1.59.1
RUN apt-get update \
     && apt-get install -y --no-install-recommends \
     libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libx11-xcb1 libxcomposite1 \
     libxcursor1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
     libxtst6 libegl1-mesa libgl1-mesa-dri libgbm1 xvfb fonts-liberation \
     fonts-noto-color-emoji fontconfig gnupg \
     && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
     | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
     && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
     > /etc/apt/sources.list.d/nodesource.list \
     && apt-get update \
     && apt-get install -y --no-install-recommends nodejs \
     && rm -rf /var/lib/apt/lists/*
RUN npm install -g @askjo/camofox-browser@${CAMOFOX_BROWSER_VERSION} \
     && CAMOFOX_DIR="$(npm root -g)/@askjo/camofox-browser" \
     && ( cd "$CAMOFOX_DIR" && npm install --no-audit --no-fund \
     camoufox-js@${CAMOUFOX_JS_VERSION} playwright-core@${PLAYWRIGHT_CORE_VERSION} ) \
     && node "$CAMOFOX_DIR/node_modules/camoufox-js/dist/__main__.js" fetch \
     && npm cache clean --force

ENV BUN_INSTALL=/root/.bun
RUN curl -fsSL https://bun.sh/install | bash
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

RUN install -m 0755 -d /etc/apt/keyrings \
     && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
     && chmod a+r /etc/apt/keyrings/docker.asc \
     && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
     > /etc/apt/sources.list.d/docker.list \
     && apt-get update \
     && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
     && rm -rf /var/lib/apt/lists/*

ENV PATH=/root/.bun/bin:/root/.local/bin:$PATH \
     CARGO_HOME=/build/cargo \
     CARGO_TARGET_DIR=/build/target

COPY docker/entrypoint.sh /usr/local/bin/pico-entrypoint
RUN chmod +x /usr/local/bin/pico-entrypoint

WORKDIR /root/.pico/agent
ENTRYPOINT ["pico-entrypoint"]
