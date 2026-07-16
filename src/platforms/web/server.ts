import type { SessionLike } from "../../engine/conversations";
import { log } from "../../util/log";
import { parseJson } from "../../util/result";
import type { WebHub } from "./adapter";
import { parseClientCommand } from "./protocol";

export type WsData = { conversationId: string | null };

export type ServerDeps<S extends SessionLike = SessionLike> = {
  port: number;
  hub: WebHub<S>;
  index: Bun.HTMLBundle | Response;
  development?: boolean;
};

export function createServer<S extends SessionLike = SessionLike>(
  deps: ServerDeps<S>,
): Bun.Server<WsData> {
  const net = log(["net"]);
  const { hub } = deps;
  return Bun.serve<WsData, "/">({
    port: deps.port,
    development: deps.development ?? false,
    routes: {
      "/": deps.index,
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
}
