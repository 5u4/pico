import { useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
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
import type { Workspace } from "@pico/contract/workspace-model";
import * as FrontendState from "@pico/frontend-state/client";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { type FormEvent, useContext, useEffect, useState } from "react";
import type {
  AssistantBlock,
  AssistantState,
  ChatSummary,
  ComposerPresentation,
  ToolCallPresentation,
  ToolState,
  TranscriptItem,
  TranscriptPresentation,
} from "./chat/chat-model.ts";
import { ChatScreen, type ChatScreenProps } from "./chat/chat-screen.tsx";
import { Button } from "./components/ui/button.tsx";
import { applyThemePreference, readBootstrappedTheme, type Theme } from "./theme.ts";

type Selection =
  | { readonly kind: "picker" }
  | { readonly kind: "workspace"; readonly workspace: Workspace }
  | { readonly kind: "chat"; readonly workspace: Workspace; readonly chat: Chat };
type State = ReturnType<typeof FrontendState.make>;
interface Session {
  readonly state: State;
  readonly registry: AtomRegistry.AtomRegistry;
}
interface Draft {
  readonly text: string;
}
type Drafts = ReadonlyMap<ChatId, Draft>;
const emptyDraft: Draft = { text: "" };
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const decodeWorkspace = Schema.decodeUnknownOption(CreateWorkspace);

export function LiveApp() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const url = new URL("/rpc", window.location.href);
    url.protocol = "ws:";
    const registry = AtomRegistry.make({ scheduleTask });
    setSession({ registry, state: FrontendState.make({ url: url.href }) });
    return () => registry.dispose();
  }, []);
  return session === null ? (
    <main className="p-6" role="status">
      Opening pico...
    </main>
  ) : (
    <RegistryContext.Provider value={session.registry}>
      <LiveRoute state={session.state} />
    </RegistryContext.Provider>
  );
}

