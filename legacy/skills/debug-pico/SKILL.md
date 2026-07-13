---
name: debug-pico
description: Use when you need to debug pico's own behavior from its source and logs — a misbehaving turn, deploy, schedule, or omp framing issue. Points to where pico's and omp's source live, how to query omp's help, and where the rotating logs are so you can self-diagnose.
---

You are pico, and pico is an omp (Oh My Pi) agent wrapped by a small Rust workspace. When your own behavior looks wrong — a turn renders badly, a deploy or `/update` misfires, a scheduled job misbehaves, or an omp frame decodes oddly — diagnose it from the source and logs below.

## pico's source

The live checkout the running bot was built from is `$PICO_HOME/agent` (default `~/.pico/agent`) — a read-only reference. It is a Rust workspace under `crates/`, split roughly into the supervisor (deploy/rollback/spawn), the worker daemon, `pico-core` (the platform-neutral turn engine, sessions, scheduling, and the omp host/client), the Discord adapter, the `pico` CLI, and a shared crate (paths, logging, config). Find the crate that owns your symptom and read it; don't infer behavior from this summary.

## omp's source

pico runs omp through a pinned Bun host, so omp's own behavior lives in omp, not in pico. omp's uncompiled TypeScript source is under:

```
$PICO_HOME/agent/omp-host/node_modules/@oh-my-pi/pi-coding-agent/src/
```

The glue that drives it — the host process, the skill/rule providers, and the extensions — sits in `$PICO_HOME/agent/omp-host/host.ts` and the `*-extension.ts` files beside it. The omp version is pinned in `omp-host/package.json`; read the source under that `node_modules`, not a globally installed omp.

## Querying omp

The version-locked omp CLI is a **Bun** bundle — run it with `bun` (not `node`, which can't parse it):

```
bun "$PICO_HOME/agent/omp-host/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" --help
```

Run `--help`, and `<subcommand> --help`, live to see the current flags and subcommands instead of relying on remembered ones. For harness concepts and internal URIs, `read omp://...` also resolves.

## Logs

The full history lives in rotating files (daily, last 7 kept); `docker logs` stdout is only a thinner `info`-level slice of the worker and supervisor, and the CLI logs nowhere else:

- `$PICO_HOME/worker/logs/worker.<date>.log` — the worker and turn engine; most self-debugging lives here.
- `$PICO_HOME/supervisor/logs/supervisor.<date>.log` — deploys, rollbacks, and worker spawns.
- `$PICO_HOME/worker/logs/cli.<date>.log` — the `pico` CLI (`pico omp`, `bind`, `schedule`).

Each file line is one JSON object (NDJSON) from `tracing`'s json layer: `{"timestamp","level","fields":{"message",…},"target","span"?,"spans"?}`. Event `key=value` pairs land under `.fields`; the enclosing span's fields (e.g. `run_turn{thread_id=…}`) land under `.span` and `.spans[]`, so a field like `thread_id` may be in either place depending on the line. The worker/supervisor files record down to `debug` (HTTP-client crates — serenity, reqwest, hyper, h2, tungstenite, rustls — are muted to `warn` by default), the stdout slice down to `info`.

Query with `jq`, pivoting on `.target` (`pico_core::…`, `pico_discord::…`), `.level`, and the fields the lines carry:

```
cd "$PICO_HOME/worker/logs"; F=worker.$(date +%F).log

# One thread's turn (thread_id can be a span field OR an event field)
jq -c 'select(.span.thread_id=="<ID>" or .fields.thread_id=="<ID>")
       | {t:.timestamp, lvl:.level, msg:.fields.message, tgt:.target}' "$F"

# Only problems
jq -c 'select(.level=="WARN" or .level=="ERROR")' "$F"

# One target, full objects
jq 'select(.target|startswith("pico_core"))' "$F"
```

Panics land as an `ERROR` line with `panic`, `location`, and `backtrace` fields. To go below the muted defaults (e.g. the per-frame omp event stream, or un-muting an HTTP crate) needs a `RUST_LOG` directive — set at deploy time, not changeable inside a running turn; a `RUST_LOG` target directive overrides the default mute for that target.

## Approach

Read the source for ground truth, then reproduce or grep the logs for what actually happened. When this guide disagrees with the code or the logs, the code and logs win.
