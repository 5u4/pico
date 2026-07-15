import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { err, ok, type Result } from "neverthrow";
import { openDb } from "../store/db";
import type { ServerEvent } from "../web/protocol";
import {
  createConversation,
  getOrCreateDefaultWorkspace,
  listConversations,
  listWorkspaces,
} from "../web/store";
import {
  Hub,
  type HubSocket,
  type SessionLike,
  type SessionStateLike,
  type SessionsPort,
} from "./hub";

const WORKSPACE_CWD = "/tmp/pico-web-test";

class FakeSession implements SessionLike {
  state: SessionStateLike = {
    messages: [],
    streamMessage: null,
    isStreaming: false,
  };
  readonly promptCalls: string[] = [];
  abortCalls = 0;
  sessionName: string | undefined;
  readonly setSessionNameCalls: {
    name: string;
    source?: "auto" | "user";
  }[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  prompt(text: string): Promise<boolean> {
    this.promptCalls.push(text);
    return Promise.resolve(true);
  }

  abort(): Promise<unknown> {
    this.abortCalls++;
    return Promise.resolve(undefined);
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSessionName(name: string, source?: "auto" | "user"): Promise<boolean> {
    this.setSessionNameCalls.push({ name, source });
    this.sessionName = name;
    return Promise.resolve(true);
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeSessions implements SessionsPort<FakeSession> {
  readonly sessions = new Map<string, FakeSession>();
  readonly failOpen = new Map<string, string>();

  get(id: string): FakeSession | undefined {
    return this.sessions.get(id);
  }

  open(
    id: string,
    _opts: { cwd: string },
  ): Promise<Result<FakeSession, string>> {
    const failure = this.failOpen.get(id);
    if (failure) return Promise.resolve(err(failure));
    let session = this.sessions.get(id);
    if (!session) {
      session = new FakeSession();
      this.sessions.set(id, session);
    }
    return Promise.resolve(ok(session));
  }
}

class FakeSocket implements HubSocket {
  data: { conversationId: string | null } = { conversationId: null };
  readonly sent: ServerEvent[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as ServerEvent);
  }
}

function makeHub() {
  const db: Database = openDb(":memory:");
  const workspace = getOrCreateDefaultWorkspace(db, WORKSPACE_CWD);
  const sessions = new FakeSessions();
  const hub = new Hub<FakeSession>({
    db,
    sessions,
    workspaceCwd: WORKSPACE_CWD,
    autoTitle: async () => null,
  });
  return { db, workspace, sessions, hub };
}

describe("Hub.handleOpen", () => {
  test("with no conversations sends a workspaces event with draftWorkspaceId", async () => {
    const { hub, workspace } = makeHub();
    const ws = new FakeSocket();

    await hub.handleOpen(ws);

    expect(ws.sent).toHaveLength(1);
    const event = ws.sent[0];
    expect(event?.kind).toBe("workspaces");
    if (event?.kind === "workspaces") {
      expect(event.draftWorkspaceId).toBe(workspace.id);
      expect(event.activeId).toBeNull();
    }
  });

  test("with an existing conversation activates it and sends workspaces then snapshot", async () => {
    const { hub, db, workspace } = makeHub();
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const ws = new FakeSocket();

    await hub.handleOpen(ws);

    expect(ws.sent.map((e) => e.kind)).toEqual(["workspaces", "snapshot"]);
    expect(ws.data.conversationId).toBe(conversation.id);
  });
});

describe("Hub.handleCommand select", () => {
  test("unknown conversation id sends an error", async () => {
    const { hub } = makeHub();
    const ws = new FakeSocket();

    await hub.handleCommand(ws, { kind: "select", conversationId: "missing" });

    expect(ws.sent).toEqual([
      { kind: "error", message: "unknown conversation: missing" },
    ]);
  });

  test("valid conversation id activates and broadcasts a snapshot", async () => {
    const { hub, db, workspace } = makeHub();
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const ws = new FakeSocket();

    await hub.handleCommand(ws, {
      kind: "select",
      conversationId: conversation.id,
    });

    expect(ws.sent.map((e) => e.kind)).toEqual(["workspaces", "snapshot"]);
    expect(ws.data.conversationId).toBe(conversation.id);
  });
});

describe("Hub.handleCommand create", () => {
  test("creates a conversation row and broadcasts workspaces to the socket", async () => {
    const { hub, db, workspace } = makeHub();
    const ws = new FakeSocket();

    await hub.handleCommand(ws, { kind: "create", workspaceId: workspace.id });

    const rows = listConversations(db, workspace.id);
    expect(rows).toHaveLength(1);
    expect(ws.data.conversationId).toBe(rows[0]?.id ?? null);
    expect(ws.sent.some((e) => e.kind === "workspaces")).toBe(true);
  });
});

describe("Hub.handleCommand createWorkspace", () => {
  test("creates a workspace row and broadcasts to every other socket", async () => {
    const { hub, db } = makeHub();
    const ws = new FakeSocket();
    const other = new FakeSocket();
    await hub.handleOpen(other);
    other.sent.length = 0;

    await hub.handleCommand(ws, { kind: "createWorkspace", label: "New" });

    const workspaces = listWorkspaces(db);
    expect(workspaces.some((w) => w.label === "New")).toBe(true);
    expect(ws.sent[0]?.kind).toBe("workspaces");
    expect(other.sent[0]?.kind).toBe("workspaces");
  });
});

describe("Hub.handleCommand prompt/abort", () => {
  test("prompt with no active conversation sends an error", async () => {
    const { hub } = makeHub();
    const ws = new FakeSocket();

    await hub.handleCommand(ws, { kind: "prompt", text: "hi" });

    expect(ws.sent).toEqual([
      {
        kind: "error",
        message: "no active conversation; retry once connected",
      },
    ]);
  });

  test("prompt on an active session calls session.prompt with the text", async () => {
    const { hub, db, workspace, sessions } = makeHub();
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const ws = new FakeSocket();
    await hub.handleCommand(ws, {
      kind: "select",
      conversationId: conversation.id,
    });

    await hub.handleCommand(ws, { kind: "prompt", text: "hello world" });

    expect(sessions.get(conversation.id)?.promptCalls).toEqual(["hello world"]);
  });

  test("abort calls session.abort", async () => {
    const { hub, db, workspace, sessions } = makeHub();
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const ws = new FakeSocket();
    await hub.handleCommand(ws, {
      kind: "select",
      conversationId: conversation.id,
    });

    await hub.handleCommand(ws, { kind: "abort" });

    expect(sessions.get(conversation.id)?.abortCalls).toBe(1);
  });
});

describe("Hub session event dispatch", () => {
  test("a message_update event pushes a stream broadcast to subscribers", async () => {
    const { hub, db, workspace, sessions } = makeHub();
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const ws = new FakeSocket();
    await hub.handleCommand(ws, {
      kind: "select",
      conversationId: conversation.id,
    });
    ws.sent.length = 0;
    const session = sessions.get(conversation.id);
    expect(session).toBeDefined();

    session?.emit({ type: "message_update" } as unknown as AgentSessionEvent);

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]?.kind).toBe("stream");
  });

  test("a non message_update event pushes a snapshot broadcast to subscribers", async () => {
    const { hub, db, workspace, sessions } = makeHub();
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const ws = new FakeSocket();
    await hub.handleCommand(ws, {
      kind: "select",
      conversationId: conversation.id,
    });
    ws.sent.length = 0;
    const session = sessions.get(conversation.id);
    expect(session).toBeDefined();

    session?.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]?.kind).toBe("snapshot");
  });
});