function LiveRoute({ state }: { readonly state: State }) {
  const connection = useAtomValue(state.connection);
  const workspaces = useAtomValue(state.workspaces);
  const [selection, setSelection] = useState<Selection>({ kind: "picker" });
  const [drafts, setDrafts] = useState<Drafts>(() => new Map());
  const [theme, setTheme] = useState<Theme>(readBootstrappedTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [disclosures, setDisclosures] = useState<ReadonlySet<string>>(() => new Set());
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const registry = useContext(RegistryContext);
  const onThemeChange = (next: Theme) => {
    applyThemePreference(next);
    setTheme(next);
  };
  const draftValues = [...drafts.entries()].filter(([, draft]) => draft.text.length > 0);
  const unavailable = connection.kind === "unavailable";
  const onReload = () => {
    if (draftValues.length > 0) setRecoveryOpen(true);
    else window.location.reload();
  };
  const updateDraft = (chatId: ChatId, text: string) => {
    setDrafts((current) => new Map(current).set(chatId, { text }));
  };
  const sentDraft = (chatId: ChatId, sent: Draft) => {
    setDrafts((current) => {
      if (current.get(chatId) !== sent) return current;
      const next = new Map(current);
      next.delete(chatId);
      return next;
    });
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
          {draftValues.map(([chatId, draft]) => (
            <label className="mt-3 block text-label" key={chatId}>
              Draft for chat {chatId.slice(-8)}
              <textarea
                className="mt-1 block min-h-24 w-full rounded-control border border-border bg-canvas p-3 text-base"
                readOnly
                value={draft.text}
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
      <div className="min-h-0 flex-1">
        {selection.kind === "picker" ? (
          <WorkspacePicker
            connection={connection}
            onSelect={(workspace) => setSelection({ kind: "workspace", workspace })}
            onThemeChange={onThemeChange}
            state={state}
            theme={theme}
            workspaces={workspaces}
          />
        ) : (
          <WorkspaceView
            connection={connection}
            disclosures={disclosures}
            draft={
              selection.kind === "chat" ? (drafts.get(selection.chat.id) ?? emptyDraft) : emptyDraft
            }
            onChatCreated={(chat) =>
              setSelection((current) =>
                current === selection
                  ? { kind: "chat", workspace: selection.workspace, chat }
                  : current,
              )
            }
            onChatSelect={(chat) =>
              setSelection({ kind: "chat", workspace: selection.workspace, chat })
            }
            onDisclosureToggle={(id) =>
              setDisclosures((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onDraftChange={updateDraft}
            onDraftSent={sentDraft}
            onReload={onReload}
            onSidebarOpenChange={setSidebarOpen}
            onThemeChange={onThemeChange}
            onWorkspaceChange={() => {
              setSelection({ kind: "picker" });
              setSidebarOpen(false);
              registry.refresh(state.workspaces);
            }}
            selection={selection}
            sidebarOpen={sidebarOpen}
            state={state}
            theme={theme}
          />
        )}
      </div>
    </div>
  );
}

function WorkspacePicker({
  state,
  connection,
  workspaces,
  theme,
  onThemeChange,
  onSelect,
}: {
  readonly state: State;
  readonly connection: FrontendState.Connection;
  readonly workspaces: AsyncResult.AsyncResult<readonly Workspace[], unknown>;
  readonly theme: Theme;
  readonly onThemeChange: (theme: Theme) => void;
  readonly onSelect: (workspace: Workspace) => void;
}) {
  const registry = useContext(RegistryContext);
  const create = useAtomSet(state.createWorkspace, { mode: "promiseExit" });
  const creation = useAtomValue(state.createWorkspace);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const values = Option.getOrElse(AsyncResult.value(workspaces), () => []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (registry.get(state.createWorkspace).waiting || connection.kind !== "active") return;
    const input = decodeWorkspace({
      name: name.trim(),
      defaultCwd: directory,
      binding: null,
      worktree: null,
    });
    if (Option.isNone(input)) {
      setFormError("Enter a workspace name and an absolute directory on the machine running pico.");
      return;
    }
    setFormError(null);
    const exit = await create(input.value);
    if (Exit.isSuccess(exit)) {
      onSelect(exit.value);
    } else {
      const field = form.elements.namedItem("directory");
      if (field instanceof HTMLInputElement) field.focus();
    }
  };
  const error = formError ?? (creation._tag === "Failure" ? errorMessage(creation.cause) : null);
  return (
    <main className="h-full overflow-y-auto px-4 py-8 md:py-16">
      <div className="mx-auto max-w-2xl">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-display font-semibold">Choose a workspace</h1>
            <p className="mt-2 text-copy text-muted">
              Keep conversations together in a project directory.
            </p>
          </div>
          <Button
            aria-pressed={theme === "dark"}
            onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
            size="small"
            tone="secondary"
          >
            Dark theme
          </Button>
        </header>
        <section aria-label="Workspaces" className="mt-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-title font-semibold">Workspaces</h2>
            <Button
              disabled={workspaces.waiting || connection.kind !== "active"}
              onClick={() => registry.refresh(state.workspaces)}
              size="small"
              tone="ghost"
            >
              Refresh
            </Button>
          </div>
          <p className="mt-2 text-label text-muted" role="status">
            {workspaces.waiting
              ? "Loading workspaces..."
              : workspaces._tag === "Success" && values.length === 0
                ? "No workspaces yet. Create one below."
                : ""}
          </p>
          {workspaces._tag === "Failure" && (
            <p className="mt-2 text-label text-danger" role="alert">
              {errorMessage(workspaces.cause)} Use Refresh to try again, or reload if the connection
              is unavailable.
            </p>
          )}
          <ul className="mt-3 space-y-2">
            {values.map((workspace) => (
              <li key={workspace.id}>
                <button
                  className="w-full rounded-control border border-border bg-panel px-4 py-3 text-left hover:bg-surface-hover disabled:opacity-60"
                  disabled={creation.waiting}
                  onClick={() => onSelect(workspace)}
                  type="button"
                >
                  <span className="block break-words text-title font-medium">{workspace.name}</span>
                  <span className="mt-1 block break-all text-label text-muted">
                    {workspace.defaultCwd}
                  </span>
                  <span className="mt-1 block text-meta text-muted">
                    Created {dateFormat.format(workspace.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <form
          aria-labelledby="create-workspace-heading"
          className="mt-8 border-t border-border pt-6"
          onSubmit={submit}
        >
          <h2 className="text-title font-semibold" id="create-workspace-heading">
            Create a workspace
          </h2>
          <label className="mt-4 block text-label font-medium" htmlFor="workspace-name">
            Workspace name
          </label>
          <input
            aria-describedby={error ? "workspace-error" : undefined}
            aria-invalid={formError ? true : undefined}
            autoComplete="off"
            className="mt-2 block w-full rounded-control border border-border bg-panel px-3 py-2 text-base"
            disabled={creation.waiting}
            id="workspace-name"
            name="workspaceName"
            onChange={(event) => setName(event.currentTarget.value)}
            required
            type="text"
            value={name}
          />
          <label className="mt-4 block text-label font-medium" htmlFor="workspace-directory">
            Project directory
          </label>
          <p className="mt-1 text-label text-muted" id="directory-hint">
            Use an existing absolute path on the machine running pico.
          </p>
          <input
            aria-describedby={error ? "directory-hint workspace-error" : "directory-hint"}
            aria-invalid={error ? true : undefined}
            autoCapitalize="none"
            autoComplete="off"
            className="mt-2 block w-full rounded-control border border-border bg-panel px-3 py-2 text-base"
            disabled={creation.waiting}
            id="workspace-directory"
            name="directory"
            onChange={(event) => setDirectory(event.currentTarget.value)}
            placeholder="/path/to/project"
            required
            spellCheck={false}
            type="text"
            value={directory}
          />
          {error && (
            <p className="mt-3 text-label text-danger" id="workspace-error" role="alert">
              {error} Check the name and directory, then create the workspace again.
            </p>
          )}
          <Button
            className="mt-4"
            disabled={creation.waiting || connection.kind !== "active"}
            type="submit"
          >
            {creation.waiting ? "Creating workspace..." : "Create workspace"}
          </Button>
        </form>
      </div>
    </main>
  );
}

interface WorkspaceViewProps {
  readonly state: State;
  readonly selection: Exclude<Selection, { readonly kind: "picker" }>;
  readonly connection: FrontendState.Connection;
  readonly draft: Draft;
  readonly disclosures: ReadonlySet<string>;
  readonly theme: Theme;
  readonly sidebarOpen: boolean;
  readonly onChatSelect: (chat: Chat) => void;
  readonly onChatCreated: (chat: Chat) => void;
  readonly onWorkspaceChange: () => void;
  readonly onDraftChange: (chatId: ChatId, text: string) => void;
  readonly onDraftSent: (chatId: ChatId, draft: Draft) => void;
  readonly onReload: () => void;
  readonly onSidebarOpenChange: (open: boolean) => void;
  readonly onDisclosureToggle: (id: string) => void;
  readonly onThemeChange: (theme: Theme) => void;
}

function WorkspaceView(props: WorkspaceViewProps) {
  const { state, selection, connection } = props;
  const registry = useContext(RegistryContext);
  const chatsAtom = state.chats(selection.workspace.id);
  const chats = useAtomValue(chatsAtom);
  useEffect(() => {
    if (!registry.get(chatsAtom).waiting) registry.refresh(chatsAtom);
  }, [chatsAtom, registry]);
  const creation = useAtomValue(state.createChat(selection.workspace.id));
  const create = useAtomSet(state.createChat(selection.workspace.id), { mode: "promiseExit" });
  const values = Option.getOrElse(AsyncResult.value(chats), () => []);
  const records =
    selection.kind === "chat" && !values.some((chat) => chat.id === selection.chat.id)
      ? [selection.chat, ...values]
      : values;
  const summaries: readonly ChatSummary[] = records.map((chat) => ({
    id: chat.id,
    title: `Chat ${chat.id.slice(-8)}`,
    preview: chat.cwd,
    updatedLabel: `Created ${dateFormat.format(chat.createdAt)}`,
    activity: "unknown",
  }));
  const screen = {
    workspace: {
      id: selection.workspace.id,
      name: selection.workspace.name,
      contextLabel: selection.workspace.defaultCwd,
    },
    chats: summaries,
    activeChatId: selection.kind === "chat" ? selection.chat.id : null,
    sidebarOpen: props.sidebarOpen,
    theme: props.theme,
    newChatPending: creation.waiting || connection.kind !== "active",
    chatListStatus:
      chats._tag === "Failure"
        ? { kind: "error", label: `${errorMessage(chats.cause)} Retry loading chats.` }
        : chats.waiting
          ? { kind: "pending", label: "Loading chats..." }
          : values.length === 0
            ? { kind: "empty", label: "No chats yet. Create a chat to start." }
            : undefined,
    onChatsRetry: () => registry.refresh(state.chats(selection.workspace.id)),
    onWorkspaceChange: props.onWorkspaceChange,
    onSidebarOpenChange: props.onSidebarOpenChange,
    onThemeChange: props.onThemeChange,
    onDisclosureToggle: props.onDisclosureToggle,
    onChatSelect: (id: string) => {
      const chat = records.find((record) => record.id === id);
      if (chat) props.onChatSelect(chat);
    },
    onNewChat: async () => {
      if (
        registry.get(state.createChat(selection.workspace.id)).waiting ||
        connection.kind !== "active"
      )
        return;
      const exit = await create({ externalId: null });
      if (Exit.isSuccess(exit)) props.onChatCreated(exit.value);
    },
  } satisfies Omit<
    ChatScreenProps,
    | "transcript"
    | "composer"
    | "onComposerValueChange"
    | "onComposerSubmit"
    | "onStop"
    | "onTranscriptRetry"
  >;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {creation.waiting && (
        <p
          className="shrink-0 border-b border-border bg-panel p-3 text-label text-muted"
          role="status"
        >
          Creating chat...
        </p>
      )}
      {creation._tag === "Failure" && (
        <p
          className="shrink-0 border-b border-border bg-panel p-3 text-label text-danger"
          role="alert"
        >
          {errorMessage(creation.cause)} Check the workspace directory, then try New chat again.
        </p>
      )}
      <div className="min-h-0 flex-1">
        {selection.kind === "chat" ? (
          <SelectedChat {...props} chat={selection.chat} key={selection.chat.id} screen={screen} />
        ) : (
          <ChatScreen
            {...screen}
            composer={{
              mode: "send",
              value: "",
              placeholder: "Create or select a chat",
              editable: false,
              canSubmit: false,
              statusLabel: "Choose New chat to start",
            }}
            onComposerSubmit={screen.onNewChat}
            onComposerValueChange={() => props.onSidebarOpenChange(true)}
            onStop={() => props.onSidebarOpenChange(true)}
            onTranscriptRetry={screen.onChatsRetry}
            transcript={{
              state: "empty",
              title: "Choose a chat",
              description: "Select a conversation from the sidebar, or choose New chat.",
            }}
          />
        )}
      </div>
    </div>
  );
}

function SelectedChat({
  state,
  chat,
  connection,
  draft,
  disclosures,
  onDraftChange,
  onDraftSent,
  onReload,
  screen,
}: WorkspaceViewProps & {
  readonly chat: Chat;
  readonly screen: Omit<
    ChatScreenProps,
    | "transcript"
    | "composer"
    | "onComposerValueChange"
    | "onComposerSubmit"
    | "onStop"
    | "onTranscriptRetry"
  >;
}) {
  const registry = useContext(RegistryContext);
  const snapshot = useAtomValue(state.transcript(chat.id));
  const live = useAtomValue(state.live(chat.id));
  const sending = useAtomValue(state.send(chat.id));
  const stopping = useAtomValue(state.abort(chat.id));
  const send = useAtomSet(state.send(chat.id), { mode: "promiseExit" });
  const stop = useAtomSet(state.abort(chat.id));
  const available = connection.kind === "active";
  const running = live.run.kind === "running";
  const statusLabel =
    connection.kind === "opening"
      ? "Opening connection. Draft kept."
      : !available
        ? "Connection unavailable. Draft kept."
        : stopping.waiting
          ? "Stop requested..."
          : running
            ? "Pico is working"
            : sending.waiting
              ? "Waiting for response completion..."
              : live.run.kind === "unknown"
                ? "Run status unknown. You can send or request Stop."
                : live.run.outcome === "aborted"
                  ? "Response stopped"
                  : live.run.outcome === "failed"
                    ? "Response failed. Review the error before sending again."
                    : "Enter to send · Shift+Enter for a new line";
  const composer: ComposerPresentation =
    running || sending.waiting
      ? {
          mode: "stop",
          value: draft.text,
          placeholder: "Write your next message...",
          editable: true,
          canStop: available && !stopping.waiting,
          statusLabel,
        }
      : {
          mode: "send",
          value: draft.text,
          placeholder: "Ask pico to help with your project...",
          editable: true,
          canSubmit: available && draft.text.trim().length > 0,
          statusLabel,
        };
  const transcript = presentTranscript(snapshot, live, disclosures, connection);
  const retry = () =>
    connection.kind === "unavailable" ? onReload() : registry.refresh(state.transcript(chat.id));
  return (
    <div className="flex h-full min-h-0 flex-col">
      {snapshot._tag === "Failure" && transcript.state !== "error" && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel p-3 text-label">
          <p className="min-w-0 flex-1 text-danger" role="alert">
            {errorMessage(snapshot.cause)} Displayed history may be incomplete.
          </p>
          <Button onClick={retry} size="small" tone="secondary">
            {connection.kind === "unavailable" ? "Reload" : "Retry history"}
          </Button>
        </div>
      )}
      {sending._tag === "Failure" && (
        <p
          className="shrink-0 border-b border-border bg-panel p-3 text-label text-danger"
          role="alert"
        >
          {errorMessage(sending.cause)} Your draft is kept. Check the error and edit or send it
          again.
        </p>
      )}
      {stopping._tag === "Failure" && (
        <p
          className="shrink-0 border-b border-border bg-panel p-3 text-label text-danger"
          role="alert"
        >
          {errorMessage(stopping.cause)} Stop was not confirmed. Try Stop again or reload to
          reconnect.
        </p>
      )}
      {available && live.run.kind === "unknown" && !sending.waiting && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-2 text-label">
          <p className="min-w-0 flex-1 text-muted">
            Run status is unknown. History does not confirm whether a response is still running.
          </p>
          <Button
            disabled={stopping.waiting}
            onClick={() => stop(undefined)}
            size="small"
            tone="secondary"
          >
            Request Stop
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ChatScreen
          {...screen}
          chats={screen.chats.map(
            (summary): ChatSummary =>
              summary.id === chat.id
                ? {
                    ...summary,
                    title: live.title ?? summary.title,
                    activity:
                      live.run.kind === "running"
                        ? "running"
                        : live.run.kind === "unknown"
                          ? "unknown"
                          : live.run.outcome === "failed"
                            ? "failed"
                            : "idle",
                  }
                : summary,
          )}
          composer={composer}
          onComposerSubmit={async () => {
            if (
              !available ||
              registry.get(state.send(chat.id)).waiting ||
              draft.text.trim().length === 0
            )
              return;
            const exit = await send({ text: draft.text, attachments: [] });
            if (Exit.isSuccess(exit)) onDraftSent(chat.id, draft);
          }}
          onComposerValueChange={(text) => onDraftChange(chat.id, text)}
          onStop={() => stop(undefined)}
          onTranscriptRetry={retry}
          transcript={transcript}
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
