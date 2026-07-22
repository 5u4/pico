---
description: Effect-native invariants for the backend (core, web-protocol, engine) — the sanctioned patterns for validation, errors, concurrency, and resource cleanup
alwaysApply: true
---

# Backend bug prevention (Effect-native)

The backend runs on Bun + strict TypeScript + Effect v3. `tsc --noEmit` (patched
via `@effect/tsgo`, so Effect diagnostics surface as compile errors), Biome, and
`bun test` gate every commit and CI run. These invariants keep LLM-authored
Effect code correct.

Scope: `packages/core`, `packages/web-protocol`, `apps/engine`. `apps/web` is
plain TypeScript React with zero Effect — it hand-writes types and native
control flow, and imports only static types (`import type`) from
`@pico/web-protocol`.

## Invariants

- **Parse at boundaries with Schema.** Every value crossing a trust boundary —
  config, env, HTTP/tool/LLM output, file contents, the web transport payload —
  is decoded with an Effect `Schema` into a known type via `Schema.decode` /
  `Schema.decodeUnknown`. Never `as SomeType` external data; a wrong `as` is a
  lie the compiler believes. Decode, then work with the parsed value.
- **Errors live in the error channel.** Model failures as typed errors with
  `Data.TaggedError` (or `Schema.TaggedError`) and let them flow in the Effect
  `E` channel. Handle with `Effect.catchTag` / `Effect.catchTags`. Reserve
  `Effect.die` / defects for truly unrecoverable programmer errors. Never
  swallow an error to stay on the happy path, and never widen a typed error to
  the global `Error` in a catch.
- **Never leave an Effect floating.** Every Effect must be `yield*`-ed in a
  generator, composed into a pipeline, or run at an entry point. The
  `floatingEffect` diagnostic is an error — do not assign-and-forget.
- **Exhaust discriminated unions.** End a `switch`/if-chain over a union with an
  `assertNever(x: never)` default (or `Match` exhaustiveness) so a new variant
  becomes a compile error, not a silent fallthrough.
- **Respect `noUncheckedIndexedAccess`.** `arr[i]` and `map.get(k)` are
  `T | undefined`. Check before use, or reach for `Array`/`HashMap` combinators;
  don't `!`-assert the undefined away.
- **Clean up what you acquire with Scope.** Anything with a lifetime — servers,
  sockets, file handles, subscriptions, fibers — is acquired with
  `Effect.acquireRelease` / `Layer.scoped` so release runs even on interruption
  or failure. Prefer interruption (`Effect.interrupt`, fiber cancellation) over
  ad-hoc teardown flags.

## Sanctioned patterns — use Effect, don't reach for alternatives

- **Validation / parsing:** Effect `Schema`. Do not add `zod`.
- **Typed errors:** the Effect `E` channel + `Data.TaggedError`. Do not add
  `neverthrow`.
- **Concurrency / parallelism:** `Effect.all(..., { concurrency })`,
  `Effect.forEach`, `Stream`, fibers, and `Semaphore` for mutual exclusion. Do
  not add `p-map` or `async-mutex`.
- **Retry with backoff:** `Effect.retry` + `Schedule`. Do not add `p-retry`.
- **Services / DI / config:** `Effect.Service` + `Layer`, `Config` for env. The
  engine composes `Layer`s and provides them once at the entry point via
  `Layer.launch` / `BunRuntime.runMain`.

Do not introduce a broad FP or effect-system alternative; Effect covers
validation, errors, concurrency, retries, resource safety, and DI. The
`@effect/language-service` diagnostics (via `@effect/tsgo`) enforce most of the
above at typecheck time — treat their errors as build failures.
