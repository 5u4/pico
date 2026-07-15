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
import type {
  ClientCommand,
  ServerEvent,
  UiMessage,
  WorkspaceSummary,
} from "../protocol";

function convertMessage(message: UiMessage): ThreadMessageLike {
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
  error: string | null;
  dismissError: () => void;
  select: (conversationId: string) => void;
  create: (workspaceId: string) => void;
  createWorkspace: (label: string) => void;
};

type ThreadContextValue = {
  threadKey: string;
  messages: UiMessage[];
  isRunning: boolean;
  prompt: (text: string) => void;
  cancel: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);
const ThreadContext = createContext<ThreadContextValue | null>(null);

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

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [threadKey, setThreadKey] = useState("");
  const [pending, setPending] = useState<UiMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const draftWorkspaceRef = useRef<string | null>(null);
  const pendingRef = useRef<{ baseUserCount: number } | null>(null);
  const draftSeqRef = useRef(0);
  const outbox = useRef<string[]>([]);

  const applyServer = useCallback((next: UiMessage[]) => {
    setMessages(next);
    const p = pendingRef.current;
    if (p) {
      const userCount = next.filter((m) => m.role === "user").length;
      if (userCount > p.baseUserCount) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  }, []);
  const nextDraftKey = useCallback(() => {
    draftSeqRef.current += 1;
    return `draft-${draftSeqRef.current}`;
  }, []);

  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    socketRef.current = socket;
    socket.onopen = () => {
      for (const payload of outbox.current) socket.send(payload);
      outbox.current = [];
    };
    socket.onmessage = (event) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(event.data) as ServerEvent;
      } catch {
        setError("received a malformed message from the server");
        return;
      }
      if (parsed.kind === "workspaces") {
        setWorkspaces(parsed.items);
        if (parsed.activeId !== null) {
          activeIdRef.current = parsed.activeId;
          draftWorkspaceRef.current = null;
          setActiveId(parsed.activeId);
          setThreadKey((k) => (k === "" ? (parsed.activeId ?? "") : k));
        } else if (parsed.draftWorkspaceId) {
          activeIdRef.current = null;
          draftWorkspaceRef.current = parsed.draftWorkspaceId;
          pendingRef.current = null;
          setActiveId(null);
          setMessages([]);
          setPending(null);
          setIsRunning(false);
          setThreadKey(nextDraftKey());
        } else {
          activeIdRef.current = null;
          setActiveId(null);
        }
      } else if (parsed.kind === "snapshot") {
        if (parsed.conversationId !== activeIdRef.current) return;
        applyServer(parsed.messages);
        setIsRunning(parsed.isStreaming);
      } else if (parsed.kind === "stream") {
        if (parsed.conversationId !== activeIdRef.current) return;
        setIsRunning(parsed.isStreaming);
        const tail = parsed.message;
        if (tail)
          setMessages((prev) => {
            const last = prev.length - 1;
            if (last >= 0 && prev[last]?.id === tail.id) {
              const next = prev.slice();
              next[last] = tail;
              return next;
            }
            const index = prev.findIndex((m) => m.id === tail.id);
            if (index === -1) return [...prev, tail];
            const next = prev.slice();
            next[index] = tail;
            return next;
          });
      } else {
        pendingRef.current = null;
        setPending(null);
        setIsRunning(false);
        setError(parsed.message);
      }
    };
    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [applyServer, nextDraftKey]);

  const send = useCallback((command: ClientCommand) => {
    const payload = JSON.stringify(command);
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
    else outbox.current.push(payload);
  }, []);

  const prompt = useCallback(
    (text: string) => {
      pendingRef.current = {
        baseUserCount: messages.filter((m) => m.role === "user").length,
      };
      setPending({
        id: "pending-user",
        role: "user",
        parts: [{ type: "text", text }],
      });
      if (activeIdRef.current === null) {
        const workspaceId = draftWorkspaceRef.current;
        if (!workspaceId) {
          setError("no workspace selected for the new conversation");
          return;
        }
        send({ kind: "create", workspaceId, prompt: text });
      } else {
        send({ kind: "prompt", text });
      }
    },
    [send, messages],
  );
  const cancel = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
    if (activeIdRef.current !== null) send({ kind: "abort" });
    else setIsRunning(false);
  }, [send]);

  const dismissError = useCallback(() => setError(null), []);
  const select = useCallback(
    (conversationId: string) => {
      if (conversationId === activeIdRef.current) return;
      activeIdRef.current = conversationId;
      draftWorkspaceRef.current = null;
      pendingRef.current = null;
      setActiveId(conversationId);
      setThreadKey(conversationId);
      setMessages([]);
      setPending(null);
      setIsRunning(false);
      setError(null);
      send({ kind: "select", conversationId });
    },
    [send],
  );
  const create = useCallback(
    (workspaceId: string) => {
      activeIdRef.current = null;
      draftWorkspaceRef.current = workspaceId;
      pendingRef.current = null;
      setActiveId(null);
      setThreadKey(nextDraftKey());
      setMessages([]);
      setPending(null);
      setIsRunning(false);
      setError(null);
      send({ kind: "draft" });
    },
    [send, nextDraftKey],
  );
  const createWorkspace = useCallback(
    (label: string) => {
      send({ kind: "createWorkspace", label });
    },
    [send],
  );

  const shell = useMemo<ShellContextValue>(
    () => ({
      workspaces,
      activeId,
      error,
      dismissError,
      select,
      create,
      createWorkspace,
    }),
    [
      workspaces,
      activeId,
      error,
      dismissError,
      select,
      create,
      createWorkspace,
    ],
  );
  const view = useMemo(
    () => (pending ? [...messages, pending] : messages),
    [messages, pending],
  );
  const thread = useMemo<ThreadContextValue>(
    () => ({
      threadKey,
      messages: view,
      isRunning: isRunning || pending !== null,
      prompt,
      cancel,
    }),
    [threadKey, view, isRunning, pending, prompt, cancel],
  );

  return (
    <ShellContext.Provider value={shell}>
      <ThreadContext.Provider value={thread}>{children}</ThreadContext.Provider>
    </ShellContext.Provider>
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
