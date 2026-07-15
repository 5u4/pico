import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { err, ok, type Result } from "neverthrow";
import {
  Engine,
  type SessionLike,
  type SessionStateLike,
  type SessionsPort,
} from "../../engine/conversations";
import {
  createConversation,
  getConversation,
  getOrCreateDefaultWorkspace,
  listConversations,
  listWorkspaces,
} from "../../engine/registry";
import { openDb } from "../../store/db";
import { type HubSocket, WebHub } from "./adapter";
import type { ServerEvent } from "./protocol";

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

  contextUsage:
    | { tokens: number; contextWindow: number; percent: number }
    | undefined = undefined;
  contextBreakdown = {
    systemPromptTokens: 0,
    systemToolsTokens: 0,
    systemContextTokens: 0,
    skillsTokens: 0,
    messagesTokens: 0,
  };
  cost = 0;

  getContextUsage() {
    return this.contextUsage;
  }

  getContextBreakdown() {
    return this.contextBreakdown;
  }

  getSessionStats() {
    return { cost: this.cost };
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
  private readonly waiters: {
    kind: ServerEvent["kind"];
    resolve: (event: ServerEvent) => void;
  }[] = [];

  send(payload: string): void {
    const event = JSON.parse(payload) as ServerEvent;
    this.sent.push(event);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i];
      if (waiter && waiter.kind === event.kind) {
        this.waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  }

  waitFor(kind: ServerEvent["kind"]): Promise<ServerEvent> {
    const existing = this.sent.find((event) => event.kind === kind);
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<ServerEvent>();
    this.waiters.push({ kind, resolve });
    return promise;
  }
}

function makeHub(
  autoTitle: (
    session: FakeSession,
    text: string,
  ) => Promise<string | null> = async () => null,
) {
  const db: Database = openDb(":memory:");
  const workspace = getOrCreateDefaultWorkspace(
    db,
    "web",
    WORKSPACE_CWD,
    "web",
  );
  const sessions = new FakeSessions();
  const engine = new Engine<FakeSession>({ db, sessions, autoTitle });
  const hub = new WebHub<FakeSession>({
    db,
    engine,
    workspaceCwd: WORKSPACE_CWD,
  });
  return { db, workspace, sessions, hub };
}

describe("WebHub.handleOpen", () => {
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

  test("with an existing conversation sends workspaces without a draft and defers activation to the client", () => {
    const { hub, db, workspace } = makeHub();
    createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const ws = new FakeSocket();

    hub.handleOpen(ws);

    expect(ws.sent.map((e) => e.kind)).toEqual(["workspaces"]);
    const event = ws.sent[0];
    if (event?.kind === "workspaces") {
      expect(event.activeId).toBeNull();
      expect(event.draftWorkspaceId).toBeUndefined();
    }
    expect(ws.data.conversationId).toBeNull();
  });
});

