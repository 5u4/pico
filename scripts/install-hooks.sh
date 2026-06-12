#!/usr/bin/env bash
# Wire git's hooks dir to .githooks unless the user already pointed it
# somewhere else (husky, lefthook, custom). Quiet on success; verbose on the
# "already set, leaving alone" branch so contributors notice.
set -eu

current="$(git config --get core.hooksPath 2>/dev/null || true)"
if [ -z "$current" ] || [ "$current" = ".githooks" ]; then
  git config core.hooksPath .githooks
else
  echo "core.hooksPath is already set to '$current'; leaving it alone." >&2
  echo "To enable the comment gates, run:" >&2
  echo "  git config core.hooksPath .githooks" >&2
fi
