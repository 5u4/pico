# pico

pico is a **thin UI layer** over [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) for web,
Discord, and other platforms. pico owns workspaces, chats, and the surfaces that reach them; omp
remains the coding engine. Keep that boundary thin.

## A note from the dev

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity
just because it already exists. Do not introduce machinery because it looks architecturally
impressive. Understand the real constraint, then fight for the smallest model that makes the correct
behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Honor the dev's intent in both
a minimal and realistic fashion.

Treat the rest of this document as good defaults rather than hard rules. The dev's preferences
override anything here. If a rule fights the task in front of you, say so loudly and get human
sign-off before breaking it.

## Glossary

These words mean one thing each in prompts, docs, type names, and table names.

- **environment** — the machine running pico.
- **platform** — where a UI lives: pico's own surfaces, Discord, Telegram, and others.
- **binding** — a workspace's link to a foreign platform, `{ platform, externalId }`. Absent means
  pico owns the UI.
- **workspace** — a named place with a default cwd. A Discord channel is one.
- **chat** — one conversation record inside a workspace. A Discord thread is one.

## Protect live state

Tests and scripts use a temporary pico root. `~/.pico` belongs to the developer and is never a test
fixture.

## Run the local CLI

From the checkout root, run `bun install`, then `bun link --cwd packages/cli`. Start the daemon
with `pico start` or `pico start /absolute/root`. Bun must be on `PATH`, and its global bin directory
from `bun pm bin -g` must precede `/usr/bin`, which also contains a `pico` text editor on macOS.
Check `command -v pico` after linking.

The command links to this checkout and uses its installed dependencies. Source changes take effect
on the next start. Relink from another checkout before deleting the linked worktree.
Run `pico` directly, not through a package script: `bun run` can forward a terminal SIGINT that
the child already received, turning one Ctrl-C into a forced exit.

## Where code lives

- `packages/contract` — cross-package schemas, branded values, errors, interfaces, and service tags;
  never implementations.
- `packages/daemon` — reusable scoped daemon composition. It opens one pico root and owns startup,
  readiness, and cleanup. It never reads process arguments or runs a Bun main.
- `packages/cli` — the sole process entry. Effect v4 CLI parses commands and runs the daemon in the
  foreground.
- `repos/` — vendored read-only reference. Never edit or import from it.

## Effect

Run `bun run vendor:effect` (idempotent), then read `repos/effect/LLMS.md` before writing Effect
code. Treat `repos/` as read-only reference: never import from it or make the build depend on it.
The vendored v4 source outranks Effect v3 documentation and model memory. Import one namespace per
module (`effect/Effect`, `effect/Layer`, `effect/Schema`); avoid the `effect` barrel. Confirm unstable
APIs such as `effect/unstable/sql` in the vendored source.

Choose the smallest lifecycle shape:

- **Reusable plain value:** `make` only. Use this when construction is pure or the caller passes
  concrete dependencies directly; do not invent Context or Layer.
- **Context service:** `make + layer`. `make` captures dependencies once and returns the reusable
  implementation; `layer` owns bootstrap and deployment provision.
- **Standalone scoped operation/resource:** use a domain verb such as `open` or `acquire`, or `make`
  for a constructor, and put ownership in `Effect.acquireRelease`. Add a layer only when deployment
  composition needs one.
- **Layer-only adapter/composition:** `layer` only. Use it for driver adapters, bootstrap side
  effects, or layer graphs that have no reusable implementation value.

Use this Context-service shape (the example identifiers are illustrative, not repository paths):

```ts
import * as Store from "@example/contract/store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"

export const make = Effect.fn("Store.make")(function*() {
  const sql = yield* SqlClient.SqlClient

  return Store.Store.of({
    get: (key) => get(sql, key),
    put: (key, value) => put(sql, key, value)
  })
})

export const layer = <E, R>(sqlLayer: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.merge(
    Layer.effect(Store.Store, make()),
    Layer.effectDiscard(bootstrap())
  ).pipe(Layer.provide(sqlLayer))

const get = Effect.fn("Store.get")(function*(sql: SqlClient.SqlClient, key: string) {
  const rows = yield* sql<{ readonly value: string }>`
    SELECT value FROM store_entries WHERE key = ${key}
  `
  return rows[0]?.value
})

const put = Effect.fn("Store.put")(function*(sql: SqlClient.SqlClient, key: string, value: string) {
  yield* sql`
    INSERT INTO store_entries (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = ${value}
  `
})

const bootstrap = Effect.fn("Store.bootstrap")(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS store_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `
})

```

`make` is effectful because dependency capture is effectful, not because it performs bootstrap or
business work. Capture dependencies that define implementation identity or lifecycle once, then
pass them explicitly. Look up request- or scope-local policy inside an operation only when local
overrides are intentional; pass business inputs as arguments. `Store.Store.of` contains only thin
delegation, with members in contract order. Export `make` only when callers need direct construction;
otherwise keep it private. The default production installation is `layer`; name variants `layerX`.

Variants:

```ts
export const make = (prefix: string) => ({
  format: (id: string) => `${prefix}:${id}`
})
```

```ts
export const open = Effect.fn("Cancellation.open")(function*() {
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort())
  )
  return controller.signal
})
```

```ts
const bootstrap = Effect.fn("Telemetry.bootstrap")(function*() {
  yield* Effect.logInfo("telemetry ready")
})

