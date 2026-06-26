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

Logs are rotating files (daily, last 7 kept), not stdout:

- `$PICO_HOME/worker/logs/worker.<date>.log` — the worker and turn engine; most self-debugging lives here.
- `$PICO_HOME/supervisor/logs/supervisor.<date>.log` — deploys, rollbacks, and worker spawns.
- `$PICO_HOME/worker/logs/cli.<date>.log` — the `pico` CLI (`pico omp`, `bind`, `schedule`).

The files record down to `debug`, and the worker and supervisor ones also capture panics with a backtrace, so start by reading today's file and grepping for the thread, session, or schedule involved — pivot on whatever fields the lines actually carry. Going deeper than the default (for example, the per-frame omp event stream) takes a target `RUST_LOG` directive, but that is set at deploy time and cannot be changed from inside a running turn. What `docker logs` shows is fixed at `info`, so the rotating file is the real history.

## Approach

Read the source for ground truth, then reproduce or grep the logs for what actually happened. When this guide disagrees with the code or the logs, the code and logs win.
