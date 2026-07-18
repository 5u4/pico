import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type { ResultAsync } from "neverthrow";
import type {
  Engine,
  SessionLike,
  TurnEvent,
} from "../../engine/conversations";
import {
  deprovisionConversation,
  provisionConversation,
} from "../../engine/provision";
import {
  archiveConversation,
  countActiveWorktreeConversations,
  createWorkspace,
  getConversation,
  getOrCreateDefaultWorkspace,
  getWorkspace,
  listConversations,
  listWorkspaces,
  renameWorkspace,
  updateWorkspaceCwd,
} from "../../engine/registry";
import { currentBranch, sanitizeRefSegment } from "../../engine/worktree";
import { isWorktreeWorkspace, type Platform } from "../../store/schema";
import { assertNever } from "../../util/assert";
import type {
  ClientCommand,
  CommandCommand,
  ServerEvent,
  WorkspaceSummary,
} from "./protocol";

const PLATFORM: Platform = "web";
const DEFAULT_LABEL = "Default";

export interface HubSocket {
  data: { conversationId: string | null };
  send(payload: string): void;
}

export type WebHubDeps<S extends SessionLike = SessionLike> = {
  db: Database;
  engine: Engine<S>;
  workspaceCwd: string;
  worktreeCwd: string;
};

export class WebHub<S extends SessionLike = SessionLike> {
  private readonly deps: WebHubDeps<S>;
  private readonly allSockets = new Set<HubSocket>();
  private readonly viewers = new Map<string, Set<HubSocket>>();
  private readonly bridges = new Map<
    string,
    { opened: ResultAsync<void, string>; unsubscribe: () => void }
  >();
  private readonly attention = new Set<string>();

  constructor(deps: WebHubDeps<S>) {
    this.deps = deps;
    this.deps.engine.onSettled((conversationId) =>
      this.onSettled(conversationId),
    );
  }

  private onSettled(conversationId: string): void {
    if ((this.viewers.get(conversationId)?.size ?? 0) > 0) return;
    if (this.attention.has(conversationId)) return;
    this.attention.add(conversationId);
    this.broadcastAttention();
  }

  private broadcastAttention(): void {
    const event: ServerEvent = {
      kind: "attention",
      conversationIds: [...this.attention],
    };
    const payload = JSON.stringify(event);
    for (const ws of this.allSockets) ws.send(payload);
  }

  private clearAttention(conversationId: string): void {
    if (!this.attention.delete(conversationId)) return;
    this.broadcastAttention();
  }

  private finalizeArchive(conversationId: string): void {
    this.clearAttention(conversationId);
    void this.deps.engine.releaseIfIdle(conversationId);
  }

  async handleOpen(ws: HubSocket): Promise<void> {
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
    await this.sendWorkspaces(ws, hasConversations ? undefined : target.id);
    ws.send(
      JSON.stringify({
        kind: "attention",
        conversationIds: [...this.attention],
      } satisfies ServerEvent),
    );
  }

  handleClose(ws: HubSocket): void {
    this.allSockets.delete(ws);
    this.detach(ws);
  }

