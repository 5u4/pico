FROM rust:1-bookworm

RUN apt-get update \
     && apt-get install -y --no-install-recommends \
     git ripgrep ca-certificates curl unzip jq python3 python3-venv build-essential pkg-config \
     && rm -rf /var/lib/apt/lists/*

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
