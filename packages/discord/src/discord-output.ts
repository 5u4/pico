import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import type * as AgentMessage from "@pico/contract/agent-message";
import type * as Chat from "@pico/contract/chat-model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { DiscordError, discordError, reportFailure } from "./discord-error.ts";
import * as Markdown from "./discord-markdown.ts";

const FAILED_MESSAGE = "The request failed.";
const ABORTED_MESSAGE = "The request was stopped.";
const LENGTH_MESSAGE = "_The response stopped because it reached the length limit._";
const SILENT = true;
const TYPING_INTERVAL = "8 seconds";

export interface RenderedMessage {
  readonly content: string;
  readonly silent: boolean;
}

export interface DiscordOutputPolicy {
  readonly showToolCalls: boolean;
  readonly showThinking: boolean;
}

export interface DiscordOutputClient {
  readonly send: (threadId: bigint, message: RenderedMessage) => Effect.Effect<bigint, unknown>;
  readonly edit: (
    threadId: bigint,
    messageId: bigint,
    content: string,
  ) => Effect.Effect<void, unknown>;
  readonly renameThread: (threadId: bigint, title: string) => Effect.Effect<void, unknown>;
  readonly triggerTyping: (threadId: bigint) => Effect.Effect<void, unknown>;
}

interface ToolState {
  readonly presentation: ToolPresentation;
  messageId: bigint | undefined;
}

interface RunState {
  typing: Fiber.Fiber<void> | undefined;
  terminalClaimed: boolean;
  readonly tools: Map<string, ToolState>;
  readonly finishedTools: Set<string>;
}

const newRunState = (): RunState => ({
  typing: undefined,
  terminalClaimed: false,
  tools: new Map(),
  finishedTools: new Set(),
});

interface ToolPresentation {
  readonly started: string;
  readonly succeeded: string;
  readonly failed: string;
  readonly canceled: string;
}

interface ToolDefinition {
  readonly emoji: string;
  readonly started: string;
  readonly completed: string;
  readonly fallback: string;
  readonly targets: ReadonlyArray<string>;
}

const defineTool = (
  emoji: string,
  started: string,
  completed: string,
  fallback: string,
  ...targets: ReadonlyArray<string>
): ToolDefinition => ({ emoji, started, completed, fallback, targets });

const toolDefinitions: Readonly<Record<string, ToolDefinition>> = {
  read: defineTool("📖", "Reading", "Read", "input", "path", "url"),
  write: defineTool("✏️", "Writing", "Wrote", "output", "path"),
  edit: defineTool("✏️", "Editing", "Edited", "source", "path"),
  ast_edit: defineTool("✏️", "Editing", "Edited", "source", "paths", "path"),
  bash: defineTool("💻", "Running", "Ran", "command", "command", "i"),
  eval: defineTool("💻", "Evaluating", "Evaluated", "code", "title", "i", "language"),
  grep: defineTool("🔎", "Searching", "Searched", "source", "pattern", "path", "i"),
  glob: defineTool("🔎", "Finding", "Found", "files", "path", "i"),
  ast_grep: defineTool("🔎", "Searching syntax in", "Searched syntax in", "source", "path", "pat"),
  lsp: defineTool("🧭", "Inspecting", "Inspected", "code", "file", "action", "symbol"),
  web_search: defineTool("🌐", "Searching the web for", "Searched the web for", "query", "query"),
  browser: defineTool("🌐", "Browsing", "Browsed", "page", "url", "action", "name"),
  inspect_image: defineTool("🖼️", "Inspecting", "Inspected", "image", "path", "url"),
  github: defineTool("🐙", "Using GitHub for", "Used GitHub for", "repository", "repo", "op", "pr"),
  task: defineTool("🧭", "Delegating", "Delegated", "work", "i", "name"),
  hub: defineTool("🧭", "Coordinating", "Coordinated", "agents", "op", "to", "name"),
  todo: defineTool("🧭", "Updating", "Updated", "tasks", "task", "phase", "op"),
  memory_edit: defineTool("🧠", "Updating memory", "Updated memory", "context", "path", "i"),
  retain: defineTool("🧠", "Retaining", "Retained", "memory", "content", "i"),
  recall: defineTool("🧠", "Recalling", "Recalled", "memory", "query", "i"),
  reflect: defineTool("🧠", "Reflecting on", "Reflected on", "memory", "query", "i"),
  learn: defineTool("🧠", "Learning", "Learned", "lesson", "name", "i"),
  manage_skill: defineTool("🧠", "Managing skill", "Managed skill", "skill", "name", "action"),
  checkpoint: defineTool("🗂️", "Checkpointing", "Checkpointed", "context", "goal"),
  rewind: defineTool("🗂️", "Rewinding", "Rewound", "context", "report"),
  computer: defineTool("🖥️", "Controlling", "Controlled", "computer", "action", "app"),
  security_scan: defineTool("🔒", "Scanning", "Scanned", "security", "path", "i"),
};

