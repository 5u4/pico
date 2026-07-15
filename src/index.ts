import type {
  AgentSession,
  AgentSessionEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { ServerWebSocket } from "bun";
import { loadConfig } from "./config/config";
import { provisionRuntime } from "./omp/runtime";
import { Sessions } from "./omp/sessions";
import { autoTitle } from "./omp/title";
import { defaultDbPath, openDb } from "./store/db";
import type { Conversation } from "./store/schema";
import index from "./web/client/index.html";
import { toUiMessage, toUiMessages } from "./web/convert";
import {
  type ClientCommand,
  parseClientCommand,
  type ServerEvent,
  type WorkspaceSummary,
} from "./web/protocol";
import {
  createConversation,
  createWorkspace,
  getConversation,
  getOrCreateDefaultWorkspace,
  getWorkspace,
  listConversations,
  listWorkspaces,
  setConversationTitle,
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
getOrCreateDefaultWorkspace(db, config.workspaceCwd);
const sessions = new Sessions(provisioned.value);

const allSockets = new Set<Ws>();
const subscribers = new Map<string, Set<Ws>>();
const subscribed = new Set<string>();

function workspaceTree(): WorkspaceSummary[] {
  return listWorkspaces(db).map((w) => ({
    id: w.id,
    label: w.label,
    conversations: listConversations(db, w.id).map((c) => ({
      id: c.id,
      title: c.title,
    })),
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

function streamFor(conversationId: string): ServerEvent | undefined {
  const session = sessions.get(conversationId);
  if (!session) return undefined;
  const state = session.state;
  const tail = state.streamMessage;
  const message = tail
    ? (toUiMessage(tail, state.messages.length) ?? null)
    : null;
  return {
    kind: "stream",
    conversationId,
    message,
    isStreaming: state.isStreaming,
  };
}

function pushStream(conversationId: string): void {
  const event = streamFor(conversationId);
  if (!event) return;
  const payload = JSON.stringify(event);
  for (const ws of subscribers.get(conversationId) ?? []) ws.send(payload);
}

function dispatch(conversationId: string, event: AgentSessionEvent): void {
  if (event.type === "message_update") pushStream(conversationId);
  else pushSnapshot(conversationId);
}

async function ensureOpen(
  conversationId: string,
  conversationCwd: string,
): Promise<string | undefined> {
  const opened = await sessions.open(conversationId, { cwd: conversationCwd });
  if (opened.isErr()) return opened.error;
  if (!subscribed.has(conversationId)) {
    subscribed.add(conversationId);
    opened.value.subscribe((event) => dispatch(conversationId, event));
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

function detach(ws: Ws): void {
  if (ws.data.conversationId)
    subscribers.get(ws.data.conversationId)?.delete(ws);
  ws.data.conversationId = null;
}

function sendWorkspaces(ws: Ws, draftWorkspaceId?: string): void {
  const event: ServerEvent = {
    kind: "workspaces",
    items: workspaceTree(),
    activeId: ws.data.conversationId,
    ...(draftWorkspaceId ? { draftWorkspaceId } : {}),
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
  sendWorkspaces(ws);
  const snap = snapshotFor(conversationId);
  if (snap) ws.send(JSON.stringify(snap));
}

async function maybeAutoTitle(
  conversationId: string,
  session: AgentSession,
  text: string,
): Promise<void> {
  if (getConversation(db, conversationId)?.title != null) return;
  const title = await autoTitle(session, text).catch(() => null);
  if (!title) return;
  if (!setConversationTitle(db, conversationId, title)) return;
  if (!session.sessionName) {
    await session.setSessionName(title, "auto").catch((e: unknown) => {
      console.error(`title sync to omp session failed: ${e}`);
    });
  }
  for (const ws of allSockets) sendWorkspaces(ws);
}

async function runPrompt(
  ws: Ws,
  conversationId: string,
  session: AgentSession,
  text: string,
): Promise<void> {
  void maybeAutoTitle(conversationId, session, text).catch((e: unknown) => {
    console.error(`auto-title failed: ${e}`);
  });
  const error = await session
    .prompt(text)
    .then(() => undefined)
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (error) sendError(ws, error);
}

async function handleCommand(ws: Ws, command: ClientCommand): Promise<void> {
  if (command.kind === "prompt" || command.kind === "abort") {
    const conversationId = ws.data.conversationId;
    const session = conversationId ? sessions.get(conversationId) : undefined;
    if (!conversationId || !session) {
      sendError(ws, "no active conversation; retry once connected");
      return;
    }
    if (command.kind === "prompt") {
      await runPrompt(ws, conversationId, session, command.text);
    } else {
      const error = await session
        .abort()
        .then(() => undefined)
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      if (error) sendError(ws, error);
    }
    return;
  }

  if (command.kind === "draft") {
    detach(ws);
    sendWorkspaces(ws);
    return;
  }

  if (command.kind === "select") {
    const conversation = getConversation(db, command.conversationId);
    const target = conversation
      ? getWorkspace(db, conversation.workspaceId)
      : undefined;
    if (!conversation || !target || target.platform !== "web") {
      sendError(ws, `unknown conversation: ${command.conversationId}`);
      return;
    }
    await activate(ws, conversation.id, conversation.cwd);
    return;
  }

  if (command.kind === "createWorkspace") {
    const created = createWorkspace(db, {
      cwd: config.workspaceCwd,
      label: command.label,
    });
    detach(ws);
    sendWorkspaces(ws, created.id);
    for (const other of allSockets) if (other !== ws) sendWorkspaces(other);
    return;
  }

  const target = getWorkspace(db, command.workspaceId);
  if (target?.platform !== "web") {
    sendError(ws, `unknown workspace: ${command.workspaceId}`);
    return;
  }
  const created = createConversation(db, {
    workspaceId: target.id,
    cwd: target.cwd,
    title: null,
  });
  const error = await ensureOpen(created.id, created.cwd);
  if (error) {
    sendError(ws, error);
    return;
  }
  attach(ws, created.id);
  sendWorkspaces(ws);
  for (const other of allSockets) if (other !== ws) sendWorkspaces(other);
  const session = sessions.get(created.id);
  if (command.prompt && session) {
    await runPrompt(ws, created.id, session, command.prompt);
  } else {
    const snap = snapshotFor(created.id);
    if (snap) ws.send(JSON.stringify(snap));
  }
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
      allSockets.add(ws);
      const active = listWorkspaces(db)
        .flatMap((w) => listConversations(db, w.id))
        .reduce<Conversation | undefined>(
          (newest, c) =>
            newest === undefined || c.createdAt > newest.createdAt ? c : newest,
          undefined,
        );
      if (active) {
        await activate(ws, active.id, active.cwd);
      } else {
        const target = getOrCreateDefaultWorkspace(db, config.workspaceCwd);
        sendWorkspaces(ws, target.id);
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
  `pico web on http://localhost:${server.port} (workspaces in ${config.workspaceCwd})`,
);
