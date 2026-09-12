---
name: pico-identity
description: Configure persistent Pico instructions.
---

# Pico instructions

Use `identity.md` for persistent instructions about language, workflows, tools, or response format.

Use the running Pico's root directory, which defaults to `~/.pico`.

| Scope | File under `<picoRoot>` |
| --- | --- |
| Global | `agents/identity.md` |
| Discord bot | `agents/discord/bots/{botId}/identity.md` |
| Discord channel | `agents/discord/channels/{channelId}/identity.md` |

Use the parent Discord channel ID, not a thread ID.

Read the existing file, preserve unrelated instructions, and create parent directories if needed. Write plain Markdown, for example:

```markdown
- Reply in Chinese.
- Run the affected tests before reporting a code change complete.
- Include verification results when summarizing code changes.
```

After editing, tell the user that changes take effect when a session next opens. Existing sessions keep their current instructions. Do not restart Pico unless asked.
