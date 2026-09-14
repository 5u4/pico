import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { BranchNaming } from "@pico/contract/branch-naming";
import * as Chat from "@pico/contract/chat-model";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { PicoRoot } from "@pico/contract/config";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import { WorkspaceId } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { make } from "../../src/layer.ts";

const root = process.cwd();
assert.equal(root, process.env.HOME);
assert.equal(process.env.PI_CODING_AGENT_DIR, join(root, ".omp", "agent"));
assert.equal(process.env.PI_TEST_RUNTIME, "1");
const cwd = AbsolutePath.make(join(root, "project"));
const sessions = AbsolutePath.make(join(root, "sessions"));
const extensionDir = join(cwd, ".omp", "extensions");
await mkdir(extensionDir, { recursive: true });
await writeFile(
  join(cwd, ".omp", "config.yml"),
  "lsp:\n  enabled: false\nbrowser:\n  enabled: false\nskills:\n  enabled: false\n",
);
await writeFile(
  join(extensionDir, "runtime-probe.ts"),
  `export default function (api) {
  api.on("session_start", async (_event, ctx) => {
    const count = ctx.sessionManager.getEntries().filter(
      (entry) => entry.type === "custom" && entry.customType === "runtime-start",
    ).length;
    api.appendEntry("runtime-start", { count: count + 1, hasUI: ctx.hasUI });
    await api.setActiveTools(["read"]);
    api.appendEntry("runtime-tools", api.getActiveTools());
    await api.setSessionName("extension-ready");
  });
  api.on("session_shutdown", () => {
    api.appendEntry("runtime-stop", { name: api.getSessionName() });
  });
}
`,
);

const chat = Chat.Chat.make({
  id: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001"),
  workspaceId: WorkspaceId.make("018f47a0-0000-7000-8000-000000000002"),
  cwd,
  externalId: null,
  createdAt: 0,
  archivedAt: null,
});
const unusedSchedule = () => Effect.die("Unexpected schedule operation");
const schedules = Schedule.Schedules.of({
  create: unusedSchedule,
  list: unusedSchedule,
  get: unusedSchedule,
  update: unusedSchedule,
  remove: unusedSchedule,
  start: unusedSchedule,
});
const platform = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
  Layer.succeed(ChatSessionContext, {
    resolve: () => Effect.succeed({ chat, platform: "web", appendSystemPrompt: "" }),
  }),
  Layer.succeed(BranchNaming, {
    handle: () => {
      throw new Error("Unexpected title generation");
    },
  }),
);
const readJournal = async () => {
  const entries = await OmpSessionLoader.loadEntriesFromFile(join(sessions, `${chat.id}.jsonl`));
  return {
    title: entries.find((entry) => entry.type === "session")?.title,
    markers: entries.flatMap((entry) =>
      entry.type === "custom" && entry.customType.startsWith("runtime-")
        ? [{ type: entry.customType, data: entry.data }]
        : [],
    ),
  };
};
const startMarkers = (count: number) => [
  { type: "runtime-start", data: { count, hasUI: false } },
  { type: "runtime-tools", data: ["read"] },
];
const stopMarker = { type: "runtime-stop", data: { name: "extension-ready" } };

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* make({
        paths: { root: PicoRoot.make(root), sessionsDir: sessions },
        schedules,
        browser: { externalBrowser: "off", idleTimeoutMs: 10_800_000 },
      });
      yield* runtime.contextUsage(chat.id);
      const started = { title: "extension-ready", markers: startMarkers(1) };
      assert.deepEqual(yield* Effect.promise(readJournal), started);

      yield* runtime.contextUsage(chat.id);
      assert.deepEqual(yield* Effect.promise(readJournal), started);

      yield* runtime.close(chat.id);
      const closed = { ...started, markers: [...started.markers, stopMarker] };
      assert.deepEqual(yield* Effect.promise(readJournal), closed);

      yield* runtime.contextUsage(chat.id);
      const reopened = { ...closed, markers: [...closed.markers, ...startMarkers(2)] };
      assert.deepEqual(yield* Effect.promise(readJournal), reopened);

      yield* runtime.close(chat.id);
      assert.deepEqual(yield* Effect.promise(readJournal), {
        ...reopened,
        markers: [...reopened.markers, stopMarker],
      });
    }),
  ).pipe(Effect.provide(platform)),
);
