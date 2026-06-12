# Contributing

## Code conventions

- **`tracing`** — always call through the crate path: `tracing::info!(…)`, never
  `use tracing::info`. The `tracing::` prefix makes it obvious at the call site.
- **`Result`** — always fully-qualified `color_eyre::Result<T>`; never `use` it.
  The reader must see it's color_eyre's `Result`, not std's.
- **No re-exports** — no `pub use`. Consumers use full paths. Enforced by
  `clippy::pub_use` (denied in `[workspace.lints]`).

## Before you finish

Run all three, and make sure they're clean:

```sh
cargo +nightly fmt
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace -- --include-ignored
```

`--include-ignored` runs the real-world e2e tests, `#[ignore]`d by default
because they hit live external services over the network and have side effects.
They read secrets from `.env.e2e` — copy `.env.e2e.example` and fill it in
before running the gate.
