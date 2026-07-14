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
  ConversationSummary,
  ServerEvent,
  UiMessage,
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
  conversations: ConversationSummary[];
  activeId: string | null;
  error: string | null;
  dismissError: () => void;
  select: (conversationId: string) => void;
  create: () => void;
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
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const pendingRef = useRef<string[]>([]);

  useEffect(() => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socketRef.current = socket;
    socket.onopen = () => {
      for (const payload of pendingRef.current) socket.send(payload);
      pendingRef.current = [];
    };
    socket.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as ServerEvent;
      if (parsed.kind === "conversations") {
        setConversations(parsed.items);
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

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    convertMessage,
    onNew: (message: AppendMessage) => {
      const part = message.content[0];
      if (part?.type !== "text")
        throw new Error("only text messages are supported");
      send({ kind: "prompt", text: part.text });
      return Promise.resolve();
    },
    onCancel: () => {
      send({ kind: "abort" });
      return Promise.resolve();
    },
  });

  const pico = useMemo<PicoContextValue>(
    () => ({
      conversations,
      activeId,
      error,
      dismissError: () => setError(null),
      select: (conversationId) => {
        if (conversationId === activeIdRef.current) return;
        activeIdRef.current = conversationId;
        setActiveId(conversationId);
        setMessages([]);
        setError(null);
        send({ kind: "select", conversationId });
      },
      create: () => {
        activeIdRef.current = null;
        setMessages([]);
        setError(null);
        send({ kind: "create" });
      },
    }),
    [conversations, activeId, error, send],
  );

  const value = useMemo(() => runtime, [runtime]);
  return (
    <PicoContext.Provider value={pico}>
      <AssistantRuntimeProvider runtime={value}>
        {children}
      </AssistantRuntimeProvider>
    </PicoContext.Provider>
  );
}
