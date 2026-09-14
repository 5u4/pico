import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { BotSessions } from "@pico/contract/bot-session";
import { BranchNaming } from "@pico/contract/branch-naming";
import * as Chat from "@pico/contract/chat-model";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { ExternalBrowser, PicoRoot } from "@pico/contract/config";
import { AbsolutePath } from "@pico/contract/path";
import { Schedules } from "@pico/contract/schedule";
import { WorkspaceId } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const root = process.cwd();
const externalBrowser = Schema.decodeUnknownSync(ExternalBrowser)(process.argv[2]);
const nativeBrowser =
  Schema.decodeUnknownSync(Schema.Literals(["true", "false"]))(process.argv[3]) === "true";
assert.equal(process.env.HOME, root);
const agentDir = join(root, ".omp", "agent");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
const cwd = AbsolutePath.make(join(root, "project"));
const serverPath = Bun.fileURLToPath(new URL("./browser-mcp-server.ts", import.meta.url));
const namedBrowserMarker = join(root, "playwright.started");
const packagedBrowserMarker = join(root, "packaged-browser.started");
const browserMarkers = [namedBrowserMarker, packagedBrowserMarker];
const mathMarker = join(root, "local-math.started");
const toolsMarker = join(root, "session-tools.json");
const assertNoExternalBrowserState = async () => {
  if (externalBrowser === "off") {
    await assert.rejects(access(join(root, "browser")), { code: "ENOENT" });
  }
};
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
  await writeFile(join(cwd, ".omp", "config.yml"), `browser:\n  enabled: ${nativeBrowser}\n`);
  const extensions = join(cwd, ".omp", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "browser-policy-probe.ts"),
    `export default function (api) {
  api.on("session_start", async () => {
    await Bun.write(${JSON.stringify(toolsMarker)}, JSON.stringify(api.getAllTools().map(({ name }) => name)));
  });
}
`,
  );
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
    Layer.succeed(BotSessions, {
      findByChat: () => Effect.succeed(Option.none()),
      findByWorkspace: () => Effect.die("Unexpected bot lookup"),
      findByRoot: () => Effect.die("Unexpected bot lookup"),
      createConversation: () => Effect.die("Unexpected bot creation"),
      setTurn: () => Effect.die("Unexpected bot turn"),
      saveHandoff: () => Effect.die("Unexpected bot handoff"),
      readHandoff: () => Effect.die("Unexpected bot handoff"),
      rotate: () => Effect.die("Unexpected bot rotation"),
    }),
    Layer.succeed(ChatSessionContext, {
      resolve: () =>
        Effect.succeed({ chat, platform: null, appendSystemPrompt: "", formatTurnContext: null }),
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
            browser: { externalBrowser, idleTimeoutMs: 60_000 },
          });
          yield* Effect.promise(assertNoExternalBrowserState);
          yield* runtime.contextUsage(chat.id);
          const tools = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
            JSON.parse(yield* Effect.promise(() => readFile(toolsMarker, "utf8"))),
          );
          assert.equal(tools.includes("pico_browser"), externalBrowser === "agent-browser");
          assert.equal(tools.includes("schedule_create"), true);
          const manager = MCPManager.instance();
          assert.ok(manager, "The real runtime did not initialize MCP");
          const sum = async (serverName: string, a: number, b: number) => {
            const tool = manager
              .getTools()
              .find((candidate) => candidate.mcpServerName === serverName);
            assert.ok(tool?.mcpToolName, `The MCP tool is unavailable: ${serverName}`);
            const connection = manager.getConnection(serverName);
            assert.ok(connection, `The MCP server is disconnected: ${serverName}`);
            const result = await callTool(connection, tool.mcpToolName, { a, b });
            return result.content;
          };
          if (externalBrowser === "agent-browser" || nativeBrowser) {
            yield* Effect.promise(assertBrowserNotStarted);
          } else {
            for (const serverName of ["playwright", "packaged-browser"]) {
              assert.deepEqual(yield* Effect.promise(() => sum(serverName, 1, 2)), [
                { type: "text", text: "LOCAL_SUM=3" },
              ]);
            }
          }
          assert.deepEqual(yield* Effect.promise(() => sum("local-math", 19, 23)), [
            { type: "text", text: "LOCAL_SUM=42" },
          ]);

          yield* Effect.promise(() => manager.reconcileBrowserFilter(false));
          if (externalBrowser === "agent-browser") {
            yield* Effect.promise(assertBrowserNotStarted);
          } else {
            for (const serverName of ["playwright", "packaged-browser"]) {
              assert.deepEqual(yield* Effect.promise(() => sum(serverName, 5, 7)), [
                { type: "text", text: "LOCAL_SUM=12" },
              ]);
            }
          }
          assert.deepEqual(yield* Effect.promise(() => sum("local-math", -8, 25)), [
            { type: "text", text: "LOCAL_SUM=17" },
          ]);
          assert.equal(
            yield* Effect.promise(() => readFile(`${mathMarker}.calls`, "utf8")),
            "42\n17\n",
          );
          yield* Effect.promise(() => manager.reconcileBrowserFilter(true));
          for (const serverName of ["playwright", "packaged-browser"]) {
            assert.equal(manager.getConnection(serverName), undefined);
          }

          yield* runtime.close(chat.id);
          assert.equal(manager.getConnectionStatus("local-math"), "disconnected");
          yield* Effect.promise(assertNoExternalBrowserState);
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
  if (externalBrowser === "agent-browser") {
    await assertBrowserNotStarted();
  } else {
    for (const marker of browserMarkers) {
      assert.equal(await Bun.file(`${marker}.stopped`).exists(), true);
      const browserPid = Number(await readFile(marker, "utf8"));
      assert.ok(Number.isSafeInteger(browserPid) && browserPid > 0);
      assert.throws(() => process.kill(browserPid, 0), { code: "ESRCH" });
    }
  }
  await assertNoExternalBrowserState();
} finally {
  globalThis.fetch = originalFetch;
}
