---
name: pico-identity
description: Configure Pico identity.
---

# Pico identity

Use the running Pico's root directory, which defaults to `~/.pico`.

| Scope | File under `<picoRoot>` |
| --- | --- |
| Global | `agents/identity.md` |
| Discord bot | `agents/discord/bots/{botId}/identity.md` |
| Discord channel | `agents/discord/channels/{channelId}/identity.md` |

Use the parent Discord channel ID, not a thread ID.

Read the existing file, preserve unrelated instructions, and create parent directories if needed. Write plain Markdown, for example:

```markdown
Your name is Pico. Reply in Chinese. Keep answers concise.
```

After editing, tell the user that changes take effect when a session next opens. Existing sessions keep their current identity. Do not restart Pico unless asked.
