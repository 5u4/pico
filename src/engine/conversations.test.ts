import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { err, ok, type Result } from "neverthrow";
import { openDb } from "../store/db";
import {
  Engine,
  type SessionLike,
  type SessionStateLike,
  type SessionsPort,
  type TurnEvent,
} from "./conversations";
import {
  createConversation,
  getConversation,
  getOrCreateDefaultWorkspace,
} from "./registry";

const CWD = "/tmp/pico-engine-test";

class FakeSession implements SessionLike {
  state: SessionStateLike = {
    messages: [],
    streamMessage: null,
    isStreaming: false,
  };
  sessionName: string | undefined;
  readonly setSessionNameCalls: { name: string; source?: string }[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  replyText = "I fixed the broken parser.";

  prompt(text: string): Promise<boolean> {
    this.state.messages.push({
      role: "user",
      content: text,
      timestamp: Date.now(),
    } as (typeof this.state.messages)[number]);
    this.state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: this.replyText }],
      timestamp: Date.now(),
    } as (typeof this.state.messages)[number]);
    return Promise.resolve(true);
  }

  readonly customMessages: { customType: string; content: string }[] = [];

  sendCustomMessage(
    message: { customType: string; content: string; display: boolean },
    _options: { triggerTurn: false },
  ): Promise<boolean> {
    this.customMessages.push({
      customType: message.customType,
      content: message.content,
    });
    this.state.messages.push({
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      timestamp: Date.now(),
    } as (typeof this.state.messages)[number]);
    return Promise.resolve(false);
  }

  readonly sessionManager = {
    ensureOnDiskCalls: 0,
    ensureOnDisk(): Promise<void> {
      this.ensureOnDiskCalls++;
      return Promise.resolve();
    },
  };

  abort(): Promise<unknown> {
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

  open(id: string): Promise<Result<FakeSession, string>> {
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

function makeEngine() {
  const db = openDb(":memory:");
  const workspace = getOrCreateDefaultWorkspace(db, "web", CWD, "web");
  const conversation = createConversation(db, {
    workspaceId: workspace.id,
    cwd: CWD,
    title: null,
  });
  const sessions = new FakeSessions();
  const engine = new Engine<FakeSession>({
    db,
    sessions,
    autoTitle: async () => null,
  });
  return { db, engine, sessions, conversationId: conversation.id };
}

describe("Engine.subscribe lazy open", () => {
  test("opening a fresh conversation resolves without error and constructs a session", async () => {
    const { engine, sessions, conversationId } = makeEngine();
    const { opened } = engine.subscribe(conversationId, CWD, "live", () => {});
    expect((await opened).isOk()).toBe(true);
    expect(sessions.get(conversationId)).toBeDefined();
  });

  test("open failure surfaces as the resolved error", async () => {
    const { engine, sessions, conversationId } = makeEngine();
    sessions.failOpen.set(conversationId, "disk on fire");
    const { opened } = engine.subscribe(conversationId, CWD, "live", () => {});
    const result = await opened;
    expect(result.isErr() && result.error).toBe("disk on fire");
  });
});

describe("Engine subscribe mode filtering", () => {
  test("live receives deltas and every snapshot", async () => {
    const { engine, sessions, conversationId } = makeEngine();
    const events: TurnEvent[] = [];
    const { opened } = engine.subscribe(conversationId, CWD, "live", (e) =>
      events.push(e),
    );
    await opened;
    const session = sessions.get(conversationId);
    if (!session) throw new Error("session missing");

    session.state.isStreaming = true;
    session.emit({ type: "message_update" } as unknown as AgentSessionEvent);
    session.state.isStreaming = false;
    session.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);

    expect(events.map((e) => e.kind)).toEqual(["delta", "snapshot"]);
  });

  test("settled receives only settled snapshots, never deltas or streaming snapshots", async () => {
    const { engine, sessions, conversationId } = makeEngine();
    const events: TurnEvent[] = [];
    const { opened } = engine.subscribe(conversationId, CWD, "settled", (e) =>
      events.push(e),
    );
    await opened;
    const session = sessions.get(conversationId);
    if (!session) throw new Error("session missing");

    session.state.isStreaming = true;
    session.emit({ type: "message_update" } as unknown as AgentSessionEvent);
    session.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
    session.state.isStreaming = false;
    session.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);

    expect(events.map((e) => e.kind)).toEqual(["snapshot"]);
    const only = events[0];
    expect(only?.kind === "snapshot" && only.streaming).toBe(false);
  });
});

