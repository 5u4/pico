import { describe, expect, test } from "bun:test";
import type { Message } from "../../../engine/message";
import type { WorkspaceSummary } from "../protocol";
import {
  initialState,
  reduce,
  selectIsRunning,
  selectView,
  type ThreadState,
} from "./state";

function userMessage(id: string): Message {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

function assistantMessage(id: string): Message {
  return { id, role: "assistant", parts: [{ type: "text", text: id }] };
}

const workspaces: WorkspaceSummary[] = [
  {
    id: "ws-1",
    label: "Workspace 1",
    cwd: "/tmp/ws-1",
    worktree: false,
    defaultBranch: null,
    branchPrefix: null,
    conversations: [],
  },
];

describe("reduce / server / workspaces", () => {
  test("with activeId sets workspaces and activeId, clears draftWorkspaceId", () => {
    const state: ThreadState = {
      ...initialState,
      draftWorkspaceId: "draft-ws",
      threadKey: "existing-key",
    };
    const { state: next, commands } = reduce(state, {
      type: "server",
      event: { kind: "workspaces", items: workspaces, activeId: "conv-1" },
    });
    expect(next.workspaces).toBe(workspaces);
    expect(next.activeId).toBe("conv-1");
    expect(next.draftWorkspaceId).toBeNull();
    expect(next.threadKey).toBe("existing-key");
    expect(commands).toEqual([]);
  });

  test("with activeId adopts it as threadKey when threadKey was empty", () => {
    const { state: next } = reduce(initialState, {
      type: "server",
      event: { kind: "workspaces", items: workspaces, activeId: "conv-1" },
    });
    expect(next.threadKey).toBe("conv-1");
  });

  test("with draftWorkspaceId resets to a fresh draft and increments draftSeq", () => {
    const state: ThreadState = {
      ...initialState,
      messages: [userMessage("u1")],
      pending: userMessage("pending-user"),
      pendingBaseUserCount: 1,
      isRunning: true,
      draftSeq: 2,
    };
    const { state: next, commands } = reduce(state, {
      type: "server",
      event: {
        kind: "workspaces",
        items: workspaces,
        activeId: null,
        draftWorkspaceId: "ws-1",
      },
    });
    expect(next.activeId).toBeNull();
    expect(next.draftWorkspaceId).toBe("ws-1");
    expect(next.messages).toEqual([]);
    expect(next.pending).toBeNull();
    expect(next.pendingBaseUserCount).toBeNull();
    expect(next.isRunning).toBe(false);
    expect(next.draftSeq).toBe(3);
    expect(next.threadKey).toBe("draft-3");
    expect(commands).toEqual([]);
  });

  test("with neither activeId nor draftWorkspaceId only clears activeId", () => {
    const state: ThreadState = { ...initialState, activeId: "conv-1" };
    const { state: next, commands } = reduce(state, {
      type: "server",
      event: { kind: "workspaces", items: workspaces, activeId: null },
    });
    expect(next.activeId).toBeNull();
    expect(next.workspaces).toBe(workspaces);
    expect(commands).toEqual([]);
  });
});

describe("reduce / server / snapshot", () => {
  test("ignored when conversationId does not match activeId", () => {
    const state: ThreadState = { ...initialState, activeId: "conv-1" };
    const { state: next, commands } = reduce(state, {
      type: "server",
      event: {
        kind: "snapshot",
        conversationId: "conv-2",
        messages: [userMessage("m1")],
        isStreaming: true,
        usage: null,
        hasMore: false,
      },
    });
    expect(next).toBe(state);
    expect(commands).toEqual([]);
  });

  test("applied when conversationId matches activeId", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      isRunning: false,
    };
    const messages = [userMessage("m0"), assistantMessage("m1")];
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "snapshot",
        conversationId: "conv-1",
        messages,
        isStreaming: true,
        usage: null,
        hasMore: true,
      },
    });
    expect(next.messages).toEqual(messages);
    expect(next.isRunning).toBe(true);
    expect(next.hasMore).toBe(true);
  });

  test("merges a tail-window snapshot without dropping loaded-older messages", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("m0"), assistantMessage("m1")],
      hasMore: false,
    };
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "snapshot",
        conversationId: "conv-1",
        messages: [assistantMessage("m1"), userMessage("m2")],
        isStreaming: false,
        usage: null,
        hasMore: true,
      },
    });
    expect(next.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(next.hasMore).toBe(true);
  });

  test("clears pending once a snapshot brings a new user message", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      pending: userMessage("pending-user"),
      pendingBaseUserCount: 1,
    };
    const messages = [userMessage("m0"), userMessage("m2")];
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "snapshot",
        conversationId: "conv-1",
        messages,
        isStreaming: false,
        usage: null,
        hasMore: false,
      },
    });
    expect(next.pending).toBeNull();
    expect(next.pendingBaseUserCount).toBeNull();
  });

  test("keeps pending when user count has not grown past the base", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      pending: userMessage("pending-user"),
      pendingBaseUserCount: 1,
    };
    const messages = [userMessage("m0")];
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "snapshot",
        conversationId: "conv-1",
        messages,
        isStreaming: false,
        usage: null,
        hasMore: false,
      },
    });
    expect(next.pending).toEqual(userMessage("pending-user"));
    expect(next.pendingBaseUserCount).toBe(1);
  });
});