export const layer = Layer.effectDiscard(bootstrap())
```

Effect v4 installs both unscoped and scoped service constructors with
`Layer.effect(Service, make())`. A scoped `make` simply has `Scope.Scope` in its requirements;
`Layer.scoped` and `makeScoped` are not v4 patterns.

Write modules overview-first: imports; public types and service tag; `make`; `layer`; private
phase/state records; public operations; acquire/resolve/open helpers; execution; release/cleanup;
boundary utilities. Names and order are the navigation—do not add section-banner comments. Keep
internal seams private, and do not create a facade, forwarding class, or parallel interface that
merely restates the service contract.

- Name effectful functions with `Effect.fn` using semantic, service-qualified trace roles:
  `Store.make`, `Store.get`, `Store.bootstrap`, `Session.open.acquire`. Cover constructors and public
  operations; add lifecycle, rollback, or release spans only when they have distinct diagnostic
  value. Thin pure delegating closures need no span.
- Top-level operations receive captured dependencies or state first, then required domain arguments
  positionally. Use an options object for multiple heterogeneous inputs or optional, independently
  evolving controls. Pass each helper the narrowest state it needs rather than Context or a grab-bag
  object.
- Aggregate handles that share invariants and ownership into readonly phase records. Keep mutable
  per-key lifecycle in one keyed state record rather than parallel maps; keep truly operation-local
  mutable slots local. Do not wrap a single dependency in a state record.
- Put `Effect.acquireRelease` at the ownership boundary. Acquire in use order; on partial failure,
  roll back everything acquired while preserving the primary failure; release in reverse order.
  When callbacks or handles can be replaced concurrently, clear before invoking and identity-check
  before clearing a slot that may already hold its replacement.
- Construct the public service/resource value at its ownership boundary while keeping disposers and
  mutable handles private. Control flow must make ownership transfer, replacement identity,
  rollback, and release order visible.

## Logging and errors

- The terminal consumer owns the failure log. Repository, Git, OMP, and application operations
  refine and propagate errors; RPC handlers, Discord callbacks, and background workers report them.
  A consumed cleanup failure is independent of the primary failure and gets its own diagnostic.
- Use `Effect.annotateLogs` for operation, phase, and stable resource IDs. Keep routine reads,
  event chunks, empty scans, expected domain rejections, and pure interruption out of error logs.
  A mixed interruption and cleanup failure still needs a diagnostic.
- Keep safe failure categories and numeric SDK status codes. Never log prompts, credentials,
  config values, SQL parameters, attachment bodies, or arbitrary SDK payloads.
- `ApplicationError.reason` distinguishes expected rejection from operational failure without
  parsing message text. Add narrower errors when a consumer needs a different decision.
- The CLI uses `Daemon.run` to report after resource cleanup and before logger cleanup. Its returned
  `Exit` is already reported. Embedders using `Daemon.open` own the propagated failure instead.
- File append and retention failures report only to stderr, never back through the failed file sink.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure; UI stays dumb.
- Prefer inferred types over annotations. `any` is the enemy.
- Users notice a dropped frame, a lying spinner, and a stale label. Nothing repaints continuously;
  that pegs the GPU on high-refresh displays.
- Change behavior and change the docs in the same commit.
- Never modify `README.md` without the developer's explicit permission, including for behavior changes or documentation cleanup.
- Docs carry only what the environment cannot answer: conventions, reasons, and gotchas. Delete
  prose that merely restates a manifest, config file, or directory listing.

## Comments

- Default to none. What the name and type already say is a liability in prose.
- A cross-package exported method gets one line saying **who calls it and when**. What it does is
  the signature's job.
- Record counter-intuitive constraints concretely, such as why a migration is append-only or why
  path existence is checked at use time rather than decode time.
- Comments move with the code they describe and die with it.
- Every `TODO` names the condition that makes it actionable.

## Pull requests

- Never open one unless the developer explicitly asks.
- Use conventional commit titles in plain language: `fix(web): new chats no longer spike CPU`.
- State the problem in a sentence or two, then how it was fixed. End with the model and harness that
  did the work.
- Rebase onto the latest main before opening.
- Merge pull requests with squash merge, then delete the source branch.
- UI changes need before/after images; motion or timing needs a short video.
- Keep one concern per PR. If the description says "also", split it.
- When babysitting, poll checks and comments newer than the last push, verify every bot finding
  against the source, fix real findings, and dismiss false positives with a written reason. Stay
  quiet when nothing is new. Stop when the bots are green on the latest commit.

## boundaries

```
packages/
├── contract/          跨包 vocabulary、Schema、service tag、RPC 定义
├── application/       Workspace 和 Chat 的 use case 与跨 port 排序
├── omp/               OMP 18.0.10 adapter 与内存 SessionPool
├── persistence/       SQLite schema、migration、repository 实现
├── git/               Git 操作，包括 worktree 创建与本次操作的 rollback
├── rpc/               Effect RPC WebSocket client 和 server transport
├── frontend-state/    Effect Atom state、action、selector
├── config/            pico root、config.toml、secret reference、root lock
├── logging/           Effect logger、console/file sink、rotation、retention
├── discord/           Discordeno adapter，MVP 后实现
├── daemon/            scoped daemon 组装、启动、readiness 和 cleanup
├── cli/               Effect v4 CLI 和 Bun process entry
└── web/               browser client、React route 和 component
```
