import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import { ChatId } from "@pico/contract/chat-model";
import * as Schema from "effect/Schema";
import { vi } from "vitest";
import {
  browserKey,
  prepareBrowserHome,
  runBrowserLauncher,
  sendBrowserCommand,
} from "./browser-cli.ts";
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

const processes = async (marker: string) => {
  const child = Bun.spawn(["ps", "-axo", "pid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0);
  return output
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => {
      const match = /^\s*(\d+)\s+/.exec(line);
      assert.ok(match);
      return { pid: Number(match[1]) };
    });
};

const launcherFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-launch-cancel-"));
  const home = await prepareBrowserHome(root);
  const directory = dirname(home.directory);
  const ready = join(directory, "ready");
  const preload = join(directory, "hold-launcher.js");
  await writeFile(
    preload,
    `import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`)}], {
  stdio: "inherit", env: { ...process.env, BUN_OPTIONS: "" },
});
await new Promise(() => {});
`,
  );
  home.environment.BUN_OPTIONS = `--preload=${preload}`;
  return {
    home,
    ready,
    async dispose() {
      for (const { pid } of await processes(directory)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await rm(dirname(home.socketDirectory), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
};

it("does not spawn an already cancelled browser launcher", async () => {
  const fixture = await launcherFixture();
  const controller = new AbortController();
  controller.abort();
  const pending = runBrowserLauncher(fixture.home, ["--version"], controller.signal);
  try {
    await assert.rejects(within(pending, 2_000), /cancelled before dispatch/);
    assert.deepStrictEqual(await processes(fixture.home.directory), []);
    assert.equal(await Bun.file(fixture.ready).exists(), false);
  } finally {
    await fixture.dispose();
    await within(
      pending.catch(() => undefined),
      5_000,
    );
  }
});

it("reaps the launcher and its TERM-resistant child holding inherited output pipes", async () => {
  const fixture = await launcherFixture();
  const controller = new AbortController();
  const pending = runBrowserLauncher(fixture.home, ["--version"], controller.signal);
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(async () => assert.equal(await Bun.file(fixture.ready).exists(), true), {
      timeout: 5_000,
      interval: 20,
    });
    const children = await processes(dirname(fixture.home.directory));
    assert.equal(children.length, 2);
    controller.abort();
    const error = await within(outcome, 2_000);
    assert.ok(error instanceof Error);
    assert.match(error.message, /cancelled.*outcome is uncertain/);
    await vi.waitFor(
      () => {
        for (const { pid } of children)
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      },
      { timeout: 2_000, interval: 20 },
    );
  } finally {
    await fixture.dispose();
    await within(outcome, 5_000);
  }
});

for (const phase of ["first launch", "mode restart"] as const) {
  it(`cancels ${phase} without replay and reconciles a surviving native browser`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-browser-native-cancel-"));
    const home = await prepareBrowserHome(root);
    const manager = await makeBrowserManager({ root, idleTimeoutMs: 60_000 });
    let reopened: Awaited<ReturnType<typeof makeBrowserManager>> | undefined;
    const hold = join(root, "hold");
    const ready = join(root, "ready");
    const launches = join(root, "launches");
    const executable = join(root, "chrome");
    const chrome =
      Bun.which("google-chrome") ??
      Bun.which("chromium") ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    assert.equal(await Bun.file(chrome).exists(), true);
    await writeFile(
      executable,
      `#!/bin/sh
echo $$ >> ${JSON.stringify(launches)}
echo $$ > ${JSON.stringify(ready)}
while [ -f ${JSON.stringify(hold)} ]; do sleep 0.02; done
exec ${JSON.stringify(chrome)} "$@"
`,
      { mode: 0o700 },
    );
    await writeFile(
      home.config,
      JSON.stringify({
        plugins: [],
        noWebmcp: true,
        hideScrollbars: false,
        executablePath: executable,
      }),
    );
    const owner = {
      chatId: ChatId.make("018f47a0-0000-7000-8000-000000000005"),
      instance: { kind: "main" },
    } as const;
    const session = browserKey(JSON.stringify([owner.chatId, "main"]));
    let visits = 0;
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        visits++;
        return new Response("<title>Followup</title>", {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    let outcome: Promise<unknown> | undefined;
    try {
      if (phase === "mode restart") {
        await manager.execute(owner, { op: "open", url: "about:blank" });
        const before = await sendBrowserCommand(home, session, { action: "cdp_url" });
        const launchReady = join(root, "launcher-ready");
        const preload = join(root, "hold-before-native.js");
        const bunfig = join(home.directory, "bunfig.toml");
        await writeFile(
          preload,
          `await Bun.write(${JSON.stringify(launchReady)}, String(process.pid));