describe("reduce / server / older", () => {
  test("prepends older messages and updates hasMore", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("m4"), assistantMessage("m5")],
      hasMore: true,
      loadingOlder: true,
    };
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "older",
        conversationId: "conv-1",
        messages: [userMessage("m2"), assistantMessage("m3")],
        hasMore: false,
      },
    });
    expect(next.messages.map((m) => m.id)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(next.hasMore).toBe(false);
    expect(next.loadingOlder).toBe(false);
  });

  test("ignored when conversationId does not match activeId", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      loadingOlder: true,
    };
    const { state: next, commands } = reduce(state, {
      type: "server",
      event: {
        kind: "older",
        conversationId: "conv-2",
        messages: [userMessage("m0")],
        hasMore: false,
      },
    });
    expect(next).toBe(state);
    expect(commands).toEqual([]);
  });
});

describe("reduce / loadOlder", () => {
  test("emits a loadOlder command anchored on the first message", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("m2"), assistantMessage("m3")],
      hasMore: true,
    };
    const { state: next, commands } = reduce(state, { type: "loadOlder" });
    expect(next.loadingOlder).toBe(true);
    expect(commands).toEqual([
      { kind: "loadOlder", conversationId: "conv-1", beforeId: "m2" },
    ]);
  });

  test("no-op when hasMore is false", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("m2")],
      hasMore: false,
    };
    const { state: next, commands } = reduce(state, { type: "loadOlder" });
    expect(next).toBe(state);
    expect(commands).toEqual([]);
  });

  test("no-op when already loading older", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("m2")],
      hasMore: true,
      loadingOlder: true,
    };
    const { commands } = reduce(state, { type: "loadOlder" });
    expect(commands).toEqual([]);
  });
});

describe("reduce / server / heartbeatAck", () => {
  test("is a no-op that preserves state identity", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      isRunning: true,
    };
    const { state: next, commands } = reduce(state, {
      type: "server",
      event: { kind: "heartbeatAck" },
    });
    expect(next).toBe(state);
    expect(commands).toEqual([]);
  });
});

describe("reduce / server / stream", () => {
  test("ignored when conversationId does not match activeId", () => {
    const state: ThreadState = { ...initialState, activeId: "conv-1" };
    const { state: next, commands } = reduce(state, {
      type: "server",
      event: {
        kind: "stream",
        conversationId: "conv-2",
        message: assistantMessage("a1"),
        isStreaming: true,
      },
    });
    expect(next).toBe(state);
    expect(commands).toEqual([]);
  });

  test("replaces the last message when the tail id matches it", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("u1"), { ...assistantMessage("a1"), parts: [] }],
    };
    const tail = assistantMessage("a1");
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "stream",
        conversationId: "conv-1",
        message: tail,
        isStreaming: true,
      },
    });
    expect(next.messages).toEqual([userMessage("u1"), tail]);
    expect(next.isRunning).toBe(true);
  });

  test("replaces by index when the tail id matches an earlier message", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [{ ...assistantMessage("a1"), parts: [] }, userMessage("u2")],
    };
    const tail = assistantMessage("a1");
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "stream",
        conversationId: "conv-1",
        message: tail,
        isStreaming: false,
      },
    });
    expect(next.messages).toEqual([tail, userMessage("u2")]);
  });

  test("appends when the tail id is new", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("u1")],
    };
    const tail = assistantMessage("a1");
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "stream",
        conversationId: "conv-1",
        message: tail,
        isStreaming: true,
      },
    });
    expect(next.messages).toEqual([userMessage("u1"), tail]);
  });

  test("updates isRunning without touching messages when message is null", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("u1")],
    };
    const { state: next } = reduce(state, {
      type: "server",
      event: {
        kind: "stream",
        conversationId: "conv-1",
        message: null,
        isStreaming: false,
      },
    });
    expect(next.messages).toBe(state.messages);
    expect(next.isRunning).toBe(false);
  });
});

