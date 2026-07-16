import type { ContextUsageInfo } from "../../../engine/conversations";
import type { Message } from "../../../engine/message";
import { assertNever } from "../../../util/assert";
import type { ClientCommand, ServerEvent, WorkspaceSummary } from "../protocol";

export type ThreadState = {
  messages: Message[];
  isRunning: boolean;
  workspaces: WorkspaceSummary[];
  activeId: string | null;
  draftWorkspaceId: string | null;
  threadKey: string;
  pending: Message | null;
  pendingBaseUserCount: number | null;
  draftSeq: number;
  usage: ContextUsageInfo | null;
  hasMore: boolean;
  loadingOlder: boolean;
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
  draftSeq: 0,
  usage: null,
  hasMore: false,
  loadingOlder: false,
};

export type Action =
  | { type: "server"; event: ServerEvent }
  | { type: "prompt"; text: string }
  | { type: "command"; name: "ping"; text?: string }
  | { type: "cancel" }
  | { type: "select"; conversationId: string }
  | { type: "create"; workspaceId: string }
  | { type: "createWorkspace"; label: string }
  | { type: "renameWorkspace"; workspaceId: string; label: string }
  | { type: "updateWorkspaceCwd"; workspaceId: string; cwd: string }
  | { type: "archive"; conversationId: string }
  | { type: "loadOlder" };

type Reduced = {
  state: ThreadState;
  commands: ClientCommand[];
  toasts?: string[];
};

function mergeTail(prev: Message[], tail: Message): Message[] {
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

function idIndex(id: string): number {
  const n = Number.parseInt(id.slice(1), 10);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

function mergeById(prev: Message[], incoming: Message[]): Message[] {
  const out: Message[] = [];
  let i = 0;
  let j = 0;
  while (i < prev.length && j < incoming.length) {
    const a = prev[i];
    const b = incoming[j];
    if (!a) {
      i++;
      continue;
    }
    if (!b) {
      j++;
      continue;
    }
    const ai = idIndex(a.id);
    const bi = idIndex(b.id);
    if (ai < bi) {
      out.push(a);
      i++;
    } else if (ai > bi) {
      out.push(b);
      j++;
    } else {
      out.push(b);
      i++;
      j++;
    }
  }
  for (; i < prev.length; i++) {
    const a = prev[i];
    if (a) out.push(a);
  }
  for (; j < incoming.length; j++) {
    const b = incoming[j];
    if (b) out.push(b);
  }
  return out;
}

function clearPendingIfResolved(
  state: ThreadState,
  messages: Message[],
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
            usage: null,
            hasMore: false,
            loadingOlder: false,
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
      const messages = mergeById(state.messages, event.messages);
      const cleared = clearPendingIfResolved(state, messages);
      return {
        state: {
          ...state,
          messages,
          isRunning: event.isStreaming,
          usage: event.usage,
          hasMore: event.hasMore,
          ...cleared,
        },
        commands: [],
      };
    }
    case "older": {
      if (event.conversationId !== state.activeId)
        return { state, commands: [] };
      return {
        state: {
          ...state,
          messages: mergeById(event.messages, state.messages),
          hasMore: event.hasMore,
          loadingOlder: false,
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
      return {
        state: { ...state, messages, isRunning: event.isStreaming },
        commands: [],
      };
    }
    case "heartbeatAck":
      return { state, commands: [] };
    case "error":
      return {
        state: {
          ...state,
          pending: null,
          pendingBaseUserCount: null,
          isRunning: false,
        },
        commands: [],
        toasts: [event.message],
      };
    default:
      return assertNever(event);
  }
}

function reducePrompt(state: ThreadState, text: string): Reduced {
  if (state.activeId === null && state.draftWorkspaceId === null) {
    return {
      state,
      commands: [],
      toasts: ["no workspace selected for the new conversation"],
    };
  }
  const pending: Message = {
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
      usage: null,
      hasMore: false,
      loadingOlder: false,
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
      usage: null,
      hasMore: false,
      loadingOlder: false,
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
    case "command":
      if (state.activeId === null)
        return {
          state,
          commands: [],
          toasts: ["select a conversation first"],
        };
      return {
        state,
        commands: [{ kind: "command", name: action.name, text: action.text }],
      };
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
    case "renameWorkspace":
      return {
        state,
        commands: [
          {
            kind: "renameWorkspace",
            workspaceId: action.workspaceId,
            label: action.label,
          },
        ],
      };
    case "updateWorkspaceCwd":
      return {
        state,
        commands: [
          {
            kind: "updateWorkspaceCwd",
            workspaceId: action.workspaceId,
            cwd: action.cwd,
          },
        ],
      };
    case "archive":
      return {
        state,
        commands: [{ kind: "archive", conversationId: action.conversationId }],
      };
    case "loadOlder": {
      const first = state.messages[0];
      if (
        state.activeId === null ||
        !state.hasMore ||
        state.loadingOlder ||
        !first
      )
        return { state, commands: [] };
      return {
        state: { ...state, loadingOlder: true },
        commands: [
          {
            kind: "loadOlder",
            conversationId: state.activeId,
            beforeId: first.id,
          },
        ],
      };
    }
    default:
      return assertNever(action);
  }
}

export function selectView(state: ThreadState): Message[] {
  return state.pending ? [...state.messages, state.pending] : state.messages;
}

export function selectIsRunning(state: ThreadState): boolean {
  return state.isRunning || state.pending !== null;
}
