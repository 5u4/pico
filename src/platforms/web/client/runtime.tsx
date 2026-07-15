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
import { z } from "zod";
import type { ContextUsageInfo } from "../../../engine/conversations";
import type { Message } from "../../../engine/message";
import type { ClientCommand, ServerEvent, WorkspaceSummary } from "../protocol";
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
  error: string | null;
  dismissError: () => void;
  select: (conversationId: string) => void;
  create: (workspaceId: string) => void;
  createWorkspace: (label: string) => void;
  archive: (conversationId: string) => void;
};

type ThreadContextValue = {
  threadKey: string;
  messages: Message[];
  isRunning: boolean;
  usage: ContextUsageInfo | null;
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
  const stateRef = useRef(initialState);
  const [state, setState] = useState(initialState);
  const socketRef = useRef<WebSocket | null>(null);
  const outbox = useRef<string[]>([]);

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
    },
    [flush],
  );

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
        stateRef.current = {
          ...stateRef.current,
          error: "received a malformed message from the server",
        };
        setState(stateRef.current);
        return;
      }
      dispatch({ type: "server", event: parsed });
    };
    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [dispatch]);

  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
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
  const cancel = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);
  const dismissError = useCallback(
    () => dispatch({ type: "dismissError" }),
    [dispatch],
  );
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
  const archive = useCallback(
    (conversationId: string) => dispatch({ type: "archive", conversationId }),
    [dispatch],
  );

  const shell = useMemo<ShellContextValue>(
    () => ({
      workspaces: state.workspaces,
      activeId: state.activeId,
      draftWorkspaceId: state.draftWorkspaceId,
      error: state.error,
      dismissError,
      select,
      create,
      createWorkspace,
      archive,
    }),
    [
      state.workspaces,
      state.activeId,
      state.draftWorkspaceId,
      state.error,
      dismissError,
      select,
      create,
      createWorkspace,
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
      prompt,
      cancel,
    }),
    [state, view, prompt, cancel],
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
