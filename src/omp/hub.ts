import type { Database } from "bun:sqlite";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { Result } from "neverthrow";
import type { Conversation } from "../store/schema";
import { toUiMessage, toUiMessages } from "../web/convert";
import type {
  ClientCommand,
  ServerEvent,
  WorkspaceSummary,
} from "../web/protocol";
import {
  createConversation,
  createWorkspace,
  getConversation,
  getOrCreateDefaultWorkspace,
  getWorkspace,
  listConversations,
  listWorkspaces,
  setConversationTitle,
} from "../web/store";

export interface SessionStateLike {
  messages: AgentMessage[];
  streamMessage: AgentMessage | null;
  isStreaming: boolean;
}

export interface SessionLike {
  readonly state: SessionStateLike;
  prompt(text: string): Promise<boolean>;
  abort(): Promise<unknown>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  readonly sessionName: string | undefined;
  setSessionName(name: string, source?: "auto" | "user"): Promise<boolean>;
}

export interface SessionsPort<S extends SessionLike = SessionLike> {
  get(id: string): S | undefined;
  open(id: string, opts: { cwd: string }): Promise<Result<S, string>>;
}

export interface HubSocket {
  data: { conversationId: string | null };
  send(payload: string): void;
}

export type HubDeps<S extends SessionLike = SessionLike> = {
  db: Database;
  sessions: SessionsPort<S>;
  workspaceCwd: string;
  autoTitle: (session: S, text: string) => Promise<string | null>;
};

export class Hub<S extends SessionLike = SessionLike> {
  private readonly deps: HubDeps<S>;
  private readonly allSockets = new Set<HubSocket>();
  private readonly subscribers = new Map<string, Set<HubSocket>>();
  private readonly subscribed = new Set<string>();

  constructor(deps: HubDeps<S>) {
    this.deps = deps;
  }

  async handleOpen(ws: HubSocket): Promise<void> {
    this.allSockets.add(ws);
    const active = listWorkspaces(this.deps.db)
      .flatMap((w) => listConversations(this.deps.db, w.id))
      .reduce<Conversation | undefined>(
        (newest, c) =>
          newest === undefined || c.createdAt > newest.createdAt ? c : newest,
        undefined,
      );
    if (active) {
      await this.activate(ws, active.id, active.cwd);
    } else {
      const target = getOrCreateDefaultWorkspace(
        this.deps.db,
        this.deps.workspaceCwd,
      );
      this.sendWorkspaces(ws, target.id);
    }
  }

  handleClose(ws: HubSocket): void {
    this.allSockets.delete(ws);
    if (ws.data.conversationId)
      this.subscribers.get(ws.data.conversationId)?.delete(ws);
  }

  async handleCommand(ws: HubSocket, command: ClientCommand): Promise<void> {
    if (command.kind === "prompt" || command.kind === "abort") {
      const conversationId = ws.data.conversationId;
      const session = conversationId
        ? this.deps.sessions.get(conversationId)
        : undefined;
      if (!conversationId || !session) {
        this.sendError(ws, "no active conversation; retry once connected");
        return;
      }
      if (command.kind === "prompt") {
        await this.runPrompt(ws, conversationId, session, command.text);
      } else {
        const error = await session
          .abort()
          .then(() => undefined)
          .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        if (error) this.sendError(ws, error);
      }
      return;
    }

    if (command.kind === "draft") {
      this.detach(ws);
      this.sendWorkspaces(ws);
      return;
    }

    if (command.kind === "select") {
      const conversation = getConversation(
        this.deps.db,
        command.conversationId,
      );
      const target = conversation
        ? getWorkspace(this.deps.db, conversation.workspaceId)
        : undefined;
      if (!conversation || !target || target.platform !== "web") {
        this.sendError(ws, `unknown conversation: ${command.conversationId}`);
        return;
      }
      await this.activate(ws, conversation.id, conversation.cwd);
      return;
    }

    if (command.kind === "createWorkspace") {
      const created = createWorkspace(this.deps.db, {
        cwd: this.deps.workspaceCwd,
        label: command.label,
      });
      this.detach(ws);
      this.sendWorkspaces(ws, created.id);
      for (const other of this.allSockets)
        if (other !== ws) this.sendWorkspaces(other);
      return;
    }

    const target = getWorkspace(this.deps.db, command.workspaceId);
    if (target?.platform !== "web") {
      this.sendError(ws, `unknown workspace: ${command.workspaceId}`);
      return;
    }
    const created = createConversation(this.deps.db, {
      workspaceId: target.id,
      cwd: target.cwd,
      title: null,
    });
    const error = await this.ensureOpen(created.id, created.cwd);
    if (error) {
      this.sendError(ws, error);
      return;
    }
    this.attach(ws, created.id);
    this.sendWorkspaces(ws);
    for (const other of this.allSockets)
      if (other !== ws) this.sendWorkspaces(other);
    if (command.prompt) {
      const session = this.deps.sessions.get(created.id);
      if (session) {
        await this.runPrompt(ws, created.id, session, command.prompt);
      } else {
        this.sendError(
          ws,
          "conversation session unavailable; retry your message",
        );
      }
      return;
    }
    const snap = this.snapshotFor(created.id);
    if (snap) ws.send(JSON.stringify(snap));
  }

