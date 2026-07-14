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

type PicoContextValue = {
  workspaces: WorkspaceSummary[];
  activeId: string | null;
  messages: UiMessage[];
  isRunning: boolean;
  error: string | null;
  dismissError: () => void;
  select: (conversationId: string) => void;
  create: (workspaceId: string) => void;
  createWorkspace: (label: string) => void;
  prompt: (text: string) => void;
  cancel: () => void;
};

const PicoContext = createContext<PicoContextValue | null>(null);

export function usePico(): PicoContextValue {
  const value = useContext(PicoContext);
  if (!value) throw new Error("usePico must be used within RuntimeProvider");
  return value;
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const pendingRef = useRef<string[]>([]);

  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    socketRef.current = socket;
    socket.onopen = () => {
      for (const payload of pendingRef.current) socket.send(payload);
      pendingRef.current = [];
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
        activeIdRef.current = parsed.activeId;
        setActiveId(parsed.activeId);
      } else if (parsed.kind === "snapshot") {
        if (parsed.conversationId !== activeIdRef.current) return;
        setMessages(parsed.messages);
        setIsRunning(parsed.isStreaming);
      } else {
        setError(parsed.message);
      }
    };
    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, []);

  const send = useCallback((command: ClientCommand) => {
    const payload = JSON.stringify(command);
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
    else pendingRef.current.push(payload);
  }, []);

  const prompt = useCallback(
    (text: string) => {
      send({ kind: "prompt", text });
    },
    [send],
  );
  const cancel = useCallback(() => {
    send({ kind: "abort" });
  }, [send]);

  const pico = useMemo<PicoContextValue>(
    () => ({
      workspaces,
      activeId,
      messages,
      isRunning,
      error,
      dismissError: () => setError(null),
      select: (conversationId) => {
        if (conversationId === activeIdRef.current) return;
        activeIdRef.current = conversationId;
        setActiveId(conversationId);
        setMessages([]);
        setIsRunning(false);
        setError(null);
        send({ kind: "select", conversationId });
      },
      create: (workspaceId) => {
        activeIdRef.current = null;
        setActiveId(null);
        setMessages([]);
        setIsRunning(false);
        setError(null);
        send({ kind: "create", workspaceId });
      },
      createWorkspace: (label) => {
        activeIdRef.current = null;
        setActiveId(null);
        setMessages([]);
        setIsRunning(false);
        setError(null);
        send({ kind: "createWorkspace", label });
      },
      prompt,
      cancel,
    }),
    [workspaces, activeId, messages, isRunning, error, send, prompt, cancel],
  );

  return <PicoContext.Provider value={pico}>{children}</PicoContext.Provider>;
}

export function AssistantPane({ children }: { children: ReactNode }) {
  const { activeId, messages, isRunning, prompt, cancel } = usePico();
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
    <AssistantRuntimeProvider key={activeId ?? "none"} runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
