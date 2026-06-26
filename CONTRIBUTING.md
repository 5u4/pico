# Contributing

## Code conventions

- **`tracing`** — always call through the crate path: `tracing::info!(…)`, never
  `use tracing::info`. The `tracing::` prefix makes it obvious at the call site.
- **`Result`** — always fully-qualified `color_eyre::Result<T>`; never `use` it.
  The reader must see it's color_eyre's `Result`, not std's.
- **No re-exports** — no `pub use`. Consumers use full paths. Enforced by
  `clippy::pub_use` (denied in `[workspace.lints]`).
- **Comments** — none (see AGENTS.md §6). The only comments allowed are
  `// SAFETY:` above an `unsafe` block and an `SPDX-License-Identifier` header
  where required. A pre-commit + CI gate (`scripts/lint-comments.sh`) fails any
  diff that adds another comment; install it via `scripts/install-hooks.sh`.

## Logging

Logs are written to `<root>/logs/{worker,supervisor,cli}.<date>.log` (daemons and
the `pico` CLI each get their own stream), rotated daily and kept for 7 files.
The stdout layer is fixed at `info` so `docker logs` stays clean; `RUST_LOG` does
not affect it. The rotating file is the self-debug product: it defaults to `debug`,
and `RUST_LOG` *adds* to it without silencing other crates — use a target directive,
e.g. `RUST_LOG=pico_core=trace`, to surface the per-frame omp event stream in the
file. Read history from the file instead of reproducing. Panics are
captured into the file via a panic hook in addition to color_eyre's pretty
stderr output.

## Before you finish

Run all three, and make sure they're clean:

```sh
cargo +nightly fmt
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace -- --include-ignored
```
