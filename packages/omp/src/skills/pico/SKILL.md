---
name: pico
description: "Pico basics: workspaces, chats, and worktree mode."
---

# Pico

Pico manages workspaces and chats. OMP is the execution engine.

## Workspaces and chats

A workspace is a named container with a default working directory, `defaultCwd`.

A chat is a conversation within a workspace, with an assigned working directory, `cwd`.

On Discord, workspaces map to channels. A chat may have a corresponding thread in its workspace's channel.

## Working directories

Without worktree mode, a new chat uses the workspace's default working directory. Separate chats can edit the same files. Starting a new chat does not isolate file changes.

A worktree workspace has worktree mode enabled. Each new chat gets a separate Git worktree and branch. The chat's `cwd` points to that worktree, while the workspace's `defaultCwd` identifies the source repository.
