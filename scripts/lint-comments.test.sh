#!/usr/bin/env bash
# Behavioral tests for the comment-lint scripts. Each case spins up a throwaway
# git repo, stages Rust sources, and asserts the gate's exit code and output.
# Run: bash scripts/lint-comments.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DENSITY="$HERE/lint-comments.sh"
REASONS="$HERE/lint-comment-reasons.sh"

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

# ---- density gate -----------------------------------------------------------

repo=$(newrepo)
cat > "$repo/a.rs" <<'RS'
fn f() {
    // narration one
    let a0 = 0;
    let a1 = 1;
    let a2 = 2;
    let a3 = 3;
    // narration two
    let a4 = 4;
    let a5 = 5;
    let a6 = 6;
    let a7 = 7;
    // narration three
    let a8 = 8;
}
RS
git -C "$repo" add a.rs
run "$DENSITY" "$repo"
expect_rc "density: over budget fails" 1
expect_contains "density: lists comment with file:line" "a.rs:2:"
expect_contains "density: lists narration text" "narration one"
rm -rf "$repo"

repo=$(newrepo)
{
  echo "fn g() {"
  echo "    // first note under ratio"
  echo "    // second note under ratio"
  echo "    // third note under ratio"
  for i in $(seq 0 39); do echo "    let v$i = $i;"; done
  echo "}"
} > "$repo/b.rs"
git -C "$repo" add b.rs
run "$DENSITY" "$repo"
expect_rc "density: under ratio passes" 0
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/c.rs" <<'RS'
// lonely
pub const X: u32 = 1;
RS
git -C "$repo" add c.rs
run "$DENSITY" "$repo"
expect_rc "density: below line floor skips" 0
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/d.rs" <<'RS'
fn d() {
    // note one
    // note two
    let a0 = 0;
    let a1 = 1;
    let a2 = 2;
    let a3 = 3;
    let a4 = 4;
    let a5 = 5;
    let a6 = 6;
    let a7 = 7;
    let a8 = 8;
}
RS
git -C "$repo" add d.rs
run "$DENSITY" "$repo"
expect_rc "density: within comment floor passes" 0
expect_contains "density: floor message shown" "floor"
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/e.rs" <<'RS'
/// Doc narration line one saying nothing the signature doesn't.
/// Doc narration line two restating the field defined below it.
/// Doc narration line three of pure filler prose sitting here.
pub struct S {
    pub a: u32,
    pub b: u32,
    pub c: u32,
    pub d: u32,
    pub e: u32,
    pub f: u32,
    pub g: u32,
    pub h: u32,
    pub i: u32,
}
RS
git -C "$repo" add e.rs
run "$DENSITY" "$repo"
expect_rc "density: /// doc prose counts" 1
expect_contains "density: lists a doc prose line" "Doc narration line one"
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/f.rs" <<'RS'
/// Narrate one pointless sentence about this routine here now.
/// Narrate two pointless sentence about this routine here now.
/// Narrate three pointless sentence about this routine now ok.
///
/// ```
/// let exempt_marker = compute() + compute();
/// assert!(exempt_marker >= compute());
/// ```
pub fn compute() -> u32 {
    let a = 1;
    let b = 2;
    let c = 3;
    a + b + c
}
RS
git -C "$repo" add f.rs
run "$DENSITY" "$repo"
expect_rc "density: doc prose over budget fails" 1
expect_contains "density: lists doc prose" "Narrate one"
expect_absent "density: exempts doctest fence body" "exempt_marker"
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/g.rs" <<'RS'
/// Doc heading for the function defined below here today.
///
/// ```text
/// counted_prose_alpha
/// counted_prose_beta
/// counted_prose_gamma
/// ```
pub fn t() -> u32 {
    let a = 1;
    let b = 2;
    let c = 3;
    let d = 4;
    a + b + c + d
}
RS
git -C "$repo" add g.rs
run "$DENSITY" "$repo"
expect_rc "density: text fence body counts" 1
expect_contains "density: lists text fence body" "counted_prose_alpha"
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/h.rs" <<'RS'
pub fn s() {
    // SAFETY: pointer valid for the whole struct, checked just above.
    let a = 1;
    // SAFETY: length fits, bounds verified by the caller before entry.
    let b = 2;
    // SAFETY: no aliasing here, exclusive access is held by this frame.
    let c = 3;
    let d = 4;
    let e = 5;
    let f = 6;
    let g = 7;
    let _ = (a, b, c, d, e, f, g);
}
RS
git -C "$repo" add h.rs
run "$DENSITY" "$repo"
expect_rc "density: SAFETY comments exempt" 0
expect_absent "density: no FAIL for SAFETY-only" "FAIL"
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/i.rs" <<'RS'
// SPDX-License-Identifier: MIT
// SPDX-License-Identifier: MIT
// SPDX-License-Identifier: MIT
pub fn x() {
    let a = 1;
    let b = 2;
    let c = 3;
    let d = 4;
    let e = 5;
    let f = 6;
    let g = 7;
    let h = 8;
    let _ = (a, b, c, d, e, f, g, h);
}
RS
git -C "$repo" add i.rs
run "$DENSITY" "$repo"
expect_rc "density: SPDX headers exempt" 0
rm -rf "$repo"

# ---- keep-reason commit-msg gate -------------------------------------------

repo=$(newrepo)
cat > "$repo/j.rs" <<'RS'
// note
pub const X: u32 = 1;
RS
git -C "$repo" add j.rs
printf 'add x\n' > "$repo/msg"
run "$REASONS" "$repo" msg
expect_rc "reasons: missing trailer fails" 1
expect_contains "reasons: explains the trailer" "Comments:"
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/k.rs" <<'RS'
// invariant: caller holds the lock
pub const X: u32 = 1;
RS
git -C "$repo" add k.rs
printf 'add x\n\nComments: invariant — caller holds the lock\n' > "$repo/msg"
run "$REASONS" "$repo" msg
expect_rc "reasons: present trailer passes" 0
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/l.rs" <<'RS'
pub const X: u32 = 1;
pub const Y: u32 = 2;
RS
git -C "$repo" add l.rs
printf 'add\n' > "$repo/msg"
run "$REASONS" "$repo" msg
expect_rc "reasons: no comments passes" 0
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/m.rs" <<'RS'
// note
pub const X: u32 = 1;
RS
git -C "$repo" add m.rs
printf 'add\n\n# Comments: this is a git scissor comment\n' > "$repo/msg"
run "$REASONS" "$repo" msg
expect_rc "reasons: ignores Comments: in a stripped # line" 1
rm -rf "$repo"

repo=$(newrepo)
cat > "$repo/n.rs" <<'RS'
pub fn s() {
    // SAFETY: caller guarantees the pointer outlives this call.
    let a = 1;
    let _ = a;
}
RS
git -C "$repo" add n.rs
printf 'add\n' > "$repo/msg"
run "$REASONS" "$repo" msg
expect_rc "reasons: SAFETY-only needs no trailer" 0
rm -rf "$repo"

# ---- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
