import { useAtomValue } from "@effect/atom-react/Hooks";
import { RegistryContext, scheduleTask } from "@effect/atom-react/RegistryContext";
import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentToolResultMessage,
  AgentTranscript,
} from "@pico/contract/agent-message";
import { CreateWorkspace } from "@pico/contract/application";
import type { Chat, ChatId } from "@pico/contract/chat-model";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import type { Workspace, WorkspaceId } from "@pico/contract/workspace-model";
import * as FrontendState from "@pico/frontend-state/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssistantBlock,
  AssistantState,
  ComposerPresentation,
  NavigationPresentation,
  ToolCallPresentation,
  ToolState,
  TranscriptItem,
  TranscriptPresentation,
} from "./chat/chat-model.ts";
import { ChatScreen, type WorkspaceFormProps } from "./chat/chat-screen.tsx";
import { Button } from "./components/ui/button.tsx";
import { applyThemePreference, readBootstrappedTheme, type Theme } from "./theme.ts";

type State = ReturnType<typeof FrontendState.make>;
interface Session {
  readonly state: State;
  readonly registry: AtomRegistry.AtomRegistry;
}
interface DraftValue {
  readonly text: string;
}
interface DraftEntry {
  readonly key: number;
  readonly workspace: Workspace;
  readonly value: DraftValue;
  readonly target: { readonly kind: "new" } | { readonly kind: "chat"; readonly chat: Chat };
  readonly submission:
    | { readonly kind: "idle" }
    | { readonly kind: "creating" }
    | { readonly kind: "sending" }
    | { readonly kind: "error"; readonly message: string };
}
interface NavigationState {
  readonly selectedKey: number | null;
  readonly entries: ReadonlyMap<number, DraftEntry>;
  readonly expanded: ReadonlySet<WorkspaceId>;
}
const emptyDraft: DraftValue = { text: "" };
const workspaceStorageKey = "pico-last-workspace";
const openingConnection = Atom.make<FrontendState.Connection>({ kind: "opening" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const decodeWorkspace = Schema.decodeUnknownOption(CreateWorkspace);

function readWorkspacePreference(): string | null {
  try {
    return window.localStorage.getItem(workspaceStorageKey);
  } catch {
    return null;
  }
}

function runCommand<A, E, Input>(
  registry: AtomRegistry.AtomRegistry,
  command: Atom.Writable<AsyncResult.AsyncResult<A, E>, Input>,
  input: Input,
): Promise<Exit.Exit<A, E>> {
  registry.set(command, input);
  return Effect.runPromiseExit(
    AtomRegistry.getResult(registry, command, { suspendOnWaiting: true }),
  );
}

export function LiveApp() {
  const bootRegistry = useContext(RegistryContext);
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const url = new URL("/rpc", window.location.href);
    url.protocol = "ws:";
    const registry = AtomRegistry.make({ scheduleTask });
    setSession({ registry, state: FrontendState.make({ url: url.href }) });
    return () => registry.dispose();
  }, []);
  return (
    <RegistryContext.Provider value={session?.registry ?? bootRegistry}>
      <LiveRoute state={session?.state ?? null} />
    </RegistryContext.Provider>
  );
}