describe("Engine.prompt", () => {
  test("lazily opens then runs on the session", async () => {
    const { engine, sessions, conversationId } = makeEngine();
    const result = await engine.prompt(conversationId, CWD, "hi");
    expect(result.isOk()).toBe(true);
    expect(sessions.get(conversationId)).toBeDefined();
  });

  test("returns the open error without prompting", async () => {
    const { engine, sessions, conversationId } = makeEngine();
    sessions.failOpen.set(conversationId, "no model");
    const result = await engine.prompt(conversationId, CWD, "hi");
    expect(result.isErr() && result.error).toBe("no model");
  });
});

describe("Engine.record", () => {
  test("appends a custom message and broadcasts a snapshot", async () => {
    const { engine, sessions, conversationId } = makeEngine();
    const events: TurnEvent[] = [];
    const { opened } = engine.subscribe(conversationId, CWD, "live", (e) =>
      events.push(e),
    );
    await opened;
    events.length = 0;

    const result = await engine.record(
      conversationId,
      CWD,
      "command:ping",
      "Pong hi",
    );
    expect(result.isOk()).toBe(true);

    const session = sessions.get(conversationId);
    expect(session?.customMessages).toEqual([
      { customType: "command:ping", content: "Pong hi" },
    ]);
    expect(session?.sessionManager.ensureOnDiskCalls).toBe(1);

    const snapshot = events.find((e) => e.kind === "snapshot");
    expect(snapshot).toBeDefined();
    if (snapshot?.kind !== "snapshot") throw new Error("expected snapshot");
    expect(snapshot.messages).toContainEqual({
      id: "m0",
      role: "system",
      parts: [{ type: "text", text: "Pong hi" }],
    });
  });

  test("returns the open error without recording", async () => {
    const { engine, sessions, conversationId } = makeEngine();
    sessions.failOpen.set(conversationId, "no model");
    const result = await engine.record(
      conversationId,
      CWD,
      "command:ping",
      "Pong",
    );
    expect(result.isErr() && result.error).toBe("no model");
  });
});

function titleWaiter(want: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const titles: string[] = [];
  const listener = (event: TurnEvent) => {
    if (event.kind !== "title") return;
    titles.push(event.title);
    if (event.title === want) resolve();
  };
  return { titles, listener, done: promise };
}

