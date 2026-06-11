# Contributing

## Code conventions

- **`tracing`** — always call through the crate path: `tracing::info!(…)`, never
  `use tracing::info`. The `tracing::` prefix makes it obvious at the call site.
- **`Result`** — always fully-qualified `color_eyre::Result<T>`; never `use` it.
  The reader must see it's color_eyre's `Result`, not std's.
- **No re-exports** — no `pub use`. Consumers use full paths. Enforced by
  `clippy::pub_use` (denied in `[workspace.lints]`).

## Before you finish

Run both, and make sure they're clean:

```sh
cargo +nightly fmt
cargo clippy
```
