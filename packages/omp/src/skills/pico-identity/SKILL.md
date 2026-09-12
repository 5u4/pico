---
name: pico-identity
description: Configure Pico identity, response style, and instructions globally or for a Discord bot or channel.
---

# Pico identity

Edit `identity.md` in the scope the user wants. Use the running daemon's pico root, which defaults to `~/.pico`. Do not assume the chat's working directory is the pico root.

| Scope | File under `<picoRoot>` |
| --- | --- |
| Global | `agents/identity.md` |
| Discord bot | `agents/discord/bots/{botId}/identity.md` |
| Discord channel | `agents/discord/channels/{channelId}/identity.md` |

Use actual Discord IDs. `channelId` is the parent channel, not a thread. Channel instructions apply to every bot in that channel.

Read the existing file before editing, preserve unrelated instructions, and create parent directories when needed. Write plain Markdown describing the desired identity, responsibilities, language, or response style.

Pico appends global, bot, then channel content. More-specific conventions take precedence. Missing or blank files are skipped; an empty file does not clear inherited instructions. Native workspaces use only the global file.

Changes apply when a live session next opens, not on the next message in an existing session. Tell the user this after editing. Do not restart the daemon unless asked.
