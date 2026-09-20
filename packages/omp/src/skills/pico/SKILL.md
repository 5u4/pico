---
name: pico
description: "Pico basics: workspaces, chats, worktree mode, Telegram setup, and web port configuration."
---

# Pico

Pico manages workspaces and chats. OMP is the execution engine.

## Workspaces and chats

A workspace is a named container with a default working directory, `defaultCwd`.

A chat is a conversation within a workspace, with an assigned working directory, `cwd`.

On Discord, workspaces map to channels. A chat may have a corresponding thread in its workspace's channel.

On Telegram, a forum supergroup maps to a workspace. Each named topic maps to one chat. Private chats and the General topic do not start conversations.

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

## Connect Telegram

Use a bot in a trusted forum supergroup. Grant bot administrator access or disable its privacy mode so ordinary topic messages reach it. Group members can read replies even when they cannot send prompts.

Add the group's numeric ID and each permitted user's numeric ID as strings in `<pico-root>/config.toml`.

```toml
[telegram]
allowed_chat = ["-1001234567890"]
allowed_user = ["123456789"]
```

Replace the example IDs with the actual IDs. Both allowlists must match an incoming message. An empty list permits nobody.

Store the bot token in `<pico-root>/secrets/telegram_bot_token` with owner-only read and write permissions. Restart pico after configuration changes. Missing or blank token files disable Telegram independently of Discord.

Use a bot without a configured webhook or another active poller. Pico uses long polling and never removes webhooks automatically.

Send `/bind /absolute/project/path` in the group, then send text in an existing named topic. A new topic chat uses that workspace directory. Rebinding changes future chats, not existing ones. Send `/abort` in a topic to stop its current run.

Telegram currently accepts text only. It sends completed assistant text without Markdown formatting. Attachments, private chats, automatic topic creation, model-selection commands, and schedule delivery are not supported.

The polling offset is held in memory. A crash can replay an input that Telegram has not yet acknowledged. Ambiguous message-send failures are not retried automatically.
