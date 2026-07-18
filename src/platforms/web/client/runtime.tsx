import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { ContextUsageInfo } from "../../../engine/conversations";
import type { Message } from "../../../engine/message";
import type { ClientCommand, ServerEvent, WorkspaceSummary } from "../protocol";
import {
  backoffDelayMs,
  type ConnectionStatus,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECTED_NOTICE_MS,
} from "./connection";
import { PERSIST_KEYS, readPersisted, writePersisted } from "./persist";
import {
  type Action,
  initialState,
  reduce,
  selectIsRunning,
  selectView,
} from "./state";

function convertMessage(message: Message): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: message.parts.map((part) =>
      part.type === "tool-call"
        ? {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
            result: part.result,
            isError: part.isError,
          }
        : part,
    ),
  };
}

type ShellContextValue = {
  workspaces: WorkspaceSummary[];
  activeId: string | null;
  draftWorkspaceId: string | null;
  select: (conversationId: string) => void;
  create: (workspaceId: string) => void;
  createWorkspace: (label: string) => void;
  renameWorkspace: (workspaceId: string, label: string) => void;
  updateWorkspaceCwd: (
    workspaceId: string,
    cwd: string,
    worktree: { defaultBranch: string; branchPrefix: string } | null,
  ) => void;
  archive: (conversationId: string) => void;
};

type ThreadContextValue = {
  threadKey: string;
  messages: Message[];
  isRunning: boolean;
  usage: ContextUsageInfo | null;
  hasMore: boolean;
  loadingOlder: boolean;
  prompt: (text: string) => void;
  command: (name: "ping", text?: string) => void;
  cancel: () => void;
  loadOlder: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);
const ThreadContext = createContext<ThreadContextValue | null>(null);
const ConnectionContext = createContext<ConnectionStatus>("connecting");

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used within RuntimeProvider");
  return value;
}

export function useThread(): ThreadContextValue {
  const value = useContext(ThreadContext);
  if (!value) throw new Error("useThread must be used within RuntimeProvider");
  return value;
}