describe("reduce / server / error", () => {
  test("clears pending and isRunning, sets error message", () => {
    const state: ThreadState = {
      ...initialState,
      pending: userMessage("pending-user"),
      pendingBaseUserCount: 0,
      isRunning: true,
    };
    const {
      state: next,
      commands,
      toasts,
    } = reduce(state, {
      type: "server",
      event: { kind: "error", message: "boom" },
    });
    expect(next.pending).toBeNull();
    expect(next.pendingBaseUserCount).toBeNull();
    expect(next.isRunning).toBe(false);
    expect(toasts).toEqual(["boom"]);
    expect(commands).toEqual([]);
  });
});

describe("reduce / prompt", () => {
  test("errors and sends no command when neither activeId nor draftWorkspaceId is set", () => {
    const {
      state: next,
      commands,
      toasts,
    } = reduce(initialState, {
      type: "prompt",
      text: "hi",
    });
    expect(toasts).toEqual(["no workspace selected for the new conversation"]);
    expect(next.pending).toBeNull();
    expect(commands).toEqual([]);
  });

  test("sends a create command and sets pending when drafting a workspace", () => {
    const state: ThreadState = { ...initialState, draftWorkspaceId: "ws-1" };
    const { state: next, commands } = reduce(state, {
      type: "prompt",
      text: "hi",
    });
    expect(commands).toEqual([
      { kind: "create", workspaceId: "ws-1", prompt: "hi" },
    ]);
    expect(next.pending).toEqual({
      id: "pending-user",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(next.pendingBaseUserCount).toBe(0);
  });

  test("sends a prompt command when a conversation is active", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("u1")],
    };
    const { state: next, commands } = reduce(state, {
      type: "prompt",
      text: "hi",
    });
    expect(commands).toEqual([{ kind: "prompt", text: "hi" }]);
    expect(next.pendingBaseUserCount).toBe(1);
  });
});

describe("reduce / cancel", () => {
  test("clears pending and sends an abort command", () => {
    const state: ThreadState = {
      ...initialState,
      pending: userMessage("pending-user"),
      pendingBaseUserCount: 2,
    };
    const { state: next, commands } = reduce(state, { type: "cancel" });
    expect(next.pending).toBeNull();
    expect(next.pendingBaseUserCount).toBeNull();
    expect(commands).toEqual([{ kind: "abort" }]);
  });
});

describe("reduce / command", () => {
  test("errors and sends no command when no conversation is active", () => {
    const { commands, toasts } = reduce(initialState, {
      type: "command",
      name: "ping",
      text: "hi",
    });
    expect(toasts).toEqual(["select a conversation first"]);
    expect(commands).toEqual([]);
  });

  test("sends a command with its text when a conversation is active", () => {
    const state: ThreadState = { ...initialState, activeId: "conv-1" };
    const { state: next, commands } = reduce(state, {
      type: "command",
      name: "ping",
      text: "hi",
    });
    expect(next).toBe(state);
    expect(commands).toEqual([{ kind: "command", name: "ping", text: "hi" }]);
  });

  test("omits text when the command has none", () => {
    const state: ThreadState = { ...initialState, activeId: "conv-1" };
    const { commands } = reduce(state, { type: "command", name: "ping" });
    expect(commands).toEqual([
      { kind: "command", name: "ping", text: undefined },
    ]);
  });
});

