#!/usr/bin/env bash
# Behavioral tests for the no-comment gate. Each case spins up a throwaway git
# repo, stages Rust sources, and asserts the gate's exit code and output.
# Run: bash scripts/lint-comments.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/lint-comments.sh"

pass=0
fail=0

newrepo() {
  local d
  d="$(mktemp -d)"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  printf '%s' "$d"
}

run() { # <script> <repo> [args...]
  local script="$1" repo="$2"
  shift 2
  OUT="$(cd "$repo" && bash "$script" "$@" 2>&1)"
  RC=$?
}

ok() { pass=$((pass + 1)); printf 'ok   - %s\n' "$1"; }
no() { fail=$((fail + 1)); printf 'FAIL - %s\n       %s\n' "$1" "$2"; }

expect_rc() { if [ "$RC" = "$2" ]; then ok "$1"; else no "$1" "want rc=$2 got rc=$RC :: $OUT"; fi; }
expect_contains() { case "$OUT" in *"$2"*) ok "$1" ;; *) no "$1" "missing '$2' :: $OUT" ;; esac; }
expect_absent() { case "$OUT" in *"$2"*) no "$1" "unexpected '$2' :: $OUT" ;; *) ok "$1" ;; esac; }

# A single added comment fails — there is no density budget or floor anymore.
repo=$(newrepo)
cat > "$repo/a.rs" <<'RS'
// lonely note
pub const X: u32 = 1;
RS
git -C "$repo" add a.rs
run "$GATE" "$repo"
expect_rc "one comment fails" 1
expect_contains "lists comment file:line" "a.rs:1:"
expect_contains "lists comment text" "lonely note"

# /// doc prose is a comment and fails.
repo=$(newrepo)
cat > "$repo/b.rs" <<'RS'
/// Doc narration the signature already says.
pub fn b() {}
RS
git -C "$repo" add b.rs
run "$GATE" "$repo"
expect_rc "/// doc fails" 1
expect_contains "lists doc prose" "Doc narration"

# //! inner doc fails.
repo=$(newrepo)
cat > "$repo/c.rs" <<'RS'
//! module narration
pub const X: u32 = 1;
RS
git -C "$repo" add c.rs
run "$GATE" "$repo"
expect_rc "//! inner doc fails" 1

# Block comment (including bare interior lines) fails.
repo=$(newrepo)
cat > "$repo/d.rs" <<'RS'
/* narration interior line one
   narration interior line two */
pub const X: u32 = 1;
RS
git -C "$repo" add d.rs
run "$GATE" "$repo"
expect_rc "block comment fails" 1
expect_contains "lists block interior" "narration interior line two"

# `// SAFETY:` is exempt.
repo=$(newrepo)
cat > "$repo/e.rs" <<'RS'
pub fn s() {
    // SAFETY: trivially sound in this test
    let _ = 1;
}
RS
git -C "$repo" add e.rs
run "$GATE" "$repo"
expect_rc "SAFETY exempt passes" 0
expect_absent "no FAIL for SAFETY-only" "FAIL"

# `SPDX-License-Identifier` headers are exempt.
repo=$(newrepo)
cat > "$repo/f.rs" <<'RS'
// SPDX-License-Identifier: MIT
pub const X: u32 = 1;
RS
git -C "$repo" add f.rs
run "$GATE" "$repo"
expect_rc "SPDX exempt passes" 0

# No comments at all passes.
repo=$(newrepo)
cat > "$repo/g.rs" <<'RS'
pub const X: u32 = 1;
pub const Y: u32 = 2;
RS
git -C "$repo" add g.rs
run "$GATE" "$repo"
expect_rc "no comments passes" 0

# A `//` line inside a raw string starting at column 0 is the known heuristic
# false positive; we do not test for it. The gate flags line-leading comments
# only, so a trailing comment on a code line slips through — covered by the
# prose policy, not this gate.
repo=$(newrepo)
cat > "$repo/h.rs" <<'RS'
pub fn h() {
    let _ = 1;
}
RS
git -C "$repo" add h.rs
run "$GATE" "$repo"
expect_rc "trailing-comment-free code passes" 0

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