export function useConnection(): ConnectionStatus {
  return useContext(ConnectionContext);
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const stateRef = useRef(initialState);
  const [state, setState] = useState(initialState);
  const socketRef = useRef<WebSocket | null>(null);
  const outbox = useRef<string[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const reselectRef = useRef<string | null>(null);
  const hadOnlineRef = useRef(false);

  const send = useCallback((command: ClientCommand) => {
    const payload = JSON.stringify(command);
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
    else outbox.current.push(payload);
  }, []);

  const flush = useCallback(
    (commands: ClientCommand[]) => {
      for (const command of commands) send(command);
    },
    [send],
  );

  const dispatch = useCallback(
    (action: Action) => {
      const result = reduce(stateRef.current, action);
      stateRef.current = result.state;
      setState(result.state);
      flush(result.commands);
      if (result.toasts)
        for (const message of result.toasts)
          toast.error(message, { duration: Number.POSITIVE_INFINITY });
    },
    [flush],
  );

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;

    const stopHeartbeat = () => {
      clearInterval(heartbeatTimer);
      clearTimeout(pongTimer);
      heartbeatTimer = undefined;
      pongTimer = undefined;
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer !== undefined) return;
      const base = backoffDelayMs(attempt);
      const delay = base * (0.85 + Math.random() * 0.3);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (closed) return;
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws`);
      socketRef.current = socket;
      const active = socket;
      active.onopen = () => {
        if (closed) return;
        attempt = 0;
        clearTimeout(noticeTimer);
        if (hadOnlineRef.current) {
          setStatus("reconnected");
          noticeTimer = setTimeout(
            () => setStatus("online"),
            RECONNECTED_NOTICE_MS,
          );
        } else {
          setStatus("online");
        }
        hadOnlineRef.current = true;
        const reselect = reselectRef.current;
        if (reselect !== null)
          active.send(
            JSON.stringify({ kind: "select", conversationId: reselect }),
          );
        for (const payload of outbox.current) active.send(payload);
        outbox.current = [];
        heartbeatTimer = setInterval(() => {
          if (active.readyState !== WebSocket.OPEN) return;
          active.send(JSON.stringify({ kind: "heartbeat" }));
          clearTimeout(pongTimer);
          pongTimer = setTimeout(() => active.close(), HEARTBEAT_TIMEOUT_MS);
        }, HEARTBEAT_INTERVAL_MS);
      };
      active.onmessage = (event) => {
        let parsed: ServerEvent;
        try {
          parsed = JSON.parse(event.data) as ServerEvent;
        } catch {
          toast.error("received a malformed message from the server", {
            duration: Number.POSITIVE_INFINITY,
          });
          return;
        }
        if (parsed.kind === "heartbeatAck") {
          clearTimeout(pongTimer);
          pongTimer = undefined;
          return;
        }
        dispatch({ type: "server", event: parsed });
      };
      active.onclose = () => {
        if (socketRef.current === active) socketRef.current = null;
        if (active !== socket) return;
        socket = null;
        stopHeartbeat();
        if (closed) return;
        clearTimeout(noticeTimer);
        noticeTimer = undefined;
        reselectRef.current = stateRef.current.activeId;
        if (hadOnlineRef.current) setStatus("reconnecting");
        scheduleReconnect();
      };
    };

    const wake = () => {
      if (closed) return;
      if (document.visibilityState === "hidden") return;
      if (socket?.readyState === WebSocket.OPEN) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      const stale = socket;
      socket = null;
      stale?.close();
      attempt = 0;
      connect();
    };

    connect();
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      closed = true;
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
      clearTimeout(reconnectTimer);
      clearTimeout(noticeTimer);
      stopHeartbeat();
      socketRef.current = null;
      socket?.close();
    };
  }, [dispatch]);

  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    if (reselectRef.current !== null) return;
    if (state.workspaces.length === 0) return;
    if (state.activeId !== null || state.draftWorkspaceId !== null) return;
    bootstrapped.current = true;
    const wanted = readPersisted(
      PERSIST_KEYS.activeConversation,
      z.string().nullable(),
      null,
    );
    const exists =
      wanted !== null &&
      state.workspaces.some((w) =>
        w.conversations.some((c) => c.id === wanted),
      );
    const first = state.workspaces[0];
    if (exists) dispatch({ type: "select", conversationId: wanted });
    else {
      if (wanted !== null)
        writePersisted(PERSIST_KEYS.activeConversation, null);
      if (first) dispatch({ type: "create", workspaceId: first.id });
    }
  }, [state.workspaces, state.activeId, state.draftWorkspaceId, dispatch]);

  useEffect(() => {
    if (!bootstrapped.current) return;
    writePersisted(PERSIST_KEYS.activeConversation, state.activeId);
  }, [state.activeId]);

  const prompt = useCallback(
    (text: string) => dispatch({ type: "prompt", text }),
    [dispatch],
  );
  const command = useCallback(
    (name: "ping", text?: string) => dispatch({ type: "command", name, text }),
    [dispatch],
  );
  const cancel = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);
  const select = useCallback(
    (conversationId: string) => dispatch({ type: "select", conversationId }),
    [dispatch],
  );
  const create = useCallback(
    (workspaceId: string) => dispatch({ type: "create", workspaceId }),
    [dispatch],
  );
  const createWorkspace = useCallback(
    (label: string) => dispatch({ type: "createWorkspace", label }),
    [dispatch],
  );
  const renameWorkspace = useCallback(
    (workspaceId: string, label: string) =>
      dispatch({ type: "renameWorkspace", workspaceId, label }),
    [dispatch],
  );
  const updateWorkspaceCwd = useCallback(
    (
      workspaceId: string,
      cwd: string,
      worktree: { defaultBranch: string; branchPrefix: string } | null,
    ) => dispatch({ type: "updateWorkspaceCwd", workspaceId, cwd, worktree }),
    [dispatch],
  );
  const archive = useCallback(
    (conversationId: string) => dispatch({ type: "archive", conversationId }),
    [dispatch],
  );
  const loadOlder = useCallback(
    () => dispatch({ type: "loadOlder" }),
    [dispatch],
  );

  const shell = useMemo<ShellContextValue>(
    () => ({
      workspaces: state.workspaces,
      activeId: state.activeId,
      draftWorkspaceId: state.draftWorkspaceId,
      select,
      create,
      createWorkspace,
      renameWorkspace,
      updateWorkspaceCwd,
      archive,
    }),
    [
      state.workspaces,
      state.activeId,
      state.draftWorkspaceId,
      select,
      create,
      createWorkspace,
      renameWorkspace,
      updateWorkspaceCwd,
      archive,
    ],
  );
  const view = useMemo(() => selectView(state), [state]);
  const thread = useMemo<ThreadContextValue>(
    () => ({
      threadKey: state.threadKey,
      messages: view,
      isRunning: selectIsRunning(state),
      usage: state.usage,
      hasMore: state.hasMore,
      loadingOlder: state.loadingOlder,
      prompt,
      command,
      cancel,
      loadOlder,
    }),
    [state, view, prompt, command, cancel, loadOlder],
  );

  return (
    <ConnectionContext.Provider value={status}>
      <ShellContext.Provider value={shell}>
        <ThreadContext.Provider value={thread}>
          {children}
        </ThreadContext.Provider>
      </ShellContext.Provider>
    </ConnectionContext.Provider>
  );
}

export function AssistantPane({ children }: { children: ReactNode }) {
  const { threadKey, messages, isRunning, prompt, cancel } = useThread();
  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    convertMessage,
    onNew: (message: AppendMessage) => {
      const part = message.content[0];
      if (part?.type !== "text")
        throw new Error("only text messages are supported");
      prompt(part.text);
      return Promise.resolve();
    },
    onCancel: () => {
      cancel();
      return Promise.resolve();
    },
  });
  return (
    <AssistantRuntimeProvider key={threadKey || "none"} runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