const ToolArguments = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeToolArguments = Schema.decodeUnknownOption(ToolArguments);
const emptyToolArguments: Readonly<Record<string, unknown>> = {};
const isStringArray = Schema.is(Schema.Array(Schema.String));

const parseToolArguments = (source: string): Readonly<Record<string, unknown>> =>
  Option.getOrElse(decodeToolArguments(source), () => emptyToolArguments);
const toolDefinition = (name: string) =>
  Object.hasOwn(toolDefinitions, name) ? toolDefinitions[name] : undefined;
const toolName = (name: string) => Markdown.truncate(name, 100) ?? "tool";
const toolMessage = (content: string, fallback: string) =>
  Markdown.truncate(content, Markdown.TOOL_MESSAGE_LIMIT) ?? fallback;
const toolStartedMessage = (emoji: string, action: string) => {
  const content = Markdown.truncate(`${emoji} ${action}`, Markdown.TOOL_MESSAGE_LIMIT - 1) ?? emoji;
  return content.endsWith("…") ? content : `${content}…`;
};
const toolTarget = (arguments_: Readonly<Record<string, unknown>>, definition: ToolDefinition) => {
  for (const name of definition.targets) {
    const value = arguments_[name];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
      continue;
    }
    if (!isStringArray(value)) continue;
    const strings: string[] = [];
    for (const item of value) {
      const trimmed = item.trim();
      if (trimmed.length > 0) strings.push(trimmed);
    }
    if (strings.length > 0) return strings.join(", ");
  }
  return definition.fallback;
};
const toolPresentation = (
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): ToolPresentation => {
  const definition = toolDefinition(name);
  if (definition === undefined) {
    const safeName = toolName(name);
    return {
      started: toolStartedMessage("⚙️", safeName),
      succeeded: toolMessage(`⚙️ Completed ${safeName}`, "⚙️ Completed tool"),
      failed: toolMessage(`❌ Completed ${safeName}`, "❌ Completed tool"),
      canceled: toolMessage(`⚙️ ${safeName} canceled.`, "⚙️ Tool canceled."),
    };
  }
  const target = toolTarget(arguments_, definition);
  return {
    started: toolStartedMessage(definition.emoji, `${definition.started} ${target}`),
    succeeded: toolMessage(
      `${definition.emoji} ${definition.completed} ${target}`,
      `${definition.emoji} ${definition.completed} ${definition.fallback}`,
    ),
    failed: toolMessage(
      `❌ ${definition.completed} ${target}`,
      `❌ ${definition.completed} ${definition.fallback}`,
    ),
    canceled: toolMessage(
      `${definition.emoji} ${definition.started} ${target} canceled.`,
      `${definition.emoji} ${definition.started} ${definition.fallback} canceled.`,
    ),
  };
};

const textMessages = (text: string, silent: boolean): ReadonlyArray<RenderedMessage> =>
  Markdown.split(text).map(({ content }) => ({ content, silent }));