describe("reduce / select", () => {
  test("is a no-op when selecting the already-active conversation", () => {
    const state: ThreadState = { ...initialState, activeId: "conv-1" };
    const { state: next, commands } = reduce(state, {
      type: "select",
      conversationId: "conv-1",
    });
    expect(next).toBe(state);
    expect(commands).toEqual([]);
  });

  test("resets thread state and sends a select command for a new conversation", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      draftWorkspaceId: "ws-1",
      messages: [userMessage("u1")],
      pending: userMessage("pending-user"),
      pendingBaseUserCount: 1,
      isRunning: true,
    };
    const { state: next, commands } = reduce(state, {
      type: "select",
      conversationId: "conv-2",
    });
    expect(next.activeId).toBe("conv-2");
    expect(next.draftWorkspaceId).toBeNull();
    expect(next.threadKey).toBe("conv-2");
    expect(next.messages).toEqual([]);
    expect(next.pending).toBeNull();
    expect(next.isRunning).toBe(false);
    expect(commands).toEqual([{ kind: "select", conversationId: "conv-2" }]);
  });
});

describe("reduce / create", () => {
  test("drafts a new workspace conversation and increments the draft key", () => {
    const state: ThreadState = {
      ...initialState,
      activeId: "conv-1",
      messages: [userMessage("u1")],
      isRunning: true,
      draftSeq: 4,
    };
    const { state: next, commands } = reduce(state, {
      type: "create",
      workspaceId: "ws-2",
    });
    expect(next.activeId).toBeNull();
    expect(next.draftWorkspaceId).toBe("ws-2");
    expect(next.draftSeq).toBe(5);
    expect(next.threadKey).toBe("draft-5");
    expect(next.messages).toEqual([]);
    expect(next.isRunning).toBe(false);
    expect(commands).toEqual([{ kind: "draft" }]);
  });
});

describe("reduce / createWorkspace", () => {
  test("sends a createWorkspace command without touching state", () => {
    const { state: next, commands } = reduce(initialState, {
      type: "createWorkspace",
      label: "New workspace",
    });
    expect(next).toBe(initialState);
    expect(commands).toEqual([
      { kind: "createWorkspace", label: "New workspace" },
    ]);
  });
});

describe("reduce / updateWorkspaceCwd", () => {
  test("sends a regular updateWorkspaceCwd command without touching state", () => {
    const { state: next, commands } = reduce(initialState, {
      type: "updateWorkspaceCwd",
      workspaceId: "ws-1",
      cwd: "/tmp/new",
      worktree: null,
    });
    expect(next).toBe(initialState);
    expect(commands).toEqual([
      {
        kind: "updateWorkspaceCwd",
        workspaceId: "ws-1",
        cwd: "/tmp/new",
        worktree: null,
      },
    ]);
  });

  test("forwards worktree fields when present", () => {
    const { commands } = reduce(initialState, {
      type: "updateWorkspaceCwd",
      workspaceId: "ws-1",
      cwd: "/repo",
      worktree: { defaultBranch: "main", branchPrefix: "feat" },
    });
    expect(commands).toEqual([
      {
        kind: "updateWorkspaceCwd",
        workspaceId: "ws-1",
        cwd: "/repo",
        worktree: { defaultBranch: "main", branchPrefix: "feat" },
      },
    ]);
  });
});

describe("selectors", () => {
  test("selectView appends pending after messages", () => {
    const state: ThreadState = {
      ...initialState,
      messages: [userMessage("u1")],
      pending: userMessage("pending-user"),
    };
    expect(selectView(state)).toEqual([
      userMessage("u1"),
      userMessage("pending-user"),
    ]);
  });

  test("selectView returns messages unchanged when there is no pending", () => {
    const state: ThreadState = {
      ...initialState,
      messages: [userMessage("u1")],
    };
    expect(selectView(state)).toBe(state.messages);
  });

  test("selectIsRunning is true while isRunning or pending is set", () => {
    expect(selectIsRunning(initialState)).toBe(false);
    expect(selectIsRunning({ ...initialState, isRunning: true })).toBe(true);
    expect(
      selectIsRunning({
        ...initialState,
        pending: userMessage("pending-user"),
      }),
    ).toBe(true);
  });
});