  async handleCommand(ws: HubSocket, command: ClientCommand): Promise<void> {
    if (command.kind === "heartbeat") {
      ws.send(JSON.stringify({ kind: "heartbeatAck" } satisfies ServerEvent));
      return;
    }

    if (command.kind === "prompt" || command.kind === "abort") {
      const conversationId = ws.data.conversationId;
      const conversation = conversationId
        ? getConversation(this.deps.db, conversationId)
        : undefined;
      if (!conversationId || !conversation) {
        this.sendError(ws, "no active conversation; retry once connected");
        return;
      }
      const result =
        command.kind === "prompt"
          ? await this.deps.engine.prompt(
              conversationId,
              conversation.cwd,
              command.text,
            )
          : await this.deps.engine.abort(conversationId);
      if (result.isErr()) this.sendError(ws, result.error);
      return;
    }

    if (command.kind === "command") {
      const conversationId = ws.data.conversationId;
      const conversation = conversationId
        ? getConversation(this.deps.db, conversationId)
        : undefined;
      if (!conversationId || !conversation) {
        this.sendError(ws, "no active conversation; retry once connected");
        return;
      }
      const text = this.runCommand(command);
      const result = await this.deps.engine.record(
        conversationId,
        conversation.cwd,
        `command:${command.name}`,
        text,
      );
      if (result.isErr()) this.sendError(ws, result.error);
      return;
    }

    if (command.kind === "draft") {
      this.detach(ws);
      await this.sendWorkspaces(ws);
      return;
    }

    if (command.kind === "loadOlder") {
      if (ws.data.conversationId !== command.conversationId) return;
      const older = this.deps.engine.loadOlder(
        command.conversationId,
        command.beforeId,
      ) ?? { messages: [], hasMore: false };
      ws.send(
        JSON.stringify({
          kind: "older",
          conversationId: command.conversationId,
          messages: older.messages,
          hasMore: older.hasMore,
        } satisfies ServerEvent),
      );
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
      await this.sendWorkspaces(ws, created.id);
      for (const other of this.allSockets)
        if (other !== ws) await this.sendWorkspaces(other);
      return;
    }

    if (command.kind === "renameWorkspace") {
      const target = getWorkspace(this.deps.db, command.workspaceId);
      if (target?.platform !== PLATFORM) {
        this.sendError(ws, `unknown workspace: ${command.workspaceId}`);
        return;
      }
      renameWorkspace(this.deps.db, target.id, command.label);
      for (const other of this.allSockets) await this.sendWorkspaces(other);
      return;
    }

    if (command.kind === "updateWorkspaceCwd") {
      const target = getWorkspace(this.deps.db, command.workspaceId);
      if (target?.platform !== PLATFORM) {
        this.sendError(ws, `unknown workspace: ${command.workspaceId}`);
        return;
      }
      let cwdIsDirectory = false;
      try {
        cwdIsDirectory =
          statSync(command.cwd, { throwIfNoEntry: false })?.isDirectory() ??
          false;
      } catch {
        cwdIsDirectory = false;
      }
      if (!cwdIsDirectory) {
        this.sendError(ws, `not a directory: ${command.cwd}`);
        return;
      }
      if (
        isWorktreeWorkspace(target) &&
        countActiveWorktreeConversations(this.deps.db, target.id) > 0
      ) {
        this.sendError(
          ws,
          "archive this workspace's worktree conversations before changing its directory or mode",
        );
        return;
      }
      let worktree:
        | { defaultBranch: string; branchPrefix: string }
        | null
        | undefined;
      if (command.worktree === undefined) {
        worktree = undefined;
      } else if (command.worktree === null) {
        worktree = null;
      } else {
        const prefix = sanitizeRefSegment(command.worktree.branchPrefix);
        if (prefix.isErr()) {
          this.sendError(ws, prefix.error);
          return;
        }
        worktree = {
          defaultBranch: command.worktree.defaultBranch,
          branchPrefix: prefix.value,
        };
      }
      updateWorkspaceCwd(this.deps.db, target.id, command.cwd, worktree);
      for (const other of this.allSockets) await this.sendWorkspaces(other);
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
      if (isWorktreeWorkspace(target)) {
        const removed = await deprovisionConversation(target, conversation);
        if (removed.isErr()) {
          this.sendError(ws, removed.error);
          return;
        }
      }
      archiveConversation(this.deps.db, conversation.id);
      const wasViewing = ws.data.conversationId === conversation.id;
      const otherViewers = [
        ...(this.viewers.get(conversation.id) ?? []),
      ].filter((viewer) => viewer !== ws);
      if (wasViewing) {
        this.detach(ws);
        await this.sendWorkspaces(ws, target.id);
      } else {
        await this.sendWorkspaces(ws);
      }
      for (const viewer of otherViewers) {
        this.detach(viewer);
        await this.sendWorkspaces(viewer, target.id);
      }
      this.finalizeArchive(conversation.id);
      for (const other of this.allSockets)
        if (other !== ws && !otherViewers.includes(other))
          await this.sendWorkspaces(other);
      return;
    }

    const target = getWorkspace(this.deps.db, command.workspaceId);
    if (target?.platform !== PLATFORM) {
      this.sendError(ws, `unknown workspace: ${command.workspaceId}`);
      return;
    }
    const provisioned = await provisionConversation(
      this.deps.db,
      target,
      this.deps.worktreeCwd,
      null,
    );
    if (provisioned.isErr()) {
      this.sendError(ws, provisioned.error);
      return;
    }
    const created = provisioned.value;
    const bridged = await this.bridge(created.id, created.cwd);
    if (bridged.isErr()) {
      this.sendError(ws, bridged.error);
      return;
    }
    this.attach(ws, created.id);
    await this.sendWorkspaces(ws);
    for (const other of this.allSockets)
      if (other !== ws) await this.sendWorkspaces(other);
    if (command.prompt) {
      const promptResult = await this.deps.engine.prompt(
        created.id,
        created.cwd,
        command.prompt,
      );
      if (promptResult.isErr()) this.sendError(ws, promptResult.error);
      return;
    }
    const snap = this.snapshotEvent(created.id);
    if (snap) ws.send(JSON.stringify(snap));
  }

