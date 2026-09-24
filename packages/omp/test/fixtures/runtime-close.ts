import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { BranchNaming } from "@pico/contract/branch-naming";
import { ChatId } from "@pico/contract/chat-model";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { PicoRoot } from "@pico/contract/config";
import type { AgentError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import { Schedules } from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { agentError } from "../../src/agent-error.ts";

const root = process.cwd();
const agentDir = join(root, ".omp", "agent");
assert.equal(process.env.HOME, root);
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
await mkdir(agentDir, { recursive: true });
const { PROVIDER_REGISTRY } = await import("@oh-my-pi/pi-ai/registry");
await writeFile(
  join(agentDir, "config.yml"),
  `disabledProviders: ${JSON.stringify([...PROVIDER_REGISTRY.map(({ id }) => id), "ollama", "llama.cpp", "lm-studio"])}\nlsp:\n  enabled: false\nskills:\n  enabled: false\n`,
);
const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
await Settings.init({ cwd: root });

const operation = (poolExit: Exit.Exit<void, AgentError>, browserError: Error | undefined) => ({
  poolExit,
  browserError,
  trace: [] as string[],
  poolStarted: Promise.withResolvers<void>(),
  releasePool: Promise.withResolvers<void>(),
  releaseBrowser: Promise.withResolvers<void>(),
  browserSettled: Promise.withResolvers<void>(),
});
let active: ReturnType<typeof operation> | undefined;
const { makeSessionPool } = await import("../../src/session-pool.ts");
const { makeAgentBrowserManager } = await import("../../src/agent-browser/manager.ts");
mock.module("../../src/session-pool.ts", () => ({
  makeSessionPool: (...args: Parameters<typeof makeSessionPool>) =>
    makeSessionPool(...args).pipe(
      Effect.map((pool) => ({
        ...pool,
        close: Effect.fn("CloseFixture.pool")(function* (chatId: ChatId) {
          const current = active;
          assert.ok(current);
          current.trace.push("pool-start");
          yield* pool.close(chatId);
          current.poolStarted.resolve();
          yield* Effect.promise(() => current.releasePool.promise);
          current.trace.push("pool-settled");
          return yield* current.poolExit;
        }),
      })),
    ),
}));
mock.module("../../src/agent-browser/manager.ts", () => ({
  makeAgentBrowserManager: async (...args: Parameters<typeof makeAgentBrowserManager>) => {
    const manager = await makeAgentBrowserManager(...args);
    return {
      ...manager,
      closeChat: async (chatId: ChatId) => {
        const current = active;
        assert.ok(current);
        current.trace.push("browser-start");
        await manager.closeChat(chatId);
        await current.releaseBrowser.promise;
        current.trace.push("browser-settled");
        current.browserSettled.resolve();
        if (current.browserError !== undefined) throw current.browserError;
      },
    };
  },
}));
const { make } = await import("../../src/layer.ts");
const unusedSchedule = () => Effect.die("Unexpected schedule operation");
const platform = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
  Layer.succeed(ChatSessionContext, {
    resolve: () => Effect.die("Close must not open a session"),
  }),
  Layer.succeed(BranchNaming, {
    handle: () => {
      throw new Error("Unexpected title generation");
    },
  }),
);
const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000001");
const poolError = agentError("Pool close failed", new Error("pool journal failure"));
const browserError = agentError("Browser close failed", new Error("browser process failure"));
const poolDefect = new Error("pool finalizer defect");
const poolCause = Cause.combine(
  Cause.fail(poolError),
  Cause.combine(Cause.die(poolDefect), Cause.interrupt(731)),
);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* make({
        paths: {
          root: PicoRoot.make(root),
          sessionsDir: AbsolutePath.make(join(root, "sessions")),
        },
        schedules: Schedules.of({
          withCurrentTargets: () => Effect.die("unexpected schedule target scan"),
          create: unusedSchedule,
          list: unusedSchedule,
          overview: unusedSchedule,
          get: unusedSchedule,
          update: unusedSchedule,
          remove: unusedSchedule,
          trigger: unusedSchedule,
          start: unusedSchedule,
        }),
        browser: { externalBrowser: "agent-browser", idleTimeoutMs: 60_000 },
      });
      const close = async (poolExit: Exit.Exit<void, AgentError>, failure?: Error) => {
        const current = operation(poolExit, failure);
        active = current;
        let settled = false;
        const pending = Effect.runPromiseExit(runtime.close(chatId)).then((exit) => {
          settled = true;
          return exit;
        });
        try {
          await current.poolStarted.promise;
          assert.deepEqual(current.trace, ["browser-start", "pool-start"]);
          current.releaseBrowser.resolve();
          await current.browserSettled.promise;
          assert.equal(settled, false, "Close must wait for pool cleanup after browser failure");
          current.releasePool.resolve();
          const exit = await pending;
          assert.deepEqual(current.trace, [
            "browser-start",
            "pool-start",
            "browser-settled",
            "pool-settled",
          ]);
          return exit;
        } finally {
          current.releaseBrowser.resolve();
          current.releasePool.resolve();
          await pending;
          active = undefined;
        }
      };
      const both = yield* Effect.promise(() => close(Exit.failCause(poolCause), browserError));
      assert.ok(Exit.isFailure(both));
      assert.deepEqual(
        both.cause.reasons.map((reason) => reason._tag),
        ["Fail", "Die", "Interrupt", "Fail"],
      );
      const errors = both.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
      assert.equal(errors[0], poolError);
      assert.equal(errors[1], browserError);
      assert.deepEqual(
        both.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect),
        [poolDefect],
      );
      assert.deepEqual([...Cause.interruptors(both.cause)], [731]);

      const poolOnly = yield* Effect.promise(() => close(Exit.fail(poolError)));
      assert.ok(Exit.isFailure(poolOnly));
      assert.deepEqual(
        poolOnly.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
        [poolError],
      );
      assert.equal(poolOnly.cause.reasons.length, 1);

      const browserOnly = yield* Effect.promise(() => close(Exit.void, browserError));
      assert.ok(Exit.isFailure(browserOnly));
      assert.equal(browserOnly.cause.reasons.length, 1);
      assert.deepEqual(
        browserOnly.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
        [browserError],
      );

      const success = yield* Effect.promise(() => close(Exit.void));
      assert.ok(Exit.isSuccess(success));
      assert.equal(success.value, undefined);
    }),
  ).pipe(Effect.provide(platform)),
);
