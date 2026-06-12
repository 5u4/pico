#!/usr/bin/env bash
# Comment-density guard. Counts added *discretionary* comment lines (see
# lint-common.sh) against total added non-blank lines in the Rust diff. Fails
# only on floods: the diff is large enough (>= MIN_LINES added), more than
# COMMENT_FLOOR comments were added, and they exceed THRESHOLD_PCT of the diff.
# Lists every offending comment so each can be justified against a keep-reason
# or deleted. Per-comment justification itself is the commit-msg gate's job
# (lint-comment-reasons.sh); this gate only stops floods.
#
# Usage:
#   scripts/lint-comments.sh                 # staged diff (pre-commit)
#   scripts/lint-comments.sh <REV>           # working tree vs REV
#   scripts/lint-comments.sh --range A..B    # arbitrary range (CI)

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lint-common.sh"

THRESHOLD_PCT=10
MIN_LINES=12
COMMENT_FLOOR=2

if [ "${1:-}" = "--range" ]; then
  if [ -z "${2:-}" ]; then
    echo "usage: $0 --range <git-range>" >&2
    exit 2
  fi
  RANGE="$2"
elif [ -n "${1:-}" ]; then
  RANGE="$1"
else
  # Pre-commit: compare the index to HEAD. --cached restricts to staged changes
  # so unstaged scratch comments don't count.
  RANGE="--cached"
fi

# `git diff` exits 0 with no changes, 1 with changes, >1 on real errors
# (invalid range/ref). Don't mask >1 with `|| true` — that silently disables
# enforcement.
set +e
DIFF=$(git diff $RANGE --unified=0 -- "${PATHS[@]}")
diff_exit=$?
set -e
if [ "$diff_exit" -ne 0 ] && [ "$diff_exit" -ne 1 ]; then
  echo "lint-comments: \`git diff $RANGE\` failed (exit $diff_exit)." >&2
  exit "$diff_exit"
fi

if [ -z "$DIFF" ]; then
  exit 0
fi

# Added non-blank lines (exclude `+++` file headers).
added_nonblank=$(printf '%s\n' "$DIFF" | awk '
  /^\+\+\+/ { next }
  /^\+/     { if (length($0) > 1) added++ }
  END       { print added + 0 }
')

LIST=$(printf '%s\n' "$DIFF" | discretionary_comments)
added_comments=$(printf '%s\n' "$LIST" | awk 'NF { c++ } END { print c + 0 }')

if [ "$added_nonblank" -lt "$MIN_LINES" ]; then
  printf 'lint-comments: diff too small to enforce (added=%d, floor=%d). skipped.\n' \
    "$added_nonblank" "$MIN_LINES" >&2
  exit 0
fi

# A handful of comments is never a flood; per-comment justification is the
# commit-msg gate's job, so the density gate ignores diffs at/under the floor.
if [ "$added_comments" -le "$COMMENT_FLOOR" ]; then
  printf 'lint-comments: %d discretionary comment(s) <= floor %d. skipped.\n' \
    "$added_comments" "$COMMENT_FLOOR" >&2
  exit 0
fi

# Integer percent (no bash float). pct = 100 * comments / nonblank.
pct=$(( added_comments * 100 / added_nonblank ))

printf 'lint-comments: %d added non-blank, %d discretionary comment(s) (%d%%; budget %d%%).\n' \
  "$added_nonblank" "$added_comments" "$pct" "$THRESHOLD_PCT" >&2

if [ "$pct" -gt "$THRESHOLD_PCT" ]; then
  cat >&2 <<EOF
lint-comments: FAIL — comment density ${pct}% > ${THRESHOLD_PCT}% budget.
Name a keep-reason for each comment below or delete it.
Keep only: non-obvious choice, workaround, type-invariant, perf tradeoff,
security boundary, cross-file contract.
EOF
  printf '%s\n' "$LIST" | sed 's/^/  /' >&2
  exit 1
fi