while (await Bun.file(${JSON.stringify(hold)}).exists()) await Bun.sleep(20);`,
        );
        await writeFile(bunfig, `preload = [${JSON.stringify(preload)}]\n`);
        await writeFile(hold, "");
        const beforeNative = new AbortController();
        outcome = manager
          .execute(owner, { op: "mode", mode: "headed", userRequested: true }, beforeNative.signal)
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await vi.waitFor(async () => assert.equal(await Bun.file(launchReady).exists(), true), {
          timeout: 5_000,
          interval: 20,
        });
        beforeNative.abort();
        const earlyError = await within(outcome, 2_000);
        assert.ok(earlyError instanceof Error);
        assert.match(earlyError.message, /cancelled.*outcome is uncertain/);
        await rm(bunfig);
        await rm(hold);
        assert.deepStrictEqual(
          await sendBrowserCommand(home, session, { action: "cdp_url" }),
          before,
        );
        await sendBrowserCommand(home, session, {
          action: "evaluate",
          script:
            "setTimeout(() => { document.body.dataset.confirmed = String(confirm('Keep this browser?')); }, 0); 'scheduled'",
        });
        await vi.waitFor(
          async () => {
            const dialog = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(
              await sendBrowserCommand(home, session, { action: "dialog", response: "status" }),
            );
            assert.equal(dialog.type, "confirm");
          },
          { timeout: 5_000, interval: 20 },
        );
        const recovered = await manager.execute(owner, { op: "dialog", response: "accept" });
        const accepted = recovered[0];
        assert.ok(accepted?.type === "text");
        assert.deepStrictEqual(
          Schema.decodeUnknownSync(
            Schema.Struct({ handled: Schema.Boolean, accepted: Schema.Boolean }),
          )(JSON.parse(accepted.text)),
          { handled: true, accepted: true },
        );
        const unchanged = recovered[1];
        assert.ok(unchanged?.type === "text");
        assert.equal(
          Schema.decodeUnknownSync(Schema.Struct({ mode: Schema.String }))(
            JSON.parse(unchanged.text),
          ).mode,
          "headless",
        );
        const confirmed = (
          await manager.execute(owner, {
            op: "eval",
            script: "document.body.dataset.confirmed",
          })
        )[0];
        assert.ok(confirmed?.type === "text");
        assert.equal(Schema.decodeUnknownSync(Result)(JSON.parse(confirmed.text)).result, "true");
        await rm(ready);
      }
      await writeFile(hold, "");
      const controller = new AbortController();
      const pending = manager.execute(
        owner,
        phase === "first launch"
          ? { op: "open", url: `http://127.0.0.1:${site.port}/cancelled` }
          : { op: "mode", mode: "headed", userRequested: true },
        controller.signal,
      );
      outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(async () => assert.equal(await Bun.file(ready).exists(), true), {
        timeout: 15_000,
        interval: 20,
      });
      const launchers = await processes(home.config);
      assert.equal(launchers.length, 2);
      const daemonPid = Number(
        await readFile(join(home.socketDirectory, `${session}.pid`), "utf8"),
      );
      controller.abort();
      const error = await within(outcome, 2_000);
      assert.ok(error instanceof Error);
      assert.match(error.message, /cancelled.*outcome is uncertain/);
      await vi.waitFor(
        () => {
          for (const { pid } of launchers)
            assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        },
        { timeout: 2_000, interval: 20 },
      );
      process.kill(daemonPid, 0);
      await rm(hold);
      const info = Schema.decodeUnknownSync(
        Schema.Struct({ browserLaunched: Schema.Boolean, backgroundPid: Schema.Number }),
      )(await within(sendBrowserCommand(home, session, { action: "session_info" }), 15_000));
      assert.equal(info.browserLaunched, true);
      assert.equal(info.backgroundPid, daemonPid);
      assert.equal(visits, 0);
      reopened = await makeBrowserManager({ root, idleTimeoutMs: 60_000 });
      const result = await within(
        reopened.execute(owner, {
          op: "eval",
          script:
            "document.body.dataset.runs = String(Number(document.body.dataset.runs ?? 0) + 1)",
        }),
        10_000,
      );
      const value = result[0];
      assert.ok(value?.type === "text");
      assert.equal(Schema.decodeUnknownSync(Result)(JSON.parse(value.text)).result, "1");
      const metadata = result[1];
      assert.ok(metadata?.type === "text");
      const expectedMode = phase === "first launch" ? "headless" : "headed";
      const Mode = Schema.Struct({ mode: Schema.String });
      assert.equal(Schema.decodeUnknownSync(Mode)(JSON.parse(metadata.text)).mode, expectedMode);
      assert.equal(
        Schema.decodeUnknownSync(Mode)(
          JSON.parse(await readFile(join(home.directory, "owners", `${session}.json`), "utf8")),
        ).mode,
        expectedMode,
      );
      assert.equal(visits, 0);
      assert.equal(
        (await readFile(launches, "utf8")).trim().split("\n").length,
        phase === "first launch" ? 1 : 2,
      );
    } finally {
      await rm(hold, { force: true });
      if (outcome) await within(outcome, 20_000);
      await sendBrowserCommand(
        home,
        session,
        { action: "dialog", response: "dismiss" },
        AbortSignal.timeout(2_000),
      ).catch(() => undefined);
      await reopened?.dispose();
      await manager.dispose();
      await site.stop(true);
      await rm(dirname(home.socketDirectory), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}
