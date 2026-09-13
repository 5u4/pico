import * as Schema from "effect/Schema";

const coordinate = Schema.Number.check(Schema.isFinite());
const Input = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ack"), seq: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("input_mouse"),
    eventType: Schema.Literals(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: coordinate,
    y: coordinate,
    button: Schema.Literals(["left", "right", "middle", "none"]),
    clickCount: Schema.Int,
    modifiers: Schema.Int,
    deltaX: coordinate,
    deltaY: coordinate,
  }),
  Schema.Struct({
    type: Schema.Literal("input_keyboard"),
    eventType: Schema.Literals(["keyDown", "keyUp", "char"]),
    key: Schema.String,
    code: Schema.String,
    text: Schema.String,
    windowsVirtualKeyCode: Schema.Int,
    modifiers: Schema.Int,
  }),
]);
const decodeInput = Schema.decodeUnknownSync(Input);
type InputMessage = typeof Input.Type;
const tabId = Schema.String.check(Schema.isPattern(/^t[1-9]\d*$/));
const TabsRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("refresh") }),
  Schema.Struct({ action: Schema.Literal("select"), tabId }),
]);
const decodeTabsRequest = Schema.decodeUnknownSync(TabsRequest);
export type BrowserTabsRequest = typeof TabsRequest.Type;
export const BrowserTabs = Schema.Struct({
  tabs: Schema.Array(
    Schema.Struct({ tabId, title: Schema.String, url: Schema.String, active: Schema.Boolean }),
  ),
});
type Route = {
  readonly port: number;
  readonly identity: number;
  readonly valid: () => Promise<boolean>;
  readonly tabs: (request: BrowserTabsRequest) => Promise<typeof BrowserTabs.Type>;
  readonly sockets: Set<Bun.ServerWebSocket<Connection>>;
};
type Connection = {
  readonly route: Route;
  upstream: WebSocket | null;
  verified: boolean;
  readonly keys: Map<string, InputMessage & { type: "input_keyboard" }>;
  readonly buttons: Map<string, InputMessage & { type: "input_mouse" }>;
};

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pico browser</title><style>
*{box-sizing:border-box}body{margin:0;background:#171918;color:#f4f5f2;font:15px system-ui,sans-serif}header{padding:16px 24px;border-bottom:1px solid #40443f;display:flex;gap:16px;align-items:center;flex-wrap:wrap}h1{font-size:18px;margin:0}#status{color:#d0d8cb}#url{margin:0;padding:10px 24px;overflow-wrap:anywhere;color:#bbcbb4;min-height:38px}main{padding:0 24px 24px}canvas{display:block;max-width:100%;height:auto;background:white;touch-action:none;outline-offset:4px}canvas:focus{outline:3px solid #96c883}button,input,select{font:inherit;padding:10px 12px;border:1px solid #899081;border-radius:5px}button{cursor:pointer;background:#e8efdf;color:#172115;min-height:44px}button:disabled{cursor:default;opacity:.6}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #96c883;outline-offset:2px}form{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:18px 0}input,select{background:#242822;color:inherit}input{min-width:230px}select{min-width:0;max-width:100%;min-height:44px}p{line-height:1.5}small{color:#c0c4bb}</style></head><body><header><h1>Pico browser</h1><span id="status" role="status" aria-live="polite">Connecting</span><button id="connect" type="button">Reconnect viewer</button><button id="disconnect" type="button">Disconnect viewer</button></header><p id="url"></p><main><form id="tabs-form"><label for="tabs">Browser tab</label><select id="tabs" aria-describedby="tabs-help" disabled><option value="">Refresh tabs to load open pages</option></select><button id="select-tab" type="submit" disabled>Show tab</button><button id="refresh-tabs" type="button">Refresh tabs</button><span id="tabs-status" role="status" aria-live="polite"></span></form><p id="tabs-help">Opened a login popup? Refresh tabs, then choose it and select Show tab.</p><canvas id="page" tabindex="0" aria-label="Remote browser. Click to interact, then type. Escape releases keyboard focus."></canvas><form id="text-form"><label for="text">Send text to focused field</label><input id="text" type="password" autocomplete="off"><button type="submit">Send text</button></form><p>Complete login here, then send a message in your Pico chat to resume. This viewer does not resume the assistant automatically.</p><small>Local to the daemon machine. Native passkey and operating-system dialogs may need explicitly requested headed mode. Hiding this page stops its stream.</small></main><script src="./client.js"></script></body></html>`;

export const makeBrowserViewer = () => {
  const routes = new Map<string, Route>();
  let server: Bun.Server<Connection> | undefined;
  const release = (connection: Connection) => {
    const upstream = connection.upstream;
    if (upstream?.readyState === WebSocket.OPEN) {
      for (const event of connection.keys.values())
        upstream.send(JSON.stringify({ ...event, eventType: "keyUp", text: "", modifiers: 0 }));
      for (const event of connection.buttons.values())
        upstream.send(JSON.stringify({ ...event, eventType: "mouseReleased", modifiers: 0 }));
    }
    connection.keys.clear();
    connection.buttons.clear();
    connection.verified = false;
    upstream?.close();
    connection.upstream = null;
  };
  const revoke = (token: string) => {
    const route = routes.get(token);
    if (!route) return;
    routes.delete(token);
    for (const socket of route.sockets) {
      release(socket.data);
      socket.close(1001, "Browser viewer closed");
    }
  };
  return {
    expose({
      port,
      identity,
      valid,
      tabs,
      previous,
    }: Omit<Route, "sockets"> & { readonly previous: string | undefined }) {
      if (
        previous &&
        routes.get(previous)?.port === port &&
        routes.get(previous)?.identity === identity &&
        server
      )
        return { token: previous, url: `http://127.0.0.1:${server.port}/${previous}/` };
      if (previous) revoke(previous);
      if (!server)
        server = Bun.serve<Connection>({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request, current) {
            const url = new URL(request.url);
            const host = request.headers.get("host");
            const allowedHost =
              host === `127.0.0.1:${current.port}` || host === `localhost:${current.port}`;
            const headers = {
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy":
                "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            };
            const origin = request.headers.get("origin");
            if (!allowedHost || (origin !== null && origin !== `http://${host}`))
              return new Response("Forbidden", { status: 403, headers });
            const parts = url.pathname.split("/");
            const token = parts[1] ?? "";
            const route = routes.get(token);
            if (!route || parts.length !== 3)
              return new Response("Viewer expired", { status: 404, headers });
            if (parts[2] === "tabs") {
              if (request.method !== "POST")
                return new Response("Method not allowed", { status: 405, headers });
              if (
                origin !== `http://${host}` ||
                request.headers.get("content-type") !== "application/json"
              )
                return new Response("Forbidden", { status: 403, headers });
              let command: BrowserTabsRequest;
              try {
                command = decodeTabsRequest(await request.json());
              } catch {
                return new Response("Invalid tab request", { status: 400, headers });
              }
              if (!(await route.valid()) || routes.get(token) !== route)
                return new Response("Viewer expired", { status: 410, headers });
              try {
                const result = await route.tabs(command);
                if (!(await route.valid()) || routes.get(token) !== route)
                  return new Response("Viewer expired", { status: 410, headers });
                return Response.json(result, { headers });
              } catch {
                if (!(await route.valid()) || routes.get(token) !== route)
                  return new Response("Viewer expired", { status: 410, headers });
                return new Response("Could not update tabs. Refresh tabs to check the browser.", {
                  status: 409,
                  headers,
                });
              }
            }
            if (request.method !== "GET")
              return new Response("Method not allowed", { status: 405, headers });
            if (parts[2] === "ws") {
              if (origin !== `http://${host}`)
                return new Response("Forbidden", { status: 403, headers });
              if (!(await route.valid()) || routes.get(token) !== route)
                return new Response("Viewer expired", { status: 410, headers });
              if (
                current.upgrade(request, {
                  data: {
                    route,
                    upstream: null,
                    verified: false,
                    keys: new Map(),
                    buttons: new Map(),
                  },
                })
              )
                return;
              return new Response("WebSocket required", { status: 400, headers });
            }
            if (parts[2] === "client.js")
              return new Response(
                Bun.file(new URL("./browser-viewer-client.js", import.meta.url)),
                { headers: { ...headers, "Content-Type": "text/javascript" } },
              );
            if (parts[2] !== "") return new Response("Not found", { status: 404, headers });
            return new Response(html, {
              headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
            });
          },
          websocket: {
            maxPayloadLength: 128 * 1024,
            open(socket) {
              socket.data.route.sockets.add(socket);
              const upstream = new WebSocket(
                `ws://127.0.0.1:${socket.data.route.port}/?pacing=ack&maxFps=10`,
              );
              socket.data.upstream = upstream;
              const pending: string[] = [];
              upstream.onopen = async () => {
                if (!(await socket.data.route.valid()) || socket.data.upstream !== upstream) {
                  socket.close(1001, "Viewer expired");
                  return;
                }
                socket.data.verified = true;
                for (const message of pending) socket.send(message);
                pending.length = 0;
              };
              upstream.onmessage = (event) => {
                if (typeof event.data !== "string") return;
                if (socket.data.verified) socket.send(event.data);
                else if (pending.length < 8) pending.push(event.data);
                else socket.close(1013, "Viewer is not ready");
              };
              upstream.onclose = () => socket.close(1001, "Browser disconnected");
              upstream.onerror = () => socket.close(1011, "Browser disconnected");
            },
            message(socket, raw) {
              try {
                const message = decodeInput(
                  JSON.parse(typeof raw === "string" ? raw : raw.toString()),
                );
                const upstream = socket.data.upstream;
                if (!socket.data.verified || upstream?.readyState !== WebSocket.OPEN) return;
                if (message.type === "input_keyboard") {
                  if (message.eventType === "keyDown")
                    socket.data.keys.set(message.code || message.key, message);
                  else if (message.eventType === "keyUp")
                    socket.data.keys.delete(message.code || message.key);
                } else if (message.type === "input_mouse") {
                  if (message.eventType === "mousePressed")
                    socket.data.buttons.set(message.button, message);
                  else if (message.eventType === "mouseReleased")
                    socket.data.buttons.delete(message.button);
                }
                upstream.send(JSON.stringify(message));
              } catch {
                socket.close(1008, "Invalid viewer input");
              }
            },
            close(socket) {
              release(socket.data);
              socket.data.route.sockets.delete(socket);
            },
          },
        });
      const token = crypto.randomUUID().replaceAll("-", "");
      routes.set(token, { port, identity, valid, tabs, sockets: new Set() });
      return { token, url: `http://127.0.0.1:${server.port}/${token}/` };
    },
    revoke,
    async dispose() {
      for (const token of routes.keys()) revoke(token);
      await server?.stop(true);
      server = undefined;
    },
  };
};
