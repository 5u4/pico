#!/usr/bin/env bash
# Shared definitions for the comment gate (lint-comments.sh). Source it; do not
# execute.

# Restrict to Rust sources; exclude build output.
PATHS=(
  '*.rs'
  ':!target/*'
  ':!*/target/*'
)

# Read a unified diff on stdin; emit one `FILE:NEWLINE:RAW` record per added
# comment line. Comments are banned, so every added comment is emitted, with two
# exemptions:
#   - `// SAFETY:` blocks: the soundness argument an `unsafe` block requires.
#   - `SPDX-License-Identifier` headers: legally required.
# Detection is line-leading: a line whose first non-blank token is `//`, `///`,
# `//!`, `/*`, or a `*` interior of an open block comment. Trailing comments on a
# code line (`foo(); // x`) are not flagged — distinguishing them from `//` inside
# a string needs a real lexer; the prose policy covers that case instead.
discretionary_comments() {
  awk '
    function classify(c) {
      if (in_block) {
        if (c ~ /\*\//) in_block = 0
        return 1
      }
      if (c ~ /^\/\//) {
        if (c ~ /^\/\/[[:space:]]*SAFETY:/) return 0
        if (c ~ /^\/\/[[:space:]]*SPDX-License-Identifier/) return 0
        return 1
      }
      if (c ~ /^\/\*/) {
        if (c !~ /\*\//) in_block = 1
        return 1
      }
      return 0
    }
    /^\+\+\+ b\// { f = substr($0, 7); in_block = 0; next }
    /^@@ /        { split($0, a, "+"); split(a[2], b, /[ ,]/); n = b[1]; in_block = 0; next }
    /^-/          { next }
    /^\+/ {
      line = substr($0, 2)
      c = line; sub(/^[[:space:]]+/, "", c)
      if (classify(c))
        printf "%s:%d:%s\n", f, n, line
      n++
      next
    }
  '
}