export const renderAssistant = (
  message: AgentMessage.AgentAssistantMessage,
  showThinking: boolean,
): ReadonlyArray<RenderedMessage> => {
  const rendered: RenderedMessage[] = [];
  let notified = message.status === "completed" && message.stopReason === "tool-use";
  const lastTextIndex = message.content.findLastIndex((content) => content.type === "text");

  for (let index = 0; index < message.content.length; index++) {
    const content = message.content[index];
    if (showThinking && content?.type === "thinking") {
      if (content.text.trim().length === 0) continue;
      const thinking = Markdown.truncate(`🧠 ${content.text}`, Markdown.THINKING_LIMIT);
      if (thinking !== undefined) rendered.push({ content: thinking, silent: SILENT });
      continue;
    }
    if (content?.type !== "text") continue;

    const suffix =
      message.stopReason === "length" && index === lastTextIndex ? `\n\n${LENGTH_MESSAGE}` : "";
    const chunks = textMessages(`${content.text}${suffix}`, notified);
    if (chunks.length === 0) continue;
    rendered.push(...chunks);
    notified = true;
  }

  if (message.status === "failed") {
    rendered.push({
      content: message.stopReason === "aborted" ? ABORTED_MESSAGE : FAILED_MESSAGE,
      silent: false,
    });
  } else if (message.stopReason === "length" && lastTextIndex === -1) {
    rendered.push({ content: LENGTH_MESSAGE, silent: false });
  }
  return rendered;
};

const interruptTyping = Effect.fn("Discord.output.interruptTyping")(function* (state: RunState) {
  const typing = state.typing;
  state.typing = undefined;
  if (typing !== undefined) yield* Fiber.interrupt(typing);
});

