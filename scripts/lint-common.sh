#!/usr/bin/env bash
# Shared definitions for the comment-lint scripts (lint-comments.sh,
# lint-comment-reasons.sh). Source it; do not execute.

# Restrict to Rust sources; exclude build output.
PATHS=(
  '*.rs'
  ':!target/*'
  ':!*/target/*'
)

# Read a unified diff on stdin; emit one `FILE:NEWLINE:RAW` record per added
# *discretionary* comment line — the lines a budget should police. Exempt, and
# therefore never emitted:
#   - code inside rustdoc fences (``` / ```rust / ```no_run / …): compiled and
#     run by `cargo test`, so it cannot rot. `text` and `ignore` fences are NOT
#     verified, so their bodies are treated as prose and emitted.
#   - `// SAFETY:` blocks: mandated by clippy::undocumented_unsafe_blocks.
#   - `SPDX-License-Identifier` headers: legally required.
# Doc prose (`///`, `//!`) and `/* */` blocks (incl. bare interior lines) ARE
# emitted — LLMs narrate there too.
#
# Fence and block-comment state reset at every hunk/file boundary: a wholesale
# addition lands in one unified=0 hunk, so its open/close markers are both
# present. Lines appended into a pre-existing doctest or block comment (markers
# outside the diff window) are the one case that can be miscounted.
discretionary_comments() {
  awk '
    function classify(c,   rest, info, nt, i, toks) {
      if (in_block) {
        if (c ~ /\*\//) in_block = 0
        return 1
      }
      if (c ~ /^\/\/\//)     { rest = c; sub(/^\/\/\/[[:space:]]?/, "", rest) }
      else if (c ~ /^\/\/!/) { rest = c; sub(/^\/\/![[:space:]]?/, "", rest) }
      else if (c ~ /^\/\//)  { rest = c; sub(/^\/\/[[:space:]]?/, "", rest) }
      else if (c ~ /^\/\*/) {
        if (c !~ /\*\//) in_block = 1
        return 1
      }
      else                   { return 0 }

      if (rest ~ /^```/) {
        if (in_fence) { in_fence = 0 }
        else {
          in_fence = 1
          info = rest; sub(/^`+/, "", info)
          fence_counts = 0
          nt = split(info, toks, /[, \t]+/)
          for (i = 1; i <= nt; i++)
            if (toks[i] == "ignore" || toks[i] == "text") fence_counts = 1
        }
        return 0
      }
      if (in_fence)                      return fence_counts
      if (rest ~ /^[[:space:]]*SAFETY:/) return 0
      return 1
    }
    /^\+\+\+ b\// { f = substr($0, 7); in_fence = 0; in_block = 0; next }
    /^@@ /        { split($0, a, "+"); split(a[2], b, /[ ,]/); n = b[1]; in_fence = 0; in_block = 0; next }
    /^-/          { next }
    /^\+/ {
      line = substr($0, 2)
      c = line; sub(/^[[:space:]]+/, "", c)
      if (line !~ /SPDX-License-Identifier/ && classify(c))
        printf "%s:%d:%s\n", f, n, line
      n++
      next
    }
  '
}
