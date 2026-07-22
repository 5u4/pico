---
description: Pre-PR checklist — rebase onto latest main, then self-audit your own diff
alwaysApply: true
---

# Rebase onto latest main before opening a PR

Before `gh pr create`, rebase the feature branch onto the freshly-fetched
default branch so the PR diff is clean and merge conflicts surface now, not
at merge time.

```sh
git fetch origin main
git rebase origin/main
```

- **Fetch first.** Never rebase onto a stale local `main`.
- **Already up to date** (rebase is a no-op) → proceed straight to PR creation.
- **Conflict** → STOP. Report the conflicting files and ask. Never
  speculatively resolve a rebase conflict to "make it apply".
- **Re-push after rebase:** if the branch was already pushed, use
  `git push --force-with-lease` (never bare `--force`). Fresh branch → normal push.

# Self-audit your own diff before opening a PR

After the rebase and before `gh pr create`, grep **your own added lines** for
the adversarial patterns the reviewer will flag anyway — the same ones
`rule://ts-bug-prevention` and `AGENTS.md` call out: `as`-casting external
data, `!` non-null assertions, `any`, floating effects, and unexhausted unions.

For each hit, ask whether it is genuinely needed (real interop, a narrowing
guard) or just laziness the compiler would otherwise let slide. Fix the lazy
ones now.

This is a self-check, not a CI gate: these patterns are sometimes legitimate,
so there is no mechanical ban — but catching your own before the bot does
removes an entire review round-trip. Do not re-list the patterns here; the
canonical list lives in `rule://ts-bug-prevention`.