export const make = (
  client: DiscordOutputClient,
  scope: Scope.Scope,
  policy: DiscordOutputPolicy,
) => {
  const states = new Map<Chat.ChatId, RunState>();

  const stateFor = (chatId: Chat.ChatId) => {
    const current = states.get(chatId);
    if (current !== undefined) return current;
    const state = newRunState();
    states.set(chatId, state);
    return state;
  };

  const startTyping = Effect.fn("Discord.output.startTyping")(function* (
    threadId: bigint,
    state: RunState,
  ) {
    yield* interruptTyping(state);
    let degraded = false;
    const loop = Effect.forever(
      client.triggerTyping(threadId).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (!degraded) return Effect.void;
            degraded = false;
            return Effect.logInfo("Discord typing indicator recovered").pipe(
              Effect.annotateLogs({ operation: "trigger-typing", outcome: "recovered" }),
            );
          }),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          if (degraded) return Effect.void;
          degraded = true;
          return reportFailure("trigger-typing", cause, "warning");
        }),
        Effect.andThen(Effect.sleep(TYPING_INTERVAL)),
      ),
    ).pipe(Effect.annotateLogs({ component: "discord", threadId: threadId.toString() }));
    state.typing = yield* Effect.forkIn(loop, scope, { startImmediately: true });
  });
  const updateToolMessage = Effect.fn("Discord.output.updateToolMessage")(function* (
    threadId: bigint,
    messageId: bigint | undefined,
    content: string,
  ) {
    if (messageId === undefined) {
      yield* client.send(threadId, { content, silent: SILENT });
      return;
    }
    yield* client.edit(threadId, messageId, content).pipe(
      Effect.catch((error) => {
        const edit = discordError("edit-message", error);
        return client.send(threadId, { content, silent: SILENT }).pipe(
          Effect.mapError((failure) => {
            const delivery = discordError("send-message", failure);
            return new DiscordError({
              ...delivery,
              message: "Discord tool message replacement failed",
              operation: "edit-message-fallback",
              messageId: messageId.toString(),
              ...(edit.status === undefined ? {} : { editStatus: edit.status }),
              ...(edit.discordCode === undefined ? {} : { editDiscordCode: edit.discordCode }),
            });
          }),
          Effect.andThen(
            edit.discordCode === 10008
              ? Effect.void
              : reportFailure("edit-message", Cause.fail(edit), "warning").pipe(
                  Effect.annotateLogs({
                    messageId: messageId.toString(),
                    outcome: "sent-replacement",
                  }),
                ),
          ),
        );
      }),
    );
  });

  const finishTool = Effect.fn("Discord.output.finishTool")(function* (
    threadId: bigint,
    state: RunState,
    toolCallId: string,
    name: string,
    status: "succeeded" | "failed",
  ) {
    if (state.finishedTools.has(toolCallId)) return;
    state.finishedTools.add(toolCallId);
    const tool = state.tools.get(toolCallId);
    state.tools.delete(toolCallId);
    const presentation = tool?.presentation ?? toolPresentation(name, emptyToolArguments);
    const content = status === "succeeded" ? presentation.succeeded : presentation.failed;
    yield* updateToolMessage(threadId, tool?.messageId, content);
  });

  const flushTools = Effect.fn("Discord.output.flushTools")(function* (
    threadId: bigint,
    state: RunState,
  ) {
    const pending = Array.from(state.tools.entries());
    state.tools.clear();
    for (const [toolCallId, tool] of pending) {
      if (state.finishedTools.has(toolCallId)) continue;
      state.finishedTools.add(toolCallId);
      yield* updateToolMessage(threadId, tool.messageId, tool.presentation.canceled);
    }
  });

  return Effect.fn("Discord.output.dispatch")(
    function* (threadId: bigint, envelope: AgentEventEnvelope) {
      const event = envelope.event;
      if (
        !policy.showToolCalls &&
        (event.type === "tool-started" || event.type === "tool-finished")
      ) {
        return;
      }
      const state = stateFor(envelope.chatId);

      switch (event.type) {
        case "run-started": {
          yield* interruptTyping(state);
          yield* flushTools(threadId, state).pipe(
            Effect.catchCause((cause) => reportFailure("finalize-stale-tools", cause, "warning")),
          );
          const next = newRunState();
          states.set(envelope.chatId, next);
          yield* startTyping(threadId, next);
          return;
        }
        case "text-delta":
        case "thinking-delta":
        case "notice":
          return;
        case "title-changed":
          yield* client
            .renameThread(threadId, event.title)
            .pipe(Effect.catchCause((cause) => reportFailure("rename-thread", cause, "warning")));
          return;
        case "tool-started": {
          if (state.tools.has(event.toolCallId) || state.finishedTools.has(event.toolCallId))
            return;
          const presentation = toolPresentation(
            event.toolName,
            parseToolArguments(event.argumentsJson),
          );
          const tool: ToolState = { presentation, messageId: undefined };
          state.tools.set(event.toolCallId, tool);
          tool.messageId = yield* client.send(threadId, {
            content: presentation.started,
            silent: SILENT,
          });
          return;
        }
        case "tool-finished":
          yield* finishTool(threadId, state, event.toolCallId, event.toolName, event.status);
          return;
        case "message-settled": {
          if (event.message.role !== "assistant") return;
          const terminal =
            event.message.status === "failed" || event.message.stopReason !== "tool-use";
          if (terminal && state.terminalClaimed) return;
          if (terminal) state.terminalClaimed = true;
          const messages = renderAssistant(event.message, policy.showThinking);
          for (const [chunkIndex, message] of messages.entries()) {
            yield* client.send(threadId, message).pipe(
              Effect.mapError(
                (error) =>
                  new DiscordError({
                    ...discordError("send-message", error),
                    chunkIndex,
                    chunkCount: messages.length,
                  }),
              ),
            );
          }
          return;
        }
        case "run-finished": {
          yield* interruptTyping(state);
          yield* flushTools(threadId, state);
          if (event.outcome === "completed" || state.terminalClaimed) return;
          state.terminalClaimed = true;
          yield* client.send(threadId, {
            content: event.outcome === "aborted" ? ABORTED_MESSAGE : FAILED_MESSAGE,
            silent: false,
          });
          return;
        }
      }
    },
    (effect, threadId, envelope) =>
      effect.pipe(
        Effect.annotateLogs({
          component: "discord",
          chatId: envelope.chatId,
          threadId: threadId.toString(),
          eventType: envelope.event.type,
        }),
      ),
  );
};
