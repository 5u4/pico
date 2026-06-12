#!/usr/bin/env bash
# commit-msg gate: when a commit adds discretionary Rust comment lines (see
# lint-common.sh), its message must carry a `Comments:` trailer naming the
# keep-reason(s). Forces the "name a reason or delete it" discipline at the one
# moment the author controls the message. Density is policed separately by
# lint-comments.sh (pre-commit/CI).
#
# Usage: scripts/lint-comment-reasons.sh <commit-msg-file>
# Bypass with `git commit --no-verify`.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lint-common.sh"

MSG_FILE="${1:-}"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
  echo "usage: $0 <commit-msg-file>" >&2
  exit 2
fi

set +e
DIFF=$(git diff --cached --unified=0 -- "${PATHS[@]}")
diff_exit=$?
set -e
if [ "$diff_exit" -ne 0 ] && [ "$diff_exit" -ne 1 ]; then
  echo "lint-comment-reasons: \`git diff --cached\` failed (exit $diff_exit)." >&2
  exit "$diff_exit"
fi
[ -z "$DIFF" ] && exit 0

added_comments=$(printf '%s\n' "$DIFF" | discretionary_comments | awk 'NF { c++ } END { print c + 0 }')
[ "$added_comments" -eq 0 ] && exit 0

# A `Comments:` trailer with non-empty text, ignoring scissors/comment lines
# git strips from the final message.
if grep -qiE '^[[:space:]]*Comments:[[:space:]]*\S' \
    <(grep -vE '^[[:space:]]*#' "$MSG_FILE"); then
  exit 0
fi

cat >&2 <<EOF
lint-comment-reasons: FAIL — this commit adds $added_comments Rust comment line(s)
but the message has no \`Comments:\` trailer naming why each survives.

Add a trailer such as:
  Comments: invariant — caller holds the store lock before mutate.

Keep only: non-obvious choice, workaround, type-invariant, perf tradeoff,
security boundary, cross-file contract. Otherwise delete the comment.
Bypass (discouraged): git commit --no-verify
EOF
exit 1
