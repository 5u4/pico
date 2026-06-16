# pico

A self-hosted Discord bot that fronts the Oh My Pi coding agent (`omp`): each
Discord thread drives one `omp` session. A small **supervisor** daemon keeps the
**worker** (the bot) alive and hot-swaps it on deploy, rolling back automatically
if a new build fails to come up.

## Quickstart (Linux)

Prerequisites: a Rust toolchain, `omp` on your `PATH`, and a Discord bot token
with the **Message Content** intent enabled.

### 1. Clone and install the binaries

```sh
git clone https://github.com/5u4/pico.git
cd pico
cargo install --path crates/supervisor   # -> ~/.cargo/bin/pico-supervisor
cargo install --path crates/worker       # -> ~/.cargo/bin/pico-worker
```

Make sure `~/.cargo/bin` is on your `PATH`.

### 2. Run the supervisor under systemd

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/pico-supervisor.service <<'EOF'
[Unit]
Description=pico supervisor

[Service]
ExecStart=%h/.cargo/bin/pico-supervisor
Restart=always
RestartSec=2
# The worker spawns `omp` from this PATH — include the dir omp lives in.
Environment=PATH=%h/.cargo/bin:%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

sudo loginctl enable-linger "$USER"        # keep it running across logout/reboot
systemctl --user daemon-reload
systemctl --user enable --now pico-supervisor
```

It comes up with no worker yet and logs `no current slot; awaiting deploy` —
expected until step 4.

### 3. Add the bot token and server config

```sh
mkdir -p ~/.pico/workers/default/secrets
printf '%s' 'YOUR_BOT_TOKEN' > ~/.pico/workers/default/secrets/discord_bot_token
chmod 600 ~/.pico/workers/default/secrets/discord_bot_token

cat > ~/.pico/workers/default/config.toml <<'EOF'
[[guild]]
id = "YOUR_DISCORD_SERVER_ID"        # 17–20 digit snowflake
cwd = "/abs/path/the/bot/works/in"   # where omp runs for this server
EOF
```

A server with no `[[guild]]` entry is ignored.

### 4. Deploy the worker

```sh
pico-supervisor deploy "$(command -v pico-worker)"
pico-supervisor status
```

The supervisor copies the binary into its own tree, starts it, and waits for it
to connect to Discord before going live; on the next reboot it brings this worker
back automatically. The bot is up — try `/ping` in a configured channel.

## Operating

```sh
pico-supervisor status               # pid, current build, recent deploys
pico-supervisor deploy <abs-path>    # roll forward (auto-rolls-back on failure)
pico-supervisor rollback             # return to the previous build
pico-supervisor stop                 # stop the worker; the daemon keeps running
journalctl --user -u pico-supervisor -f
```

**Update the bot** (from the repo): `git pull`, then

```sh
cargo install --path crates/worker
pico-supervisor deploy "$(command -v pico-worker)"
```

or `/deploy path:<abs-path>` from a configured Discord channel.

## Layout & config

Everything lives under `~/.pico`, split into two trees the daemon and bot never
write across:

- `~/.pico/supervisor/` — the daemon's own state: control socket, build slots,
  staged worker binaries, logs. Optional `supervisor.toml` overrides defaults
  (`health_timeout_secs`, `socket_path`, worker `root`).
- `~/.pico/workers/default/` — the worker root: `secrets/discord_bot_token`,
  `config.toml` (served servers), `bindings.toml` (per-channel routing, written
  by the in-Discord `/bind` command), optional `profiles/<name>/`, and logs.

## Running as a system service

Prefer not to enable lingering (e.g. a shared host)? Install the unit at
`/etc/systemd/system/pico-supervisor.service` with `User=you` and an explicit
`Environment=PATH=…` instead of a user unit, then `sudo systemctl enable --now
pico-supervisor`. Everything still resolves from that user's `$HOME`.

## Running in Docker

An alternative to the systemd setup: the supervisor and worker run together in
one container, building the worker from the bind-mounted repo on start. State
lives on Docker volumes, so `docker compose down` (even `-v`) never loses the
token or sessions.

- the repo is bind-mounted at `/workspace/pico` — build source, and the cwd the
  bot works in for bound channels;
- `pico-state` → `~/.pico` (token, config, bindings, profiles, sessions);
- `omp-state` → `~/.omp` (omp's Copilot auth + config, not its blob cache);
- `pico-build` → cargo registry + `target`, so restarts build incrementally.

### 1. Seed the volumes from an existing install

`docker/seed.sh` copies this host's `~/.pico/workers` and the omp credentials
from `~/.omp/agent` into the `pico-state` and `omp-state` volumes, rewriting the
guild/channel `cwd`s to their in-container paths. omp's multi-GB blob cache is
left behind — only auth + config cross over.

```sh
bash docker/seed.sh
```

Starting fresh instead? Skip the seed, drop a `discord_bot_token` and
`config.toml` into the `pico-state` volume by hand (see "Layout & config"), and
set up omp auth by logging in once with `docker compose exec pico omp` after the
container is up.

### 2. Build and run

```sh
docker compose up -d --build
docker compose logs -f          # the first run is a cold cargo build
```

The container builds both binaries, deploys the worker, and connects to Discord.
A later restart with unchanged code reuses the live build slot instead of
redeploying. Only one instance may hold the bot token at a time — stop the
host/systemd supervisor before bringing the container up.

### Operating

`pico-supervisor` is on the container's PATH, so the usual verbs work:

```sh
docker compose exec pico pico-supervisor status
docker compose exec pico pico-supervisor rollback
```

To roll a code change forward, edit it on the host (the repo is mounted) and
either `docker compose restart pico` (rebuilds, then redeploys if the binary
changed) or do a health-checked, auto-rolling-back swap in place:

```sh
docker compose exec pico sh -lc \
  'cargo build --release -p pico-worker && pico-supervisor deploy "$(command -v pico-worker)"'
```
