import { useAtomValue } from "@effect/atom-react/Hooks";
import { RegistryContext } from "@effect/atom-react/RegistryContext";
import type { TranscriptSnapshot } from "@pico/contract/agent-runtime";
import { CreateWorkspace } from "@pico/contract/application";
import type { Chat, ChatId } from "@pico/contract/chat-model";
import { GitError, WorkspaceBindingInvalid } from "@pico/contract/errors";
import type { Workspace, WorkspaceId } from "@pico/contract/workspace-model";
import type * as FrontendState from "@pico/frontend-state/client";
import { useRouter, useRouterState } from "@tanstack/react-router";
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
  ChatTabPresentation,
  CloseChatPresentation,
  ComposerPresentation,
  ContextUsagePresentation,
  NavigationPresentation,
  PromptSuggestion,
  SidebarSearchPresentation,
  ToolCallPresentation,
  TranscriptPresentation,
} from "./chat/chat-model.ts";
import { ChatScreen } from "./chat/chat-screen.tsx";
import { ConnectionRecovery } from "./chat/connection-recovery.tsx";
import type { WorkspaceFormProps } from "./chat/workspace-dialog.tsx";
import type { WorkspaceSettingsEditor } from "./chat/workspace-settings-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { type ConversationPage, type Page, pageFromMatches } from "./routes.tsx";
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
  readonly disclosures: ReadonlyMap<string, boolean>;
  readonly target: { readonly kind: "new" } | { readonly kind: "chat"; readonly chat: Chat };
  readonly submission:
    | { readonly kind: "idle" }
    | { readonly kind: "creating" }
    | { readonly kind: "sending" }
    | { readonly kind: "error"; readonly message: string };
}
interface TabState {
  readonly openKeys: readonly number[];
  readonly entries: ReadonlyMap<number, DraftEntry>;
  readonly expanded: ReadonlySet<WorkspaceId>;
}
type PageContent =
  | { readonly kind: "home" }
  | { readonly kind: "loading"; readonly label: string }
  | {
      readonly kind: "error";
      readonly title: string;
      readonly description: string;
      readonly recovery: "home" | "workspace" | "workspaces" | "chats";
    }
  | {
      readonly kind: "ready";
      readonly workspace: Workspace;
      readonly target: DraftEntry["target"];
    };
interface CloseChatTarget {
  readonly chatId: ChatId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly workspaceName: string;
}
type CloseChatFlow =
  | { readonly kind: "idle" }
  | { readonly kind: "closing"; readonly target: CloseChatTarget }
  | {
      readonly kind: "confirmation";
      readonly target: CloseChatTarget;
      readonly warning: string | null;
    }
  | {
      readonly kind: "error";
      readonly target: CloseChatTarget;
      readonly outcome: "closed" | "unconfirmed";
      readonly message: string;
    };
const emptyDraft: DraftValue = { text: "" };
const workspaceStorageKey = "pico-last-workspace";
const openingConnection = Atom.make<FrontendState.Connection>({ kind: "opening" });
const emptyTitles = Atom.make<ReadonlyMap<ChatId, string>>(new Map());
const decodeWorkspace = Schema.decodeUnknownOption(CreateWorkspace);
const tokenFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const percentageFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function presentContextUsage(
  result: AsyncResult.AsyncResult<TranscriptSnapshot["contextUsage"], unknown> | undefined,
  connection: FrontendState.Connection,
): ContextUsagePresentation {
  if (!result) {
    return {
      kind: "unavailable",
      label: "Context estimate unavailable",
      description: "Context usage appears after this chat opens an agent session.",
    };
  }
  if (result._tag === "Initial") {
    return connection.kind === "unavailable"
      ? {
          kind: "unavailable",
          label: "Context estimate unavailable",
          description: "Connection unavailable. Reconnect to read context usage.",
        }
      : {
          kind: "loading",
          label: "Loading context estimate",
          description: "Reading the current context estimate.",
        };
  }
  if (result._tag === "Failure" || result.value.kind === "error") {
    return {
      kind: "error",
      label: "Context estimate unavailable",
      description:
        connection.kind === "unavailable"
          ? "Connection unavailable. Reconnect to read context usage."
          : "Could not refresh context usage. Reopen these details to try again.",
    };
  }
  const usage = result.value;
  if (usage.kind === "unavailable") {
    return {
      kind: "unavailable",
      label: "Context estimate unavailable",
      description:
        "No context estimate is available for this chat. Viewing history does not open an agent session.",
    };
  }
  const fraction = usage.usedTokens / usage.contextWindow;
  const percentage = `${percentageFormat.format(fraction * 100)}%`;
  return {
    kind: "available",
    label: `Context estimate ${percentage}`,
    percentage,
    fraction: Math.max(0, Math.min(1, fraction)),
    used: tokenFormat.format(usage.usedTokens),
    capacity: tokenFormat.format(usage.contextWindow),
    remaining: tokenFormat.format(Math.max(0, usage.contextWindow - usage.usedTokens)),
    categories: [
      { label: "Messages", tokens: tokenFormat.format(usage.messagesTokens) },
      { label: "System prompt", tokens: tokenFormat.format(usage.systemPromptTokens) },
      { label: "Tools", tokens: tokenFormat.format(usage.systemToolsTokens) },
      { label: "Project context", tokens: tokenFormat.format(usage.systemContextTokens) },
      { label: "Skills", tokens: tokenFormat.format(usage.skillsTokens) },
    ],
    description:
      connection.kind === "unavailable"
        ? "Connection unavailable. Showing the last context snapshot, not billable token totals."
        : result.waiting
          ? "Refreshing. Showing the last context snapshot, not billable token totals."
          : "Current context estimate at the last snapshot, not billable token totals.",
  };
}