describe("WebHub.handleCommand select", () => {
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

describe("WebHub.handleCommand create", () => {
  test("creates a conversation row and broadcasts workspaces to the socket", async () => {
    const { hub, db, workspace } = makeHub();
    const ws = new FakeSocket();

    await hub.handleCommand(ws, { kind: "create", workspaceId: workspace.id });

    const rows = listConversations(db, workspace.id);
    expect(rows).toHaveLength(1);
    expect(ws.data.conversationId).toBe(rows[0]?.id ?? null);
    expect(ws.sent.some((e) => e.kind === "workspaces")).toBe(true);
  });

  test("with a prompt runs it on the freshly opened session", async () => {
    const { hub, db, workspace, sessions } = makeHub();
    const ws = new FakeSocket();

    await hub.handleCommand(ws, {
      kind: "create",
      workspaceId: workspace.id,
      prompt: "kick off",
    });

    const created = listConversations(db, workspace.id)[0];
    expect(created).toBeDefined();
    if (created) {
      expect(sessions.get(created.id)?.promptCalls).toEqual(["kick off"]);
    }
  });
});

describe("WebHub.handleCommand createWorkspace", () => {
  test("creates a workspace row and broadcasts to every other socket", async () => {
    const { hub, db } = makeHub();
    const ws = new FakeSocket();
    const other = new FakeSocket();
    await hub.handleOpen(other);
    other.sent.length = 0;

    await hub.handleCommand(ws, { kind: "createWorkspace", label: "New" });

    const workspaces = listWorkspaces(db, "web");
    expect(workspaces.some((w) => w.label === "New")).toBe(true);
    expect(ws.sent[0]?.kind).toBe("workspaces");
    expect(other.sent[0]?.kind).toBe("workspaces");
  });
});

describe("WebHub.handleCommand prompt/abort", () => {
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

describe("WebHub session event dispatch", () => {
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

  test("a snapshot broadcast carries context usage computed from the session", async () => {
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
    if (!session) return;
    session.contextUsage = { tokens: 3200, contextWindow: 400000, percent: 1 };
    session.contextBreakdown = {
      systemPromptTokens: 100,
      systemToolsTokens: 200,
      systemContextTokens: 300,
      skillsTokens: 400,
      messagesTokens: 2200,
    };
    session.cost = 0.42;

    session.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);

    const event = ws.sent[0];
    expect(event?.kind).toBe("snapshot");
    if (event?.kind !== "snapshot") return;
    expect(event.usage).toEqual({
      tokens: 3200,
      contextWindow: 400000,
      percent: 1,
      cost: 0.42,
      breakdown: {
        systemPrompt: 100,
        systemTools: 200,
        systemContext: 300,
        skills: 400,
        messages: 2200,
      },
    });
  });

  test("a snapshot broadcast carries null usage before any turn", async () => {
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

    const event = ws.sent[0];
    expect(event?.kind).toBe("snapshot");
    if (event?.kind !== "snapshot") return;
    expect(event.usage).toBeNull();
  });
});

describe("WebHub session open failure", () => {
  test("select on a session that fails to open sends the open error", async () => {
    const { hub, db, workspace, sessions } = makeHub();
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    sessions.failOpen.set(conversation.id, "disk on fire");
    const ws = new FakeSocket();

    await hub.handleCommand(ws, {
      kind: "select",
      conversationId: conversation.id,
    });

    expect(ws.sent).toEqual([{ kind: "error", message: "disk on fire" }]);
    expect(ws.data.conversationId).toBeNull();
  });
});

describe("WebHub auto-title", () => {
  test("a generated title is persisted and broadcast to every socket", async () => {
    const { hub, db, workspace, sessions } = makeHub(
      async () => "Fix the parser",
    );
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const ws = new FakeSocket();
    hub.handleOpen(ws);
    await hub.handleCommand(ws, {
      kind: "select",
      conversationId: conversation.id,
    });
    ws.sent.length = 0;

    await hub.handleCommand(ws, {
      kind: "prompt",
      text: "the parser is broken",
    });
    await ws.waitFor("workspaces");

    expect(getConversation(db, conversation.id)?.title).toBe("Fix the parser");
    expect(sessions.get(conversation.id)?.setSessionNameCalls).toEqual([
      { name: "Fix the parser", source: "auto" },
    ]);
  });
});

describe("WebHub concurrent activation", () => {
  test("two sockets activating one conversation share a single bridge", async () => {
    const { hub, db, workspace, sessions } = makeHub();
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      title: null,
    });
    const a = new FakeSocket();
    const b = new FakeSocket();

    await Promise.all([
      hub.handleCommand(a, {
        kind: "select",
        conversationId: conversation.id,
      }),
      hub.handleCommand(b, {
        kind: "select",
        conversationId: conversation.id,
      }),
    ]);
    a.sent.length = 0;
    b.sent.length = 0;

    sessions
      .get(conversation.id)
      ?.emit({ type: "message_update" } as unknown as AgentSessionEvent);

    expect(a.sent.filter((e) => e.kind === "stream")).toHaveLength(1);
    expect(b.sent.filter((e) => e.kind === "stream")).toHaveLength(1);
  });
});
