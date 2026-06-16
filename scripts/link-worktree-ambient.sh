#!/usr/bin/env bash
# post-checkout payload: a new git worktree is a clean checkout of *tracked*
# files, so base_repo's gitignored ambient files never reach it. When this repo
# is used as a pico worktree-channel base, each per-thread worktree would lose
# the local `.omp` rules/skills and the `.env.e2e` secrets, so a worktree agent
# drops the working conventions and can't run the e2e tests. Symlink those local
# files from the main worktree into each new one. They stay gitignored and
# uncommitted (`.omp` and `.env*` are both ignored) — only this script, its hook,
# and its test are tracked, so nothing private enters git history.
#
# Best-effort by design: never exit non-zero, or `git worktree add` would report
# failure even though the worktree was created.
set -uo pipefail

# Local, gitignored paths mirrored from the main worktree into each new one,
# relative to the repo root. Add more here if needed.
LINK=(.omp .env.e2e)

# git runs post-checkout with cwd = the worktree being checked out.
here="$(pwd)"
# The main worktree (always the first `git worktree list` entry) holds the real,
# gitignored files; linked worktrees point back at it. Strip the `worktree `
# prefix rather than take field 2, so a base path with spaces isn't truncated.
main="$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"

# In the main worktree itself (plain `git checkout` / `git clone`) there is
# nothing to mirror — the files already live here.
if [ -z "${main:-}" ] || [ "$here" = "$main" ]; then
  exit 0
fi

for item in "${LINK[@]}"; do
  src="$main/$item"
  dst="$here/$item"
  # Skip when base_repo has nothing local to share, or the worktree already has
  # the path (a tracked file or a link from a prior checkout — never clobber).
  if [ ! -e "$src" ]; then continue; fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then continue; fi
  ln -s "$src" "$dst" 2>/dev/null \
    || echo "link-worktree-ambient: could not link $item into $here" >&2
done

exit 0
