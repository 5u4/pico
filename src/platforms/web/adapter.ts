import type { Database } from "bun:sqlite";
import type {
  Engine,
  SessionLike,
  TurnEvent,
} from "../../engine/conversations";
import {
  archiveConversation,
  createConversation,
  createWorkspace,
  getConversation,
  getOrCreateDefaultWorkspace,
  getWorkspace,
  listConversations,
  listWorkspaces,
} from "../../engine/registry";
import type { Platform } from "../../store/schema";
import type { ClientCommand, ServerEvent, WorkspaceSummary } from "./protocol";

const PLATFORM: Platform = "web";
const DEFAULT_LABEL = "default";

export interface HubSocket {
  data: { conversationId: string | null };
  send(payload: string): void;
}

export type WebHubDeps<S extends SessionLike = SessionLike> = {
  db: Database;
  engine: Engine<S>;
  workspaceCwd: string;
};

export class WebHub<S extends SessionLike = SessionLike> {
  private readonly deps: WebHubDeps<S>;
  private readonly allSockets = new Set<HubSocket>();
  private readonly viewers = new Map<string, Set<HubSocket>>();
  private readonly bridges = new Map<
    string,
    { opened: Promise<string | undefined>; unsubscribe: () => void }
  >();

  constructor(deps: WebHubDeps<S>) {
    this.deps = deps;
  }

  handleOpen(ws: HubSocket): void {
    this.allSockets.add(ws);
    const target = getOrCreateDefaultWorkspace(
      this.deps.db,
      PLATFORM,
      this.deps.workspaceCwd,
      DEFAULT_LABEL,
    );
    const hasConversations = listWorkspaces(this.deps.db, PLATFORM).some(
      (w) => listConversations(this.deps.db, w.id).length > 0,
    );
    this.sendWorkspaces(ws, hasConversations ? undefined : target.id);
  }

  handleClose(ws: HubSocket): void {
    this.allSockets.delete(ws);
    this.detach(ws);
  }

  async handleCommand(ws: HubSocket, command: ClientCommand): Promise<void> {
    if (command.kind === "prompt" || command.kind === "abort") {
      const conversationId = ws.data.conversationId;
      const conversation = conversationId
        ? getConversation(this.deps.db, conversationId)
        : undefined;
      if (!conversationId || !conversation) {
        this.sendError(ws, "no active conversation; retry once connected");
        return;
      }
      const error =
        command.kind === "prompt"
          ? await this.deps.engine.prompt(
              conversationId,
              conversation.cwd,
              command.text,
            )
          : await this.deps.engine.abort(conversationId);
      if (error) this.sendError(ws, error);
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
      if (!conversation || target?.platform !== PLATFORM) {
        this.sendError(ws, `unknown conversation: ${command.conversationId}`);
        return;
      }
      await this.activate(ws, conversation.id, conversation.cwd);
      return;
    }

    if (command.kind === "createWorkspace") {
      const created = createWorkspace(this.deps.db, {
        cwd: this.deps.workspaceCwd,
        platform: PLATFORM,
        label: command.label,
      });
      this.detach(ws);
      this.sendWorkspaces(ws, created.id);
      for (const other of this.allSockets)
        if (other !== ws) this.sendWorkspaces(other);
      return;
    }

    if (command.kind === "archive") {
      const conversation = getConversation(
        this.deps.db,
        command.conversationId,
      );
      const target = conversation
        ? getWorkspace(this.deps.db, conversation.workspaceId)
        : undefined;
      if (!conversation || target?.platform !== PLATFORM) {
        this.sendError(ws, `unknown conversation: ${command.conversationId}`);
        return;
      }
      archiveConversation(this.deps.db, conversation.id);
      const wasViewing = ws.data.conversationId === conversation.id;
      const otherViewers = [
        ...(this.viewers.get(conversation.id) ?? []),
      ].filter((viewer) => viewer !== ws);
      if (wasViewing) {
        this.detach(ws);
        this.sendWorkspaces(ws, target.id);
      } else {
        this.sendWorkspaces(ws);
      }
      for (const viewer of otherViewers) {
        this.detach(viewer);
        this.sendWorkspaces(viewer, target.id);
      }
      for (const other of this.allSockets)
        if (other !== ws && !otherViewers.includes(other))
          this.sendWorkspaces(other);
      return;
    }

    const target = getWorkspace(this.deps.db, command.workspaceId);
    if (target?.platform !== PLATFORM) {
      this.sendError(ws, `unknown workspace: ${command.workspaceId}`);
      return;
    }
    const created = createConversation(this.deps.db, {
      workspaceId: target.id,
      cwd: target.cwd,
      title: null,
    });
    const error = await this.bridge(created.id, created.cwd);
    if (error) {
      this.sendError(ws, error);
      return;
    }
    this.attach(ws, created.id);
    this.sendWorkspaces(ws);
    for (const other of this.allSockets)
      if (other !== ws) this.sendWorkspaces(other);
    if (command.prompt) {
      const promptError = await this.deps.engine.prompt(
        created.id,
        created.cwd,
        command.prompt,
      );
      if (promptError) this.sendError(ws, promptError);
      return;
    }
    const snap = this.snapshotEvent(created.id);
    if (snap) ws.send(JSON.stringify(snap));
  }

