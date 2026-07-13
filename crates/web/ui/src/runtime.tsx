import { useCallback, useEffect, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";

type ServerFrame =
  | { kind: "bubble_new"; id: number; text: string; reply: boolean; silent: boolean }
  | { kind: "bubble_patch"; id: number; text: string }
  | { kind: "title"; title: string }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "error"; message: string };

const RUNNING = { type: "running" } as const;
const COMPLETE = { type: "complete", reason: "stop" } as const;

export function PicoRuntimeProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<readonly ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let intentional = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data) as ServerFrame;
      switch (f.kind) {
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
          break;
        case "title":
          document.title = `${f.title} · pico`;
          break;
        case "error":
          setIsRunning(false);
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: [{ type: "text", text: `⚠️ ${f.message}` }] },
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
          role: "assistant",
          content: [{ type: "text", text: "⚠️ Connection lost. Reload to reconnect." }],
        },
      ]);
    };

    return () => {
      intentional = true;
      ws.close();
    };
  }, []);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (!text) return;
    setMessages((prev) => [...prev, { role: "user", content: [{ type: "text", text }] }]);
    wsRef.current?.send(JSON.stringify({ kind: "prompt", text }));
  }, []);

  const onCancel = useCallback(async () => {
    wsRef.current?.send(JSON.stringify({ kind: "cancel" }));
  }, []);

  const runtime = useExternalStoreRuntime({
    messages,
    setMessages,
    isRunning,
    onNew,
    onCancel,
    convertMessage: (m) => m,
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
