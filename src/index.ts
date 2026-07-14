import type { ServerWebSocket } from "bun";
import { loadConfig } from "./config/config";
import { provisionRuntime } from "./omp/runtime";
import { Sessions } from "./omp/sessions";
import { defaultDbPath, openDb } from "./store/db";
import index from "./web/client/index.html";
import { toUiMessages } from "./web/convert";
import {
  type ClientCommand,
  type ConversationSummary,
  parseClientCommand,
  type ServerEvent,
} from "./web/protocol";
import {
  createConversation,
  getConversation,
  getOrCreateWebWorkspace,
  listConversations,
} from "./web/store";

type WsData = { conversationId: string | null };
type Ws = ServerWebSocket<WsData>;

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
const workspace = getOrCreateWebWorkspace(db, config.projectsRoot);
const sessions = new Sessions(provisioned.value);

const allSockets = new Set<Ws>();
const subscribers = new Map<string, Set<Ws>>();
const subscribed = new Set<string>();

function summaries(): ConversationSummary[] {
  return listConversations(db, workspace.id).map((c) => ({
    id: c.id,
    title: c.title,
  }));
}

function snapshotFor(conversationId: string): ServerEvent | undefined {
  const session = sessions.get(conversationId);
  if (!session) return undefined;
  const state = session.state;
  const stream = state.streamMessage ? [state.streamMessage] : [];
  return {
    kind: "snapshot",
    conversationId,
    messages: toUiMessages([...state.messages, ...stream]),
    isStreaming: state.isStreaming,
  };
}

function pushSnapshot(conversationId: string): void {
  const event = snapshotFor(conversationId);
  if (!event) return;
  const payload = JSON.stringify(event);
  for (const ws of subscribers.get(conversationId) ?? []) ws.send(payload);
}

async function ensureOpen(
  conversationId: string,
  conversationCwd: string,
): Promise<string | undefined> {
  const opened = await sessions.open(conversationId, { cwd: conversationCwd });
  if (opened.isErr()) return opened.error;
  if (!subscribed.has(conversationId)) {
    subscribed.add(conversationId);
    opened.value.subscribe(() => pushSnapshot(conversationId));
  }
  return undefined;
}

function attach(ws: Ws, conversationId: string): void {
  if (ws.data.conversationId)
    subscribers.get(ws.data.conversationId)?.delete(ws);
  ws.data.conversationId = conversationId;
  let set = subscribers.get(conversationId);
  if (!set) {
    set = new Set();
    subscribers.set(conversationId, set);
  }
  set.add(ws);
}

function sendConversations(ws: Ws): void {
  const activeId = ws.data.conversationId;
  if (!activeId) return;
  const event: ServerEvent = {
    kind: "conversations",
    items: summaries(),
    activeId,
  };
  ws.send(JSON.stringify(event));
}

function sendError(ws: Ws, message: string): void {
  const event: ServerEvent = { kind: "error", message };
  ws.send(JSON.stringify(event));
}

async function activate(
  ws: Ws,
  conversationId: string,
  conversationCwd: string,
): Promise<void> {
  const error = await ensureOpen(conversationId, conversationCwd);
  if (error) {
    sendError(ws, error);
    return;
  }
  attach(ws, conversationId);
  sendConversations(ws);
  const snap = snapshotFor(conversationId);
  if (snap) ws.send(JSON.stringify(snap));
}

async function handleCommand(ws: Ws, command: ClientCommand): Promise<void> {
  if (command.kind === "prompt" || command.kind === "abort") {
    const conversationId = ws.data.conversationId;
    const session = conversationId ? sessions.get(conversationId) : undefined;
    if (!session) {
      sendError(ws, "no active conversation; retry once connected");
      return;
    }
    if (command.kind === "prompt") {
      const error = await session
        .prompt(command.text)
        .then(() => undefined)
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (error) sendError(ws, error);
    } else {
      const error = await session
        .abort()
        .then(() => undefined)
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (error) sendError(ws, error);
    }
    return;
  }

  if (command.kind === "select") {
    const conversation = getConversation(db, command.conversationId);
    if (!conversation || conversation.workspaceId !== workspace.id) {
      sendError(ws, `unknown conversation: ${command.conversationId}`);
      return;
    }
    await activate(ws, conversation.id, conversation.cwd);
    return;
  }

  const created = createConversation(db, {
    workspaceId: workspace.id,
    cwd: workspace.cwd,
    title: command.title ?? null,
  });
  await activate(ws, created.id, created.cwd);
  for (const other of allSockets) if (other !== ws) sendConversations(other);
}

const server = Bun.serve<WsData, "/">({
  port: config.port,
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    "/": index,
  },
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return srv.upgrade(req, { data: { conversationId: null } })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      allSockets.add(ws);
      const existing = listConversations(db, workspace.id);
      const first = existing[0];
      const active =
        first ??
        createConversation(db, {
          workspaceId: workspace.id,
          cwd: workspace.cwd,
          title: null,
        });
      await activate(ws, active.id, active.cwd);
      if (!first) {
        for (const other of allSockets)
          if (other !== ws) sendConversations(other);
      }
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
      if (command) await handleCommand(ws, command);
    },
    close(ws) {
      allSockets.delete(ws);
      if (ws.data.conversationId)
        subscribers.get(ws.data.conversationId)?.delete(ws);
    },
  },
});

console.log(
  `pico web on http://localhost:${server.port} (projects ${workspace.cwd})`,
);
