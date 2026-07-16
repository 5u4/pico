import { dispose } from "@logtape/logtape";
import { loadConfig } from "./config/config";
import { Engine } from "./engine/conversations";
import { getOrCreateDefaultWorkspace } from "./engine/registry";
import { provisionRuntime } from "./engine/runtime";
import { Sessions } from "./engine/sessions";
import { autoTitle } from "./engine/title";
import { WebHub } from "./platforms/web/adapter";
import index from "./platforms/web/client/index.html";
import { createServer } from "./platforms/web/server";
import { defaultDbPath, openDb } from "./store/db";
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
getOrCreateDefaultWorkspace(db, "web", config.workspaceCwd, "default");
const sessions = new Sessions(provisioned.value);
const engine = new Engine({ db, sessions, autoTitle });
const hub = new WebHub({
  db,
  engine,
  workspaceCwd: config.workspaceCwd,
});

const server = createServer({
  port: config.port,
  hub,
  index,
  development: Bun.env.NODE_ENV !== "production",
});

boot.info(
  "pico web on http://localhost:{port} (workspaces in {workspaceCwd})",
  { port: server.port, workspaceCwd: config.workspaceCwd },
);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  boot.info("shutting down ({signal})", { signal });
  server.stop();
  await sessions.closeAll();
  db.close();
  await dispose();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
