import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BranchNaming } from "@pico/contract/branch-naming";
import * as Chat from "@pico/contract/chat-model";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { PicoRoot } from "@pico/contract/config";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import { WorkspaceId } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { make as makeSessionStore } from "../../src/agent-session-store.ts";
import { make } from "../../src/layer.ts";

const root = process.cwd();
assert.equal(root, process.env.HOME);
assert.equal(process.env.PI_CODING_AGENT_DIR, join(root, ".omp", "agent"));
assert.equal(process.env.PI_TEST_RUNTIME, "1");
const cwd = AbsolutePath.make(join(root, "project"));
const sessions = AbsolutePath.make(join(root, "sessions"));
const extensionDir = join(cwd, ".omp", "extensions");
const authCommandMarker = join(root, "auth-command-ran");
const extensionInitMarker = join(root, "extension-initialized");
await mkdir(extensionDir, { recursive: true });
await writeFile(
  join(cwd, ".omp", "config.yml"),
  "lsp:\n  enabled: false\nbrowser:\n  enabled: false\nskills:\n  enabled: false\nmodelRoles:\n  default: pico-fixture/default\nenabledModels:\n  - pico-fixture/*\n",
);
await mkdir(join(root, ".omp", "agent"), { recursive: true });
await writeFile(
  join(root, ".omp", "agent", "models.yml"),
  JSON.stringify({
    providers: {
      "pico-fixture": {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: `!touch ${JSON.stringify(authCommandMarker)}; printf fixture-only`,
        models: ["default", "workspace", "switched"].map((id) => ({
          id,
          name: id,
          contextWindow: 32_768,
          maxTokens: 1_024,
        })),
      },
    },
  }),
);
await writeFile(
  join(extensionDir, "runtime-probe.ts"),
  `export default async function (api) {
  await Bun.write(${JSON.stringify(extensionInitMarker)}, "initialized");
  api.registerProvider("pico-extension", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fixture-only",
    models: [{
      id: "preferred",
      name: "Extension preferred",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 1024,
    }],
  });
  api.on("session_start", async (_event, ctx) => {
    const count = ctx.sessionManager.getEntries().filter(
      (entry) => entry.type === "custom" && entry.customType === "runtime-start",
    ).length;
    api.appendEntry("runtime-start", { count: count + 1, hasUI: ctx.hasUI, model: ctx.model?.id });
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
const secondChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");
const unusedSchedule = () => Effect.die("Unexpected schedule operation");
const schedules = Schedule.Schedules.of({
  withCurrentTargets: () => Effect.die("unexpected schedule target scan"),
  create: unusedSchedule,
  list: unusedSchedule,
  overview: unusedSchedule,
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
    resolve: (id) =>
      Effect.succeed({ chat: { ...chat, id }, platform: "web", appendSystemPrompt: "" }),
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
const startMarkers = (count: number, model: string) => [
  { type: "runtime-start", data: { count, hasUI: false, model } },
  { type: "runtime-tools", data: ["read"] },
];
const stopMarker = { type: "runtime-stop", data: { name: "extension-ready" } };
const assistantMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Saved reply" }],
  api: "openai-completions",
  provider: "pico-fixture",
  model: "workspace",
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const coldCases = [
  {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000004"),
    prepare: (manager: SessionManager) => {
      manager.appendMessage(assistantMessage);
    },
    expected: { provider: "pico-fixture", id: "workspace", name: "workspace" },
  },
  {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000005"),
    prepare: (manager: SessionManager) => {
      manager.appendModelChange("pico-fixture/switched", "default");
      manager.appendMessage(assistantMessage);
    },
    expected: { provider: "pico-fixture", id: "switched", name: "switched" },
  },
  {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000006"),
    prepare: (manager: SessionManager) => {
      manager.appendModelChange("pico-fixture/default", "default");
      manager.appendModelChange("pico-extension/preferred", "temporary");
    },
    expected: null,
  },
  {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000007"),
    prepare: (manager: SessionManager) => {
      manager.appendModelChange("pico-fixture/workspace", "temporary");
      manager.appendModelChange("pico-fixture/default", "temporary", true);
      manager.appendModelChange("pico-fixture/switched", "default");
      manager.appendMessage(assistantMessage);
    },
    expected: { provider: "pico-fixture", id: "switched", name: "switched" },
  },
  {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000008"),
    prepare: (manager: SessionManager) => {
      manager.appendModelChange("pico-fixture/workspace", "temporary");
      manager.appendModelChange("pico-fixture/default", "temporary", true);
    },
    expected: { provider: "pico-fixture", id: "workspace", name: "workspace" },
  },
  {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000009"),
    prepare: (manager: SessionManager) => {
      manager.appendModelChange("pico-fixture/workspace", "temporary");
      manager.appendModelChange("pico-fixture/switched", "slow");
      manager.appendMessage(assistantMessage);
    },
    expected: { provider: "pico-fixture", id: "switched", name: "switched" },
  },
  {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000010"),
    prepare: (manager: SessionManager) => {
      manager.appendModelChange("pico-fixture/workspace", "temporary");
      manager.appendModelChange("pico-fixture/switched", "default");
      manager.appendModelChange("pico-fixture/default", "temporary", true);
    },
    expected: { provider: "pico-fixture", id: "switched", name: "switched" },
  },
  {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000011"),
    prepare: (manager: SessionManager) => {
      manager.appendModelChange("pico-fixture/workspace", "temporary");
      manager.appendModelChange("pico-fixture/switched", "slow");
      manager.appendModelChange("pico-fixture/default", "temporary", true);
    },
    expected: { provider: "pico-fixture", id: "switched", name: "switched" },
  },
];

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* makeSessionStore(sessions);
      yield* store.create({
        chatId: chat.id,
        cwd,
        modelOverride: { provider: "pico-fixture", id: "workspace" },
      });
      yield* store.create({ chatId: secondChatId, cwd, modelOverride: null });
      for (const scenario of coldCases) {
        yield* Effect.promise(async () => {
          const manager = await SessionManager.open(
            join(sessions, `${scenario.chatId}.jsonl`),
            sessions,
            undefined,
            { initialCwd: cwd, suppressBreadcrumb: true },
          );
          try {
            scenario.prepare(manager);
            await manager.ensureOnDisk();
            await manager.flush();
          } finally {
            await manager.close();
          }
        });
      }
      const runtime = yield* make({
        paths: { root: PicoRoot.make(root), sessionsDir: sessions },
        schedules,
        browser: { externalBrowser: "off", idleTimeoutMs: 10_800_000 },
      });
      const beforeRead = yield* Effect.promise(() =>
        readFile(join(sessions, `${chat.id}.jsonl`), "utf8"),
      );
      assert.equal((yield* runtime.transcript(chat.id)).currentModel?.id, "workspace");
      assert.deepEqual((yield* Effect.promise(readJournal)).markers, []);
      assert.equal(
        yield* Effect.promise(() => readFile(join(sessions, `${chat.id}.jsonl`), "utf8")),
        beforeRead,
      );
      assert.equal((yield* runtime.transcript(secondChatId)).currentModel?.id, "default");
      for (const scenario of coldCases) {
        const sessionFile = join(sessions, `${scenario.chatId}.jsonl`);
        const before = yield* Effect.promise(() => readFile(sessionFile, "utf8"));
        assert.deepEqual(
          (yield* runtime.transcript(scenario.chatId)).currentModel,
          scenario.expected,
        );
        assert.equal(yield* Effect.promise(() => readFile(sessionFile, "utf8")), before);
      }
      assert.equal(yield* Effect.promise(() => Bun.file(authCommandMarker).exists()), false);
      assert.equal(yield* Effect.promise(() => Bun.file(extensionInitMarker).exists()), false);
      for (const scenario of coldCases) {
        if (scenario.expected === null) continue;
        yield* runtime.contextUsage(scenario.chatId);
        assert.deepEqual(
          (yield* runtime.transcript(scenario.chatId)).currentModel,
          scenario.expected,
        );
      }
      const extensionChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000006");
      yield* runtime.contextUsage(extensionChatId);
      assert.deepEqual((yield* runtime.transcript(extensionChatId)).currentModel, {
        provider: "pico-extension",
        id: "preferred",
        name: "Extension preferred",
      });
      yield* runtime.contextUsage(chat.id);
      const started = { title: "extension-ready", markers: startMarkers(1, "workspace") };
      assert.deepEqual(yield* Effect.promise(readJournal), started);

      yield* runtime.contextUsage(chat.id);
      assert.deepEqual(yield* Effect.promise(readJournal), started);
      const switched = yield* runtime.switchModel(chat.id, {
        provider: "pico-fixture",
        id: "switched",
      });
      assert.equal(switched.kind, "persisted");
      assert.equal(switched.model.id, "switched");
      assert.deepEqual((yield* runtime.transcript(chat.id)).currentModel, switched.model);
      assert.equal((yield* runtime.transcript(secondChatId)).currentModel?.id, "default");

      yield* runtime.close(chat.id);
      const closed = { ...started, markers: [...started.markers, stopMarker] };
      assert.deepEqual(yield* Effect.promise(readJournal), closed);
      assert.deepEqual((yield* runtime.transcript(chat.id)).currentModel, switched.model);
      assert.deepEqual(yield* Effect.promise(readJournal), closed);

      yield* runtime.contextUsage(chat.id);
      const reopened = { ...closed, markers: [...closed.markers, ...startMarkers(2, "switched")] };
      assert.deepEqual(yield* Effect.promise(readJournal), reopened);

      yield* runtime.close(chat.id);
      assert.deepEqual(yield* Effect.promise(readJournal), {
        ...reopened,
        markers: [...reopened.markers, stopMarker],
      });
    }),
  ).pipe(Effect.provide(platform)),
);