function LiveRoute({ state }: { readonly state: State | null }) {
  const registry = useContext(RegistryContext);
  const connection = useAtomValue(state?.connection ?? openingConnection);
  const [navigation, setNavigation] = useState<NavigationState>(() => ({
    selectedKey: null,
    entries: new Map(),
    expanded: new Set(),
  }));
  const navigationRef = useRef(navigation);
  const nextDraftKey = useRef(0);
  const navigationVersion = useRef(0);
  const [initialWorkspace] = useState(readWorkspacePreference);
  const preferredWorkspace = useRef(initialWorkspace);
  const creatingChats = useRef(new Set<WorkspaceId>());
  const stoppingChats = useRef(new Set<ChatId>());
  const workspacePending = useRef(false);
  const workspaceDialogVersion = useRef(0);
  const openWorkspaceDialog = useRef<number | null>(null);
  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false);
  const [workspaceSubmission, setWorkspaceSubmission] = useState<WorkspaceFormProps["submission"]>({
    kind: "ready",
  });
  const [theme, setTheme] = useState<Theme>(readBootstrappedTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [disclosures, setDisclosures] = useState<ReadonlySet<string>>(() => new Set());
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const groupedAtom = useMemo(
    () =>
      Atom.make((get) => {
        const result = state ? get(state.workspaces) : AsyncResult.initial<readonly Workspace[]>();
        const workspaces = Option.getOrElse(AsyncResult.value(result), () => []);
        return {
          result,
          groups: workspaces.map((workspace) => ({
            workspace,
            chats:
              state && navigation.expanded.has(workspace.id)
                ? get(state.chats(workspace.id))
                : null,
          })),
        };
      }),
    [state, navigation.expanded],
  );
  const { result: workspaces, groups } = useAtomValue(groupedAtom);
  const selected =
    navigation.selectedKey === null ? undefined : navigation.entries.get(navigation.selectedKey);
  const chatId = selected?.target.kind === "chat" ? selected.target.chat.id : null;
  const conversationAtom = useMemo(
    () =>
      Atom.make((get) =>
        state && chatId
          ? {
              snapshot: get(state.transcript(chatId)),
              live: get(state.live(chatId)),
              sending: get(state.send(chatId)),
              stopping: get(state.abort(chatId)),
            }
          : null,
      ),
    [state, chatId],
  );
  const conversation = useAtomValue(conversationAtom);

  const updateNavigation = (change: (current: NavigationState) => NavigationState) => {
    const current = navigationRef.current;
    const next = change(current);
    navigationRef.current = next;
    setNavigation(next);
    if (state && current.expanded !== next.expanded) {
      for (const id of next.expanded) {
        if (current.expanded.has(id)) continue;
        const chats = state.chats(id);
        const result = registry.get(chats);
        if (result._tag !== "Initial" && !result.waiting) registry.refresh(chats);
      }
    }
  };
  const updateEntry = (key: number, change: (entry: DraftEntry) => DraftEntry) => {
    updateNavigation((current) => {
      const entry = current.entries.get(key);
      if (!entry) return current;
      return { ...current, entries: new Map(current.entries).set(key, change(entry)) };
    });
  };
  const selectDraft = (workspace: Workspace) => {
    const current = navigationRef.current;
    const existing = [...current.entries.values()].find(
      (entry) => entry.workspace.id === workspace.id && entry.target.kind === "new",
    );
    const entry: DraftEntry = existing ?? {
      key: nextDraftKey.current++,
      workspace,
      value: emptyDraft,
      target: { kind: "new" },
      submission: { kind: "idle" },
    };
    navigationVersion.current++;
    updateNavigation((value) => ({
      selectedKey: entry.key,
      entries: existing ? value.entries : new Map(value.entries).set(entry.key, entry),
      expanded: new Set(value.expanded).add(workspace.id),
    }));
  };

  useEffect(() => {
    if (workspaces._tag !== "Success" || workspaces.waiting) return;
    const current = navigationRef.current;
    const entry =
      current.selectedKey === null ? undefined : current.entries.get(current.selectedKey);
    if (entry && workspaces.value.some((workspace) => workspace.id === entry.workspace.id)) {
      try {
        window.localStorage.setItem(workspaceStorageKey, entry.workspace.id);
      } catch {}
      preferredWorkspace.current = entry.workspace.id;
      return;
    }
    const workspace =
      workspaces.value.find((item) => item.id === preferredWorkspace.current) ??
      workspaces.value[0];
    if (workspace) selectDraft(workspace);
    else {
      if (current.selectedKey !== null)
        updateNavigation((value) => ({ ...value, selectedKey: null }));
      try {
        window.localStorage.removeItem(workspaceStorageKey);
      } catch {}
    }
  }, [workspaces, selected?.workspace.id]);

  const setWorkspaceOpen = (open: boolean) => {
    openWorkspaceDialog.current = open ? ++workspaceDialogVersion.current : null;
    setWorkspaceSubmission({ kind: workspacePending.current ? "pending" : "ready" });
    setWorkspaceFormOpen(open);
  };
  const createWorkspace = async (input: { readonly name: string; readonly directory: string }) => {
    if (!state || workspacePending.current || registry.get(state.connection).kind !== "active")
      return;
    const decoded = decodeWorkspace({
      name: input.name.trim(),
      defaultCwd: input.directory,
      binding: null,
      worktree: null,
    });
    if (Option.isNone(decoded)) {
      setWorkspaceSubmission({
        kind: "error",
        message: "Enter a workspace name and an absolute directory on the machine running pico.",
      });
      return;
    }
    workspacePending.current = true;
    const dialogVersion = openWorkspaceDialog.current;
    const selectionVersion = navigationVersion.current;
    setWorkspaceSubmission({ kind: "pending" });
    const exit = await runCommand(registry, state.createWorkspace, decoded.value);
    workspacePending.current = false;
    if (openWorkspaceDialog.current !== dialogVersion) {
      setWorkspaceSubmission({ kind: "ready" });
      return;
    }
    if (Exit.isFailure(exit)) {
      setWorkspaceSubmission({ kind: "error", message: errorMessage(exit.cause) });
      return;
    }
    setWorkspaceOpen(false);
    if (navigationVersion.current === selectionVersion) selectDraft(exit.value);
  };
  const newChat = (workspaceId?: string) => {
    const current = navigationRef.current;
    const entry =
      current.selectedKey === null ? undefined : current.entries.get(current.selectedKey);
    const workspace = workspaceId
      ? groups.find((group) => group.workspace.id === workspaceId)?.workspace
      : (entry?.workspace ?? groups[0]?.workspace);
    if (workspace) selectDraft(workspace);
    else setWorkspaceOpen(true);
  };
  const selectChat = (workspaceId: string, id: string) => {
    const group = groups.find((item) => item.workspace.id === workspaceId);
    if (!group) return;
    const current = navigationRef.current;
    const existing = [...current.entries.values()].find(
      (entry) => entry.target.kind === "chat" && entry.target.chat.id === id,
    );
    const chat =
      existing?.target.kind === "chat"
        ? existing.target.chat
        : group.chats &&
          Option.getOrElse(AsyncResult.value(group.chats), () => []).find((item) => item.id === id);
    if (!chat) return;
    const entry: DraftEntry = existing ?? {
      key: nextDraftKey.current++,
      workspace: group.workspace,
      value: emptyDraft,
      target: { kind: "chat", chat },
      submission: { kind: "idle" },
    };
    navigationVersion.current++;
    updateNavigation((value) => ({
      ...value,
      selectedKey: entry.key,
      entries: existing ? value.entries : new Map(value.entries).set(entry.key, entry),
    }));
  };
  const submitDraft = async () => {
    if (!state || registry.get(state.connection).kind !== "active") return;
    const current = navigationRef.current;
    const entry =
      current.selectedKey === null ? undefined : current.entries.get(current.selectedKey);
    if (
      !entry ||
      entry.value.text.trim().length === 0 ||
      entry.submission.kind === "creating" ||
      entry.submission.kind === "sending"
    )
      return;
    const key = entry.key;
    const sentValue = entry.value;
    let chat: Chat;
    if (entry.target.kind === "new") {
      if (creatingChats.current.has(entry.workspace.id)) return;
      creatingChats.current.add(entry.workspace.id);
      updateEntry(key, (value) => ({ ...value, submission: { kind: "creating" } }));
      const exit = await runCommand(registry, state.createChat(entry.workspace.id), {
        externalId: null,
      });
      creatingChats.current.delete(entry.workspace.id);
      if (Exit.isFailure(exit)) {
        updateEntry(key, (value) => ({
          ...value,
          submission: {
            kind: "error",
            message: `${errorMessage(exit.cause)} Your draft is kept. Try sending again.`,
          },
        }));
        return;
      }
      chat = exit.value;
      updateEntry(key, (value) => ({
        ...value,
        target: { kind: "chat", chat },
        submission: { kind: "sending" },
      }));
    } else {
      chat = entry.target.chat;
      if (
        registry.get(state.send(chat.id)).waiting ||
        registry.get(state.live(chat.id)).run.kind === "running"
      )
        return;
      updateEntry(key, (value) => ({ ...value, submission: { kind: "sending" } }));
    }
    const exit = await runCommand(registry, state.send(chat.id), {
      text: sentValue.text,
      attachments: [],
    });
    updateEntry(key, (value) => ({
      ...value,
      value: Exit.isSuccess(exit) && value.value === sentValue ? emptyDraft : value.value,
      submission: Exit.isSuccess(exit)
        ? { kind: "idle" }
        : {
            kind: "error",
            message: `${errorMessage(exit.cause)} Your draft is kept. Edit or send it again.`,
          },
    }));
  };
  const stop = async () => {
    if (!state || registry.get(state.connection).kind !== "active") return;
    const current = navigationRef.current;
    const entry =
      current.selectedKey === null ? undefined : current.entries.get(current.selectedKey);
    if (entry?.target.kind !== "chat") return;
    const id = entry.target.chat.id;
    if (stoppingChats.current.has(id) || registry.get(state.abort(id)).waiting) return;
    stoppingChats.current.add(id);
    await runCommand(registry, state.abort(id), undefined);
    stoppingChats.current.delete(id);
  };

  const draftValues = [...navigation.entries.values()].filter(
    (entry) => entry.value.text.length > 0,
  );
  const unavailable = connection.kind === "unavailable";
  const available = connection.kind === "active";
  const onReload = () => {
    if (draftValues.length > 0) setRecoveryOpen(true);
    else window.location.reload();
  };
  const retryTranscript = () => {
    if (unavailable) onReload();
    else if (state && chatId) registry.refresh(state.transcript(chatId));
    else if (state) registry.refresh(state.workspaces);
  };
  const presentation: NavigationPresentation = {
    activeWorkspaceId: selected?.workspace.id ?? null,
    activeChatId: chatId,
    status:
      workspaces._tag === "Failure"
        ? { kind: "error", label: errorMessage(workspaces.cause) }
        : workspaces.waiting || workspaces._tag === "Initial"
          ? { kind: "pending", label: "Loading workspaces..." }
          : groups.length === 0
            ? { kind: "empty", label: "No workspaces yet." }
            : undefined,
    groups: groups.map(({ workspace, chats }) => {
      const records = chats ? [...Option.getOrElse(AsyncResult.value(chats), () => [])] : [];
      if (chats) {
        for (const entry of navigation.entries.values()) {
          if (entry.workspace.id !== workspace.id || entry.target.kind !== "chat") continue;
          const chat = entry.target.chat;
          if (!records.some((record) => record.id === chat.id)) records.unshift(chat);
        }
      }
      return {
        workspace: { id: workspace.id, name: workspace.name, contextLabel: workspace.defaultCwd },
        expanded: navigation.expanded.has(workspace.id),
        chats: records.map((chat) => ({
          id: chat.id,
          title:
            chat.id === chatId && conversation?.live.title
              ? conversation.live.title
              : `Chat ${chat.id.slice(-8)}`,
        })),
        status:
          chats?._tag === "Failure"
            ? { kind: "error", label: errorMessage(chats.cause) }
            : chats && (chats.waiting || chats._tag === "Initial")
              ? { kind: "pending", label: "Loading chats..." }
              : chats && records.length === 0
                ? { kind: "empty", label: "No chats yet." }
                : undefined,
      };
    }),
  };
  const creating = selected?.submission.kind === "creating";
  const sending = selected?.submission.kind === "sending" || conversation?.sending.waiting;
  const running = conversation?.live.run.kind === "running";
  const statusLabel = !selected
    ? "Add a workspace to start a chat"
    : connection.kind === "opening"
      ? "Opening connection. Draft kept."
      : !available
        ? "Connection unavailable. Draft kept."
        : creating
          ? "Creating chat. Draft kept."
          : conversation?.stopping.waiting
            ? "Stop requested..."
            : running
              ? "Pico is working"
              : sending
                ? "Waiting for response completion..."
                : conversation?.live.run.kind === "unknown"
                  ? "Run status unknown. You can send or request Stop."
                  : conversation?.live.run.kind === "finished" &&
                      conversation.live.run.outcome === "aborted"
                    ? "Response stopped"
                    : conversation?.live.run.kind === "finished" &&
                        conversation.live.run.outcome === "failed"
                      ? "Response failed. Review the error before sending again."
                      : "Enter to send · Shift+Enter for a new line";
  const composer: ComposerPresentation =
    running || sending
      ? {
          mode: "stop",
          value: selected?.value.text ?? "",
          placeholder: "Write your next message...",
          editable: true,
          canStop: available && !conversation?.stopping.waiting,
          statusLabel,
        }
      : {
          mode: "send",
          value: selected?.value.text ?? "",
          placeholder: selected
            ? "Ask pico to help with your project..."
            : "Add a workspace to start",
          editable: !!selected,
          canSubmit: available && !!selected && !creating && selected.value.text.trim().length > 0,
          statusLabel,
        };
  const transcript: TranscriptPresentation = conversation
    ? presentTranscript(conversation.snapshot, conversation.live, disclosures, connection)
    : selected
      ? {
          state: "empty",
          title: "What are you working on?",
          description: `Start a conversation in ${selected.workspace.name}.`,
        }
      : workspaces._tag === "Failure"
        ? {
            state: "error",
            title: "Workspaces unavailable",
            description: errorMessage(workspaces.cause),
            retryLabel: unavailable ? "Reload" : "Retry workspaces",
          }
        : workspaces._tag === "Initial" || workspaces.waiting
          ? { state: "loading", label: "Loading workspaces..." }
          : {
              state: "empty",
              title: "Bring your project to pico",
              description:
                "Add a workspace to chat about your code. Your conversations stay together in its project directory.",
            };

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-canvas text-foreground">
      {connection.kind !== "active" && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-3 text-label">
          <p className="min-w-0 flex-1" role={unavailable ? "alert" : "status"}>
            {unavailable
              ? "Connection unavailable. Responses and drafts are kept here. Try Reload. If pico restarted, open the new URL from its startup log."
              : "Opening connection to pico..."}
          </p>
          {unavailable && (
            <Button onClick={onReload} size="small" tone="secondary">
              Reload
            </Button>
          )}
        </div>
      )}
      {recoveryOpen && (
        <section
          aria-label="Save drafts before reloading"
          className="max-h-[60dvh] shrink-0 overflow-y-auto border-b border-border bg-panel p-4"
        >
          <h2 className="text-title font-semibold">Save drafts before reloading</h2>
          <p className="mt-1 text-label text-muted">
            Copy any drafts you want to keep. Reloading clears unsent text.
          </p>
          {draftValues.map((entry) => (
            <label className="mt-3 block text-label" key={entry.key}>
              {entry.target.kind === "chat" ? `Chat ${entry.target.chat.id.slice(-8)}` : "New chat"}{" "}
              in {entry.workspace.name}
              <textarea
                className="mt-1 block min-h-24 w-full rounded-control border border-border bg-canvas p-3 text-base"
                readOnly
                value={entry.value.text}
              />
            </label>
          ))}
          <div className="mt-3 flex flex-wrap gap-3">
            <Button onClick={() => setRecoveryOpen(false)} size="small" tone="secondary">
              Keep editing
            </Button>
            <Button onClick={() => window.location.reload()} size="small" tone="danger">
              Discard drafts and reload
            </Button>
          </div>
        </section>
      )}
      {conversation?.snapshot._tag === "Failure" && transcript.state !== "error" && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel p-3 text-label">
          <p className="min-w-0 flex-1 text-danger" role="alert">
            {errorMessage(conversation.snapshot.cause)} Displayed history may be incomplete.
          </p>
          <Button onClick={retryTranscript} size="small" tone="secondary">
            {unavailable ? "Reload" : "Retry history"}
          </Button>
        </div>
      )}
      {selected?.submission.kind === "error" && (
        <p
          className="shrink-0 border-b border-border bg-panel p-3 text-label text-danger"
          role="alert"
        >
          {selected.submission.message}
        </p>
      )}
      {conversation?.stopping._tag === "Failure" && (
        <p
          className="shrink-0 border-b border-border bg-panel p-3 text-label text-danger"
          role="alert"
        >
          {errorMessage(conversation.stopping.cause)} Stop was not confirmed. Try Stop again or
          reload to reconnect.
        </p>
      )}
      {available && conversation?.live.run.kind === "unknown" && !sending && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-2 text-label">
          <p className="min-w-0 flex-1 text-muted">
            Run status is unknown. History does not confirm whether a response is still running.
          </p>
          <Button
            disabled={conversation.stopping.waiting}
            onClick={stop}
            size="small"
            tone="secondary"
          >
            Request Stop
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ChatScreen
          composer={composer}
          contextLabel={
            selected
              ? `${selected.workspace.name} · ${selected.target.kind === "chat" ? selected.target.chat.cwd : selected.workspace.defaultCwd}`
              : "Your project conversations"
          }
          conversationKey={selected ? String(selected.key) : null}
          navigation={presentation}
          onChatSelect={selectChat}
          onChatsRetry={(id) => {
            const workspace = groups.find((group) => group.workspace.id === id)?.workspace;
            if (state && workspace) registry.refresh(state.chats(workspace.id));
          }}
          onComposerSubmit={submitDraft}
          onComposerValueChange={(text) => {
            const key = navigationRef.current.selectedKey;
            if (key !== null) updateEntry(key, (entry) => ({ ...entry, value: { text } }));
          }}
          onDisclosureToggle={(id) =>
            setDisclosures((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onNewChat={newChat}
          onSidebarOpenChange={setSidebarOpen}
          onStop={stop}
          onThemeChange={(next) => {
            applyThemePreference(next);
            setTheme(next);
          }}
          onTranscriptRetry={retryTranscript}
          onWorkspaceRetry={() => {
            if (state) registry.refresh(state.workspaces);
          }}
          onWorkspaceToggle={(id) => {
            const workspace = groups.find((group) => group.workspace.id === id)?.workspace;
            if (!workspace) return;
            updateNavigation((current) => {
              const expanded = new Set(current.expanded);
              if (expanded.has(workspace.id)) expanded.delete(workspace.id);
              else expanded.add(workspace.id);
              return { ...current, expanded };
            });
          }}
          sidebarOpen={sidebarOpen}
          theme={theme}
          title={chatId ? (conversation?.live.title ?? `Chat ${chatId.slice(-8)}`) : "New chat"}
          transcript={transcript}
          workspaceForm={{
            open: workspaceFormOpen,
            available,
            submission: workspaceSubmission,
            onOpenChange: setWorkspaceOpen,
            onSubmit: createWorkspace,
          }}
        />
      </div>
    </div>
  );
}

function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  if (error instanceof ApplicationError) return error.message;
  if (error instanceof ChatClosed) return "This chat is closed. Create a new chat to continue.";
  return "The request could not be completed.";
}

function presentTranscript(
  snapshot: AsyncResult.AsyncResult<AgentTranscript, unknown>,
  live: FrontendState.LiveChat,
  disclosures: ReadonlySet<string>,
  connection: FrontendState.Connection,
): TranscriptPresentation {
  const messages = Option.getOrElse(AsyncResult.value(snapshot), () => []);
  const results = new Map<string, AgentToolResultMessage[]>();
  for (const message of messages) {
    if (message.role !== "tool-result") continue;
    const current = results.get(message.toolCallId);
    if (current) current.push(message);
    else results.set(message.toolCallId, [message]);
  }
  const anchoredTools = new Set<string>();
  const items: TranscriptItem[] = [];
  const tool = (id: string, name: string, key: string) => {
    anchoredTools.add(id);
    const output = results.get(id);
    const activity = live.tools.get(id);
    const last = output?.at(-1);
    const state: ToolState = last
      ? { kind: last.status, label: last.status === "failed" ? "Failed" : "Complete" }
      : activity?.kind === "finished"
        ? {
            kind: activity.end.status,
            label: activity.end.status === "failed" ? "Failed" : "Complete",
          }
        : activity?.kind === "running" &&
            live.run.kind === "running" &&
            connection.kind === "active"
          ? { kind: "running", label: "Running" }
          : { kind: "unknown", label: "Status unknown" };
    const call: ToolCallPresentation = {
      id: key,
      icon: "generic",
      label: name,
      summary: "Tool call",
      state,
      output: output
        ?.flatMap((message) =>
          message.content.map((content) =>
            content.type === "text" ? content.text : "[Image result]",
          ),
        )
        .join("\n"),
    };
    items.push({
      kind: "tool-group",
      id: key,
      title: `${name} · ${state.label}`,
      calls: [call],
      open: disclosures.has(key),
    });
  };
  const append = (message: AgentMessage, key: string) => {
    if (message.role === "user") {
      items.push({
        kind: "user",
        id: key,
        text: message.content
          .map((content) => (content.type === "text" ? content.text : "[Image attachment]"))
          .join("\n"),
        timestampLabel: timeFormat.format(message.timestamp),
      });
      return;
    }
    if (message.role === "tool-result") {
      if (!anchoredTools.has(message.toolCallId)) tool(message.toolCallId, message.toolName, key);
      return;
    }
    let blocks: AssistantBlock[] = [];
    let part = 0;
    const flush = () => {
      if (blocks.length === 0) return;
      items.push({
        kind: "assistant",
        id: `${key}-part-${part++}`,
        blocks,
        state: assistantState(message),
        timestampLabel: timeFormat.format(message.timestamp),
        modelLabel: message.model,
      });
      blocks = [];
    };
    for (const [index, content] of message.content.entries()) {
      const id = `${key}-content-${index}`;
      switch (content.type) {
        case "text":
          blocks.push({ kind: "text", id, text: content.text });
          break;
        case "thinking":
          blocks.push({
            kind: "thinking",
            id,
            label: "Thinking",
            text: content.text,
            open: disclosures.has(id),
            phase: "complete",
          });
          break;
        case "image":
          blocks.push({ kind: "text", id, text: "[Image response]" });
          break;
        case "tool-call":
          flush();
          tool(content.id, content.name, id);
          break;
        default: {
          const exhaustive: never = content;
          return exhaustive;
        }
      }
    }
    flush();
    if (message.status === "failed")
      items.push({
        kind: "notice",
        id: `${key}-failure`,
        tone: message.stopReason === "aborted" ? "warning" : "error",
        title: message.stopReason === "aborted" ? "Response stopped" : "Response failed",
        text: message.message ?? "Partial output is retained. Send a message to continue.",
      });
  };
  const appendBlocks = (blocks: ReadonlyMap<number, FrontendState.LiveBlock>, key: string) => {
    if (blocks.size === 0) return;
    const active = live.run.kind === "running" && connection.kind === "active";
    items.push({
      kind: "assistant",
      id: key,
      timestampLabel: "Live response",
      modelLabel: "pico",
      state: active
        ? { kind: "streaming", label: "Responding" }
        : { kind: "unknown", label: "Partial response retained" },
      blocks: [...blocks.values()]
        .sort((a, b) => a.contentIndex - b.contentIndex)
        .map((block): AssistantBlock => {
          const id = `${key}-${block.contentIndex}`;
          return block.type === "text-delta"
            ? { kind: "text", id, text: block.text }
            : {
                kind: "thinking",
                id,
                label: "Thinking",
                text: block.text,
                open: disclosures.has(id),
                phase: active ? "streaming" : "unknown",
              };
        }),
    });
  };
  for (const [index, message] of messages.entries()) {
    append(message, `snapshot-${index}`);
  }
  live.pending.forEach((pending, index) => {
    if (pending.kind === "message") append(pending.message, `pending-${index}`);
    else appendBlocks(pending.blocks, `pending-blocks-${index}`);
  });
  appendBlocks(live.blocks, "live-blocks");
  for (const [id, activity] of live.tools) {
    if (!anchoredTools.has(id))
      tool(
        id,
        activity.kind === "running" ? activity.start.toolName : activity.end.toolName,
        `live-tool-${id}`,
      );
  }
  for (const [index, notice] of live.notices.entries()) {
    items.push({
      kind: "notice",
      id: `notice-${index}`,
      tone: notice.level,
      title: notice.level === "error" ? "Request failed" : "Pico",
      text: notice.message,
    });
  }
  if (items.length > 0)
    return {
      state: "ready",
      items,
      liveLabel: live.run.kind === "running" ? "Response in progress" : "Conversation",
    };
  if (snapshot._tag === "Failure")
    return {
      state: "error",
      title: "History unavailable",
      description: `${errorMessage(snapshot.cause)} ${connection.kind === "unavailable" ? "Reload to reconnect." : "Retry loading the conversation."}`,
      retryLabel: connection.kind === "unavailable" ? "Reload" : "Retry history",
    };
  if (snapshot.waiting || snapshot._tag === "Initial")
    return { state: "loading", label: "Loading conversation..." };
  return {
    state: "empty",
    title: "Start a conversation",
    description: "Ask pico to help with the code in this workspace.",
  };
}

function assistantState(message: AgentAssistantMessage): AssistantState {
  return message.status === "completed"
    ? { kind: "complete" }
    : {
        kind: "interrupted",
        label: message.stopReason === "aborted" ? "Stopped" : "Response failed",
      };
}
