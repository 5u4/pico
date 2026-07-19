import type { Database } from "bun:sqlite";
import { listConversations, listWorkspaces } from "../../engine/registry";
import { currentBranch } from "../../engine/worktree";
import { isWorktreeWorkspace, type Platform } from "../../store/schema";
import type { HubSocket } from "./adapter";
import type { ServerEvent, WorkspaceSummary } from "./protocol";

export class WorkspaceBroadcaster {
  private readonly db: Database;
  private readonly platform: Platform;
  private readonly sockets = new Set<HubSocket>();

  constructor(db: Database, platform: Platform) {
    this.db = db;
    this.platform = platform;
  }

  add(ws: HubSocket): void {
    this.sockets.add(ws);
  }

  remove(ws: HubSocket): void {
    this.sockets.delete(ws);
  }

  get connections(): Iterable<HubSocket> {
    return this.sockets;
  }

  private tree(): Promise<WorkspaceSummary[]> {
    return Promise.all(
      listWorkspaces(this.db, this.platform).map(async (w) => ({
        id: w.id,
        label: w.label,
        cwd: w.cwd,
        worktree: isWorktreeWorkspace(w),
        defaultBranch: w.defaultBranch,
        branchPrefix: w.branchPrefix,
        conversations: await Promise.all(
          listConversations(this.db, w.id).map(async (c) => ({
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

  private emit(
    ws: HubSocket,
    items: WorkspaceSummary[],
    draftWorkspaceId?: string,
  ): void {
    const event: ServerEvent = {
      kind: "workspaces",
      items,
      activeId: ws.data.conversationId,
      ...(draftWorkspaceId ? { draftWorkspaceId } : {}),
    };
    ws.send(JSON.stringify(event));
  }

  async sendTo(ws: HubSocket, draftWorkspaceId?: string): Promise<void> {
    this.emit(ws, await this.tree(), draftWorkspaceId);
  }

  async broadcast(drafts?: Map<HubSocket, string>): Promise<void> {
    const items = await this.tree();
    for (const ws of this.sockets) this.emit(ws, items, drafts?.get(ws));
  }
}
