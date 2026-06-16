#!/usr/bin/env bash
# Behavioral tests for the worktree ambient-file linker. Each case spins up a
# throwaway base repo with the hook + script committed (and this repo's real
# .gitignore, so the "status stays clean" guarantee is actually exercised), forks
# a worktree exactly the way pico does (`git -C <base> worktree add`), and asserts
# the resulting symlinks. Run: bash scripts/link-worktree-ambient.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/link-worktree-ambient.sh"
HOOK="$HERE/../.githooks/post-checkout"
GITIGNORE="$HERE/../.gitignore"

pass=0
fail=0

ok() { pass=$((pass + 1)); printf 'ok   - %s\n' "$1"; }
no() { fail=$((fail + 1)); printf 'FAIL - %s\n       %s\n' "$1" "$2"; }

expect_symlink() { # <name> <path> <target>
  if [ -L "$2" ] && [ "$(readlink "$2")" = "$3" ]; then ok "$1"; else
    no "$1" "want symlink $2 -> $3, got: $(ls -ld "$2" 2>&1)"
  fi
}
expect_no_path() { # <name> <path>
  if [ -e "$2" ] || [ -L "$2" ]; then no "$1" "unexpected path $2"; else ok "$1"; fi
}
expect_true() { # <name> <test-cmd...>
  if "${@:2}"; then ok "$1"; else no "$1" "predicate failed"; fi
}
expect_clean() { # <name> <worktree> — git status must report nothing
  local s; s="$(cd "$2" && git status --porcelain)"
  if [ -z "$s" ]; then ok "$1"; else no "$1" "dirty worktree: $s"; fi
}

# A base repo with the hook + script committed and hooks wired, mirroring how a
# contributor would have this repo set up before pico forks worktrees from it.
# Carries the real .gitignore so the linked symlinks are ignored exactly as they
# are in the live repo. Optional $1 places the repo at a chosen path (e.g. one
# with a space); default is a fresh mktemp dir.
newbase() {
  local d="${1:-$(mktemp -d)}"
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  mkdir -p "$d/scripts" "$d/.githooks"
  cp "$SCRIPT" "$d/scripts/link-worktree-ambient.sh"
  cp "$HOOK" "$d/.githooks/post-checkout"
  cp "$GITIGNORE" "$d/.gitignore"
  chmod +x "$d/scripts/link-worktree-ambient.sh" "$d/.githooks/post-checkout"
  git -C "$d" add -A
  git -C "$d" commit -q -m init
  git -C "$d" config core.hooksPath .githooks
  printf '%s' "$d"
}

# ---- worktree add links both ambient paths, and status stays clean ----------
base=$(newbase)
mkdir -p "$base/.omp/rules"; echo rule > "$base/.omp/rules/x.md"
printf 'E2E_X=1\n' > "$base/.env.e2e"
wt="$base.wt"
git -C "$base" worktree add -q "$wt" HEAD 2>/dev/null
expect_symlink "worktree add links .omp" "$wt/.omp" "$base/.omp"
expect_symlink "worktree add links .env.e2e" "$wt/.env.e2e" "$base/.env.e2e"
# The .omp / .env.e2e symlinks must be ignored, or an agent's `git add -A` on the
# pico/<thread> branch would commit them — guards the `.omp` (not `.omp/`) pattern.
expect_clean "worktree status clean (symlinks ignored)" "$wt"

# ---- re-running the hook is idempotent (never clobbers the existing link) ----
( cd "$wt" && bash scripts/link-worktree-ambient.sh ) ; rc=$?
expect_true "rerun exits 0" [ "$rc" = 0 ]
expect_symlink "rerun keeps .omp link" "$wt/.omp" "$base/.omp"
rm -rf "$wt"; git -C "$base" worktree prune; rm -rf "$base"

# ---- a missing source is skipped, the present one still links ----------------
base=$(newbase)
mkdir -p "$base/.omp"; echo r > "$base/.omp/r.md"   # no .env.e2e in this base
wt="$base.wt"
git -C "$base" worktree add -q "$wt" HEAD 2>/dev/null
expect_symlink "present source links" "$wt/.omp" "$base/.omp"
expect_no_path "missing source skipped" "$wt/.env.e2e"
rm -rf "$wt"; git -C "$base" worktree prune; rm -rf "$base"

# ---- main-worktree guard: a plain checkout must not self-link or error -------
base=$(newbase)
mkdir -p "$base/.omp"; echo r > "$base/.omp/r.md"
printf 'E2E=1\n' > "$base/.env.e2e"
out="$(cd "$base" && git checkout -q -b other 2>&1)" ; rc=$?
expect_true "main checkout exits 0" [ "$rc" = 0 ]
expect_true "main .omp stays a real dir" test -d "$base/.omp" -a ! -L "$base/.omp"
rm -rf "$base"

# ---- an existing real path is never replaced by a link -----------------------
base=$(newbase)
mkdir -p "$base/.omp"; echo r > "$base/.omp/r.md"
wt="$base.wt"
git -C "$base" worktree add -q "$wt" HEAD 2>/dev/null
rm "$wt/.omp"; mkdir "$wt/.omp"; echo local > "$wt/.omp/own.md"   # worktree-owned
( cd "$wt" && bash scripts/link-worktree-ambient.sh )
expect_true "existing real dir kept" test -d "$wt/.omp" -a ! -L "$wt/.omp"
rm -rf "$wt"; git -C "$base" worktree prune; rm -rf "$base"

# ---- a base path with a space still links (awk must not split on whitespace) -
sproot=$(mktemp -d); sp="$sproot/has space"
base=$(newbase "$sp/repo")
mkdir -p "$base/.omp"; echo r > "$base/.omp/r.md"
wt="$sp/wt"
git -C "$base" worktree add -q "$wt" HEAD 2>/dev/null
expect_symlink "spaced base path links .omp" "$wt/.omp" "$base/.omp"
rm -rf "$sproot"

# ---- absent script (old fork ref): hook no-ops, worktree add still succeeds --
base=$(newbase)
mkdir -p "$base/.omp"; echo r > "$base/.omp/r.md"
rm "$base/scripts/link-worktree-ambient.sh"   # hook resolves main's copy → gone
wt="$base.wt"
git -C "$base" worktree add -q "$wt" HEAD 2>/dev/null ; rc=$?
expect_true "absent script: worktree add succeeds" [ "$rc" = 0 ]
expect_no_path "absent script: no link created" "$wt/.omp"
rm -rf "$wt"; git -C "$base" worktree prune; rm -rf "$base"

# ---- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
