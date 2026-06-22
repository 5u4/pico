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

## Before you finish

Run all three, and make sure they're clean:

```sh
cargo +nightly fmt
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace -- --include-ignored
```