  private runCommand(command: CommandCommand): string {
    switch (command.name) {
      case "ping":
        return `Pong ${command.text ?? ""}`.trim();
      default:
        return assertNever(command.name);
    }
  }

  private workspaceTree(): Promise<WorkspaceSummary[]> {
    return Promise.all(
      listWorkspaces(this.deps.db, PLATFORM).map(async (w) => ({
        id: w.id,
        label: w.label,
        cwd: w.cwd,
        worktree: isWorktreeWorkspace(w),
        defaultBranch: w.defaultBranch,
        branchPrefix: w.branchPrefix,
        conversations: await Promise.all(
          listConversations(this.deps.db, w.id).map(async (c) => ({
            id: c.id,
            title: c.title,
            cwd: c.cwd,
            branch: isWorktreeWorkspace(w)
              ? (await currentBranch(c.cwd)).unwrapOr(null)
              : null,
          })),
        ),
      })),
    );
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
      hasMore: snap.hasMore,
    };
  }

  private async dispatch(
    conversationId: string,
    event: TurnEvent,
  ): Promise<void> {
    if (event.kind === "title") {
      for (const ws of this.allSockets) await this.sendWorkspaces(ws);
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
            hasMore: event.hasMore,
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
  ): ResultAsync<void, string> {
    const existing = this.bridges.get(conversationId);
    if (existing) return existing.opened;
    const { unsubscribe, opened } = this.deps.engine.subscribe(
      conversationId,
      conversationCwd,
      "live",
      (event) => this.dispatch(conversationId, event),
    );
    this.bridges.set(conversationId, { opened, unsubscribe });
    return opened.orTee(() => {
      unsubscribe();
      this.bridges.delete(conversationId);
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

  private async sendWorkspaces(
    ws: HubSocket,
    draftWorkspaceId?: string,
  ): Promise<void> {
    const event: ServerEvent = {
      kind: "workspaces",
      items: await this.workspaceTree(),
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
    const bridged = await this.bridge(conversationId, conversationCwd);
    if (bridged.isErr()) {
      this.sendError(ws, bridged.error);
      return;
    }
    this.attach(ws, conversationId);
    this.clearAttention(conversationId);
    await this.sendWorkspaces(ws);
    const snap = this.snapshotEvent(conversationId);
    if (snap) ws.send(JSON.stringify(snap));
  }
}
