import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "./config/config";
import { Hub } from "./omp/hub";
import { provisionRuntime } from "./omp/runtime";
import { Sessions } from "./omp/sessions";
import { autoTitle } from "./omp/title";
import { defaultDbPath, openDb } from "./store/db";
import index from "./web/client/index.html";
import { parseClientCommand } from "./web/protocol";
import { getOrCreateDefaultWorkspace } from "./web/store";

type WsData = { conversationId: string | null };

const cwd = process.cwd();

const config = (await loadConfig()).match(
  (c) => c,
  (e) => {
    console.error(`failed to load config: ${e}`);
    process.exit(1);
  },
);

const provisioned = await provisionRuntime({ cwd });
if (provisioned.isErr()) {
  console.error(`failed to provision omp runtime: ${provisioned.error}`);
  process.exit(1);
}

const db = openDb(defaultDbPath());
getOrCreateDefaultWorkspace(db, config.workspaceCwd);
const sessions = new Sessions(provisioned.value);
const hub = new Hub<AgentSession>({
  db,
  sessions,
  workspaceCwd: config.workspaceCwd,
  autoTitle,
});

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
        if (!sameOrigin)
          return new Response("forbidden origin", { status: 403 });
      }
      return srv.upgrade(req, { data: { conversationId: null } })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      await hub.handleOpen(ws);
    },
    async message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const command = parseClientCommand(parsed);
      if (command) await hub.handleCommand(ws, command);
    },
    close(ws) {
      hub.handleClose(ws);
    },
  },
});

console.log(
  `pico web on http://localhost:${server.port} (workspaces in ${config.workspaceCwd})`,
);
