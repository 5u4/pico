---
name: pico
description: Pico workspace, chat, Git worktree, working directory, and platform ID concepts.
---

# Pico

Pico manages workspaces and chats. OMP is the execution engine.

## Workspaces and chats

A workspace is a named container with a default working directory, `defaultCwd`.

A chat belongs to one workspace and has its own conversation history and working directory, `cwd`.

On Discord, a workspace corresponds to a channel, and a chat corresponds to a thread in that channel.

## Working directories

Without worktree mode, a new chat uses the workspace's default working directory. Separate chats can edit the same files. Starting a new chat does not isolate file changes.

A worktree workspace is a workspace with worktree mode enabled, not another container between a workspace and its chats. Each new chat gets a separate Git worktree and branch. The chat's `cwd` points to that worktree, while the workspace's `defaultCwd` identifies the source repository.

Use the current `cwd` for file and command operations rather than assuming it matches the workspace's default directory.

## Current context

The injected `Chat context` contains `workspaceId` and `chatId`. These are Pico IDs.

When present, `discord.guildId`, `discord.channelId`, and `discord.threadId` are Discord platform IDs. Use the ID type requested by the tool. IDs identify records, not filesystem paths. Do not infer the working directory from an ID.

## Related skills

- For persistent instructions, read [pico-instructions](../pico-instructions/SKILL.md).
- For reminders and scheduled tasks, read [pico-schedule](../pico-schedule/SKILL.md).