  private workspaceTree(): WorkspaceSummary[] {
    return listWorkspaces(this.deps.db).map((w) => ({
      id: w.id,
      label: w.label,
      conversations: listConversations(this.deps.db, w.id).map((c) => ({
        id: c.id,
        title: c.title,
      })),
    }));
  }

  private snapshotFor(conversationId: string): ServerEvent | undefined {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return undefined;
    const state = session.state;
    const stream = state.streamMessage ? [state.streamMessage] : [];
    return {
      kind: "snapshot",
      conversationId,
      messages: toUiMessages([...state.messages, ...stream]),
      isStreaming: state.isStreaming,
    };
  }

  private pushSnapshot(conversationId: string): void {
    const event = this.snapshotFor(conversationId);
    if (!event) return;
    const payload = JSON.stringify(event);
    for (const ws of this.subscribers.get(conversationId) ?? [])
      ws.send(payload);
  }

  private streamFor(conversationId: string): ServerEvent | undefined {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return undefined;
    const state = session.state;
    const tail = state.streamMessage;
    const message = tail
      ? (toUiMessage(tail, state.messages.length) ?? null)
      : null;
    return {
      kind: "stream",
      conversationId,
      message,
      isStreaming: state.isStreaming,
    };
  }

  private pushStream(conversationId: string): void {
    const event = this.streamFor(conversationId);
    if (!event) return;
    const payload = JSON.stringify(event);
    for (const ws of this.subscribers.get(conversationId) ?? [])
      ws.send(payload);
  }

  private dispatch(conversationId: string, event: AgentSessionEvent): void {
    if (event.type === "message_update") this.pushStream(conversationId);
    else this.pushSnapshot(conversationId);
  }

  private async ensureOpen(
    conversationId: string,
    conversationCwd: string,
  ): Promise<string | undefined> {
    const opened = await this.deps.sessions.open(conversationId, {
      cwd: conversationCwd,
    });
    if (opened.isErr()) return opened.error;
    if (!this.subscribed.has(conversationId)) {
      this.subscribed.add(conversationId);
      opened.value.subscribe((event) => this.dispatch(conversationId, event));
    }
    return undefined;
  }

  private attach(ws: HubSocket, conversationId: string): void {
    if (ws.data.conversationId)
      this.subscribers.get(ws.data.conversationId)?.delete(ws);
    ws.data.conversationId = conversationId;
    let set = this.subscribers.get(conversationId);
    if (!set) {
      set = new Set();
      this.subscribers.set(conversationId, set);
    }
    set.add(ws);
  }

  private detach(ws: HubSocket): void {
    if (ws.data.conversationId)
      this.subscribers.get(ws.data.conversationId)?.delete(ws);
    ws.data.conversationId = null;
  }

  private sendWorkspaces(ws: HubSocket, draftWorkspaceId?: string): void {
    const event: ServerEvent = {
      kind: "workspaces",
      items: this.workspaceTree(),
      activeId: ws.data.conversationId,
      ...(draftWorkspaceId ? { draftWorkspaceId } : {}),
    };
    ws.send(JSON.stringify(event));
  }

  private sendError(ws: HubSocket, message: string): void {
    const event: ServerEvent = { kind: "error", message };
    ws.send(JSON.stringify(event));
  }

  private async activate(
    ws: HubSocket,
    conversationId: string,
    conversationCwd: string,
  ): Promise<void> {
    const error = await this.ensureOpen(conversationId, conversationCwd);
    if (error) {
      this.sendError(ws, error);
      return;
    }
    this.attach(ws, conversationId);
    this.sendWorkspaces(ws);
    const snap = this.snapshotFor(conversationId);
    if (snap) ws.send(JSON.stringify(snap));
  }

  private async maybeAutoTitle(
    conversationId: string,
    session: S,
    text: string,
  ): Promise<void> {
    if (getConversation(this.deps.db, conversationId)?.title != null) return;
    const title = await this.deps.autoTitle(session, text).catch(() => null);
    if (!title) return;
    if (!setConversationTitle(this.deps.db, conversationId, title)) return;
    if (!session.sessionName) {
      await session.setSessionName(title, "auto").catch((e: unknown) => {
        console.error(`title sync to omp session failed: ${e}`);
      });
    }
    for (const ws of this.allSockets) this.sendWorkspaces(ws);
  }

  private async runPrompt(
    ws: HubSocket,
    conversationId: string,
    session: S,
    text: string,
  ): Promise<void> {
    void this.maybeAutoTitle(conversationId, session, text).catch(
      (e: unknown) => {
        console.error(`auto-title failed: ${e}`);
      },
    );
    const error = await session
      .prompt(text)
      .then(() => undefined)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (error) this.sendError(ws, error);
  }
}