const suggestionPool: readonly PromptSuggestion[] = [
  {
    kind: "explain",
    label: "Explain how this project is organized",
    text: "Inspect this project and explain its structure, main components, and entry points. Cite the relevant files. Do not change any files.",
  },
  {
    kind: "review",
    label: "Review recent changes for potential bugs",
    text: "Review this project's uncommitted changes, or its latest commit if there are none. Look for correctness issues and missing edge cases. Cite the relevant files and lines, and do not change any files.",
  },
  {
    kind: "fix",
    label: "Find a bug worth investigating",
    text: "Inspect this project's code for a concrete bug worth investigating. Explain the evidence, a safe way to reproduce it, and a possible fix. Do not invent an issue if none is supported, and do not change any files.",
  },
  {
    kind: "explain",
    label: "Trace the main application flow",
    text: "Inspect this project and trace a main user action from its entry point through the application. Explain the key functions and data flow with file references. Do not change any files.",
  },
  {
    kind: "review",
    label: "Review how this project handles errors",
    text: "Review error handling in this project's main execution paths. Identify concrete risks involving lost errors, incomplete cleanup, or misleading recovery behavior, with file references. Do not change any files.",
  },
  {
    kind: "fix",
    label: "Investigate gaps in the test coverage",
    text: "Inspect this project's tests and the code they cover. Identify an important behavior or edge case that may be untested, explain the evidence, and suggest a focused regression test. Do not change any files.",
  },
];

function reconcileWorkspaceSnapshots(
  current: TabState,
  workspaces: readonly Workspace[],
): TabState {
  if (current.entries.size === 0) return current;
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  let entries: Map<number, DraftEntry> | undefined;
  for (const [key, entry] of current.entries) {
    const workspace = byId.get(entry.workspace.id);
    if (!workspace || workspace === entry.workspace) continue;
    entries ??= new Map(current.entries);
    entries.set(key, { ...entry, workspace });
  }
  return entries ? { ...current, entries } : current;
}

function removeClosedChat(current: TabState, chatId: ChatId): TabState {
  let nextEntries: Map<number, DraftEntry> | undefined;
  for (const [key, entry] of current.entries) {
    if (entry.target.kind !== "chat" || entry.target.chat.id !== chatId) continue;
    nextEntries ??= new Map(current.entries);
    nextEntries.delete(key);
  }
  if (!nextEntries) return current;
  const entries = nextEntries;
  const openKeys = current.openKeys.filter((key) => entries.has(key));
  return { ...current, entries, openKeys };
}

function findPageEntry(
  page: Page,
  entries: ReadonlyMap<number, DraftEntry>,
): DraftEntry | undefined {
  if (page.kind !== "draft" && page.kind !== "chat" && page.kind !== "settings") return;
  for (const entry of entries.values()) {
    if (entry.workspace.id !== page.workspaceId) continue;
    if (page.kind === "chat") {
      if (entry.target.kind === "chat" && entry.target.chat.id === page.chatId) return entry;
    } else if (entry.target.kind === "new") {
      return entry;
    }
  }
}

function entryPage(entry: DraftEntry): ConversationPage {
  return entry.target.kind === "chat"
    ? { kind: "chat", workspaceId: entry.workspace.id, chatId: entry.target.chat.id }
    : { kind: "draft", workspaceId: entry.workspace.id };
}

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