describe("Engine auto-title", () => {
  test("emits the final title and syncs it to the session after the turn", async () => {
    const db = openDb(":memory:");
    const workspace = getOrCreateDefaultWorkspace(db, "web", CWD, "web");
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: CWD,
      title: null,
    });
    const sessions = new FakeSessions();
    const engine = new Engine<FakeSession>({
      db,
      sessions,
      autoTitle: () => Promise.resolve("Fix the parser"),
    });
    const w = titleWaiter("Fix the parser");
    const { opened } = engine.subscribe(
      conversation.id,
      CWD,
      "live",
      w.listener,
    );
    await opened;

    await engine.prompt(conversation.id, CWD, "the parser is broken");
    await w.done;

    expect(getConversation(db, conversation.id)?.title).toBe("Fix the parser");
    expect(sessions.get(conversation.id)?.setSessionNameCalls).toEqual([
      { name: "Fix the parser", source: "auto" },
    ]);
  });

  test("shows a provisional truncated title first, then overwrites it", async () => {
    const db = openDb(":memory:");
    const workspace = getOrCreateDefaultWorkspace(db, "web", CWD, "web");
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: CWD,
      title: null,
    });
    const sessions = new FakeSessions();
    const engine = new Engine<FakeSession>({
      db,
      sessions,
      autoTitle: () => Promise.resolve("Fix the parser"),
    });
    const w = titleWaiter("Fix the parser");
    const { opened } = engine.subscribe(
      conversation.id,
      CWD,
      "live",
      w.listener,
    );
    await opened;

    await engine.prompt(conversation.id, CWD, "the parser is broken");
    await w.done;

    expect(w.titles).toEqual(["the parser is broken", "Fix the parser"]);
    expect(getConversation(db, conversation.id)?.title).toBe("Fix the parser");
  });

  test("feeds both the prompt and the assistant reply into title generation", async () => {
    const db = openDb(":memory:");
    const workspace = getOrCreateDefaultWorkspace(db, "web", CWD, "web");
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: CWD,
      title: null,
    });
    const sessions = new FakeSessions();
    let captured = "";
    const engine = new Engine<FakeSession>({
      db,
      sessions,
      autoTitle: (_session, text) => {
        captured = text;
        return Promise.resolve("Parser fixed");
      },
    });
    const w = titleWaiter("Parser fixed");
    const { opened } = engine.subscribe(
      conversation.id,
      CWD,
      "live",
      w.listener,
    );
    await opened;

    await engine.prompt(conversation.id, CWD, "the parser is broken");
    await w.done;

    expect(captured).toContain("the parser is broken");
    expect(captured).toContain("I fixed the broken parser.");
  });

  test("keeps the provisional title when the LLM declines to title", async () => {
    const db = openDb(":memory:");
    const workspace = getOrCreateDefaultWorkspace(db, "web", CWD, "web");
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: CWD,
      title: null,
    });
    const sessions = new FakeSessions();
    const { promise: attempted, resolve } = Promise.withResolvers<void>();
    const engine = new Engine<FakeSession>({
      db,
      sessions,
      autoTitle: () => {
        resolve();
        return Promise.resolve(null);
      },
    });
    const { opened } = engine.subscribe(conversation.id, CWD, "live", () => {});
    await opened;

    await engine.prompt(conversation.id, CWD, "hi");
    expect(getConversation(db, conversation.id)?.title).toBe("hi");
    await attempted;
    await Promise.resolve();

    expect(getConversation(db, conversation.id)?.title).toBe("hi");
    expect(sessions.get(conversation.id)?.setSessionNameCalls).toEqual([]);
  });

  test("skips session sync and broadcast when the conversation vanished", async () => {
    const db = openDb(":memory:");
    const workspace = getOrCreateDefaultWorkspace(db, "web", CWD, "web");
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: CWD,
      title: null,
    });
    const sessions = new FakeSessions();
    const { promise: attempted, resolve } = Promise.withResolvers<void>();
    const engine = new Engine<FakeSession>({
      db,
      sessions,
      autoTitle: () => {
        db.query("DELETE FROM conversations WHERE id = $id").run({
          id: conversation.id,
        });
        resolve();
        return Promise.resolve("Fix the parser");
      },
    });
    const events: TurnEvent[] = [];
    const { opened } = engine.subscribe(conversation.id, CWD, "live", (e) =>
      events.push(e),
    );
    await opened;

    await engine.prompt(conversation.id, CWD, "the parser is broken");
    await attempted;
    await Promise.resolve();

    expect(
      events.some((e) => e.kind === "title" && e.title === "Fix the parser"),
    ).toBe(false);
    expect(sessions.get(conversation.id)?.setSessionNameCalls).toEqual([]);
  });

  test("titles only on the first turn of a conversation", async () => {
    const db = openDb(":memory:");
    const workspace = getOrCreateDefaultWorkspace(db, "web", CWD, "web");
    const conversation = createConversation(db, {
      workspaceId: workspace.id,
      cwd: CWD,
      title: null,
    });
    const sessions = new FakeSessions();
    let calls = 0;
    const engine = new Engine<FakeSession>({
      db,
      sessions,
      autoTitle: () => {
        calls++;
        return Promise.resolve("Fix the parser");
      },
    });
    const w = titleWaiter("Fix the parser");
    const { opened } = engine.subscribe(
      conversation.id,
      CWD,
      "live",
      w.listener,
    );
    await opened;

    await engine.prompt(conversation.id, CWD, "the parser is broken");
    await w.done;
    await engine.prompt(conversation.id, CWD, "still broken");
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(sessions.get(conversation.id)?.setSessionNameCalls).toEqual([
      { name: "Fix the parser", source: "auto" },
    ]);
  });
});
