---
description: PR review reply + resolve workflow via gh + GraphQL
alwaysApply: true
---

# PR review workflow

After addressing review comments on a GitHub PR (any reviewer — human, Copilot, CodeRabbit, etc.):

1. Push the fix commit first. Get the short SHA.
2. For each comment thread, reply via `gh api repos/<owner>/<repo>/pulls/<N>/comments/<COMMENT_ID>/replies -f body='Fixed in <SHA>. <one-sentence explanation of what changed>'`.
3. Then resolve each thread via GraphQL: `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<THREAD_ID>"}) { thread { isResolved } } }'`.

Do all replies + resolves in a single batched bash call after the fix is pushed — do not interleave with the code change. The user does not want to manually resolve each thread in the GitHub UI.

## Discovering thread IDs and comment IDs

```sh
gh api graphql -f query='
{ repository(owner:"<owner>",name:"<repo>"){ pullRequest(number:<N>){
  reviewThreads(first:20){ nodes { id isResolved comments(first:5){ nodes{ author{login} path line body }}}}
}}}'

gh api repos/<owner>/<repo>/pulls/<N>/comments --jq '.[] | {id, path, body: (.body[0:60])}'
```

## When NOT to apply

- The reviewer is the user themselves and they only want a conversation, not a fix
- The comment is purely informational ("FYI" / "nit, no action needed") — still acknowledge but skip the resolve unless the user said so
- The fix is rejected (you disagree and the user agreed with you) — reply with the reasoning, leave unresolved for the human reviewer to close
