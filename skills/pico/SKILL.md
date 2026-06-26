---
name: pico
description: pico's own features and settings guide. Use when the user asks what pico is or what it can do, how to configure or customize pico, how profiles / worktrees / scheduling / long-term memory / the camofox browser / model selection / deployment work, or where a particular setting lives.
---

pico is a personal AI assistant. Under the hood it is an omp (Oh My Pi) agent: the same harness, persona, and tools, reachable two ways — as a bot over Discord, and through a command-line interface. Every Discord thread and every CLI session is one ongoing omp session: a single continuous conversation that keeps its own history, working directory, and state for as long as it lives. This guide describes what pico can do and where its settings live, so you can answer questions about pico itself accurately.

## Threads & worktrees

A conversation lives in a thread (on Discord) or a session (on the CLI), and each is backed by a working directory. A channel can be bound either to a plain working directory shared by its threads, or to a git base-repo — in which case every new thread forks its own fresh git worktree off that repo, isolating its changes from sibling threads. Closing a thread archives it, and when it was backed by a per-thread worktree, closing can also clean that worktree up.

## Profiles

A binding selects a profile (the default profile is named `default`). A profile is an isolated overlay layered on top of the base omp configuration: it can ADD its own skills and rules, and set its own model and browser toggle, all of which take priority over the base. Different channels can therefore run pico with entirely different capabilities and personalities. Each profile lives under `profiles/<profile>/` with its own `skills`, `rules`, `identity.md`, `profile.toml`, and `sessions`. pico runs one omp host process per profile.

## Binding a working directory

Binding is what connects a Discord channel (or a CLI session) to where pico does its work. A binding records the working directory or git base-repo, the profile to use, and related per-channel settings. Until a channel is bound, pico has no working directory there; once bound, its threads operate inside that directory (or fork worktrees from that repo) using the bound profile.

## Scheduling

pico can schedule autonomous jobs that run on their own, without a person prompting them. Each job has one of three trigger kinds:

- **oneshot** — fires once at a single future time.
- **cron** — a standard 5-field cron expression with an IANA timezone.
- **interval** — repeats on a fixed period, no shorter than 60 seconds.

A job delivers its run in one of two modes: `continue` fires the run into the same thread/session that owns the job, while `fresh` opens a brand-new thread for each run. A job may carry an optional pre-run bash script that acts as a gate: its JSON output `{skip, context}` decides whether the model actually runs and, if it does, feeds it that context. Runs missed while pico was down are swept on startup. A job that keeps failing is auto-disabled after three strikes, and a notice is posted to the guild's home channel.

## Long-term memory

pico has a long-term memory store, backed by Hindsight, that persists across sessions. The agent can retain durable facts and later recall or reflect over them, so knowledge learned in one conversation can resurface in another. Memory runs as a separate side service and is enabled through omp's memory backend.

## Browser

pico can drive a real camofox (Firefox/Camoufox) browser, exposed through the `camo_*` tools: open and navigate pages, snapshot the page, click, type, scroll, take screenshots, and list or close tabs. The browser is enabled per profile, via that profile's browser toggle in its `profile.toml`. The logged-in browser session — its cookies and logins — is shared across profiles and persists across restarts, not isolated per profile. For setting up or refreshing a logged-in browser session, use the separate `browser-login` skill rather than configuring cookies by hand here.

## Model

The language model is chosen per profile, via the model setting in `profiles/<profile>/profile.toml`. Model resolution tries an exact provider/id match first, then a fuzzy match by id, and finally falls back to the default model. Because the model is part of the profile overlay, different channels can run pico on different models.

## Command-line interface

Besides Discord, pico offers a command-line interface that launches the omp TUI bound to a channel/thread. It reuses the same binding, profile, identity, and session machinery as Discord, so a CLI session and a Discord thread are interchangeable views onto the same kind of omp session. When more than one thread exists for a binding, the CLI presents a picker (handling the none / one / many cases); with a single thread it attaches directly.

## Deploy & updates

pico runs under a supervisor that manages the worker process. On an update, the supervisor hot-swaps the worker binary in place rather than requiring a full restart, keeps a short history of recent deploys, and automatically rolls back to the previous binary if the new one fails to start. The whole stack is deployed via docker-compose.

## Where settings live

Configuration lives under `PICO_HOME` (default `~/.pico`), split between the worker root (`PICO_HOME/worker/`) and the supervisor root (`PICO_HOME/supervisor/`).

Under `PICO_HOME/worker/`:

- `worker.toml` — timezone, the worktree directory, the list of active platforms, and scheduling settings (grace period, script timeout, run cap).
- `discord.toml` — per-guild settings (id, working directory, profile, home channel) plus top-level rendering options.
- `profiles/<profile>/profile.toml` — the profile's model and browser toggle.
- `profiles/<profile>/skills` and `profiles/<profile>/rules` — that profile's added capabilities.
- `pico.db` — persistent state (bindings, threads, schedules, and more).

Under `PICO_HOME/supervisor/`:

- `supervisor.toml` — supervisor settings.
