---
description: Sync onto latest main before opening a GitHub PR
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
