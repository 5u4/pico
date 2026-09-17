---
name: pico
description: "Pico basics: workspaces, chats, worktree mode, and web port configuration."
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

## Web port

The daemon reads `[web].port` from `<pico-root>/config.toml` at startup. The default root is `~/.pico`.

```toml
[web]
port = 7426
```

Omitting the setting uses `http://127.0.0.1:7426`. Set `port = 0` to let the OS choose a free port. The startup log reports the actual URL.

The port must be an integer from 0 through 65535. Restart the daemon after changing it. A busy fixed port fails startup instead of selecting another port. Concurrent pico roots need distinct ports or `port = 0`.
