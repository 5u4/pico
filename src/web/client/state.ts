import { assertNever } from "../../util/assert";
import type {
  ClientCommand,
  ServerEvent,
  UiMessage,
  WorkspaceSummary,
} from "../protocol";

export type ThreadState = {
  messages: UiMessage[];
  isRunning: boolean;
  workspaces: WorkspaceSummary[];
  activeId: string | null;
  draftWorkspaceId: string | null;
  threadKey: string;
  pending: UiMessage | null;
  pendingBaseUserCount: number | null;
  error: string | null;
  draftSeq: number;
};

export const initialState: ThreadState = {
  messages: [],
  isRunning: false,
  workspaces: [],
  activeId: null,
  draftWorkspaceId: null,
  threadKey: "",
  pending: null,
  pendingBaseUserCount: null,
  error: null,
  draftSeq: 0,
};

export type Action =
  | { type: "server"; event: ServerEvent }
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  | { type: "select"; conversationId: string }
  | { type: "create"; workspaceId: string }
  | { type: "createWorkspace"; label: string }
  | { type: "dismissError" };

type Reduced = { state: ThreadState; commands: ClientCommand[] };

function mergeTail(prev: UiMessage[], tail: UiMessage): UiMessage[] {
  const last = prev.length - 1;
  if (last >= 0 && prev[last]?.id === tail.id) {
    const next = prev.slice();
    next[last] = tail;
    return next;
  }
  const index = prev.findIndex((m) => m.id === tail.id);
  if (index === -1) return [...prev, tail];
  const next = prev.slice();
  next[index] = tail;
  return next;
}

function clearPendingIfResolved(
  state: ThreadState,
  messages: UiMessage[],
): Pick<ThreadState, "pending" | "pendingBaseUserCount"> {
  if (state.pendingBaseUserCount === null) {
    return {
      pending: state.pending,
      pendingBaseUserCount: state.pendingBaseUserCount,
    };
  }
  const userCount = messages.filter((m) => m.role === "user").length;
  if (userCount > state.pendingBaseUserCount) {
    return { pending: null, pendingBaseUserCount: null };
  }
  return {
    pending: state.pending,
    pendingBaseUserCount: state.pendingBaseUserCount,
  };
}

function reduceServer(state: ThreadState, event: ServerEvent): Reduced {
  switch (event.kind) {
    case "workspaces": {
      if (event.activeId !== null) {
        return {
          state: {
            ...state,
            workspaces: event.items,
            activeId: event.activeId,
            draftWorkspaceId: null,
            threadKey:
              state.threadKey === "" ? event.activeId : state.threadKey,
          },
          commands: [],
        };
      }
      if (event.draftWorkspaceId) {
        const draftSeq = state.draftSeq + 1;
        return {
          state: {
            ...state,
            workspaces: event.items,
            activeId: null,
            draftWorkspaceId: event.draftWorkspaceId,
            pending: null,
            pendingBaseUserCount: null,
            messages: [],
            isRunning: false,
            threadKey: `draft-${draftSeq}`,
            draftSeq,
          },
          commands: [],
        };
      }
      return {
        state: { ...state, workspaces: event.items, activeId: null },
        commands: [],
      };
    }
    case "snapshot": {
      if (event.conversationId !== state.activeId)
        return { state, commands: [] };
      const cleared = clearPendingIfResolved(state, event.messages);
      return {
        state: {
          ...state,
          messages: event.messages,
          isRunning: event.isStreaming,
          ...cleared,
        },
        commands: [],
      };
    }
    case "stream": {
      if (event.conversationId !== state.activeId)
        return { state, commands: [] };
      const messages = event.message
        ? mergeTail(state.messages, event.message)
        : state.messages;
      const cleared = clearPendingIfResolved(state, messages);
      return {
        state: { ...state, messages, isRunning: event.isStreaming, ...cleared },
        commands: [],
      };
    }
    case "error":
      return {
        state: {
          ...state,
          pending: null,
          pendingBaseUserCount: null,
          isRunning: false,
          error: event.message,
        },
        commands: [],
      };
    default:
      return assertNever(event);
  }
}

function reducePrompt(state: ThreadState, text: string): Reduced {
  if (state.activeId === null && state.draftWorkspaceId === null) {
    return {
      state: {
        ...state,
        error: "no workspace selected for the new conversation",
      },
      commands: [],
    };
  }
  const pending: UiMessage = {
    id: "pending-user",
    role: "user",
    parts: [{ type: "text", text }],
  };
  const pendingBaseUserCount = state.messages.filter(
    (m) => m.role === "user",
  ).length;
  const command: ClientCommand =
    state.draftWorkspaceId !== null && state.activeId === null
      ? { kind: "create", workspaceId: state.draftWorkspaceId, prompt: text }
      : { kind: "prompt", text };
  return {
    state: { ...state, pending, pendingBaseUserCount },
    commands: [command],
  };
}

function reduceSelect(state: ThreadState, conversationId: string): Reduced {
  if (conversationId === state.activeId) return { state, commands: [] };
  return {
    state: {
      ...state,
      activeId: conversationId,
      draftWorkspaceId: null,
      pending: null,
      pendingBaseUserCount: null,
      threadKey: conversationId,
      messages: [],
      isRunning: false,
      error: null,
    },
    commands: [{ kind: "select", conversationId }],
  };
}

function reduceCreate(state: ThreadState, workspaceId: string): Reduced {
  const draftSeq = state.draftSeq + 1;
  return {
    state: {
      ...state,
      activeId: null,
      draftWorkspaceId: workspaceId,
      pending: null,
      pendingBaseUserCount: null,
      threadKey: `draft-${draftSeq}`,
      draftSeq,
      messages: [],
      isRunning: false,
      error: null,
    },
    commands: [{ kind: "draft" }],
  };
}

export function reduce(state: ThreadState, action: Action): Reduced {
  switch (action.type) {
    case "server":
      return reduceServer(state, action.event);
    case "prompt":
      return reducePrompt(state, action.text);
    case "cancel":
      return {
        state: { ...state, pending: null, pendingBaseUserCount: null },
        commands: [{ kind: "abort" }],
      };
    case "select":
      return reduceSelect(state, action.conversationId);
    case "create":
      return reduceCreate(state, action.workspaceId);
    case "createWorkspace":
      return {
        state,
        commands: [{ kind: "createWorkspace", label: action.label }],
      };
    case "dismissError":
      return { state: { ...state, error: null }, commands: [] };
    default:
      return assertNever(action);
  }
}

export function selectView(state: ThreadState): UiMessage[] {
  return state.pending ? [...state.messages, state.pending] : state.messages;
}

export function selectIsRunning(state: ThreadState): boolean {
  return state.isRunning || state.pending !== null;
}
