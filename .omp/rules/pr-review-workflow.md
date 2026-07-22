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

## Fix by class, not by comment

A review comment that names a *pattern* (`as`-cast, floating effect, TOCTOU,
missing `await`, `!`, unexhausted union, …) almost always has sibling instances
in the same changeset — the reviewer only flagged the one it landed on. Before
replying "fixed":

1. Extract the pattern and `grep` the whole touched file (and the rest of the
   diff) for it.
2. Fix **every** instance in one commit, not just the flagged line.
3. Then reply, noting you swept the class (e.g. "no `as` casts remain in the
   file").

Point-fixing the single flagged line turns one comment into a round-trip per
sibling instance. One reviewer hit = grep the class = one sweep.

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
