import type { AgentEvent } from "@pico/contract/agent-event";
import type {
  AgentAssistantMessage,
  AgentMessageId,
  AgentTranscript,
} from "@pico/contract/agent-message";

type Event<Type extends AgentEvent["type"]> = Extract<AgentEvent, { readonly type: Type }>;

export type LiveRun =
  | { readonly kind: "unknown" }
  | { readonly kind: "running" }
  | { readonly kind: "finished"; readonly outcome: Event<"run-finished">["outcome"] };

export type LiveBlock = Event<"text-delta" | "thinking-delta">;

export type LiveAssistant =
  | {
      readonly kind: "draft";
      readonly blocks: ReadonlyMap<number, LiveBlock>;
      readonly phase: "streaming" | "retained";
    }
  | { readonly kind: "settled"; readonly message: AgentAssistantMessage };

export type LiveTool =
  | { readonly kind: "running"; readonly start: Event<"tool-started"> }
  | {
      readonly kind: "finished";
      readonly start: Event<"tool-started"> | null;
      readonly end: Event<"tool-finished">;
    };

export interface LiveChat {
  readonly run: LiveRun;
  readonly assistant: ReadonlyMap<AgentMessageId, LiveAssistant>;
  readonly snapshotIds: ReadonlySet<AgentMessageId>;
  readonly tools: ReadonlyMap<string, LiveTool>;
  readonly notices: ReadonlyArray<Event<"notice">>;
}

export const emptyLiveChat = (): LiveChat => ({
  run: { kind: "unknown" },
  assistant: new Map(),
  snapshotIds: new Set(),
  tools: new Map(),
  notices: [],
});

const retainDrafts = (messages: LiveChat["assistant"]): LiveChat["assistant"] => {
  let retained: Map<AgentMessageId, LiveAssistant> | undefined;
  for (const [id, message] of messages) {
    if (message.kind !== "draft" || message.phase === "retained") continue;
    retained ??= new Map(messages);
    retained.set(id, { ...message, phase: "retained" });
  }
  return retained ?? messages;
};

export const acknowledgeTranscript = (state: LiveChat, transcript: AgentTranscript): LiveChat => {
  let assistant: Map<AgentMessageId, LiveAssistant> | undefined;
  let snapshotIds: Set<AgentMessageId> | undefined;
  for (const message of transcript) {
    if (message.role !== "assistant") continue;
    if (state.assistant.has(message.id)) {
      assistant ??= new Map(state.assistant);
      assistant.delete(message.id);
    }
    if (!state.snapshotIds.has(message.id)) {
      snapshotIds ??= new Set(state.snapshotIds);
      snapshotIds.add(message.id);
    }
  }
  return assistant || snapshotIds
    ? {
        ...state,
        assistant: assistant ?? state.assistant,
        snapshotIds: snapshotIds ?? state.snapshotIds,
      }
    : state;
};

export const reduceLiveChat = (
  state: LiveChat,
  event: Exclude<AgentEvent, { readonly type: "title-changed" }>,
): LiveChat => {
  switch (event.type) {
    case "notice":
      return { ...state, notices: [...state.notices, event] };
    case "run-started":
      return {
        ...state,
        run: { kind: "running" },
        assistant: retainDrafts(state.assistant),
        tools: new Map(),
      };
    case "text-delta":
    case "thinking-delta": {
      if (state.snapshotIds.has(event.messageId)) return state;
      const message = state.assistant.get(event.messageId);
      if (message?.kind === "settled") return state;
      const previous = message?.blocks.get(event.contentIndex);
      const blocks = new Map(message?.blocks);
      blocks.set(event.contentIndex, {
        ...event,
        text: previous?.type === event.type ? previous.text + event.text : event.text,
      });
      const assistant = new Map(state.assistant);
      assistant.set(event.messageId, { kind: "draft", blocks, phase: "streaming" });
      return { ...state, run: { kind: "running" }, assistant };
    }
    case "message-settled": {
      const message = event.message;
      if (message.role !== "assistant" || state.snapshotIds.has(message.id)) return state;
      const assistant = new Map(state.assistant);
      assistant.set(message.id, { kind: "settled", message });
      return { ...state, assistant };
    }
    case "tool-started": {
      const tools = new Map(state.tools);
      tools.set(event.toolCallId, { kind: "running", start: event });
      return { ...state, run: { kind: "running" }, tools };
    }
    case "tool-finished": {
      const tools = new Map(state.tools);
      tools.set(event.toolCallId, {
        kind: "finished",
        start: state.tools.get(event.toolCallId)?.start ?? null,
        end: event,
      });
      return { ...state, run: { kind: "running" }, tools };
    }
    case "run-finished":
      return {
        ...state,
        run: { kind: "finished", outcome: event.outcome },
        assistant: retainDrafts(state.assistant),
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
