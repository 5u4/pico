---
description: Zero comments in code — carry intent in names, types, structure
alwaysApply: true
---

# No comments in code

Write zero comments. No `//`, no `/* */`, no JSDoc `/** */`. No "what"/"why"
notes, no `TODO`/`NOTE`, no section banners, no restating the code. Names,
types, and structure carry intent.

Only two comments are allowed:

- `// biome-ignore <rule>: <reason>` — a scoped Biome suppression with a reason.
- an `SPDX-License-Identifier` header, where legally required.

`scripts/lint-comments.ts` gates this on pre-commit and in CI. Adding any other
comment fails the gate — don't write one, and don't reintroduce removed ones.
