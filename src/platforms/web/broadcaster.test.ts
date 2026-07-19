import { describe, expect, test } from "bun:test";
import { getOrCreateDefaultWorkspace } from "../../engine/registry";
import { openDb } from "../../store/db";
import type { HubSocket } from "./adapter";
import { WorkspaceBroadcaster } from "./broadcaster";
import type { ServerEvent } from "./protocol";

const CWD = "/tmp/pico-broadcaster-test";

class FakeSocket implements HubSocket {
  data: { conversationId: string | null } = { conversationId: null };
  readonly sent: ServerEvent[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as ServerEvent);
  }
}

function make() {
  const db = openDb(":memory:");
  getOrCreateDefaultWorkspace(db, "web", CWD, "web");
  return new WorkspaceBroadcaster(db, "web");
}

describe("WorkspaceBroadcaster", () => {
  test("broadcast reaches every registered socket", async () => {
    const broadcaster = make();
    const a = new FakeSocket();
    const b = new FakeSocket();
    broadcaster.add(a);
    broadcaster.add(b);

    await broadcaster.broadcast();

    expect(a.sent.at(-1)?.kind).toBe("workspaces");
    expect(b.sent.at(-1)?.kind).toBe("workspaces");
  });

  test("broadcast applies a draft only to the targeted socket", async () => {
    const broadcaster = make();
    const drafting = new FakeSocket();
    const other = new FakeSocket();
    broadcaster.add(drafting);
    broadcaster.add(other);

    await broadcaster.broadcast(new Map([[drafting, "ws-1"]]));

    const draftEvent = drafting.sent.at(-1);
    const otherEvent = other.sent.at(-1);
    expect(
      draftEvent?.kind === "workspaces" ? draftEvent.draftWorkspaceId : null,
    ).toBe("ws-1");
    expect(
      otherEvent?.kind === "workspaces"
        ? otherEvent.draftWorkspaceId
        : undefined,
    ).toBeUndefined();
  });

  test("sendTo emits the socket's active conversation as activeId", async () => {
    const broadcaster = make();
    const ws = new FakeSocket();
    ws.data.conversationId = "conv-9";
    broadcaster.add(ws);

    await broadcaster.sendTo(ws);

    const event = ws.sent.at(-1);
    expect(event?.kind === "workspaces" ? event.activeId : null).toBe("conv-9");
  });

  test("a removed socket stops receiving broadcasts", async () => {
    const broadcaster = make();
    const ws = new FakeSocket();
    broadcaster.add(ws);
    broadcaster.remove(ws);

    await broadcaster.broadcast();

    expect(ws.sent).toHaveLength(0);
  });
});
