# pico

A Discord bot that fronts the Oh My Pi coding agent (`omp`). Two binaries:

- **`supervisor`** — a long-running daemon. It owns the control socket, manages
  the worker binary in `current`/`previous` slots, and hot-deploys / rolls back
  the worker without losing in-flight work. Run with **no arguments** to start
  the daemon; the same binary with a subcommand (`deploy`, `status`, `stop`,
  `rollback`) is a thin client that talks to a running daemon over its socket.
- **`worker`** — the Discord client. One per host. It connects to the gateway,
  routes each thread to an `omp --mode rpc-ui` child, and reports `ready` back to
  the supervisor so a bad deploy fails its health check and rolls back instead
  of half-starting. Spawned and supervised by the daemon; you never launch it by
  hand after the first deploy.

This guide targets **Linux** (systemd). macOS/Windows are not covered.

## How it fits together

```
~/.pico/
├── supervisor/
│   ├── supervisor.toml          # optional daemon config (see below)
│   ├── pico.sock                # control socket (created at runtime)
│   ├── slots/
│   │   ├── current             # symlink to builds/<id>/worker (absolute), booted on startup
│   │   └── previous            # symlink to the prior build, rollback target
│   ├── builds/<id>/worker       # deploy copies each binary here
│   └── logs/                    # supervisor.<date>.log
└── workers/
    └── default/                 # the worker root
        ├── secrets/
        │   └── discord_bot_token   # REQUIRED — the bot token, nothing else
        ├── config.toml             # which guilds are served (see below)
        ├── bindings.toml           # per-channel routing, managed by /bind
        ├── profiles/<name>/
        │   ├── config.toml         # model + display options
        │   └── identity.md         # appended system prompt
        └── logs/                   # worker.<date>.log
```

Everything hangs off `$HOME/.pico`, resolved from the running user's home — so
the supervisor and your `supervisor status` client must run as the **same user**.
That is also why the recommended deployment is a **systemd user service**: `$HOME`
is correct automatically, no dedicated account or root is needed.

## Prerequisites

- **Rust 1.92+** (`rustup`) to build the binaries.
- **`omp` on the service's `PATH`.** The worker spawns `omp --mode rpc-ui` per
  thread; if it is not reachable, every turn fails. systemd services do **not**
  inherit your interactive shell `PATH`, so the unit below sets it explicitly —
  make sure the directory holding `omp` is in it.
- **An `omp` model provider configured for the service user.** The worker passes
  no provider credentials; `omp` resolves its own from its `$HOME`-based
  credential store (or env). Because the user service runs as you, an `omp`
  login you already did on the box works as-is.
- **A Discord bot application** with a token and the **Message Content** intent
  enabled (Developer Portal → Bot → Privileged Gateway Intents). Invite it to
  your server with the `bot` and `applications.commands` scopes.

## 1. Build

```sh
cargo build --release -p supervisor -p worker
```

This produces `target/release/supervisor` and `target/release/worker`.

## 2. Install the supervisor binary

Only the **supervisor** needs a stable install path — the worker binary is taken
over by `deploy` (copied into `~/.pico/supervisor/builds/`). Put it somewhere on
your `PATH`:

```sh
mkdir -p ~/.local/bin
install -m755 target/release/supervisor ~/.local/bin/supervisor
# ensure ~/.local/bin is on your interactive PATH (add to ~/.profile if needed)
```

## 3. Configure the worker root

```sh
mkdir -p ~/.pico/workers/default/secrets
printf '%s' 'YOUR_DISCORD_BOT_TOKEN' > ~/.pico/workers/default/secrets/discord_bot_token
chmod 600 ~/.pico/workers/default/secrets/discord_bot_token
```

Then declare which Discord servers the bot serves. A guild **without** an entry
here is ignored entirely, so this file is required to do anything useful:

```sh
cat > ~/.pico/workers/default/config.toml <<'EOF'
# One block per served Discord server.
[[guild]]
id = "123456789012345678"            # the guild (server) id, 17–20 digits, quoted
cwd = "/home/you/projects/app"        # absolute dir omp runs in for this guild
profile = "default"                   # optional; defaults to "default"
EOF
```

Channels inside a served guild default to that guild's `(profile, cwd)`; the
in-Discord `/bind` command overrides a single channel and writes `bindings.toml`
for you. A profile is optional — `profiles/<name>/config.toml` can set
`[llm] model = "provider/model"` and `[discord] surface_thinking = true`, and
`identity.md` is appended to the system prompt — but the defaults work with no
profile directory at all.

