import type { AgentEvent } from "@pico/contract/agent-event";
import { AgentAssistantMessage, type AgentTranscript } from "@pico/contract/agent-message";
import * as Schema from "effect/Schema";

type Event<Type extends AgentEvent["type"]> = Extract<AgentEvent, { readonly type: Type }>;

export type LiveRun =
  | { readonly kind: "unknown" }
  | { readonly kind: "running" }
  | { readonly kind: "finished"; readonly outcome: Event<"run-finished">["outcome"] };

export type LiveBlock = Event<"text-delta" | "thinking-delta">;

export type PendingContent =
  | {
      readonly kind: "message";
      readonly message: AgentAssistantMessage;
      readonly occurrence: number | null;
    }
  | { readonly kind: "blocks"; readonly blocks: ReadonlyMap<number, LiveBlock> };

export type LiveTool =
  | { readonly kind: "running"; readonly start: Event<"tool-started"> }
  | {
      readonly kind: "finished";
      readonly start: Event<"tool-started"> | null;
      readonly end: Event<"tool-finished">;
    };

export interface LiveChat {
  readonly run: LiveRun;
  readonly blocks: ReadonlyMap<number, LiveBlock>;
  readonly pending: ReadonlyArray<PendingContent>;
  readonly tools: ReadonlyMap<string, LiveTool>;
  readonly notices: ReadonlyArray<Event<"notice">>;
  readonly title: string | null;
}

export const emptyLiveChat = (): LiveChat => ({
  run: { kind: "unknown" },
  blocks: new Map(),
  pending: [],
  tools: new Map(),
  notices: [],
  title: null,
});

const equivalentMessage = Schema.toEquivalence(AgentAssistantMessage);

const occurrences = (transcript: AgentTranscript, message: AgentAssistantMessage): number => {
  let count = 0;
  for (const candidate of transcript) {
    if (candidate.role === "assistant" && equivalentMessage(candidate, message)) count += 1;
  }
  return count;
};

const sealBlocks = (state: LiveChat): ReadonlyArray<PendingContent> =>
  state.blocks.size === 0
    ? state.pending
    : [...state.pending, { kind: "blocks", blocks: state.blocks }];

export const acknowledgeTranscript = (
  state: LiveChat,
  transcript: AgentTranscript,
  eligible: ReadonlyArray<PendingContent>,
): LiveChat => {
  const pending = state.pending.filter(
    (entry) =>
      entry.kind === "blocks" ||
      entry.occurrence === null ||
      !eligible.includes(entry) ||
      occurrences(transcript, entry.message) < entry.occurrence,
  );
  return pending.length === state.pending.length ? state : { ...state, pending };
};

export const reduceLiveChat = (
  state: LiveChat,
  event: AgentEvent,
  transcript: AgentTranscript | null = null,
): LiveChat => {
  switch (event.type) {
    case "run-started":
      return {
        ...state,
        run: { kind: "running" },
        pending: sealBlocks(state),
        blocks: new Map(),
        tools: new Map(),
      };
    case "text-delta":
    case "thinking-delta": {
      const previous = state.blocks.get(event.contentIndex);
      const blocks = new Map(state.blocks);
      blocks.set(event.contentIndex, {
        ...event,
        text: previous?.type === event.type ? previous.text + event.text : event.text,
      });
      return { ...state, run: { kind: "running" }, blocks };
    }
    case "message-settled": {
      const message = event.message;
      if (message.role !== "assistant") return state;
      let occurrence = transcript === null ? null : occurrences(transcript, message) + 1;
      if (occurrence !== null) {
        for (const entry of state.pending) {
          if (entry.kind === "message" && equivalentMessage(entry.message, message))
            occurrence += 1;
        }
      }
      return {
        ...state,
        blocks: new Map(),
        pending: [...state.pending, { kind: "message", message, occurrence }],
      };
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
    case "notice":
      return { ...state, notices: [...state.notices, event] };
    case "run-finished":
      return {
        ...state,
        run: { kind: "finished", outcome: event.outcome },
        pending: sealBlocks(state),
        blocks: new Map(),
      };
    case "title-changed":
      return { ...state, title: event.title };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
