import type { AgentEvent } from "@pico/contract/agent-event";

type Event<Type extends AgentEvent["type"]> = Extract<AgentEvent, { readonly type: Type }>;

export type LiveRun =
  | { readonly kind: "unknown" }
  | { readonly kind: "running" }
  | { readonly kind: "finished"; readonly outcome: Event<"run-finished">["outcome"] };

export type LiveBlock = Event<"text-delta" | "thinking-delta">;

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
  readonly tools: ReadonlyMap<string, LiveTool>;
  readonly notices: ReadonlyArray<Event<"notice">>;
  readonly title: string | null;
}

export const emptyLiveChat = (): LiveChat => ({
  run: { kind: "unknown" },
  blocks: new Map(),
  tools: new Map(),
  notices: [],
  title: null,
});

export const reduceLiveChat = (state: LiveChat, event: AgentEvent): LiveChat => {
  switch (event.type) {
    case "run-started":
      return { ...state, run: { kind: "running" }, blocks: new Map(), tools: new Map() };
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
    case "message-settled":
      return event.message.role === "assistant" && state.blocks.size > 0
        ? { ...state, blocks: new Map() }
        : state;
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
      return { ...state, tools };
    }
    case "notice":
      return { ...state, notices: [...state.notices, event] };
    case "run-finished":
      return {
        ...state,
        run: { kind: "finished", outcome: event.outcome },
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
