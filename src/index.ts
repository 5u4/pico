import { dispose } from "@logtape/logtape";
import { loadConfig } from "./config/config";
import { Engine } from "./engine/conversations";
import { getOrCreateDefaultWorkspace } from "./engine/registry";
import { provisionRuntime } from "./engine/runtime";
import { Sessions } from "./engine/sessions";
import { autoTitle } from "./engine/title";
import { WebHub } from "./platforms/web/adapter";
import index from "./platforms/web/client/index.html";
import { parseClientCommand } from "./platforms/web/protocol";
import { defaultDbPath, openDb } from "./store/db";
import { configureLogging, log } from "./util/log";
import { parseJson } from "./util/result";

type WsData = { conversationId: string | null };

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

const net = log(["net"]);
const server = Bun.serve<WsData, "/">({
  port: config.port,
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    "/": index,
  },
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const origin = req.headers.get("origin");
      if (origin) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(origin).host === req.headers.get("host");
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          net.warning("rejected ws upgrade from forbidden origin {origin}", {
            origin,
          });
          return new Response("forbidden origin", { status: 403 });
        }
      }
      if (srv.upgrade(req, { data: { conversationId: null } }))
        return undefined;
      net.warning("ws upgrade failed");
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      await hub.handleOpen(ws);
    },
    async message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      const parsed = parseJson(text);
      if (parsed.isErr()) {
        net.debug("dropped malformed ws frame ({bytes} bytes)", {
          bytes: text.length,
        });
        return;
      }
      const command = parseClientCommand(parsed.value);
      if (!command) {
        net.debug("dropped unrecognized ws command");
        return;
      }
      await hub.handleCommand(ws, command);
    },
    close(ws) {
      hub.handleClose(ws);
    },
  },
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
