import { useAtomValue } from "@effect/atom-react/Hooks";
import { RegistryContext } from "@effect/atom-react/RegistryContext";
import { CreateWorkspace } from "@pico/contract/application";
import type { Chat, ChatId } from "@pico/contract/chat-model";
import type { Workspace, WorkspaceId } from "@pico/contract/workspace-model";
import type * as FrontendState from "@pico/frontend-state/client";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  ComposerPresentation,
  NavigationPresentation,
  TranscriptPresentation,
} from "./chat/chat-model.ts";
import { ChatScreen } from "./chat/chat-screen.tsx";
import { ConnectionRecovery } from "./chat/connection-recovery.tsx";
import type { WorkspaceFormProps } from "./chat/workspace-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { applyThemePreference, readBootstrappedTheme, type Theme } from "./theme.ts";
import { errorMessage, presentTranscript } from "./transcript-presentation.ts";

type State = ReturnType<typeof FrontendState.make>;
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

export function WorkspaceChat({ state }: { readonly state: State | null }) {
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
      platform: "web",
      externalId: null,
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
      }));
    } else {
      chat = entry.target.chat;
      if (
        registry.get(state.send(chat.id)).waiting ||
        registry.get(state.live(chat.id)).run.kind === "running"
      )
        return;
    }
    updateEntry(key, (value) => ({
      ...value,
      value: value.value === sentValue ? emptyDraft : value.value,
      submission: { kind: "sending" },
    }));
    const exit = await runCommand(registry, state.send(chat.id), {
      text: sentValue.text,
      attachments: [],
    });
    updateEntry(key, (value) => ({
      ...value,
      value: Exit.isFailure(exit) && value.value === emptyDraft ? sentValue : value.value,
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
      <ConnectionRecovery
        connection={connection.kind}
        recovery={
          recoveryOpen
            ? draftValues.map((entry) => ({
                key: entry.key,
                label: `${entry.target.kind === "chat" ? `Chat ${entry.target.chat.id.slice(-8)}` : "New chat"} in ${entry.workspace.name}`,
                text: entry.value.text,
              }))
            : null
        }
        onReload={onReload}
        onKeepEditing={() => setRecoveryOpen(false)}
        onDiscardAndReload={() => window.location.reload()}
      />
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
          desktopCollapse={{ collapsed: sidebarCollapsed, onCollapsedChange: setSidebarCollapsed }}
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
