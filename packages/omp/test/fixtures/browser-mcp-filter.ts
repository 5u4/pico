import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { BranchNaming } from "@pico/contract/branch-naming";
import * as Chat from "@pico/contract/chat-model";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { PicoRoot } from "@pico/contract/config";
import { AbsolutePath } from "@pico/contract/path";
import { Schedules } from "@pico/contract/schedule";
import { WorkspaceId } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const root = process.cwd();
assert.equal(process.env.HOME, root);
const agentDir = join(root, ".omp", "agent");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
const cwd = AbsolutePath.make(join(root, "project"));
const serverPath = Bun.fileURLToPath(new URL("./browser-mcp-server.ts", import.meta.url));
const namedBrowserMarker = join(root, "playwright.started");
const packagedBrowserMarker = join(root, "packaged-browser.started");
const browserMarkers = [namedBrowserMarker, packagedBrowserMarker];
const mathMarker = join(root, "local-math.started");
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0]) => {
    throw new Error(`Unexpected network request: ${String(input)}`);
  },
  {
    preconnect: (input: string | URL) => {
      throw new Error(`Unexpected network preconnection: ${String(input)}`);
    },
  },
);

try {
  const { PROVIDER_REGISTRY } = await import("@oh-my-pi/pi-ai/registry");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(
    join(agentDir, "config.yml"),
    `disabledProviders: ${JSON.stringify([...PROVIDER_REGISTRY.map(({ id }) => id), "ollama", "llama.cpp", "lm-studio"])}\nlsp:\n  enabled: false\nskills:\n  enabled: false\n`,
  );
  await writeFile(join(cwd, ".omp", "config.yml"), "browser:\n  enabled: true\n");
  const server = (marker: string, ...args: string[]) => ({
    command: process.execPath,
    args: ["--no-env-file", serverPath, marker, ...args],
    cwd: root,
  });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { playwright: server(namedBrowserMarker) } }),
  );
  await writeFile(
    join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "packaged-browser": server(packagedBrowserMarker, "@playwright/mcp"),
        "local-math": server(mathMarker),
      },
    }),
  );

  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  await Settings.init({ cwd });
  const [{ loadAllMCPConfigs }, { MCPManager }, { callTool }, { make }] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/mcp/config"),
    import("@oh-my-pi/pi-coding-agent/mcp/manager"),
    import("@oh-my-pi/pi-coding-agent/mcp/client"),
    import("../../src/layer.ts"),
  ]);
  const unfiltered = await loadAllMCPConfigs(cwd, { filterBrowser: false });
  assert.deepEqual(Object.keys(unfiltered.configs).sort(), [
    "local-math",
    "packaged-browser",
    "playwright",
  ]);
  const chat = Chat.Chat.make({
    id: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001"),
    workspaceId: WorkspaceId.make("018f47a0-0000-7000-8000-000000000002"),
    cwd,
    externalId: null,
    createdAt: 0,
    archivedAt: null,
  });
  const unusedSchedule = () => Effect.die("Unexpected schedule operation");
  const schedules = Schedules.of({
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
      resolve: () => Effect.succeed({ chat, platform: null, appendSystemPrompt: "" }),
    }),
    Layer.succeed(BranchNaming, {
      handle: () => {
        throw new Error("Unexpected title generation");
      },
    }),
  );
  const assertBrowserNotStarted = async () => {
    for (const marker of browserMarkers) {
      assert.equal(await Bun.file(marker).exists(), false, `Browser MCP started: ${marker}`);
    }
  };

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* make({
            paths: {
              root: PicoRoot.make(root),
              sessionsDir: AbsolutePath.make(join(root, "sessions")),
            },
            schedules,
            browser: { idleTimeoutMs: 60_000 },
          });
          yield* runtime.contextUsage(chat.id);
          const manager = MCPManager.instance();
          assert.ok(manager, "The real runtime did not initialize MCP");
          const sum = async (a: number, b: number) => {
            const tool = manager
              .getTools()
              .find((candidate) => candidate.mcpServerName === "local-math");
            assert.ok(tool?.mcpToolName, "The unrelated MCP tool is unavailable");
            const connection = manager.getConnection("local-math");
            assert.ok(connection, "The unrelated MCP server is disconnected");
            const result = await callTool(connection, tool.mcpToolName, { a, b });
            return result.content;
          };
          yield* Effect.promise(assertBrowserNotStarted);
          assert.deepEqual(yield* Effect.promise(() => sum(19, 23)), [
            { type: "text", text: "LOCAL_SUM=42" },
          ]);

          yield* Effect.promise(() => manager.reconcileBrowserFilter(false));
          yield* Effect.promise(assertBrowserNotStarted);
          assert.deepEqual(yield* Effect.promise(() => sum(-8, 25)), [
            { type: "text", text: "LOCAL_SUM=17" },
          ]);
          assert.equal(
            yield* Effect.promise(() => readFile(`${mathMarker}.calls`, "utf8")),
            "42\n17\n",
          );

          yield* runtime.close(chat.id);
          assert.equal(manager.getConnectionStatus("local-math"), "disconnected");
        }),
      ).pipe(Effect.provide(platform)),
    );
  } finally {
    await MCPManager.instance()?.disconnectAll();
  }

  assert.equal(await Bun.file(`${mathMarker}.stopped`).exists(), true);
  const pid = Number(await readFile(mathMarker, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assertBrowserNotStarted();
} finally {
  globalThis.fetch = originalFetch;
}
