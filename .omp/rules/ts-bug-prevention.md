---
description: TypeScript bug-prevention invariants and the sanctioned libraries for validation, errors, concurrency, and resource cleanup
alwaysApply: true
---

# TypeScript bug prevention

The repo runs on Bun + strict TypeScript. `tsc --noEmit`, Biome, and `bun test`
gate every commit and CI run. These invariants keep LLM-authored code correct.

## Invariants

- **Parse at boundaries, never assume.** Every value crossing a trust boundary —
  config, env, HTTP responses, tool/LLM output, file contents — is parsed with a
  Zod schema into a known type. Never `as SomeType` external data; a wrong `as`
  is a lie the compiler believes. Validate, then work with the parsed value.
- **Errors are values, not surprises.** For fallible operations return
  `neverthrow`'s `Result<T, E>` instead of throwing. Reserve `throw` for truly
  unrecoverable programmer errors. Never write an empty `catch`, and never
  swallow an error to stay on the happy path — handle it or propagate it.
- **Exhaust discriminated unions.** End a `switch`/if-chain over a union with an
  `assertNever(x: never)` default so a new variant becomes a compile error, not a
  silent fallthrough.
- **Respect `noUncheckedIndexedAccess`.** `arr[i]` and `map.get(k)` are
  `T | undefined`. Check before use; don't `!`-assert the undefined away.
- **Clean up what you acquire.** Use `using`/`await using` (explicit resource
  management) for anything with a lifetime — timers, subscriptions, sockets,
  file handles. Pair every listener/interval with its teardown. Prefer
  `AbortSignal` to cancel in-flight work and prevent stale-response races.

## Sanctioned libraries — use these, don't reach for alternatives

- **Validation / parsing:** `zod`.
- **Typed errors:** `neverthrow` (`Result`, `ok`, `err`).
- **Bounded parallelism:** `p-map` (`p-map(items, fn, { concurrency })`). Plain
  unbounded fan-out uses native `Promise.all` / `Promise.allSettled`.
- **Retry with backoff:** `p-retry`.
- **Mutual exclusion over shared mutable state:** `async-mutex` (`Mutex`,
  `Semaphore`) — only when a race is real, not preemptively.

Do not introduce a competing library for any of these roles. Do not adopt
`Effect` or a broad FP runtime; the sanctioned small libraries plus native
`AbortController`/`using` cover leaks, races, retries, and parallelism.
