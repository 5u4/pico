FROM rust:1-bookworm

# System packages (installed as root at build time).
RUN apt-get update \
     && apt-get install -y --no-install-recommends \
     git ripgrep ca-certificates curl unzip jq python3 python3-venv build-essential pkg-config \
     && rm -rf /var/lib/apt/lists/*

# Docker CLI (system-wide).
RUN install -m 0755 -d /etc/apt/keyrings \
     && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
     && chmod a+r /etc/apt/keyrings/docker.asc \
     && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
     > /etc/apt/sources.list.d/docker.list \
     && apt-get update \
     && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
     && rm -rf /var/lib/apt/lists/*

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
     CARGO_HOME=/home/pico/.cache/build/cargo
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
