import { describe, expect, test } from "bun:test";
import { Engine } from "../../engine/conversations";
import { openDb } from "../../store/db";
import { WebHub } from "./adapter";
import { type FakeWebSession, FakeWebSessions } from "./fake-session";
import type { ClientCommand, ServerEvent } from "./protocol";
import { createServer, type WsData } from "./server";

const WORKSPACE_CWD = "/tmp/pico-web-e2e";

type Harness = {
  server: Bun.Server<WsData>;
  port: number;
  close: () => Promise<void>;
};

function startServer(): Harness {
  const db = openDb(":memory:");
  const sessions = new FakeWebSessions();
  const engine = new Engine<FakeWebSession>({
    db,
    sessions,
    autoTitle: async () => null,
  });
  const hub = new WebHub<FakeWebSession>({
    db,
    engine,
    workspaceCwd: WORKSPACE_CWD,
  });
  const server = createServer({
    port: 0,
    hub,
    index: new Response("<!doctype html><title>pico</title>", {
      headers: { "content-type": "text/html" },
    }),
  });
  return {
    server,
    port: server.port ?? 0,
    close: async () => {
      await server.stop(true);
      db.close();
    },
  };
}

class TestClient {
  private readonly ws: WebSocket;
  private readonly received: ServerEvent[] = [];
  private readonly waiters: {
    match: (event: ServerEvent) => boolean;
    resolve: (event: ServerEvent) => void;
  }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (event) => {
      const parsed = JSON.parse(String(event.data)) as ServerEvent;
      this.received.push(parsed);
      const index = this.waiters.findIndex((w) => w.match(parsed));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(parsed);
      }
    };
  }

  static connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const client = new TestClient(ws);
    const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
    ws.onopen = () => resolve(client);
    ws.onerror = () => reject(new Error("ws connection failed"));
    return promise;
  }

  send(command: ClientCommand): void {
    this.ws.send(JSON.stringify(command));
  }

  sendRaw(payload: string): void {
    this.ws.send(payload);
  }

  waitFor(match: (event: ServerEvent) => boolean): Promise<ServerEvent> {
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<ServerEvent>();
    this.waiters.push({ match, resolve });
    return promise;
  }

  close(): void {
    this.ws.close();
  }
}

describe("createServer HTTP routing", () => {
  test("serves the index bundle at /", async () => {
    const harness = startServer();
    try {
      const response = await fetch(`http://localhost:${harness.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("pico");
    } finally {
      await harness.close();
    }
  });

  test("returns 404 for unknown paths", async () => {
    const harness = startServer();
    try {
      const response = await fetch(`http://localhost:${harness.port}/nope`);
      expect(response.status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  test("rejects a ws upgrade from a cross-origin request with 403", async () => {
    const harness = startServer();
    try {
      const response = await fetch(`http://localhost:${harness.port}/ws`, {
        headers: { origin: "http://evil.example" },
      });
      expect(response.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  test("returns 400 when a same-origin request cannot be upgraded", async () => {
    const harness = startServer();
    try {
      const response = await fetch(`http://localhost:${harness.port}/ws`);
      expect(response.status).toBe(400);
    } finally {
      await harness.close();
    }
  });
});

describe("createServer websocket round-trip", () => {
  test("sends a workspaces event with a draft workspace on open", async () => {
    const harness = startServer();
    const client = await TestClient.connect(harness.port);
    try {
      const event = await client.waitFor((e) => e.kind === "workspaces");
      expect(event.kind).toBe("workspaces");
      if (event.kind !== "workspaces") return;
      expect(event.draftWorkspaceId).toBeDefined();
      expect(event.items).toHaveLength(1);
      expect(event.items[0]?.conversations).toHaveLength(0);
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("creating a conversation yields a workspaces event carrying it", async () => {
    const harness = startServer();
    const client = await TestClient.connect(harness.port);
    try {
      const open = await client.waitFor((e) => e.kind === "workspaces");
      if (open.kind !== "workspaces") return;
      const workspaceId = open.items[0]?.id;
      expect(workspaceId).toBeDefined();
      if (!workspaceId) return;

      client.send({ kind: "create", workspaceId });
      const populated = await client.waitFor(
        (e) =>
          e.kind === "workspaces" && e.items[0]?.conversations.length === 1,
      );
      expect(populated.kind).toBe("workspaces");
      if (populated.kind !== "workspaces") return;
      expect(populated.activeId).not.toBeNull();
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("a prompt drives a snapshot containing the echoed reply", async () => {
    const harness = startServer();
    const client = await TestClient.connect(harness.port);
    try {
      const open = await client.waitFor((e) => e.kind === "workspaces");
      if (open.kind !== "workspaces") return;
      const workspaceId = open.items[0]?.id;
      if (!workspaceId) return;
      client.send({ kind: "create", workspaceId });
      await client.waitFor(
        (e) =>
          e.kind === "workspaces" && e.items[0]?.conversations.length === 1,
      );

      client.send({ kind: "prompt", text: "hi there" });
      const reply = await client.waitFor(
        (e) =>
          e.kind === "snapshot" &&
          e.messages.some((m) => m.role === "assistant"),
      );
      expect(reply.kind).toBe("snapshot");
      if (reply.kind !== "snapshot") return;
      const assistant = reply.messages.find((m) => m.role === "assistant");
      expect(assistant?.parts[0]).toEqual({
        type: "text",
        text: "echo: hi there",
      });
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("a malformed frame is dropped without tearing down the socket", async () => {
    const harness = startServer();
    const client = await TestClient.connect(harness.port);
    try {
      await client.waitFor((e) => e.kind === "workspaces");
      client.sendRaw("this is not json");
      client.send({ kind: "draft" });
      const event = await client.waitFor(
        (e) => e.kind === "workspaces" && e.draftWorkspaceId === undefined,
      );
      expect(event.kind).toBe("workspaces");
    } finally {
      client.close();
      await harness.close();
    }
  });

  test("an unrecognized command is dropped without tearing down the socket", async () => {
    const harness = startServer();
    const client = await TestClient.connect(harness.port);
    try {
      await client.waitFor((e) => e.kind === "workspaces");
      client.sendRaw(JSON.stringify({ kind: "bogus" }));
      client.send({ kind: "draft" });
      const event = await client.waitFor(
        (e) => e.kind === "workspaces" && e.draftWorkspaceId === undefined,
      );
      expect(event.kind).toBe("workspaces");
    } finally {
      client.close();
      await harness.close();
    }
  });
});
