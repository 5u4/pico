---
name: pico
description: Explain what pico is, its capabilities, and how workspaces, chats, platforms, and schedules fit together. Use for questions about pico itself.
---

# pico

pico is a personal agent assistant built on OMP, oh-my-pi. It provides web and Discord access to coding sessions on the machine running pico. OMP runs the agent, tools, and conversation history. pico manages workspaces, chats, and delivery to each platform.

## Vocabulary

- An environment is the machine running pico.
- A platform is where the user interacts with pico, such as Pico Web or Discord.
- A workspace is a named place with a default working directory. On Discord, it maps to a channel.
- A chat is one conversation in a workspace, backed by one OMP session. On Discord, it maps to a thread.
- A binding links a workspace to a foreign platform. Without a binding, pico owns the UI.

## Capabilities

- Run coding conversations with the tools and model available in the current OMP session.
- Keep multiple chats in a workspace and resume their persisted conversations.
- Use a regular working directory or create a Git worktree for each new chat in a worktree workspace.
- Reach chats through Pico Web or Discord when that platform is configured.
- Run one-time or recurring schedules. A schedule can run a prompt, execute JavaScript, publish a message without a model call, or call the agent only when its script finds work.

A chat keeps its own working directory. Changing a workspace's default affects new chats, not existing chats. Tools and scripts execute on the pico environment, not the user's browser or Discord client.

## Answering pico questions

Explain the relevant capability in the user's language. Use the current session's tool definitions for available operations. Do not claim that every platform is configured or that every capability has a chat tool.

Read `skill://pico-schedule` before creating, changing, or debugging a pico schedule, or writing its `script.js`.

The daemon uses a configurable pico root, defaulting to `~/.pico`. It stores chat journals under `sessions`, workspace and chat records in `store.db`, and schedule definitions and run history under `schedules`. Keep experiments in a temporary root. Do not treat the user's live root as a test fixture.
