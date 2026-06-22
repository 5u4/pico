# AGENTS.md

Behavioral guidelines for agents working in this repo. Bias toward caution over
speed; use judgment on trivial tasks. For project-specific code conventions and
the checks to run before finishing, follow CONTRIBUTING.md.

## 1. Discuss before acting

**Don't plow ahead alone. Surface tradeoffs. Don't hide confusion.**

- Present real options with pros and cons; don't pick silently when
  interpretations differ.
- State your assumptions explicitly.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, and ask.
- Define success criteria up front, then loop until verified.

## 2. Research before guessing

**Read the code first. Verify, don't invent.**

- Read the relevant files before changing them.
- Look up unfamiliar APIs, crate versions, and behavior — search the web or read
  local sources rather than guessing.
- Ground every claim in something you actually read or ran.

## 3. Delegate to keep context clean

**Fan independent work out to subagents when available.**

- Push parallelizable investigation and edits to subagents; keep the main
  thread on synthesis and decisions.
- Don't pollute the main context with large dumps you can summarize.

## 4. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features, abstractions, or configurability beyond what was asked.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it.

## 5. Surgical changes

**Touch only what the request needs. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken; match existing style.
- Remove orphans your change created; leave pre-existing dead code alone
  (mention it instead).
- Every changed line should trace to the request.

## 6. No comments — code is the source of truth

**Write zero comments.** No `//`, no `///` / `//!` doc comments, no `/* */`.
Names, types, and structure carry intent; comments drift, so they are banned.

- The only exceptions: `// SAFETY:` above an `unsafe` block, and an
  `SPDX-License-Identifier` header where one is required.
- A pre-commit + CI gate (`scripts/lint-comments.sh`) fails any diff that adds a
  non-exempt comment. Don't bypass it.