export function WorkspaceChat({
  state,
  page,
}: {
  readonly state: State | null;
  readonly page: Page;
}) {
  const router = useRouter();
  const routeState = useRouterState({
    select: (current) => ({ status: current.status, location: current.location }),
  });
  const visitCounter = router.options.context.visit;
  const visit = visitCounter.current;
  const ownsVisit = () =>
    visitCounter.current === visit &&
    router.state.status === "idle" &&
    router.state.location === routeState.location;
  const registry = useContext(RegistryContext);
  const connection = useAtomValue(state?.connection ?? openingConnection);
  const available = connection.kind === "active";
  const [navigation, setNavigation] = useState<TabState>(() => ({
    openKeys: [],
    entries: new Map(),
    expanded: new Set(),
  }));
  const navigationRef = useRef(navigation);
  const nextDraftKey = useRef(0);
  const [initialWorkspace] = useState(readWorkspacePreference);
  const preferredWorkspace = useRef(initialWorkspace);
  const creatingChats = useRef(new Set<WorkspaceId>());
  const stoppingChats = useRef(new Set<ChatId>());
  const workspacePending = useRef(false);
  const [workspaceSubmission, setWorkspaceSubmission] = useState<{
    readonly session: number;
    readonly value: WorkspaceFormProps["submission"];
  }>({ session: visit, value: { kind: "ready" } });
  const [workspaceEditor, setWorkspaceEditor] = useState<WorkspaceSettingsEditor | null>(null);
  const workspaceEditorRef = useRef(workspaceEditor);
  const workspaceSavePending = useRef(false);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const dialogOpener = useRef<{
    readonly visit: number;
    readonly element: HTMLElement | null;
  } | null>(null);
  const [closeFlow, setCloseFlow] = useState<CloseChatFlow>({ kind: "idle" });
  const closeFlowRef = useRef(closeFlow);
  const unsettledCloseMembership = useRef(
    new Map<ChatId, { readonly workspaceId: WorkspaceId; readonly visit: number }>(),
  );
  const closingWorkspaceId = closeFlow.kind === "idle" ? null : closeFlow.target.workspaceId;
  const [theme, setTheme] = useState<Theme>(readBootstrappedTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [search, setSearch] = useState<SidebarSearchPresentation>({ kind: "closed" });
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const suggestions = useMemo(
    () => suggestionPool.slice(suggestionOffset, suggestionOffset + 3),
    [suggestionOffset],
  );
  const [toolSelection, setToolSelection] = useState<{
    readonly conversationKey: number;
    readonly callId: string;
  } | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [contextDetailsKey, setContextDetailsKey] = useState<number | null>();
  const routeWorkspaceId =
    page.kind === "draft" || page.kind === "chat" || page.kind === "settings"
      ? page.workspaceId
      : null;
  const routeChatWorkspaceId = page.kind === "chat" ? page.workspaceId : null;
  const groupedAtom = useMemo(
    () =>
      Atom.make((get) => {
        const result = state ? get(state.workspaces) : AsyncResult.initial<readonly Workspace[]>();
        let workspaces = Option.getOrElse(AsyncResult.value(result), () => []);
        if (result._tag !== "Success" || result.waiting) {
          for (const entry of navigation.entries.values()) {
            if (!workspaces.some((workspace) => workspace.id === entry.workspace.id)) {
              workspaces = [...workspaces, entry.workspace];
            }
          }
        }
        const retainedWorkspaces = new Set<WorkspaceId>();
        for (const entry of navigation.entries.values()) {
          if (entry.target.kind === "chat") retainedWorkspaces.add(entry.workspace.id);
        }
        return {
          result,
          groups: workspaces.map((workspace) => ({
            workspace,
            chats:
              state &&
              (search.kind === "open" ||
                navigation.expanded.has(workspace.id) ||
                workspace.id === closingWorkspaceId ||
                workspace.id === routeChatWorkspaceId ||
                retainedWorkspaces.has(workspace.id))
                ? get(state.chats(workspace.id))
                : null,
          })),
        };
      }),
    [
      state,
      navigation.expanded,
      navigation.entries,
      search.kind,
      closingWorkspaceId,
      routeChatWorkspaceId,
    ],
  );
  const { result: workspaces, groups } = useAtomValue(groupedAtom);
  const liveTitles = useAtomValue(state?.titles ?? emptyTitles);
  const titles = useMemo(() => {
    const merged = new Map<ChatId, string>();
    for (const group of groups) {
      if (!group.chats) continue;
      for (const chat of Option.getOrElse(AsyncResult.value(group.chats), () => [])) {
        if (chat.title !== null) merged.set(chat.id, chat.title);
      }
    }
    for (const [id, title] of liveTitles) merged.set(id, title);
    return merged;
  }, [groups, liveTitles]);
  const content = ((): PageContent => {
    if (page.kind === "home" || page.kind === "new-workspace") return { kind: "home" };
    if (page.kind === "invalid") {
      return {
        kind: "error",
        title: "Page not found",
        description: "This address is not a pico page, or its workspace or chat ID is invalid.",
        recovery: "home",
      };
    }
    const retained = findPageEntry(page, navigation.entries);
    const settledWorkspaces = workspaces._tag === "Success" && !workspaces.waiting;
    const group = groups.find((group) => group.workspace.id === page.workspaceId);
    const workspace = group?.workspace ?? (!settledWorkspaces ? retained?.workspace : undefined);
    if (!workspace) {
      if (workspaces._tag === "Failure") {
        return {
          kind: "error",
          title: "Workspaces unavailable",
          description: errorMessage(workspaces.cause),
          recovery: "workspaces",
        };
      }
      if (!settledWorkspaces) return { kind: "loading", label: "Loading workspace..." };
      return {
        kind: "error",
        title: "Workspace not found",
        description:
          "This workspace is not available in pico. Choose a workspace from the sidebar or return home.",
        recovery: "home",
      };
    }
    if (!settledWorkspaces && !retained) {
      return workspaces._tag === "Failure"
        ? {
            kind: "error",
            title: "Workspaces unavailable",
            description: errorMessage(workspaces.cause),
            recovery: "workspaces",
          }
        : { kind: "loading", label: "Loading workspace..." };
    }
    if (page.kind === "settings" && workspace.platform !== "web") {
      return {
        kind: "error",
        title: "Settings unavailable",
        description: "This workspace is managed by another platform.",
        recovery: "workspace",
      };
    }
    if (page.kind === "settings" && workspaceSaving && workspaceEditor?.session !== visit) {
      return { kind: "loading", label: "Finishing the previous workspace save..." };
    }
    if (page.kind !== "chat") return { kind: "ready", workspace, target: { kind: "new" } };
    const chats = group?.chats;
    if (chats?._tag === "Success" && !chats.waiting) {
      const chat = chats.value.find((chat) => chat.id === page.chatId);
      return chat
        ? { kind: "ready", workspace, target: { kind: "chat", chat } }
        : {
            kind: "error",
            title: "Chat not found",
            description:
              "This chat is not open in this workspace. It may have been archived, or the address may name a different workspace.",
            recovery: "workspace",
          };
    }
    if (retained?.target.kind === "chat")
      return { kind: "ready", workspace, target: retained.target };
    return chats?._tag === "Failure"
      ? {
          kind: "error",
          title: "Chats unavailable",
          description: errorMessage(chats.cause),
          recovery: "chats",
        }
      : { kind: "loading", label: "Loading chat..." };
  })();
  const selected = content.kind === "ready" ? findPageEntry(page, navigation.entries) : undefined;
  const chatId = selected?.target.kind === "chat" ? selected.target.chat.id : null;
  const conversationAtom = useMemo(
    () =>
      Atom.make((get) =>
        state && chatId
          ? {
              snapshot: get(state.transcript(chatId)),
              live: get(state.live(chatId)),
              contextUsage: get(state.contextUsage(chatId)),
              sending: get(state.send(chatId)),
              stopping: get(state.abort(chatId)),
            }
          : null,
      ),
    [state, chatId],
  );
  const conversation = useAtomValue(conversationAtom);

  useEffect(() => {
    setContextDetailsKey(undefined);
    setToolSelection(null);
  }, [visit, selected?.key]);

  useEffect(() => {
    if (!state || !chatId || !available) return;
    const snapshot = state.transcript(chatId);
    const current = registry.get(snapshot);
    if (current._tag !== "Initial" && !current.waiting) registry.refresh(snapshot);
  }, [state, registry, chatId, available]);

  const updateNavigation = (change: (current: TabState) => TabState) => {
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
  const navigatePage = (
    destination: Exclude<Page, { readonly kind: "invalid" }>,
    replace = false,
    origin: HTMLElement | null = null,
  ) => {
    visitCounter.current++;
    setToolSelection(null);
    switch (destination.kind) {
      case "home":
        void router.navigate({ to: "/", replace });
        break;
      case "new-workspace":
        void router.navigate({ to: "/workspaces/new", replace });
        break;
      case "draft":
        void router.navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: destination.workspaceId },
          replace,
        });
        break;
      case "chat":
        void router.navigate({
          to: "/workspaces/$workspaceId/chats/$chatId",
          params: { workspaceId: destination.workspaceId, chatId: destination.chatId },
          replace,
        });
        break;
      case "settings":
        void router.navigate({
          to: "/workspaces/$workspaceId/settings",
          params: { workspaceId: destination.workspaceId },
          replace,
        });
        break;
      default: {
        const exhaustive: never = destination;
        return exhaustive;
      }
    }
    dialogOpener.current = { visit: visitCounter.current, element: origin };
  };
  const retainEntry = (workspace: Workspace, target: DraftEntry["target"], open: boolean) => {
    const destination: ConversationPage =
      target.kind === "chat"
        ? { kind: "chat", workspaceId: workspace.id, chatId: target.chat.id }
        : { kind: "draft", workspaceId: workspace.id };
    const current = navigationRef.current;
    const existing = findPageEntry(destination, current.entries);
    const entry: DraftEntry = existing ?? {
      key: nextDraftKey.current++,
      workspace,
      target,
      value: emptyDraft,
      disclosures: new Map(),
      submission: { kind: "idle" },
    };
    const opening = open && !current.openKeys.includes(entry.key);
    if (!existing || opening) {
      updateNavigation((value) => ({
        ...value,
        entries: existing ? value.entries : new Map(value.entries).set(entry.key, entry),
        openKeys: opening ? [...value.openKeys, entry.key] : value.openKeys,
        expanded:
          opening && target.kind === "new" && !value.expanded.has(workspace.id)
            ? new Set(value.expanded).add(workspace.id)
            : value.expanded,
      }));
    }
    return entry;
  };
  const pruneClosedChat = (chatId: ChatId, ownerVisit: number) => {
    const current = navigationRef.current;
    const livePage = pageFromMatches(router.state.matches);
    const selectedEntry = findPageEntry(livePage, current.entries);
    const next = removeClosedChat(current, chatId);
    if (
      livePage.kind === "chat" &&
      livePage.chatId === chatId &&
      visitCounter.current === ownerVisit &&
      router.state.status === "idle"
    ) {
      const index = selectedEntry ? current.openKeys.indexOf(selectedEntry.key) : -1;
      const nextKey = next.openKeys[Math.max(0, Math.min(index, next.openKeys.length - 1))];
      const neighbor = nextKey === undefined ? undefined : next.entries.get(nextKey);
      navigatePage(neighbor ? entryPage(neighbor) : { kind: "home" }, true);
    }
    if (next === current) return;
    updateNavigation(() => next);
    setToolSelection((selection) =>
      selection && !next.entries.has(selection.conversationKey) ? null : selection,
    );
  };

  useEffect(() => {
    if (workspaces._tag !== "Success" || workspaces.waiting) return;
    if (state && registry.get(state.workspaces) !== workspaces) return;
    updateNavigation((current) => reconcileWorkspaceSnapshots(current, workspaces.value));
  }, [state, registry, workspaces]);

  useEffect(() => {
    if (!state || !ownsVisit() || content.kind !== "ready") return;
    if (registry.get(state.workspaces) !== workspaces) return;
    const chats = groups.find((group) => group.workspace.id === content.workspace.id)?.chats;
    if (page.kind === "chat" && chats && registry.get(state.chats(page.workspaceId)) !== chats)
      return;
    retainEntry(content.workspace, content.target, true);
    try {
      window.localStorage.setItem(workspaceStorageKey, content.workspace.id);
    } catch {}
    preferredWorkspace.current = content.workspace.id;
  }, [state, registry, page, workspaces, groups, content.kind, visit, routeState.status]);

  useEffect(() => {
    if (!state) return;
    for (const [chatId, { workspaceId, visit }] of unsettledCloseMembership.current) {
      const result = groups.find((group) => group.workspace.id === workspaceId)?.chats;
      if (result?._tag !== "Success" || result.waiting) continue;
      if (registry.get(state.chats(workspaceId)) !== result) continue;
      unsettledCloseMembership.current.delete(chatId);
      if (!result.value.some((chat) => chat.id === chatId)) pruneClosedChat(chatId, visit);
    }
  }, [closeFlow, groups]);

  const addWorkspace = () => {
    const origin = document.activeElement;
    navigatePage(
      { kind: "new-workspace" },
      false,
      origin instanceof HTMLElement && origin !== document.body ? origin : null,
    );
  };
  const createWorkspace = async (input: { readonly name: string; readonly directory: string }) => {
    if (
      !state ||
      !ownsVisit() ||
      page.kind !== "new-workspace" ||
      workspacePending.current ||
      registry.get(state.connection).kind !== "active"
    )
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
        session: visit,
        value: {
          kind: "error",
          message: "Enter a workspace name and an absolute directory on the machine running pico.",
        },
      });
      return;
    }
    workspacePending.current = true;
    setWorkspaceSubmission({ session: visit, value: { kind: "pending" } });
    const exit = await runCommand(registry, state.createWorkspace, decoded.value);
    workspacePending.current = false;
    if (Exit.isSuccess(exit)) retainEntry(exit.value, { kind: "new" }, false);
    if (!ownsVisit()) {
      setWorkspaceSubmission({ session: visit, value: { kind: "ready" } });
      return;
    }
    if (Exit.isFailure(exit)) {
      setWorkspaceSubmission({
        session: visit,
        value: { kind: "error", message: errorMessage(exit.cause) },
      });
      return;
    }
    navigatePage({ kind: "draft", workspaceId: exit.value.id }, true);
  };
  const updateWorkspaceEditor = (editor: WorkspaceSettingsEditor | null) => {
    workspaceEditorRef.current = editor;
    setWorkspaceEditor(editor);
  };
  useEffect(() => {
    if (!ownsVisit()) return;
    const current = workspaceEditorRef.current;
    if (page.kind !== "settings" || content.kind !== "ready") {
      if (current !== null) updateWorkspaceEditor(null);
      return;
    }
    if (!state || registry.get(state.workspaces) !== workspaces) return;
    if (current?.session === visit) return;
    const workspace = content.workspace;
    updateWorkspaceEditor({
      session: visit,
      workspace,
      configuration:
        workspace.worktree === null
          ? { kind: "direct", cwd: workspace.defaultCwd }
          : { kind: "worktree", repository: workspace.defaultCwd, settings: workspace.worktree },
      origin: dialogOpener.current?.visit === visit ? dialogOpener.current.element : null,
      submission: { kind: "ready" },
    });
  }, [state, registry, workspaces, page, content.kind, visit, routeState.status]);
  const editWorkspace = (workspaceId: string, origin: HTMLElement) => {
    if (workspaceSavePending.current) return;
    const workspace = groups.find((group) => group.workspace.id === workspaceId)?.workspace;
    if (workspace?.platform !== "web") return;
    navigatePage({ kind: "settings", workspaceId: workspace.id }, false, origin);
  };
  const closeWorkspaceEditor = () => {
    if (page.kind === "settings" && ownsVisit()) {
      navigatePage({ kind: "draft", workspaceId: page.workspaceId }, true);
    }
  };
  const saveWorkspace = async () => {
    const editor = workspaceEditorRef.current;
    if (
      !state ||
      !ownsVisit() ||
      page.kind !== "settings" ||
      editor?.session !== visit ||
      workspaceSavePending.current ||
      registry.get(state.connection).kind !== "active"
    )
      return;
    workspaceSavePending.current = true;
    setWorkspaceSaving(true);
    updateWorkspaceEditor({ ...editor, submission: { kind: "pending" } });
    const exit = await runCommand(registry, state.updateWorkspace, {
      workspaceId: editor.workspace.id,
      configuration: editor.configuration,
    });
    workspaceSavePending.current = false;
    setWorkspaceSaving(false);
    if (Exit.isSuccess(exit)) {
      updateNavigation((current) => reconcileWorkspaceSnapshots(current, [exit.value]));
    }
    const current = workspaceEditorRef.current;
    if (!ownsVisit() || current?.session !== editor.session) return;
    if (Exit.isSuccess(exit)) {
      navigatePage({ kind: "draft", workspaceId: exit.value.id }, true);
      return;
    }
    const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
    updateWorkspaceEditor({
      ...current,
      submission: {
        kind: "error",
        message: error instanceof GitError ? error.message : errorMessage(exit.cause),
        issue: error instanceof WorkspaceBindingInvalid ? error.issue : null,
      },
    });
  };
  const newChat = (workspaceId?: string) => {
    const workspace = workspaceId
      ? groups.find((group) => group.workspace.id === workspaceId)?.workspace
      : (groups.find((group) => group.workspace.id === routeWorkspaceId)?.workspace ??
        groups.find((group) => group.workspace.id === preferredWorkspace.current)?.workspace ??
        groups[0]?.workspace);
    if (workspace) navigatePage({ kind: "draft", workspaceId: workspace.id });
    else if (!workspaceId) addWorkspace();
  };
  const selectChat = (workspaceId: string, id: string) => {
    const group = groups.find((item) => item.workspace.id === workspaceId);
    if (!group) return;
    const current = navigationRef.current;
    const existing = [...current.entries.values()].find(
      (entry) =>
        entry.workspace.id === workspaceId &&
        entry.target.kind === "chat" &&
        entry.target.chat.id === id,
    );
    const chat =
      group.chats &&
      Option.getOrElse(AsyncResult.value(group.chats), () => []).find((item) => item.id === id);
    const target = chat ?? (existing?.target.kind === "chat" ? existing.target.chat : undefined);
    if (target) navigatePage({ kind: "chat", workspaceId: group.workspace.id, chatId: target.id });
  };
  const selectTab = (id: string) => {
    const current = navigationRef.current;
    const key = current.openKeys.find((key) => String(key) === id);
    const entry = key === undefined ? undefined : current.entries.get(key);
    if (!entry || (key === selected?.key && page.kind !== "settings")) return;
    navigatePage(entryPage(entry));
  };
  const closeTab = (id: string) => {
    const current = navigationRef.current;
    const index = current.openKeys.findIndex((key) => String(key) === id);
    if (index === -1) return;
    const key = current.openKeys[index];
    const openKeys = current.openKeys.filter((openKey) => openKey !== key);
    const active = findPageEntry(pageFromMatches(router.state.matches), current.entries);
    if (active?.key === key) {
      const nextKey = openKeys[Math.min(index, openKeys.length - 1)];
      const neighbor = nextKey === undefined ? undefined : current.entries.get(nextKey);
      navigatePage(neighbor ? entryPage(neighbor) : { kind: "home" }, true);
    }
    updateNavigation((value) => ({ ...value, openKeys }));
  };
  const updateCloseFlow = (next: CloseChatFlow) => {
    closeFlowRef.current = next;
    setCloseFlow(next);
  };
  const runCloseChat = async (target: CloseChatTarget, allowDirtyWorktree: boolean) => {
    if (!state) return;
    const ownerVisit = visitCounter.current;
    updateCloseFlow({ kind: "closing", target });
    const exit = await runCommand(registry, state.closeChat(target.workspaceId), {
      chatId: target.chatId,
      allowDirtyWorktree,
    });
    if (Exit.isSuccess(exit) && exit.value.kind === "closed") {
      unsettledCloseMembership.current.delete(target.chatId);
      pruneClosedChat(target.chatId, ownerVisit);
    }
    const refresh = await Effect.runPromiseExit(
      AtomRegistry.getResult(registry, state.chats(target.workspaceId), {
        suspendOnWaiting: true,
      }),
    );
    const membership = registry.get(state.chats(target.workspaceId));
    if (
      Exit.isSuccess(refresh) &&
      membership._tag === "Success" &&
      !membership.waiting &&
      membership.value === refresh.value
    ) {
      unsettledCloseMembership.current.delete(target.chatId);
      if (!refresh.value.some((chat) => chat.id === target.chatId))
        pruneClosedChat(target.chatId, ownerVisit);
    } else if (Exit.isFailure(exit) || exit.value.kind !== "closed") {
      unsettledCloseMembership.current.set(target.chatId, {
        workspaceId: target.workspaceId,
        visit: ownerVisit,
      });
    }
    const warning = Exit.isFailure(refresh)
      ? `The chat list could not be refreshed. ${errorMessage(refresh.cause)}`
      : null;
    if (Exit.isFailure(exit)) {
      updateCloseFlow({
        kind: "error",
        target,
        outcome: "unconfirmed",
        message: `${errorMessage(exit.cause)} The chat may already be archived, with cleanup unfinished.${warning ? ` ${warning}` : ""}`,
      });
      return;
    }
    switch (exit.value.kind) {
      case "worktree-confirmation-required":
        updateCloseFlow({ kind: "confirmation", target, warning });
        return;
      case "closed":
        updateCloseFlow(
          warning
            ? { kind: "error", target, outcome: "closed", message: `Chat closed. ${warning}` }
            : { kind: "idle" },
        );
        return;
      default: {
        const exhaustive: never = exit.value;
        return exhaustive;
      }
    }
  };
  const closeChat = (workspaceId: string, id: string) => {
    if (
      !state ||
      closeFlowRef.current.kind !== "idle" ||
      registry.get(state.connection).kind !== "active"
    )
      return;
    const group = groups.find((group) => group.workspace.id === workspaceId);
    if (!group) return;
    const existing = [...navigationRef.current.entries.values()].find(
      (entry) =>
        entry.workspace.id === workspaceId &&
        entry.target.kind === "chat" &&
        entry.target.chat.id === id,
    );
    const chat =
      existing?.target.kind === "chat"
        ? existing.target.chat
        : group.chats &&
          Option.getOrElse(AsyncResult.value(group.chats), () => []).find((chat) => chat.id === id);
    if (!chat) return;
    void runCloseChat(
      {
        chatId: chat.id,
        workspaceId: group.workspace.id,
        title: titles.get(chat.id) ?? `Chat ${chat.id.slice(-8)}`,
        workspaceName: group.workspace.name,
      },
      false,
    );
  };
  const confirmCloseChat = () => {
    const current = closeFlowRef.current;
    if (
      !state ||
      current.kind !== "confirmation" ||
      registry.get(state.connection).kind !== "active"
    )
      return;
    void runCloseChat(current.target, true);
  };
  const retryCloseChat = () => {
    const current = closeFlowRef.current;
    if (
      !state ||
      current.kind !== "error" ||
      current.outcome === "closed" ||
      registry.get(state.connection).kind !== "active"
    )
      return;
    void runCloseChat(current.target, false);
  };
  const dismissCloseChat = () => {
    const current = closeFlowRef.current;
    if (current.kind === "confirmation" || current.kind === "error") {
      updateCloseFlow({ kind: "idle" });
    }
  };
  const changeSearch = (next: SidebarSearchPresentation) => {
    if (state && search.kind === "closed" && next.kind === "open") {
      for (const { workspace } of groups) {
        const chats = state.chats(workspace.id);
        const result = registry.get(chats);
        if (result._tag !== "Initial" && !result.waiting) registry.refresh(chats);
      }
    }
    setSearch(next);
  };
  const submitDraft = async () => {
    if (
      !state ||
      !ownsVisit() ||
      (page.kind !== "draft" && page.kind !== "chat") ||
      registry.get(state.connection).kind !== "active"
    )
      return;
    const entry = findPageEntry(page, navigationRef.current.entries);
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
      if (ownsVisit() && navigationRef.current.openKeys.includes(key)) {
        navigatePage({ kind: "chat", workspaceId: entry.workspace.id, chatId: chat.id }, true);
      }
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
  const selectSuggestion = (text: string) => {
    if (!state || !ownsVisit() || registry.get(state.connection).kind !== "active") return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (
      !entry ||
      entry.key !== selected?.key ||
      entry.submission.kind === "creating" ||
      entry.submission.kind === "sending"
    )
      return;
    if (entry.target.kind === "new") {
      if (creatingChats.current.has(entry.workspace.id)) return;
    } else if (
      registry.get(state.send(entry.target.chat.id)).waiting ||
      registry.get(state.live(entry.target.chat.id)).run.kind === "running"
    ) {
      return;
    }
    updateEntry(entry.key, (value) => ({ ...value, value: { text } }));
    void submitDraft();
  };
  const stop = async () => {
    if (!state || !ownsVisit() || registry.get(state.connection).kind !== "active") return;
    const entry = findPageEntry(page, navigationRef.current.entries);
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
  const closePresentation: CloseChatPresentation =
    closeFlow.kind === "idle"
      ? closeFlow
      : closeFlow.kind === "closing"
        ? {
            kind: "closing",
            title: closeFlow.target.title,
            workspaceName: closeFlow.target.workspaceName,
          }
        : closeFlow.kind === "confirmation"
          ? {
              kind: "confirmation",
              title: closeFlow.target.title,
              workspaceName: closeFlow.target.workspaceName,
              warning: closeFlow.warning,
              canConfirm: available,
            }
          : {
              kind: "error",
              title: closeFlow.target.title,
              workspaceName: closeFlow.target.workspaceName,
              message: closeFlow.message,
              retry: closeFlow.outcome === "unconfirmed" ? { enabled: available } : null,
            };
  const onReload = () => {
    if (draftValues.length > 0) setRecoveryOpen(true);
    else window.location.reload();
  };
  const retryTranscript = () => {
    if (content.kind === "error" && content.recovery === "home") navigatePage({ kind: "home" });
    else if (content.kind === "error" && content.recovery === "workspace" && routeWorkspaceId)
      navigatePage({ kind: "draft", workspaceId: routeWorkspaceId });
    else if (unavailable) onReload();
    else if (content.kind === "error" && content.recovery === "chats" && state && routeWorkspaceId)
      registry.refresh(state.chats(routeWorkspaceId));
    else if (state && chatId) registry.refresh(state.transcript(chatId));
    else if (state) registry.refresh(state.workspaces);
  };
  const query = search.kind === "open" ? search.query.trim().toLocaleLowerCase() : "";
  const navigationGroups = groups
    .map(({ workspace, chats }): NavigationPresentation["groups"][number] => {
      const records = chats ? [...Option.getOrElse(AsyncResult.value(chats), () => [])] : [];
      if (chats && (chats._tag !== "Success" || chats.waiting)) {
        for (const entry of navigation.entries.values()) {
          if (entry.workspace.id !== workspace.id || entry.target.kind !== "chat") continue;
          const chat = entry.target.chat;
          if (!records.some((record) => record.id === chat.id))
            records.unshift({ ...chat, title: null });
        }
      }
      const summaries = records.map((chat) => ({
        id: chat.id,
        title: titles.get(chat.id) ?? `Chat ${chat.id.slice(-8)}`,
      }));
      const matchesWorkspace = workspace.name.toLocaleLowerCase().includes(query);
      return {
        workspace: {
          id: workspace.id,
          name: workspace.name,
          contextLabel: workspace.defaultCwd,
          canEditConfiguration: workspace.platform === "web",
        },
        expanded: search.kind === "open" || navigation.expanded.has(workspace.id),
        chats:
          search.kind === "open" && !matchesWorkspace
            ? summaries.filter((chat) => chat.title.toLocaleLowerCase().includes(query))
            : summaries,
        status:
          chats?._tag === "Failure"
            ? { kind: "error", label: errorMessage(chats.cause) }
            : chats && (chats.waiting || chats._tag === "Initial")
              ? { kind: "pending", label: "Loading chats..." }
              : chats && records.length === 0
                ? { kind: "empty", label: "No chats yet." }
                : undefined,
      };
    })
    .filter(
      (group) =>
        search.kind === "closed" ||
        group.workspace.name.toLocaleLowerCase().includes(query) ||
        group.chats.length > 0 ||
        group.status?.kind === "pending" ||
        group.status?.kind === "error",
    );
  const presentation: NavigationPresentation = {
    activeWorkspaceId: routeWorkspaceId,
    activeChatId: chatId,
    status:
      workspaces._tag === "Failure"
        ? { kind: "error", label: errorMessage(workspaces.cause) }
        : workspaces.waiting || workspaces._tag === "Initial"
          ? { kind: "pending", label: "Loading workspaces..." }
          : groups.length === 0
            ? { kind: "empty", label: "No workspaces yet." }
            : search.kind === "open" && navigationGroups.length === 0
              ? { kind: "empty", label: "No matching chats or workspaces." }
              : undefined,
    groups: navigationGroups,
  };
  const tabs: ChatTabPresentation[] = [];
  for (const key of navigation.openKeys) {
    const entry = navigation.entries.get(key);
    if (!entry) continue;
    tabs.push({
      id: String(key),
      title:
        entry.target.kind === "chat"
          ? (titles.get(entry.target.chat.id) ?? `Chat ${entry.target.chat.id.slice(-8)}`)
          : "New chat",
      contextLabel: `${entry.workspace.name} · ${entry.target.kind === "chat" ? entry.target.chat.cwd : entry.workspace.defaultCwd}`,
    });
  }
  const creating = selected?.submission.kind === "creating";
  const sending = selected?.submission.kind === "sending" || conversation?.sending.waiting;
  const running = conversation?.live.run.kind === "running";
  const statusLabel = !selected
    ? groups.length > 0
      ? "Choose a chat or start a new one"
      : "Add a workspace to start a chat"
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
            : groups.length > 0
              ? "Choose a chat or start a new one"
              : "Add a workspace to start",
          editable: !!selected,
          canSubmit: available && !!selected && !creating && selected.value.text.trim().length > 0,
          statusLabel,
        };
  const transcript: TranscriptPresentation =
    content.kind === "error"
      ? {
          state: "error",
          title: content.title,
          description: content.description,
          retryLabel:
            content.recovery === "home"
              ? "Go home"
              : content.recovery === "workspace"
                ? "New chat in this workspace"
                : unavailable
                  ? "Reload"
                  : content.recovery === "chats"
                    ? "Retry chats"
                    : "Retry workspaces",
        }
      : content.kind === "loading"
        ? { state: "loading", label: content.label }
        : content.kind === "ready" && !selected
          ? { state: "loading", label: "Opening chat..." }
          : conversation && selected
            ? presentTranscript(
                conversation.snapshot,
                conversation.live,
                selected.disclosures,
                connection,
              )
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
                      title:
                        groups.length > 0
                          ? "What are you working on?"
                          : "Bring your project to pico",
                      description:
                        groups.length > 0
                          ? "Start a new chat or reopen a conversation from the sidebar. Your drafts are kept."
                          : "Add a workspace to chat about your code. Your conversations stay together in its project directory.",
                    };
  let toolPane: ToolCallPresentation | null = null;
  if (
    toolSelection &&
    toolSelection.conversationKey === selected?.key &&
    transcript.state === "ready"
  ) {
    for (const item of transcript.items) {
      if (item.kind !== "tool-group") continue;
      const call = item.calls.find((call) => call.id === toolSelection.callId);
      if (!call) continue;
      toolPane = call;
      break;
    }
  }

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
          closeChat={closePresentation}
          chatCloseDisabled={!available || closeFlow.kind !== "idle"}
          onChatClose={closeChat}
          onCloseChatConfirm={confirmCloseChat}
          onCloseChatDismiss={dismissCloseChat}
          onCloseChatRetry={retryCloseChat}
          composer={composer}
          contextUsage={presentContextUsage(conversation?.contextUsage, connection)}
          contextDetailsOpen={
            contextDetailsKey !== undefined && contextDetailsKey === (selected?.key ?? null)
          }
          onContextDetailsOpenChange={(open) => {
            setContextDetailsKey(open ? (selected?.key ?? null) : undefined);
            if (open && state && chatId && registry.get(state.connection).kind === "active") {
              registry.refresh(state.transcript(chatId));
            }
          }}
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
            if (!ownsVisit()) return;
            const entry = findPageEntry(page, navigationRef.current.entries);
            if (entry) updateEntry(entry.key, (entry) => ({ ...entry, value: { text } }));
          }}
          onDisclosuresChange={(ids, open) => {
            if (
              !ownsVisit() ||
              !selected ||
              findPageEntry(page, navigationRef.current.entries)?.key !== selected.key
            )
              return;
            updateEntry(selected.key, (entry) => {
              const disclosures = new Map(entry.disclosures);
              for (const id of ids) disclosures.set(id, open);
              return { ...entry, disclosures };
            });
          }}
          onAddWorkspace={addWorkspace}
          onEditWorkspace={editWorkspace}
          onNewChat={newChat}
          onSearchChange={changeSearch}
          onSidebarOpenChange={setSidebarOpen}
          onStop={stop}
          onSuggestionSelect={selectSuggestion}
          onSuggestionsShuffle={() =>
            setSuggestionOffset((offset) => (offset + 3) % suggestionPool.length)
          }
          onTabClose={closeTab}
          onTabSelect={selectTab}
          onThemeChange={(next) => {
            applyThemePreference(next);
            setTheme(next);
          }}
          onToolSelect={(id) => {
            if (!ownsVisit()) return;
            const key = findPageEntry(page, navigationRef.current.entries)?.key;
            if (key !== selected?.key) return;
            setToolSelection(
              id === null || key === undefined ? null : { conversationKey: key, callId: id },
            );
          }}
          onTranscriptRetry={retryTranscript}
          onWorkspaceRetry={() => {
            if (state) registry.refresh(state.workspaces);
          }}
          onWorkspaceToggle={(id) => {
            if (search.kind === "open") return;
            const workspace = groups.find((group) => group.workspace.id === id)?.workspace;
            if (!workspace) return;
            updateNavigation((current) => {
              const expanded = new Set(current.expanded);
              if (expanded.has(workspace.id)) expanded.delete(workspace.id);
              else expanded.add(workspace.id);
              return { ...current, expanded };
            });
          }}
          search={search}
          sidebarOpen={sidebarOpen}
          suggestions={
            available && selected && !creating && !sending && !running ? suggestions : []
          }
          tabs={tabs}
          theme={theme}
          title={chatId ? (titles.get(chatId) ?? `Chat ${chatId.slice(-8)}`) : "New chat"}
          toolPane={toolPane}
          transcript={transcript}
          workspaceEditPending={workspaceSaving}
          workspaceSettings={
            page.kind === "settings" &&
            content.kind === "ready" &&
            workspaceEditor?.session === visit
              ? {
                  editor: workspaceEditor,
                  available: available && !workspaceSaving,
                  onChange: (configuration) => {
                    const current = workspaceEditorRef.current;
                    if (!ownsVisit() || current?.session !== visit || workspaceSavePending.current)
                      return;
                    updateWorkspaceEditor({
                      ...current,
                      configuration,
                      submission: { kind: "ready" },
                    });
                  },
                  onClose: closeWorkspaceEditor,
                  onSubmit: saveWorkspace,
                }
              : null
          }
          workspaceForm={
            page.kind === "new-workspace"
              ? {
                  session: visit,
                  origin:
                    dialogOpener.current?.visit === visit ? dialogOpener.current.element : null,
                  available,
                  submission: workspacePending.current
                    ? { kind: "pending" }
                    : workspaceSubmission.session === visit
                      ? workspaceSubmission.value
                      : { kind: "ready" },
                  onClose: () => {
                    if (ownsVisit()) navigatePage({ kind: "home" }, true);
                  },
                  onSubmit: createWorkspace,
                }
              : null
          }
        />
      </div>
    </div>
  );
}
