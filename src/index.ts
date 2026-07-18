import { join } from "node:path";
import { dispose } from "@logtape/logtape";
import { loadConfig } from "./config/config";
import { Engine } from "./engine/conversations";
import { renameConversationBranch } from "./engine/provision";
import { getConversation, getWorkspace } from "./engine/registry";
import { provisionRuntime } from "./engine/runtime";
import { Sessions } from "./engine/sessions";
import { autoTitle } from "./engine/title";
import { WebHub } from "./platforms/web/adapter";
import index from "./platforms/web/client/index.html";
import { createServer, type WsData } from "./platforms/web/server";
import { defaultDbPath, openDb } from "./store/db";
import { reportReady } from "./supervisor/ready";
import { configureLogging, log } from "./util/log";

const cwd = process.cwd();

await configureLogging();
const boot = log(["boot"]);

const loaded = await loadConfig();
if (loaded.isErr()) {
  boot.error("failed to load config: {error}", { error: loaded.error });
  await dispose();
  process.exit(1);
}
const config = loaded.value;

const provisioned = await provisionRuntime({ cwd });
if (provisioned.isErr()) {
  boot.error("failed to provision omp runtime: {error}", {
    error: provisioned.error,
  });
  await dispose();
  process.exit(1);
}

const db = openDb(defaultDbPath());
const sessions = new Sessions(provisioned.value, {
  identityPath: join(config.workspaceCwd, "identity.md"),
});
const engine = new Engine({
  db,
  sessions,
  autoTitle,
  onTitleSettled: async (conversationId, title) => {
    const conversation = getConversation(db, conversationId);
    if (!conversation) return;
    const workspace = getWorkspace(db, conversation.workspaceId);
    if (!workspace) return;
    const renamed = await renameConversationBranch(
      db,
      workspace,
      conversation,
      title,
    );
    if (renamed.isErr()) {
      boot.warning("branch rename failed for {conversationId}: {error}", {
        conversationId,
        error: renamed.error,
      });
    }
  },
});
let server: Bun.Server<WsData> | undefined;
if (config.web.enabled) {
  const hub = new WebHub({
    db,
    engine,
    workspaceCwd: config.workspaceCwd,
    worktreeCwd: config.worktreeCwd,
  });
  server = createServer({
    port: config.web.port,
    hub,
    index,
    development: Bun.env.NODE_ENV !== "production",
  });
}

boot.info("web: {web} (workspaces in {workspaceCwd})", {
  web: server ? `http://localhost:${server.port}` : "disabled",
  workspaceCwd: config.workspaceCwd,
});

const supervisorSocket = Bun.env.PICO_SUPERVISOR_SOCKET;
const readyToken = Bun.env.PICO_READY_TOKEN;
if (supervisorSocket && readyToken) {
  const reported = await reportReady(supervisorSocket, readyToken);
  if (reported.isErr()) {
    boot.warning("failed to report ready to supervisor: {error}", {
      error: reported.error,
    });
  } else {
    boot.info("reported ready to supervisor");
  }
}

const stopped = Promise.withResolvers<number>();
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  boot.info("shutting down ({signal})", { signal });
  let code = 0;
  try {
    server?.stop();
    await sessions.closeAll();
    db.close();
    await dispose();
  } catch (error) {
    boot.error("error during shutdown: {error}", { error });
    code = 1;
  } finally {
    stopped.resolve(code);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.exit(await stopped.promise);
