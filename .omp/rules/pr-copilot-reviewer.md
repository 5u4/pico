---
description: Always request a Copilot review when opening a GitHub PR
alwaysApply: true
---

# Copilot as PR reviewer

After opening a GitHub PR, you MUST request a review from the Copilot reviewer bot. Copilot reviews are comment-only — they never block merge or count toward required approvals — so adding it costs nothing and gets a second pass.

## Mechanics

Copilot is a `Bot`, not a `User`. **`gh pr create --reviewer …` and `gh pr edit --add-reviewer …` both go through the user resolver and silently fail for bots** (they may succeed with no error and leave the reviewer list empty). The only working path is the GraphQL `requestReviews` mutation with `botIds`.

After `gh pr create` returns the PR URL:

```sh
PR_NODE_ID=$(gh pr view <N> --json id --jq .id)
gh api graphql \
  -f query='mutation($prId: ID!, $botIds: [ID!]!) {
    requestReviews(input: { pullRequestId: $prId, botIds: $botIds, union: true }) {
      pullRequest { id }
    }
  }' \
  -f prId="$PR_NODE_ID" \
  -f botIds='BOT_kgDOCnlnWA'
```

- `BOT_kgDOCnlnWA` is the GitHub.com node ID for `copilot-pull-request-reviewer`. Hardcode it; it's stable.
- On GHES the ID differs — resolve at runtime via `gh api users/copilot-pull-request-reviewer` and read `node_id`, but only bother if you actually hit GHES.
- `union: true` means "add to existing reviewers", not "replace".

## Verify

```sh
gh api graphql -f query='{ repository(owner:"<owner>", name:"<repo>") {
  pullRequest(number:<N>) { reviewRequests(first:10) { nodes {
    requestedReviewer { __typename ... on Bot { login } }
  }}}}}'
```

Look for `{"__typename":"Bot","login":"copilot-pull-request-reviewer"}`.

`gh api repos/<owner>/<repo>/pulls/<N>/requested_reviewers` is **always empty for bots** — never use it to check.

## When Copilot is not available

- GraphQL returns `Could not resolve to Bot node with the global id …` → the instance doesn't have Copilot Code Review enabled (e.g. some GHES, some orgs that disabled it). Note in chat that Copilot reviewer is unavailable for this repo and continue. Do not retry with the same ID.
- Drafts: Copilot won't auto-review until the PR is marked ready. Requesting the review on a draft is still fine — it fires on ready-for-review.

## Anti-patterns

- `gh pr create --reviewer Copilot` / `gh pr edit --add-reviewer @copilot` / `gh pr edit --add-reviewer 'copilot-pull-request-reviewer[bot]'` — all go through the user resolver. The first 422s loudly; the latter two appear to succeed but add nothing. Always use the GraphQL mutation above.
- Checking `requested_reviewers` REST endpoint or `gh pr view --json reviewRequests` and concluding "no reviewers" — both omit bots. Always verify via the GraphQL `reviewRequests` query above.