  private workspaceTree(): WorkspaceSummary[] {
    return listWorkspaces(this.deps.db, PLATFORM).map((w) => ({
      id: w.id,
      label: w.label,
      conversations: listConversations(this.deps.db, w.id).map((c) => ({
        id: c.id,
        title: c.title,
      })),
    }));
  }

  private snapshotEvent(conversationId: string): ServerEvent | undefined {
    const snap = this.deps.engine.snapshot(conversationId);
    if (!snap) return undefined;
    return {
      kind: "snapshot",
      conversationId,
      messages: snap.messages,
      isStreaming: snap.streaming,
      usage: snap.usage,
    };
  }

  private dispatch(conversationId: string, event: TurnEvent): void {
    if (event.kind === "title") {
      for (const ws of this.allSockets) this.sendWorkspaces(ws);
      return;
    }
    const payload = JSON.stringify(
      event.kind === "snapshot"
        ? {
            kind: "snapshot",
            conversationId,
            messages: event.messages,
            isStreaming: event.streaming,
            usage: event.usage,
          }
        : {
            kind: "stream",
            conversationId,
            message: event.message,
            isStreaming: event.streaming,
          },
    );
    for (const ws of this.viewers.get(conversationId) ?? []) ws.send(payload);
  }

  private bridge(
    conversationId: string,
    conversationCwd: string,
  ): Promise<string | undefined> {
    const existing = this.bridges.get(conversationId);
    if (existing) return existing.opened;
    const { unsubscribe, opened } = this.deps.engine.subscribe(
      conversationId,
      conversationCwd,
      "live",
      (event) => this.dispatch(conversationId, event),
    );
    this.bridges.set(conversationId, { opened, unsubscribe });
    return opened.then((error) => {
      if (error) {
        unsubscribe();
        this.bridges.delete(conversationId);
      }
      return error;
    });
  }

  private attach(ws: HubSocket, conversationId: string): void {
    this.detach(ws);
    ws.data.conversationId = conversationId;
    let set = this.viewers.get(conversationId);
    if (!set) {
      set = new Set();
      this.viewers.set(conversationId, set);
    }
    set.add(ws);
  }

  private detach(ws: HubSocket): void {
    const current = ws.data.conversationId;
    if (!current) return;
    const set = this.viewers.get(current);
    set?.delete(ws);
    if (set && set.size === 0) {
      this.bridges.get(current)?.unsubscribe();
      this.bridges.delete(current);
      this.viewers.delete(current);
    }
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
    const error = await this.bridge(conversationId, conversationCwd);
    if (error) {
      this.sendError(ws, error);
      return;
    }
    this.attach(ws, conversationId);
    this.sendWorkspaces(ws);
    const snap = this.snapshotEvent(conversationId);
    if (snap) ws.send(JSON.stringify(snap));
  }
}