### Optional: `supervisor.toml`

Drop `~/.pico/supervisor/supervisor.toml` only to override defaults; every field
is optional:

```toml
# socket_path = "/run/user/1000/pico.sock"   # default: ~/.pico/supervisor/pico.sock
health_timeout_secs = 30                       # worker readiness + shutdown grace

# [[workers]]                                  # default: ~/.pico/workers/default
# root = "/home/you/.pico/workers/default"
```

## 4. Run the supervisor under systemd (user service)

Create `~/.config/systemd/user/pico-supervisor.service`:

```ini
[Unit]
Description=pico supervisor (Discord worker manager)

[Service]
Type=simple
ExecStart=%h/.local/bin/supervisor
Restart=always
RestartSec=2
# The worker spawns `omp` from this PATH — include the dir omp lives in.
Environment=PATH=%h/.local/bin:%h/.bun/bin:%h/.cargo/bin:/usr/local/bin:/usr/bin:/bin
# Environment=RUST_LOG=info

[Install]
WantedBy=default.target
```

`Type=simple` fits: the supervisor stays in the foreground and shuts down
cleanly on `SIGTERM` (drains in-flight deploys, stops the worker, removes the
socket), so `systemctl stop` is graceful. The unit is intentionally **not**
sandboxed (`ProtectHome`, etc.) — `omp` needs broad filesystem access to do its
work.

Enable it, and make it survive logout and reboot:

```sh
sudo loginctl enable-linger "$USER"        # run without an active login session
systemctl --user daemon-reload
systemctl --user enable --now pico-supervisor
```

Check it and follow logs:

```sh
systemctl --user status pico-supervisor
journalctl --user -u pico-supervisor -f    # daemon journal
tail -f ~/.pico/supervisor/logs/supervisor.*.log
tail -f ~/.pico/workers/default/logs/worker.*.log
```

On a fresh box the daemon starts, binds the socket, finds no `current` slot, and
logs `no current slot; awaiting deploy` — that is expected until the first
deploy. A `status`/`deploy` fired in the first moment after start can race the
socket bind and report "is the supervisor running?"; just retry.

## 5. First deploy

With the daemon running, hand it a freshly built worker binary. It copies the
binary into its own tree, spawns it, waits for the `ready` ping, and only then
promotes the `current` slot — so the next reboot re-spawns this worker
automatically. (That boot re-spawn still has to connect to Discord and report
`ready` within `health_timeout_secs`; on a cold boot where the network isn't up
in time the supervisor logs the failure and awaits a manual deploy — it does not
auto-retry. Raise `health_timeout_secs`, or order the unit after the network, if
that bites.)

```sh
cargo build --release -p worker
supervisor deploy "$(pwd)/target/release/worker"   # path MUST be absolute
supervisor status
```

You can also deploy from a configured Discord channel:

```
/deploy path:/abs/path/to/target/release/worker
```

The new worker posts the deploy outcome back to the channel it was triggered
from.

## Operating

```sh
supervisor status      # running pid, current slot, version/build, recent deploys
supervisor deploy <abs-path-to-worker>   # roll forward; auto-rolls-back if it fails health check
supervisor rollback    # swap back to the previous slot
supervisor stop        # stop the worker (the daemon keeps running)
systemctl --user restart pico-supervisor # restart the daemon itself
```

**Updating the worker:** rebuild (`cargo build --release -p worker`) and
`supervisor deploy` the new binary. If it boots but misbehaves, `supervisor
rollback` returns to the previous slot. A deploy that fails to report `ready`
within `health_timeout_secs` is rolled back for you.

## Alternative: system-wide service

If you would rather not enable lingering — e.g. a shared or headless host — run
it as a system service instead. Install the binary under the target user's home,
then create `/etc/systemd/system/pico-supervisor.service`:

```ini
[Unit]
Description=pico supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pico
Environment=HOME=/home/pico
Environment=PATH=/home/pico/.local/bin:/home/pico/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/pico/.local/bin/supervisor
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now pico-supervisor
```

`User=pico` already makes systemd populate `$HOME` from the account database, so
the explicit `Environment=HOME=` is redundant — it just pins the value visibly,
since every path resolves from it. Run the `supervisor` client as that same user
(`sudo -u pico supervisor status`) so it finds the same socket.
