#!/usr/bin/env bash
# No-comment gate. Fails when the Rust diff adds any comment line (see
# lint-common.sh). Comments are banned here; the only allowed ones are
# `// SAFETY:` above an `unsafe` block and an `SPDX-License-Identifier` header,
# both exempt in the matcher.
#
# Usage:
#   scripts/lint-comments.sh                 # staged diff (pre-commit)
#   scripts/lint-comments.sh <REV>           # working tree vs REV
#   scripts/lint-comments.sh --range A..B    # arbitrary range (CI)

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lint-common.sh"

if [ "${1:-}" = "--range" ]; then
  if [ -z "${2:-}" ]; then
    echo "usage: $0 --range <git-range>" >&2
    exit 2
  fi
  RANGE="$2"
elif [ -n "${1:-}" ]; then
  RANGE="$1"
else
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

[ -z "$DIFF" ] && exit 0

LIST=$(printf '%s\n' "$DIFF" | discretionary_comments)
added=$(printf '%s\n' "$LIST" | awk 'NF { c++ } END { print c + 0 }')

[ "$added" -eq 0 ] && exit 0

cat >&2 <<EOF
lint-comments: FAIL — this diff adds $added comment line(s); comments are banned.
Allowed only: \`// SAFETY:\` above an \`unsafe\` block, and \`SPDX-License-Identifier\`
headers. Delete the comment(s) below; carry intent in names, types, and structure.
EOF
printf '%s\n' "$LIST" | sed 's/^/  /' >&2
exit 1
