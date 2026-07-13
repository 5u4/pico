import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";

type Bubble = { id: number; role: string; text: string };

type ServerFrame =
  | { kind: "opened"; thread_id: string; title: string }
  | { kind: "history"; bubbles: Bubble[] }
  | { kind: "bubble_new"; id: number; text: string; reply: boolean; silent: boolean }
  | { kind: "bubble_patch"; id: number; text: string }
  | { kind: "title"; title: string }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "error"; message: string };

export type TreeThread = { thread_id: string; title: string; updated_at: number };
export type TreeChannel = { channel_id: string; label: string; threads: TreeThread[] };

type SessionValue = {
  threadId: string | null;
  tree: TreeChannel[];
  isRunning: boolean;
  refreshTree: () => void;
  openThread: (id: string) => void;
  newThread: (channelId: string) => void;
  newChannel: (label: string) => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within PicoRuntimeProvider");
  return ctx;
}

const RUNNING = { type: "running" } as const;
const COMPLETE = { type: "complete", reason: "stop" } as const;

let clientIdCounter = 0;
const clientId = () => `c${clientIdCounter++}`;

const toMessage = (b: Bubble): ThreadMessageLike =>
  b.role === "user"
    ? { id: `h${b.id}`, role: "user", content: [{ type: "text", text: b.text }] }
    : { id: `h${b.id}`, role: "assistant", content: [{ type: "text", text: b.text }], status: COMPLETE };

export function PicoRuntimeProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<readonly ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeChannel[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const refreshTree = useCallback(() => {
    fetch("/api/tree")
      .then((r) => (r.ok ? r.json() : []))
      .then((t: TreeChannel[]) => setTree(t))
      .catch(() => {});
  }, []);

  const send = useCallback((frame: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }, []);
  const openThread = useCallback(
    (id: string) => {
      if (id === threadId) return;
      if (isRunning) return;
      send({ kind: "open", thread_id: id });
    },
    [send, threadId, isRunning],
  );
  const newThread = useCallback(
    (channelId: string) => {
      if (isRunning) return;
      setMessages([]);
      send({ kind: "new", channel_id: channelId });
    },
    [send, isRunning],
  );

  const newChannel = useCallback(
    async (label: string) => {
      const name = label.trim();
      if (!name) return;
      try {
        const r = await fetch("/api/channel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: name }),
        });
        if (!r.ok) {
          setMessages((prev) => [
            ...prev,
            { id: clientId(), role: "assistant", content: [{ type: "text", text: "⚠️ Could not create channel." }] },
          ]);
        }
      } finally {
        refreshTree();
      }
    },
    [refreshTree],
  );

  useEffect(() => {
    let intentional = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      const hash = location.hash.replace(/^#/, "");
      if (hash) ws.send(JSON.stringify({ kind: "open", thread_id: hash }));
    };

    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data) as ServerFrame;
      switch (f.kind) {
        case "opened":
          setThreadId(f.thread_id);
          location.hash = f.thread_id;
          document.title = f.title ? `${f.title} · pico` : "pico";
          refreshTree();
          break;
        case "history":
          setMessages(f.bubbles.map(toMessage));
          break;
        case "turn_start":
          setIsRunning(true);
          break;
        case "bubble_new":
          setMessages((prev) => [
            ...prev,
            {
              id: String(f.id),
              role: "assistant",
              content: [{ type: "text", text: f.text }],
              status: RUNNING,
            },
          ]);
          break;
        case "bubble_patch":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === String(f.id)
                ? { ...m, content: [{ type: "text", text: f.text }], status: RUNNING }
                : m,
            ),
          );
          break;
        case "turn_end":
          setIsRunning(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "assistant" && m.status?.type === "running"
                ? { ...m, status: COMPLETE }
                : m,
            ),
          );
          refreshTree();
          break;
        case "title":
          document.title = `${f.title} · pico`;
          break;
        case "error":
          setIsRunning(false);
          setMessages((prev) => [
            ...prev,
            { id: clientId(), role: "assistant", content: [{ type: "text", text: `⚠️ ${f.message}` }] },
          ]);
          break;
      }
    };

    ws.onclose = () => {
      if (intentional) return;
      setIsRunning(false);
      setMessages((prev) => [
        ...prev,
        {
          id: clientId(),
          role: "assistant",
          content: [{ type: "text", text: "⚠️ Connection lost. Reload to reconnect." }],
        },
      ]);
    };

    refreshTree();

    return () => {
      intentional = true;
      ws.close();
    };
  }, [refreshTree]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (!text) return;
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      setMessages((prev) => [
        ...prev,
        { id: clientId(), role: "assistant", content: [{ type: "text", text: "⚠️ Not connected. Reload to reconnect." }] },
      ]);
      return;
    }
    setMessages((prev) => [...prev, { id: clientId(), role: "user", content: [{ type: "text", text }] }]);
    ws.send(JSON.stringify({ kind: "prompt", text }));
  }, []);

  const onCancel = useCallback(async () => {
    send({ kind: "cancel" });
  }, [send]);

  const runtime = useExternalStoreRuntime({
    messages,
    setMessages,
    isRunning,
    onNew,
    onCancel,
    convertMessage: (m) => m,
  });

  return (
    <SessionContext.Provider value={{ threadId, tree, isRunning, refreshTree, openThread, newThread, newChannel }}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </SessionContext.Provider>
  );
}
