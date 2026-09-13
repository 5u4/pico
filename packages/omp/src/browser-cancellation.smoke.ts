import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import { ChatId } from "@pico/contract/chat-model";
import * as Schema from "effect/Schema";
import { prepareBrowserHome, sendBrowserCommand } from "./browser-cli.ts";
import { makeBrowserManager } from "./browser-manager.ts";

const within = async <A>(pending: Promise<A>, milliseconds: number): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser cancellation deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const Command = Schema.Struct({ action: Schema.String });
const Result = Schema.Struct({ result: Schema.String });

it("aborts a silent native socket without dispatching pre-cancelled work or replaying commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-cancel-transport-"));
  const home = await prepareBrowserHome(root);
  const sockets = new Set<Socket>();
  const actions: string[] = [];
  const dispatched = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk;
      const end = received.indexOf("\n");
      if (end === -1) return;
      const command = Schema.decodeUnknownSync(Command)(JSON.parse(received.slice(0, end)));
      actions.push(command.action);
      if (command.action === "hold") {
        socket.once("end", () => disconnected.resolve());
        dispatched.resolve();
      } else {
        socket.end(`${JSON.stringify({ success: true, data: actions })}\n`);
      }
    });
  });
  const session = "cancellation";
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(home.socketDirectory, `${session}.sock`), resolve);
    });
    const before = new AbortController();
    before.abort();
    await assert.rejects(
      sendBrowserCommand(home, session, { action: "never" }, before.signal),
      /cancelled before dispatch/,
    );
    const connecting = new AbortController();
    const notSent = sendBrowserCommand(home, session, { action: "connecting" }, connecting.signal);
    connecting.abort();
    await assert.rejects(notSent, /cancelled before dispatch/);

    const controller = new AbortController();
    const pending = sendBrowserCommand(home, session, { action: "hold" }, controller.signal);
    const cancelled = assert.rejects(pending, /cancelled.*outcome is uncertain/);
    await within(dispatched.promise, 2_000);
    controller.abort();
    await within(cancelled, 2_000);
    await within(disconnected.promise, 2_000);
    assert.deepStrictEqual(
      await within(sendBrowserCommand(home, session, { action: "inspect" }), 2_000),
      ["hold", "inspect"],
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dirname(home.socketDirectory), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it("releases the owner queue on cancellation while the native action can still finish once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-cancel-owner-"));
  const home = await prepareBrowserHome(root);
  const dispatched = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/hold":
          dispatched.resolve();
          await release.promise;
          return new Response("released");
        case "/completed":
          completed.resolve();
          return new Response("completed");
        default:
          return new Response(
            "<!doctype html><title>Cancellation fixture</title><body>Unchanged page</body>",
            {
              headers: { "Content-Type": "text/html" },
            },
          );
      }
    },
  });
  const manager = await makeBrowserManager({ root, idleTimeoutMs: 60_000 });
  const owner = {
    chatId: ChatId.make("018f47a0-0000-7000-8000-000000000004"),
    instance: { kind: "main" },
  } as const;
  try {
    await manager.execute(owner, { op: "open", url: `http://127.0.0.1:${site.port}/` });
    const controller = new AbortController();
    const pending = manager.execute(
      owner,
      {
        op: "eval",
        script: `(async () => {
        document.body.dataset.runs = String(Number(document.body.dataset.runs ?? "0") + 1);
        document.body.dataset.state = "waiting";
        await fetch("/hold");
        document.body.dataset.state = "completed";
        await fetch("/completed");
        return "completed";
      })()`,
      },
      controller.signal,
    );
    const cancelled = assert.rejects(pending, /cancelled.*outcome is uncertain/);
    await within(dispatched.promise, 10_000);
    controller.abort();
    await within(cancelled, 2_000);

    const nextController = new AbortController();
    const next = manager.execute(owner, { op: "get", what: "title" }, nextController.signal);
    const nextCancelled = assert.rejects(next, /cancelled/);
    nextController.abort();
    await within(nextCancelled, 2_000);

    const queued = manager.execute(owner, {
      op: "wait",
      condition: "function",
      value: "document.body.dataset.state === 'completed'",
      timeoutMs: 10_000,
    });
    release.resolve();
    await within(completed.promise, 10_000);
    await within(queued, 10_000);
    const result = (
      await manager.execute(owner, {
        op: "eval",
        script:
          "JSON.stringify({runs:document.body.dataset.runs,state:document.body.dataset.state,title:document.title})",
      })
    )[0];
    if (result?.type !== "text") throw new Error("Missing page evaluation result");
    assert.deepStrictEqual(
      JSON.parse(Schema.decodeUnknownSync(Result)(JSON.parse(result.text)).result),
      {
        runs: "1",
        state: "completed",
        title: "Cancellation fixture",
      },
    );
  } finally {
    release.resolve();
    await manager.dispose();
    await site.stop(true);
    await rm(dirname(home.socketDirectory), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
