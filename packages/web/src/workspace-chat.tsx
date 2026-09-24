import { useAtomValue } from "@effect/atom-react/Hooks";
import { RegistryContext } from "@effect/atom-react/RegistryContext";
import type {
  HistoryPreview,
  HistoryPreviewBlock,
  HistorySnapshot,
  NavigateChatHistoryRequest,
} from "@pico/contract/agent-history";
import type { AgentImageAttachment, AgentPrompt } from "@pico/contract/agent-message";
import type {
  ContextUsage,
  ModelInfo,
  ModelRef,
  ShakeMode,
  ShakeResult,
  SkillCommand,
} from "@pico/contract/agent-runtime";
import { CreateWorkspace } from "@pico/contract/application";
import type { Chat, ChatId, ChatResultSummaryEntry } from "@pico/contract/chat-model";
import { GitError, WorkspaceBindingInvalid } from "@pico/contract/errors";
import type { ScheduleOverviewResponse } from "@pico/contract/rpc";
import type * as Schedule from "@pico/contract/schedule";
import { type Workspace, WorkspaceId } from "@pico/contract/workspace-model";
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
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatTabPresentation,
  CloseChatPresentation,
  ComposerImagePresentation,
  ComposerPresentation,
  ContextUsagePresentation,
  HistoryPanelPresentation,
  HistoryPreviewBlockPresentation,
  ModelPickerPresentation,
  NavigationPresentation,
  ScheduleListPresentation,
  ShakeFeedback,
  SidebarSearchPresentation,
  SkillCompletionPresentation,
  ToolCallPresentation,
  TranscriptPresentation,
} from "./chat/chat-model.ts";
import { ChatScreen } from "./chat/chat-screen.tsx";
import { ConnectionRecovery } from "./chat/connection-recovery.tsx";
import {
  applySkill,
  filterSkills,
  findSkillToken,
  type SkillMenuVisibility,
} from "./chat/skill-completion.ts";
import type { WorkspaceFormProps } from "./chat/workspace-dialog.tsx";
import type { WorkspaceSettingsEditor } from "./chat/workspace-settings-dialog.tsx";
import { createChatReadState, type OpenCapture } from "./chat-read-state.ts";
import { Button } from "./components/ui/button.tsx";
import { presentHistoryItems } from "./history-presentation.ts";
import { type ConversationPage, type Page, pageFromMatches } from "./routes.tsx";
import { formatScheduleTime, presentSchedule } from "./schedule-presentation.ts";
import { applyThemePreference, readBootstrappedTheme, type Theme } from "./theme.ts";
import { errorMessage, presentTodo, presentTranscript } from "./transcript-presentation.ts";

type State = ReturnType<typeof FrontendState.make>;
interface DraftImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: AgentImageAttachment["mimeType"];
  readonly data: string;
}
interface DraftValue {
  readonly text: string;
  readonly images: readonly DraftImage[];
}
interface DraftEntry {
  readonly key: string;
  readonly workspace: Workspace;
  readonly value: DraftValue;
  readonly recoveredDraft: DraftValue | null;
  readonly disclosures: ReadonlyMap<string, boolean>;
  readonly target:
    | { readonly kind: "new"; readonly modelOverride: ModelRef | null }
    | { readonly kind: "chat"; readonly chat: Chat };
  readonly submission:
    | { readonly kind: "idle" }
    | { readonly kind: "creating" }
    | { readonly kind: "sending" }
    | { readonly kind: "error"; readonly message: string };
}

interface SkillMenuTabState {
  readonly caretStart: number;
  readonly caretEnd: number;
  readonly selectedIndex: number;
  readonly dismissedSignature: string | null;
  readonly tokenKey: string | null;
}

interface SkillMenuResolved {
  readonly token: NonNullable<ReturnType<typeof findSkillToken>>;
  readonly state: SkillMenuTabState;
  readonly signature: string;
  readonly visibility: SkillMenuVisibility;
  readonly options: readonly SkillCommand[];
  readonly selectedIndex: number;
}

const initialSkillMenuTabState = (caret: number): SkillMenuTabState => ({
  caretStart: caret,
  caretEnd: caret,
  selectedIndex: 0,
  dismissedSignature: null,
  tokenKey: null,
});

const menuSignature = (text: string, caretStart: number, caretEnd: number) =>
  `${text}\u0000${caretStart}:${caretEnd}`;

const menuTokenKey = (token: NonNullable<ReturnType<typeof findSkillToken>>) =>
  `${token.start}:${token.end}:${token.query.toLocaleLowerCase()}`;

const menuListboxId = (key: string) => `skill-completion-${key}`;
const menuStatusId = (key: string) => `skill-completion-status-${key}`;
const menuOptionId = (key: string, index: number) => `skill-completion-option-${key}-${index}`;
const isCreationUnconfirmed = (entry: DraftEntry | undefined) =>
  entry?.target.kind === "new" && entry.submission.kind === "error";
interface TabState {
  readonly openKeys: readonly string[];
  readonly entries: ReadonlyMap<string, DraftEntry>;
  readonly expanded: ReadonlySet<WorkspaceId>;
}
type PageContent =
  | { readonly kind: "home" }
  | { readonly kind: "schedules" }
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
type DeleteWorkspaceFlow =
  | { readonly kind: "idle" }
  | {
      readonly kind: "confirmation";
      readonly target: Pick<Workspace, "id" | "name">;
      readonly error: string | null;
    }
  | { readonly kind: "deleting"; readonly target: Pick<Workspace, "id" | "name"> };
const emptySchedules = Atom.make(AsyncResult.initial<ScheduleOverviewResponse>());
const emptyChatResults = Atom.make(
  AsyncResult.initial<ReadonlyMap<ChatId, ChatResultSummaryEntry>>(),
);
const emptyHistory = AsyncResult.initial<HistorySnapshot>();
const emptyHistoryPreview = AsyncResult.initial<HistoryPreview>();
const emptyDraft: DraftValue = { text: "", images: [] };
const workspaceStorageKey = "pico-last-workspace";
const expandedWorkspaceStorageKey = "pico-expanded-workspaces";
const openingConnection = Atom.make<FrontendState.Connection>({ kind: "opening" });
const decodeWorkspace = Schema.decodeUnknownOption(CreateWorkspace);
const decodeExpandedWorkspaceIds = Schema.decodeUnknownOption(Schema.Array(WorkspaceId));
const tokenFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const percentageFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

const workspaceDefaultModelValue = "workspace-default";
const modelValue = (model: ModelRef) => JSON.stringify([model.provider, model.id]);
const modelLabel = (model: ModelInfo) => `${model.name || model.id} · ${model.provider}`;
const modelRefLabel = (model: ModelRef) => `${model.id} · ${model.provider}`;
const isDraftEmpty = (draft: DraftValue) => draft.text.length === 0 && draft.images.length === 0;
const isDraftSendable = (draft: DraftValue) =>
  draft.text.trim().length > 0 || draft.images.length > 0;
const toComposerImages = (draft: DraftValue): readonly ComposerImagePresentation[] => draft.images;
const toPromptAttachments = (draft: DraftValue): readonly AgentImageAttachment[] =>
  draft.images.map((image, index) => ({
    type: "image",
    data: image.data,
    mimeType: image.mimeType,
    name: image.name || `restored-image-${index + 1}`,
  }));
const toDraftValue = (draft: AgentPrompt): DraftValue => ({
  text: draft.text,
  images: draft.attachments.map((image) => ({
    id: crypto.randomUUID(),
    data: image.data,
    mimeType: image.mimeType,
    name: image.name,
  })),
});
const toPreviewBlocks = (
  blocks: readonly HistoryPreviewBlock[],
): readonly HistoryPreviewBlockPresentation[] =>
  blocks.map((block, index) => ({ id: `preview-${index}`, ...block }));
function presentContextUsage(
  result: AsyncResult.AsyncResult<ContextUsage, unknown> | undefined,
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
  if (result._tag === "Failure") {
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
      description: "This session did not provide a context estimate.",
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

function reconcileWorkspaceSnapshots(
  current: TabState,
  workspaces: readonly Workspace[],
): TabState {
  if (current.entries.size === 0) return current;
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  let entries: Map<string, DraftEntry> | undefined;
  for (const [key, entry] of current.entries) {
    const workspace = byId.get(entry.workspace.id);
    if (!workspace || workspace === entry.workspace) continue;
    entries ??= new Map(current.entries);
    entries.set(key, { ...entry, workspace });
  }
  return entries ? { ...current, entries } : current;
}

function removeClosedChat(current: TabState, chatId: ChatId): TabState {
  let nextEntries: Map<string, DraftEntry> | undefined;
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

function removeWorkspace(current: TabState, workspaceId: WorkspaceId): TabState {
  const entries = new Map(
    [...current.entries].filter(([, entry]) => entry.workspace.id !== workspaceId),
  );
  let expanded = current.expanded;
  if (expanded.has(workspaceId)) {
    const next = new Set(expanded);
    next.delete(workspaceId);
    expanded = next;
  }
  return {
    entries,
    expanded,
    openKeys: current.openKeys.filter((key) => entries.has(key)),
  };
}

function findPageEntry(
  page: Page,
  entries: ReadonlyMap<string, DraftEntry>,
): DraftEntry | undefined {
  if (page.kind === "draft" || page.kind === "settings") {
    const entry = page.tabKey === null ? undefined : entries.get(page.tabKey);
    return entry?.workspace.id === page.workspaceId ? entry : undefined;
  }
  if (page.kind !== "chat") return;
  for (const entry of entries.values()) {
    if (
      entry.workspace.id === page.workspaceId &&
      entry.target.kind === "chat" &&
      entry.target.chat.id === page.chatId
    )
      return entry;
  }
}

function entryPage(entry: DraftEntry): ConversationPage {
  return entry.target.kind === "chat"
    ? { kind: "chat", workspaceId: entry.workspace.id, chatId: entry.target.chat.id }
    : { kind: "draft", workspaceId: entry.workspace.id, tabKey: entry.key };
}

function newChatTitle(text: string): string {
  const newline = text.indexOf("\n");
  return (newline === -1 ? text : text.slice(0, newline)).trim() || "New chat";
}

function readWorkspacePreference(): string | null {
  try {
    return window.localStorage.getItem(workspaceStorageKey);
  } catch {
    return null;
  }
}
function readExpandedWorkspacePreference(): ReadonlySet<WorkspaceId> {
  try {
    const value = window.localStorage.getItem(expandedWorkspaceStorageKey);
    if (value === null) return new Set();
    const decoded = decodeExpandedWorkspaceIds(JSON.parse(value));
    return Option.isSome(decoded) ? new Set(decoded.value) : new Set();
  } catch {
    return new Set();
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

function presentShake(result: ShakeResult): string {
  switch (result.mode) {
    case "elide": {
      const { toolResultsDropped, blocksDropped } = result;
      if (toolResultsDropped === 0 && blocksDropped === 0) return "Nothing to shake.";
      const removed = [];
      if (toolResultsDropped > 0) {
        removed.push(
          `${tokenFormat.format(toolResultsDropped)} tool result${toolResultsDropped === 1 ? "" : "s"}`,
        );
      }
      if (blocksDropped > 0) {
        removed.push(
          `${tokenFormat.format(blocksDropped)} large block${blocksDropped === 1 ? "" : "s"}`,
        );
      }
      return `Shake removed ${removed.join(" and ")}.`;
    }
    case "images":
      return result.imagesDropped === 0
        ? "Nothing to shake."
        : `Shake removed ${tokenFormat.format(result.imagesDropped)} image block${result.imagesDropped === 1 ? "" : "s"}.`;
    case "thinking":
      return result.thinkingBlocksDropped === 0
        ? "Nothing to shake."
        : `Shake removed ${tokenFormat.format(result.thinkingBlocksDropped)} thinking block${result.thinkingBlocksDropped === 1 ? "" : "s"}.`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
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
  const [chatReadState] = useState(() => createChatReadState());
  const [chatReadRevision, setChatReadRevision] = useState(0);
  const chatReadRequest = useMemo(
    () => chatReadState.buildRequest(),
    [chatReadState, chatReadRevision],
  );
  const openCapture = useRef<(OpenCapture & { pendingHref: string | null }) | null>(null);
  const [conversationBottom, setConversationBottom] = useState<{
    key: string | null;
    visible: boolean;
  }>({ key: null, visible: false });
  const conversationBottomRef = useRef(conversationBottom);
  const onConversationBottomChange = useCallback((key: string | null, visible: boolean) => {
    const previous = conversationBottomRef.current;
    if (previous.key === key && previous.visible === visible) return;
    const next = { key, visible };
    conversationBottomRef.current = next;
    setConversationBottom(next);
  }, []);
  const chatResults = useAtomValue(state?.chatResults ?? emptyChatResults);
  const chatResultEntries = Option.getOrElse(
    AsyncResult.value(chatResults),
    () => new Map<ChatId, ChatResultSummaryEntry>(),
  );
  const [navigation, setNavigation] = useState<TabState>(() => ({
    openKeys: [],
    entries: new Map(),
    expanded: readExpandedWorkspacePreference(),
  }));
  const navigationRef = useRef(navigation);
  const removedWorkspaceIds = useRef(new Set<WorkspaceId>());
  const lastConversationKey = useRef<string | null>(null);
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
  const [expandedScheduleId, setExpandedScheduleId] = useState<Schedule.ScheduleId | null>(null);
  const scheduleResult = useAtomValue(
    state && page.kind === "schedules" ? state.schedules : emptySchedules,
  );
  const [closeFlow, setCloseFlow] = useState<CloseChatFlow>({ kind: "idle" });
  const closeFlowRef = useRef(closeFlow);
  const [deleteFlow, setDeleteFlow] = useState<DeleteWorkspaceFlow>({ kind: "idle" });
  const deleteFlowRef = useRef(deleteFlow);
  const unsettledCloseMembership = useRef(
    new Map<ChatId, { readonly workspaceId: WorkspaceId; readonly visit: number }>(),
  );
  const closingWorkspaceId = closeFlow.kind === "idle" ? null : closeFlow.target.workspaceId;
  const [theme, setTheme] = useState<Theme>(readBootstrappedTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [search, setSearch] = useState<SidebarSearchPresentation>({ kind: "closed" });
  const [skillMenuByKey, setSkillMenuByKey] = useState<ReadonlyMap<string, SkillMenuTabState>>(
    () => new Map(),
  );
  const skillMenuOpenTokens = useRef(new Map<string, string>());
  const skillMenuCaretRevision = useRef(0);
  const [composerCaretRequest, setComposerCaretRequest] = useState<{
    readonly key: string;
    readonly revision: number;
    readonly selection: { readonly start: number; readonly end: number };
  } | null>(null);
  const [toolSelection, setToolSelection] = useState<{
    readonly conversationKey: string;
    readonly callId: string;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const historyWasOpen = useRef(false);
  const [historyRevealAll, setHistoryRevealAll] = useState(false);
  const [historyPreviewTarget, setHistoryPreviewTarget] = useState<{
    readonly conversationKey: string;
    readonly targetId: NavigateChatHistoryRequest["targetId"];
  } | null>(null);
  const [contextDetailsKey, setContextDetailsKey] = useState<string | null>();
  const [shakeFeedback, setShakeFeedback] = useState<{
    readonly visit: number;
    readonly key: string;
    readonly value: ShakeFeedback;
  } | null>(null);
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
  const titles = useMemo(() => {
    const merged = new Map<ChatId, string>();
    for (const group of groups) {
      if (!group.chats) continue;
      for (const chat of Option.getOrElse(AsyncResult.value(group.chats), () => [])) {
        if (chat.title !== null) merged.set(chat.id, chat.title);
      }
    }
    return merged;
  }, [groups]);
  useEffect(
    () => chatReadState.subscribe(() => setChatReadRevision((value) => value + 1)),
    [chatReadState],
  );
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      chatReadState.syncFromStorageEvent(event);
    };
    const onFocus = () => {
      chatReadState.syncFromStorage();
    };
    const onPageShow = () => chatReadState.syncFromStorage();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") chatReadState.syncFromStorage();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [chatReadState]);
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", (event) => {
        const capture = openCapture.current;
        if (capture !== null && capture.pendingHref === event.toLocation.href) {
          capture.pendingHref = null;
        } else {
          openCapture.current = null;
        }
      }),
    [router],
  );
  useEffect(() => {
    if (!state || connection.kind !== "active") return;
    registry.set(state.chatResults, chatReadRequest);
  }, [state, registry, connection.kind, chatReadRequest]);
  useEffect(() => {
    if (
      !state ||
      connection.kind !== "active" ||
      chatResults._tag !== "Success" ||
      chatResults.waiting
    )
      return;
    void chatReadState.reconcileCatalog(chatResults.value);
  }, [state, connection.kind, chatResults, chatReadState]);
  const content = ((): PageContent => {
    if (page.kind === "home" || page.kind === "new-workspace") return { kind: "home" };
    if (page.kind === "schedules") return { kind: "schedules" };
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
    if (page.kind !== "chat")
      return { kind: "ready", workspace, target: { kind: "new", modelOverride: null } };
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
  const selectedConversationKey = selected?.key ?? null;
  const selectedChatId = selected?.target.kind === "chat" ? selected.target.chat.id : null;
  const returnEntry =
    lastConversationKey.current === null
      ? undefined
      : navigation.entries.get(lastConversationKey.current);
  const conversationEntry = page.kind === "schedules" ? returnEntry : selected;
  const chatId =
    conversationEntry?.target.kind === "chat" ? conversationEntry.target.chat.id : null;
  const draftWorkspaceId =
    conversationEntry?.target.kind === "new" ? conversationEntry.workspace.id : null;
  const schedulesHref = router.buildLocation({ to: "/schedules" }).href;
  const visibleChatId =
    page.kind === "chat" &&
    content.kind === "ready" &&
    content.target.kind === "chat" &&
    content.target.chat.archivedAt === null
      ? content.target.chat.id
      : null;
  const returnToChatHref = !returnEntry
    ? router.buildLocation({ to: "/" }).href
    : returnEntry.target.kind === "chat"
      ? router.buildLocation({
          to: "/workspaces/$workspaceId/chats/$chatId",
          params: { workspaceId: returnEntry.workspace.id, chatId: returnEntry.target.chat.id },
        }).href
      : router.buildLocation({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: returnEntry.workspace.id },
          search: { tab: returnEntry.key },
        }).href;
  const skillsVisible =
    page.kind !== "schedules" &&
    conversationEntry !== undefined &&
    skillMenuByKey.get(conversationEntry.key)?.tokenKey != null;
  const historyVisible = historyOpen && selectedChatId !== null;
  const historyPreviewVisible =
    historyVisible && historyPreviewTarget?.conversationKey === selectedConversationKey;
  const conversationAtom = useMemo(
    () =>
      Atom.make((get) =>
        state && chatId
          ? {
              snapshot: get(state.transcript(chatId)),
              live: get(state.live(chatId)),
              history: historyVisible ? get(state.history(chatId)) : emptyHistory,
              previewHistory: historyPreviewVisible
                ? get(state.previewHistory(chatId))
                : emptyHistoryPreview,
              navigateHistory: get(state.navigateHistory(chatId)),
              historyReplacing: get(state.historyReplacing(chatId)),
              contextUsage: get(state.contextUsage(chatId)),
              todo: get(state.todo(chatId)),
              currentModel: get(state.currentModel(chatId)),
              models: get(state.availableModels(chatId)),
              skills: skillsVisible ? get(state.availableSkills(chatId)) : undefined,
              switching: get(state.switchModel(chatId)),
              sending: get(state.send(chatId)),
              stopping: get(state.abort(chatId)),
            }
          : null,
      ),
    [state, chatId, skillsVisible, historyVisible, historyPreviewVisible],
  );
  const conversation = useAtomValue(conversationAtom);
  const draftCatalogAtom = useMemo(
    () =>
      Atom.make((get) =>
        state && draftWorkspaceId
          ? {
              models: get(state.availableWorkspaceModels(draftWorkspaceId)),
              skills: skillsVisible
                ? get(state.availableWorkspaceSkills(draftWorkspaceId))
                : undefined,
            }
          : null,
      ),
    [state, draftWorkspaceId, skillsVisible],
  );
  const draftCatalog = useAtomValue(draftCatalogAtom);

  useEffect(() => {
    setContextDetailsKey(undefined);
    setToolSelection(null);
    setHistoryOpen(false);
    setHistoryQuery("");
    setHistoryRevealAll(false);
    setHistoryPreviewTarget(null);
    setShakeFeedback(null);
    skillMenuOpenTokens.current.clear();
  }, [visit, selected?.key]);

  useEffect(() => {
    if (!state || visibleChatId === null) return;
    const observed = state.observeContext(visibleChatId);
    let hiddenByPagehide = false;
    let release: (() => void) | undefined;

    const mount = () => {
      if (hiddenByPagehide || document.visibilityState !== "visible" || release !== undefined)
        return;
      release = registry.mount(observed);
    };
    const unmount = () => {
      if (release === undefined) return;
      const mounted = release;
      release = undefined;
      mounted();
      registry.refresh(observed);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        hiddenByPagehide = false;
        mount();
      } else unmount();
    };
    const onPageHide = () => {
      hiddenByPagehide = true;
      unmount();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      hiddenByPagehide = false;
      mount();
    };

    mount();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      unmount();
    };
  }, [state, registry, visibleChatId]);
  useEffect(() => {
    if (!state || connection.kind !== "active" || visibleChatId === null) return;
    if (
      chatId !== visibleChatId ||
      conversationBottom.key !== selectedConversationKey ||
      !conversationBottom.visible ||
      !ownsVisit()
    )
      return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (chatResults._tag !== "Success" || chatResults.waiting) return;
    const summary = chatResults.value.get(visibleChatId);
    if (!summary || summary.summary.kind === "unavailable" || summary.summary.latest === null)
      return;
    if (
      conversation?.snapshot._tag !== "Success" ||
      conversation.snapshot.waiting ||
      conversation.historyReplacing
    )
      return;
    const latest = summary.summary.latest;
    const rendered = conversation.snapshot.value.some(
      (message) => message.role === "assistant" && message.id === latest.messageId,
    );
    if (!rendered) return;
    const capture = openCapture.current;
    let cancelled = false;
    void chatReadState.confirm(
      visibleChatId,
      summary,
      capture,
      () =>
        !cancelled &&
        conversationBottomRef.current === conversationBottom &&
        ownsVisit() &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        registry.get(state.connection).kind === "active" &&
        registry.get(state.chatResults) === chatResults &&
        registry.get(state.transcript(visibleChatId)) === conversation.snapshot,
    );
    return () => {
      cancelled = true;
    };
  }, [
    state,
    registry,
    connection.kind,
    chatId,
    visibleChatId,
    conversationBottom,
    selectedConversationKey,
    conversation?.snapshot,
    conversation?.historyReplacing,
    chatResults,
    chatReadState,
    chatReadRevision,
    visit,
    routeState.status,
    routeState.location,
  ]);
  const updateNavigation = (change: (current: TabState) => TabState) => {
    const current = navigationRef.current;
    const next = change(current);
    const expandedChanged = current.expanded !== next.expanded;
    navigationRef.current = next;
    setNavigation(next);
    if (expandedChanged) {
      try {
        window.localStorage.setItem(
          expandedWorkspaceStorageKey,
          JSON.stringify([...next.expanded]),
        );
      } catch {}
    }
    if (state && expandedChanged) {
      for (const id of next.expanded) {
        if (current.expanded.has(id)) continue;
        const chats = state.chats(id);
        const result = registry.get(chats);
        if (result._tag !== "Initial" && !result.waiting) registry.refresh(chats);
      }
    }
  };
  const updateEntry = (key: string, change: (entry: DraftEntry) => DraftEntry) => {
    updateNavigation((current) => {
      const entry = current.entries.get(key);
      if (!entry) return current;
      return { ...current, entries: new Map(current.entries).set(key, change(entry)) };
    });
  };

  const readSkillMenuState = (entry: DraftEntry): SkillMenuTabState =>
    skillMenuByKey.get(entry.key) ?? initialSkillMenuTabState(entry.value.text.length);

  const updateSkillMenuState = (
    key: string,
    make: (current: SkillMenuTabState) => SkillMenuTabState,
  ) => {
    setSkillMenuByKey((current) => {
      const entry = navigationRef.current.entries.get(key);
      const previous =
        current.get(key) ?? initialSkillMenuTabState(entry ? entry.value.text.length : 0);
      const next = make(previous);
      if (
        next.caretStart === previous.caretStart &&
        next.caretEnd === previous.caretEnd &&
        next.selectedIndex === previous.selectedIndex &&
        next.dismissedSignature === previous.dismissedSignature &&
        next.tokenKey === previous.tokenKey
      )
        return current;
      const updated = new Map(current);
      updated.set(key, next);
      return updated;
    });
  };

  const requestComposerCaret = (key: string, start: number, end: number) => {
    skillMenuCaretRevision.current += 1;
    setComposerCaretRequest({
      key,
      revision: skillMenuCaretRevision.current,
      selection: { start, end },
    });
  };

  const skillMenuResolved: SkillMenuResolved | null = (() => {
    if (
      page.kind === "schedules" ||
      !conversationEntry ||
      !available ||
      isCreationUnconfirmed(conversationEntry)
    )
      return null;
    const tabState = readSkillMenuState(conversationEntry);
    const token = findSkillToken(
      conversationEntry.value.text,
      tabState.caretStart,
      tabState.caretEnd,
    );
    if (token === null) return null;
    const signature = menuSignature(
      conversationEntry.value.text,
      tabState.caretStart,
      tabState.caretEnd,
    );
    if (tabState.dismissedSignature === signature) return null;
    const tokenKey = menuTokenKey(token);
    const selectedIndex = tabState.tokenKey === tokenKey ? tabState.selectedIndex : 0;
    const skillsResult =
      conversationEntry.target.kind === "chat" ? conversation?.skills : draftCatalog?.skills;
    if (
      conversationEntry.submission.kind === "creating" ||
      skillsResult === undefined ||
      skillsResult._tag === "Initial" ||
      skillsResult.waiting
    ) {
      return {
        token,
        state: { ...tabState, tokenKey },
        signature,
        visibility: "loading",
        options: [],
        selectedIndex: 0,
      };
    }
    if (skillsResult._tag === "Failure") {
      return {
        token,
        state: { ...tabState, tokenKey },
        signature,
        visibility: "error",
        options: [],
        selectedIndex: 0,
      };
    }
    const options = filterSkills(
      Option.getOrElse(AsyncResult.value(skillsResult), () => []),
      token.query,
    );
    if (options.length === 0) {
      return {
        token,
        state: { ...tabState, tokenKey },
        signature,
        visibility: "empty",
        options,
        selectedIndex: 0,
      };
    }
    return {
      token,
      state: { ...tabState, tokenKey },
      signature,
      visibility: "ready",
      options,
      selectedIndex: Math.max(0, Math.min(selectedIndex, options.length - 1)),
    };
  })();

  useEffect(() => {
    if (!conversationEntry) return;
    if (skillMenuResolved === null) {
      skillMenuOpenTokens.current.delete(conversationEntry.key);
      return;
    }
  }, [conversationEntry, skillMenuResolved]);
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
      case "schedules":
        void router.navigate({ to: "/schedules", replace });
        break;
      case "new-workspace":
        void router.navigate({ to: "/workspaces/new", replace });
        break;
      case "draft":
        void router.navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: destination.workspaceId },
          search: { tab: destination.tabKey ?? undefined },
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
          search: { tab: destination.tabKey ?? undefined },
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
  const retainEntry = (
    workspace: Workspace,
    target: DraftEntry["target"],
    open: boolean,
    selectedEntry?: DraftEntry,
  ) => {
    const current = navigationRef.current;
    let existing = selectedEntry;
    if (!existing) {
      for (const entry of current.entries.values()) {
        if (
          entry.workspace.id === workspace.id &&
          (target.kind === "chat"
            ? entry.target.kind === "chat" && entry.target.chat.id === target.chat.id
            : entry.target.kind === "new" &&
              entry.target.modelOverride === null &&
              isDraftEmpty(entry.value) &&
              entry.submission.kind === "idle")
        ) {
          existing = entry;
          break;
        }
      }
    }
    const entry: DraftEntry = existing ?? {
      key: crypto.randomUUID(),
      workspace,
      target,
      value: emptyDraft,
      recoveredDraft: null,
      disclosures: new Map(),
      submission: { kind: "idle" },
    };
    const opening = open && !current.openKeys.includes(entry.key);
    if (!existing || opening) {
      updateNavigation((value) => ({
        ...value,
        entries: existing ? value.entries : new Map(value.entries).set(entry.key, entry),
        openKeys: opening ? [...value.openKeys, entry.key] : value.openKeys,
      }));
    }
    return entry;
  };
  const pruneClosedChat = (chatId: ChatId, ownerVisit: number) => {
    const current = navigationRef.current;
    const livePage = pageFromMatches(router.state.matches);
    const selectedEntry = findPageEntry(livePage, current.entries);
    const next = removeClosedChat(current, chatId);
    void chatReadState.forgetChat(chatId);
    if (openCapture.current?.chatId === chatId) openCapture.current = null;
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

  const pruneWorkspace = (workspaceId: WorkspaceId) => {
    removedWorkspaceIds.current.add(workspaceId);
    const current = navigationRef.current;
    const livePage = pageFromMatches(router.state.matches);
    const next = removeWorkspace(current, workspaceId);
    const removedChats = new Set<ChatId>();
    for (const entry of current.entries.values()) {
      if (entry.workspace.id !== workspaceId || entry.target.kind !== "chat") continue;
      removedChats.add(entry.target.chat.id);
    }
    const groupChats = groups.find((group) => group.workspace.id === workspaceId)?.chats;
    if (groupChats?._tag === "Success" && !groupChats.waiting) {
      for (const chat of groupChats.value) removedChats.add(chat.id);
    }
    if (removedChats.size > 0) {
      void chatReadState.forgetChats(removedChats);
      if (openCapture.current !== null && removedChats.has(openCapture.current.chatId))
        openCapture.current = null;
    }
    if (
      (livePage.kind === "draft" || livePage.kind === "chat" || livePage.kind === "settings") &&
      livePage.workspaceId === workspaceId &&
      router.state.status === "idle"
    ) {
      const selectedEntry = findPageEntry(livePage, current.entries);
      const index = selectedEntry ? current.openKeys.indexOf(selectedEntry.key) : 0;
      const nextKey = next.openKeys[Math.max(0, Math.min(index, next.openKeys.length - 1))];
      const neighbor = nextKey === undefined ? undefined : next.entries.get(nextKey);
      navigatePage(neighbor ? entryPage(neighbor) : { kind: "home" }, true);
    }
    if (lastConversationKey.current !== null && !next.entries.has(lastConversationKey.current)) {
      lastConversationKey.current = null;
    }
    if (preferredWorkspace.current === workspaceId) preferredWorkspace.current = null;
    try {
      if (window.localStorage.getItem(workspaceStorageKey) === workspaceId) {
        window.localStorage.removeItem(workspaceStorageKey);
      }
    } catch {}
    for (const [chatId, pending] of unsettledCloseMembership.current) {
      if (pending.workspaceId === workspaceId) unsettledCloseMembership.current.delete(chatId);
    }
    if (workspaceEditorRef.current?.workspace.id === workspaceId) {
      workspaceEditorRef.current = null;
      setWorkspaceEditor(null);
    }
    if (
      closeFlowRef.current.kind !== "idle" &&
      closeFlowRef.current.target.workspaceId === workspaceId
    ) {
      closeFlowRef.current = { kind: "idle" };
      setCloseFlow(closeFlowRef.current);
    }
    updateNavigation(() => next);
    setToolSelection((selection) =>
      selection && !next.entries.has(selection.conversationKey) ? null : selection,
    );
    setContextDetailsKey((key) => (key != null && !next.entries.has(key) ? undefined : key));
  };

  useEffect(() => {
    if (routeWorkspaceId && removedWorkspaceIds.current.has(routeWorkspaceId) && ownsVisit()) {
      pruneWorkspace(routeWorkspaceId);
    }
  }, [routeWorkspaceId, routeState.status, visit]);

  useEffect(() => {
    if (workspaces._tag !== "Success" || workspaces.waiting) return;
    if (state && registry.get(state.workspaces) !== workspaces) return;
    updateNavigation((current) => reconcileWorkspaceSnapshots(current, workspaces.value));
  }, [state, registry, workspaces]);

  useEffect(() => {
    if (!state || !ownsVisit() || content.kind !== "ready") return;
    if (removedWorkspaceIds.current.has(content.workspace.id)) return;
    if (registry.get(state.workspaces) !== workspaces) return;
    const chats = groups.find((group) => group.workspace.id === content.workspace.id)?.chats;
    if (page.kind === "chat" && chats && registry.get(state.chats(page.workspaceId)) !== chats)
      return;
    if (page.kind === "draft" || page.kind === "chat") {
      const entry = retainEntry(
        content.workspace,
        content.target,
        true,
        findPageEntry(page, navigationRef.current.entries),
      );
      lastConversationKey.current = entry.key;
      if (page.kind === "draft" && (page.tabKey !== entry.key || entry.target.kind === "chat")) {
        navigatePage(entryPage(entry), true);
      }
    }
    if (preferredWorkspace.current !== content.workspace.id) {
      preferredWorkspace.current = content.workspace.id;
      try {
        window.localStorage.setItem(workspaceStorageKey, content.workspace.id);
      } catch {}
    }
  }, [
    state,
    registry,
    page,
    workspaces,
    groups,
    content.kind,
    selected?.key,
    selected?.target,
    visit,
    routeState.status,
  ]);

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
    const entry = Exit.isSuccess(exit)
      ? retainEntry(exit.value, { kind: "new", modelOverride: null }, false)
      : undefined;
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
    if (entry) navigatePage(entryPage(entry), true);
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
    const currentPage = pageFromMatches(router.state.matches);
    navigatePage(
      {
        kind: "settings",
        workspaceId: workspace.id,
        tabKey:
          (currentPage.kind === "draft" ||
            currentPage.kind === "chat" ||
            currentPage.kind === "settings") &&
          currentPage.workspaceId === workspace.id
            ? (findPageEntry(currentPage, navigationRef.current.entries)?.key ?? null)
            : null,
      },
      false,
      origin,
    );
  };
  const updateDeleteFlow = (next: DeleteWorkspaceFlow) => {
    deleteFlowRef.current = next;
    setDeleteFlow(next);
  };
  const deleteWorkspace = (workspaceId: string) => {
    if (
      !state ||
      workspaceSavePending.current ||
      deleteFlowRef.current.kind !== "idle" ||
      registry.get(state.connection).kind !== "active"
    )
      return;
    const workspace = groups.find((group) => group.workspace.id === workspaceId)?.workspace;
    if (workspace?.platform !== "web") return;
    updateDeleteFlow({
      kind: "confirmation",
      target: { id: workspace.id, name: workspace.name },
      error: null,
    });
  };
  const confirmDeleteWorkspace = async () => {
    const flow = deleteFlowRef.current;
    if (!state || flow.kind !== "confirmation" || registry.get(state.connection).kind !== "active")
      return;
    updateDeleteFlow({ kind: "deleting", target: flow.target });
    const exit = await runCommand(registry, state.deleteWorkspace, { workspaceId: flow.target.id });
    if (Exit.isFailure(exit)) {
      updateDeleteFlow({
        kind: "confirmation",
        target: flow.target,
        error: errorMessage(exit.cause),
      });
      return;
    }
    pruneWorkspace(flow.target.id);
    updateDeleteFlow({ kind: "idle" });
  };
  const closeWorkspaceEditor = () => {
    if (page.kind === "settings" && ownsVisit()) {
      const entry = findPageEntry(page, navigationRef.current.entries);
      navigatePage(
        entry ? entryPage(entry) : { kind: "draft", workspaceId: page.workspaceId, tabKey: null },
        true,
      );
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
      closeWorkspaceEditor();
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
  const refreshSchedules = () => {
    if (!state || registry.get(state.connection).kind !== "active") return;
    if (!registry.get(state.schedules).waiting) registry.refresh(state.schedules);
  };
  useEffect(() => {
    if (page.kind !== "schedules" || !state || !available) return;
    const refresh = () => {
      if (registry.get(state.connection).kind !== "active") return;
      if (document.visibilityState === "hidden") return;
      if (!registry.get(state.schedules).waiting) registry.refresh(state.schedules);
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [state, registry, available, page.kind]);
  const openSchedules = () => {
    if (pageFromMatches(router.state.matches).kind !== "schedules")
      navigatePage({ kind: "schedules" });
  };
  const returnToChat = () => {
    const key = lastConversationKey.current;
    const entry = key === null ? undefined : navigationRef.current.entries.get(key);
    navigatePage(entry ? entryPage(entry) : { kind: "home" });
  };
  const scheduleSnapshot = Option.getOrNull(AsyncResult.value(scheduleResult));
  const scheduleRows = useMemo(
    () => scheduleSnapshot?.entries.map(presentSchedule) ?? [],
    [scheduleSnapshot],
  );
  const scheduleList: ScheduleListPresentation =
    scheduleSnapshot === null
      ? connection.kind === "unavailable"
        ? { kind: "disconnected" }
        : scheduleResult._tag === "Failure"
          ? { kind: "error", message: errorMessage(scheduleResult.cause) }
          : {
              kind: "loading",
              message:
                connection.kind === "opening" ? "Connecting to pico..." : "Loading schedules...",
            }
      : {
          kind: "loaded",
          observedAt: formatScheduleTime(scheduleSnapshot.observedAt),
          rows: scheduleRows,
          freshness: !available
            ? {
                kind: "stale",
                message:
                  connection.kind === "opening" ? "Connecting to pico." : "Connection unavailable.",
              }
            : scheduleResult._tag === "Failure"
              ? {
                  kind: "stale",
                  message: `Could not refresh schedules. ${errorMessage(scheduleResult.cause)}`,
                }
              : scheduleResult.waiting
                ? { kind: "refreshing" }
                : { kind: "current" },
        };

  const markChatUnread = (_workspaceId: string, id: string) => {
    if (openCapture.current?.chatId === id) openCapture.current = null;
    void chatReadState.markUnread(id as ChatId);
  };

  const markChatRead = (_workspaceId: string, id: string) => {
    const chatId = id as ChatId;
    const summary = chatResultEntries.get(chatId);
    void chatReadState.markRead(chatId, summary);
  };

  const newChat = (workspaceId?: string) => {
    const workspace = workspaceId
      ? groups.find((group) => group.workspace.id === workspaceId)?.workspace
      : (groups.find((group) => group.workspace.id === routeWorkspaceId)?.workspace ??
        groups.find((group) => group.workspace.id === preferredWorkspace.current)?.workspace ??
        groups[0]?.workspace);
    if (workspace)
      navigatePage(entryPage(retainEntry(workspace, { kind: "new", modelOverride: null }, true)));
    else if (!workspaceId) addWorkspace();
  };
  const captureOpen = (workspaceId: string, chatId: ChatId, navigating: boolean) => {
    openCapture.current = {
      ...chatReadState.captureOpen(chatId),
      pendingHref: navigating
        ? router.buildLocation({
            to: "/workspaces/$workspaceId/chats/$chatId",
            params: { workspaceId, chatId },
          }).href
        : null,
    };
    setChatReadRevision((value) => value + 1);
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
    if (target) {
      captureOpen(group.workspace.id, target.id, true);
      navigatePage({ kind: "chat", workspaceId: group.workspace.id, chatId: target.id });
    }
  };
  const selectTab = (id: string) => {
    const current = navigationRef.current;
    const entry = current.openKeys.includes(id) ? current.entries.get(id) : undefined;
    if (!entry) return;
    const sameTab = id === selected?.key && page.kind !== "settings";
    if (entry.target.kind === "chat")
      captureOpen(entry.workspace.id, entry.target.chat.id, !sameTab);
    if (sameTab) return;
    navigatePage(entryPage(entry));
  };
  const closeTab = (id: string) => {
    const current = navigationRef.current;
    const index = current.openKeys.indexOf(id);
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
    if (pageFromMatches(router.state.matches).kind === "schedules") returnToChat();
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
  const ensureChat = async (entry: DraftEntry): Promise<Chat | undefined> => {
    if (!state) return;
    if (entry.target.kind === "chat") return entry.target.chat;
    if (isCreationUnconfirmed(entry)) return;
    if (creatingChats.current.has(entry.workspace.id)) return;
    creatingChats.current.add(entry.workspace.id);
    updateEntry(entry.key, (value) => ({ ...value, submission: { kind: "creating" } }));
    const exit = await runCommand(registry, state.createChat(entry.workspace.id), {
      externalId: null,
      modelOverride: entry.target.modelOverride,
    });
    creatingChats.current.delete(entry.workspace.id);
    if (Exit.isFailure(exit)) {
      updateEntry(entry.key, (value) => ({
        ...value,
        submission: {
          kind: "error",
          message: `${errorMessage(exit.cause)} Your draft is kept. Check the chat list, then close this tab before starting another chat.`,
        },
      }));
      return;
    }
    const chat = exit.value;
    updateEntry(entry.key, (value) => ({
      ...value,
      target: { kind: "chat", chat },
      submission: { kind: "idle" },
    }));
    if (ownsVisit() && navigationRef.current.openKeys.includes(entry.key)) {
      navigatePage({ kind: "chat", workspaceId: entry.workspace.id, chatId: chat.id }, true);
    }
    return chat;
  };

  const openSkillCatalog = (entryKey: string) => {
    if (!state || registry.get(state.connection).kind !== "active") return;
    const entry = navigationRef.current.entries.get(entryKey);
    if (!entry || isCreationUnconfirmed(entry)) return;
    if (entry.target.kind === "chat") {
      const catalog = registry.get(state.availableSkills(entry.target.chat.id));
      if (catalog._tag !== "Initial" && !catalog.waiting) {
        registry.refresh(state.availableSkills(entry.target.chat.id));
      }
      return;
    }
    const catalog = registry.get(state.availableWorkspaceSkills(entry.workspace.id));
    if (catalog._tag !== "Initial" && !catalog.waiting) {
      registry.refresh(state.availableWorkspaceSkills(entry.workspace.id));
    }
  };

  useEffect(() => {
    if (!conversationEntry || skillMenuResolved === null) return;
    if (skillMenuOpenTokens.current.get(conversationEntry.key) === "open") return;
    skillMenuOpenTokens.current.set(conversationEntry.key, "open");
    openSkillCatalog(conversationEntry.key);
  }, [conversationEntry, skillMenuResolved, state]);
  const modelEntry = () => {
    if (!state || !ownsVisit() || registry.get(state.connection).kind !== "active") return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (
      !entry ||
      entry.key !== selected?.key ||
      entry.submission.kind === "creating" ||
      isCreationUnconfirmed(entry)
    )
      return;
    if (entry.target.kind === "chat") {
      const id = entry.target.chat.id;
      if (
        registry.get(state.switchModel(id)).waiting ||
        registry.get(state.availableModels(id)).waiting ||
        registry.get(state.currentModel(id)).waiting
      )
        return;
    }
    return entry;
  };
  const openModelPicker = () => {
    if (!state) return;
    const entry = modelEntry();
    if (!entry) return;
    if (entry.target.kind === "new") {
      const catalog = registry.get(state.availableWorkspaceModels(entry.workspace.id));
      if (catalog._tag !== "Initial" && !catalog.waiting) {
        registry.refresh(state.availableWorkspaceModels(entry.workspace.id));
      }
    }
  };
  const switchModel = async (model: ModelRef) => {
    const entry = modelEntry();
    if (!state || entry?.target.kind !== "chat") return;
    await runCommand(registry, state.switchModel(entry.target.chat.id), model);
  };
  const selectModel = (value: string) => {
    const entry = modelEntry();
    if (!state || !entry) return;
    if (entry.target.kind === "new") {
      if (value === workspaceDefaultModelValue) {
        updateEntry(entry.key, (current) => ({
          ...current,
          target:
            current.target.kind === "new"
              ? { ...current.target, modelOverride: null }
              : current.target,
        }));
        return;
      }
      const models = draftCatalog
        ? Option.getOrElse(AsyncResult.value(draftCatalog.models), () => [])
        : [];
      const model = models.find((candidate) => modelValue(candidate) === value);
      if (!model) return;
      updateEntry(entry.key, (current) => ({
        ...current,
        target:
          current.target.kind === "new"
            ? {
                ...current.target,
                modelOverride: { provider: model.provider, id: model.id },
              }
            : current.target,
      }));
      return;
    }
    const models = AsyncResult.value(registry.get(state.availableModels(entry.target.chat.id)));
    if (Option.isNone(models)) return;
    const model = models.value.find((model) => modelValue(model) === value);
    if (model) void switchModel(model);
  };
  const retryModel = () => {
    const entry = modelEntry();
    if (!state || !entry) return;
    if (entry.target.kind === "new") {
      registry.refresh(state.availableWorkspaceModels(entry.workspace.id));
      return;
    }
    const id = entry.target.chat.id;
    const request = registry.get(state.modelSwitchRequest(id));
    if (registry.get(state.switchModel(id))._tag === "Failure" && request) {
      void switchModel(request);
    } else {
      registry.refresh(state.availableModels(id));
      registry.refresh(state.currentModel(id));
    }
  };

  const moveSkillCompletion = (delta: -1 | 1) => {
    if (skillMenuResolved?.visibility !== "ready") return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (!entry || entry.key !== selected?.key) return;
    const size = skillMenuResolved.options.length;
    if (size === 0) return;
    updateSkillMenuState(entry.key, (current) => ({
      ...current,
      selectedIndex: (size + skillMenuResolved.selectedIndex + delta) % size,
    }));
  };

  const dismissSkillCompletion = () => {
    if (!skillMenuResolved) return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (!entry || entry.key !== selected?.key) return;
    updateSkillMenuState(entry.key, (current) => ({
      ...current,
      dismissedSignature: skillMenuResolved.signature,
      selectedIndex: 0,
    }));
    skillMenuOpenTokens.current.delete(entry.key);
  };

  const applySkillCompletion = (name?: string) => {
    if (skillMenuResolved?.visibility !== "ready") return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (!entry || entry.key !== selected?.key) return;
    const selectedSkill =
      name === undefined
        ? skillMenuResolved.options[skillMenuResolved.selectedIndex]
        : skillMenuResolved.options.find((option) => option.name === name);
    if (!selectedSkill) return;
    const replaced = applySkill(entry.value.text, skillMenuResolved.token, selectedSkill.name);
    updateEntry(entry.key, (value) => ({
      ...value,
      value: { ...value.value, text: replaced.text },
    }));
    const dismissedSignature = menuSignature(replaced.text, replaced.caret, replaced.caret);
    updateSkillMenuState(entry.key, (current) => ({
      ...current,
      caretStart: replaced.caret,
      caretEnd: replaced.caret,
      selectedIndex: 0,
      tokenKey: null,
      dismissedSignature,
    }));
    requestComposerCaret(entry.key, replaced.caret, replaced.caret);
    skillMenuOpenTokens.current.delete(entry.key);
  };

  const retrySkillCatalog = () => {
    if (!state || !conversationEntry || skillMenuResolved?.visibility !== "error") return;
    if (!available) return;
    if (conversationEntry.target.kind === "chat") {
      if (conversation?.skills?.waiting) return;
      registry.refresh(state.availableSkills(conversationEntry.target.chat.id));
      return;
    }
    if (draftCatalog?.skills?.waiting) return;
    registry.refresh(state.availableWorkspaceSkills(conversationEntry.workspace.id));
  };

  const recordComposerCaret = (selection: { readonly start: number; readonly end: number }) => {
    if (!ownsVisit()) return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (!entry || entry.key !== selected?.key) return;
    setComposerCaretRequest((current) =>
      current?.key === entry.key &&
      current.selection.start === selection.start &&
      current.selection.end === selection.end
        ? null
        : current,
    );
    const token = findSkillToken(entry.value.text, selection.start, selection.end);
    const tokenKey = token ? menuTokenKey(token) : null;
    updateSkillMenuState(entry.key, (current) => ({
      ...current,
      caretStart: selection.start,
      caretEnd: selection.end,
      tokenKey,
      selectedIndex: current.tokenKey === tokenKey ? current.selectedIndex : 0,
    }));
  };
  const submitDraft = async () => {
    if (
      !state ||
      content.kind !== "ready" ||
      !ownsVisit() ||
      (page.kind !== "draft" && page.kind !== "chat") ||
      registry.get(state.connection).kind !== "active"
    )
      return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (
      !entry ||
      !isDraftSendable(entry.value) ||
      entry.submission.kind === "creating" ||
      entry.submission.kind === "sending" ||
      isCreationUnconfirmed(entry)
    )
      return;
    const key = entry.key;
    const sentValue = entry.value;
    if (entry.target.kind === "chat") {
      const id = entry.target.chat.id;
      if (
        registry.get(state.send(id)).waiting ||
        registry.get(state.switchModel(id)).waiting ||
        registry.get(state.navigateHistory(id)).waiting ||
        registry.get(state.historyReplacing(id)) ||
        registry.get(state.live(id)).run.kind === "running"
      )
        return;
    }
    const chat = entry.target.kind === "chat" ? entry.target.chat : await ensureChat(entry);
    if (!chat) return;
    updateEntry(key, (value) => ({
      ...value,
      value: value.value === sentValue ? emptyDraft : value.value,
      recoveredDraft: null,
      submission: { kind: "sending" },
    }));
    const exit = await runCommand(registry, state.send(chat.id), {
      text: sentValue.text,
      attachments: toPromptAttachments(sentValue),
    });
    updateEntry(key, (value) => ({
      ...value,
      value: Exit.isFailure(exit) && value.value === emptyDraft ? sentValue : value.value,
      submission: Exit.isSuccess(exit)
        ? { kind: "idle" }
        : {
            kind: "error",
            message: `${errorMessage(exit.cause)} Your draft is kept. Check the conversation before sending again.`,
          },
    }));
  };
  const removeComposerImage = (id: string) => {
    if (!ownsVisit() || !selected) return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (!entry || entry.key !== selected.key) return;
    updateEntry(entry.key, (value) => ({
      ...value,
      value: { ...value.value, images: value.value.images.filter((image) => image.id !== id) },
    }));
  };
  const restoreRecoveredDraft = () => {
    if (!ownsVisit() || !selected) return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (!entry || entry.key !== selected.key || entry.recoveredDraft === null) return;
    updateEntry(entry.key, (value) =>
      value.recoveredDraft === null
        ? value
        : { ...value, value: value.recoveredDraft, recoveredDraft: null },
    );
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
  const shake = async (mode: ShakeMode) => {
    if (!state || !ownsVisit() || registry.get(state.connection).kind !== "active") return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (entry?.target.kind !== "chat") return;
    setShakeFeedback(null);
    const exit = await Effect.runPromiseExit(state.shake(registry, entry.target.chat.id, mode));
    if (!ownsVisit() || findPageEntry(page, navigationRef.current.entries)?.key !== entry.key)
      return;
    setShakeFeedback({
      visit,
      key: entry.key,
      value: Exit.isSuccess(exit)
        ? { kind: "status", message: presentShake(exit.value) }
        : { kind: "error", message: `Shake was not confirmed. ${errorMessage(exit.cause)}` },
    });
  };
  const orphanDrafts = [...navigation.entries.values()].filter(
    (entry) =>
      !isDraftEmpty(entry.value) &&
      workspaces._tag === "Success" &&
      !workspaces.value.some((workspace) => workspace.id === entry.workspace.id),
  );
  const historySnapshot = conversation
    ? Option.getOrNull(AsyncResult.value(conversation.history))
    : null;
  const historyPreview = conversation
    ? Option.getOrNull(AsyncResult.value(conversation.previewHistory))
    : null;
  const activeHistoryTargetId = historySnapshot?.activeLeafId ?? null;
  const selectedHistoryTargetId =
    historyPreviewTarget?.conversationKey === selectedConversationKey
      ? historyPreviewTarget.targetId
      : null;

  useEffect(() => {
    if (!state || !historyOpen || selectedChatId === null) {
      historyWasOpen.current = false;
      return;
    }
    const initialOpen = !historyWasOpen.current;
    historyWasOpen.current = true;
    if (initialOpen) {
      registry.set(state.history(selectedChatId), historyQuery);
      return;
    }
    const timeout = setTimeout(() => {
      registry.set(state.history(selectedChatId), historyQuery);
    }, 200);
    return () => clearTimeout(timeout);
  }, [state, registry, historyOpen, historyQuery, selectedChatId, visit]);

  useEffect(() => {
    if (!historyOpen || selectedConversationKey === null || historySnapshot === null) return;
    const current =
      historyPreviewTarget?.conversationKey === selectedConversationKey
        ? historyPreviewTarget.targetId
        : null;
    const next =
      current ??
      historySnapshot.activeLeafId ??
      historySnapshot.nodes.find((node) => node.visibleByDefault && node.kind !== "tool")
        ?.defaultTargetId ??
      null;
    if (next === null || current === next) return;
    setHistoryPreviewTarget({ conversationKey: selectedConversationKey, targetId: next });
  }, [historyOpen, historySnapshot, selectedConversationKey, historyPreviewTarget]);

  useEffect(() => {
    if (
      !state ||
      !historyOpen ||
      selectedChatId === null ||
      selectedHistoryTargetId === null ||
      historySnapshot?.version === undefined
    )
      return;
    registry.set(state.previewHistory(selectedChatId), selectedHistoryTargetId);
  }, [
    state,
    registry,
    historyOpen,
    selectedChatId,
    selectedHistoryTargetId,
    historySnapshot?.version,
  ]);

  const continueHistory = async () => {
    if (
      !state ||
      !ownsVisit() ||
      !historyOpen ||
      selectedConversationKey === null ||
      selectedChatId === null ||
      historySnapshot === null ||
      selectedHistoryTargetId === null ||
      historyPreview?.targetId !== selectedHistoryTargetId ||
      historyPreview.version !== historySnapshot.version ||
      registry.get(state.connection).kind !== "active"
    )
      return;
    const entry = findPageEntry(page, navigationRef.current.entries);
    if (!entry || entry.key !== selectedConversationKey || entry.target.kind !== "chat") return;
    const id = entry.target.chat.id;
    if (
      registry.get(state.navigateHistory(id)).waiting ||
      registry.get(state.historyReplacing(id)) ||
      registry.get(state.send(id)).waiting ||
      registry.get(state.switchModel(id)).waiting ||
      registry.get(state.live(id)).run.kind === "running"
    )
      return;
    const draftBefore = entry.value;
    const exit = await runCommand(registry, state.navigateHistory(entry.target.chat.id), {
      targetId: selectedHistoryTargetId,
      expectedVersion: historySnapshot.version,
    });
    if (!ownsVisit()) return;
    if (Exit.isFailure(exit)) return;
    const result = exit.value;
    if (result.kind === "cancelled") return;
    if (result.kind === "conflict") {
      registry.set(state.history(entry.target.chat.id), historyQuery);
      if (result.history.activeLeafId !== null)
        setHistoryPreviewTarget({
          conversationKey: entry.key,
          targetId: result.history.activeLeafId,
        });
      return;
    }
    registry.set(state.history(entry.target.chat.id), historyQuery);
    updateEntry(entry.key, (value) => ({ ...value, recoveredDraft: null }));
    if (result.draft === null) return;
    const recovered = toDraftValue(result.draft);
    const current = navigationRef.current.entries.get(entry.key);
    if (!current) return;
    if (isDraftEmpty(draftBefore) && isDraftEmpty(current.value) && current.value === draftBefore) {
      updateEntry(entry.key, (value) => ({ ...value, value: recovered, recoveredDraft: null }));
      return;
    }
    updateEntry(entry.key, (value) => ({ ...value, recoveredDraft: recovered }));
  };
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
  const retryConnection = () => {
    if (state) registry.set(state.ensure, undefined);
  };
  const retryTranscript = () => {
    if (content.kind === "error" && content.recovery === "home") navigatePage({ kind: "home" });
    else if (content.kind === "error" && content.recovery === "workspace" && routeWorkspaceId)
      navigatePage({ kind: "draft", workspaceId: routeWorkspaceId, tabKey: null });
    else if (unavailable) retryConnection();
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
        unread: chatReadState.unread(chat.id, chatResultEntries.get(chat.id)),
      }));
      const matchesWorkspace = workspace.name.toLocaleLowerCase().includes(query);
      const isVisibleChat = workspace.id === routeWorkspaceId && visibleChatId !== null;
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
            ? summaries.filter(
                (chat) =>
                  chat.title.toLocaleLowerCase().includes(query) ||
                  (isVisibleChat && chat.id === visibleChatId),
              )
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
    activeChatId: visibleChatId,
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
      id: key,
      title:
        entry.target.kind === "chat"
          ? (titles.get(entry.target.chat.id) ?? `Chat ${entry.target.chat.id.slice(-8)}`)
          : newChatTitle(entry.value.text),
      contextLabel: `${entry.workspace.name} · ${entry.target.kind === "chat" ? entry.target.chat.cwd : entry.workspace.defaultCwd}`,
      unread:
        entry.target.kind === "chat"
          ? chatReadState.unread(entry.target.chat.id, chatResultEntries.get(entry.target.chat.id))
          : false,
    });
  }
  const creating =
    conversationEntry?.submission.kind === "creating" ||
    (conversationEntry?.target.kind === "new" &&
      creatingChats.current.has(conversationEntry.workspace.id));
  const creationUnconfirmed = isCreationUnconfirmed(conversationEntry);
  const sending = conversationEntry?.submission.kind === "sending" || conversation?.sending.waiting;
  const running = conversation?.live.run.kind === "running";
  const switching = conversation?.switching.waiting === true;
  const historyPending =
    conversation?.navigateHistory.waiting === true || conversation?.historyReplacing === true;
  const composerSendEnabled =
    available &&
    !!selected &&
    !creating &&
    !creationUnconfirmed &&
    !switching &&
    !historyPending &&
    !running &&
    !sending;
  const statusLabel = historyPending
    ? "Confirming conversation destination. Draft kept."
    : !conversationEntry
      ? groups.length > 0
        ? "Choose a chat or start a new one"
        : "Add a workspace to start a chat"
      : creationUnconfirmed
        ? "Chat creation was not confirmed. Check the chat list, then close this tab before starting another chat."
        : connection.kind === "opening"
          ? "Opening connection. Draft kept."
          : !available
            ? "Connection unavailable. Draft kept."
            : creating
              ? conversationEntry.submission.kind === "creating"
                ? "Creating chat. Draft kept."
                : "Another chat is being created. Draft kept."
              : switching
                ? "Switching model. Draft kept."
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
  const composerImages = toComposerImages(conversationEntry?.value ?? emptyDraft);
  const composer: ComposerPresentation =
    running || sending
      ? {
          mode: "stop",
          value: conversationEntry?.value.text ?? "",
          images: composerImages,
          placeholder: "Write your next message...",
          editable: true,
          canStop: available && !conversation?.stopping.waiting,
          statusLabel,
        }
      : {
          mode: "send",
          value: conversationEntry?.value.text ?? "",
          images: composerImages,
          placeholder: conversationEntry
            ? "Ask pico to help with your project..."
            : groups.length > 0
              ? "Choose a chat or start a new one"
              : "Add a workspace to start",
          editable: !!conversationEntry,
          canSubmit: composerSendEnabled && !!selected && isDraftSendable(selected.value),
          statusLabel,
        };
  const todo = conversation
    ? Option.getOrElse(AsyncResult.value(conversation.todo), () => ({
        kind: "unavailable" as const,
      }))
    : { kind: "unavailable" as const };
  const modelPicker = ((): ModelPickerPresentation => {
    const current = conversation
      ? Option.getOrUndefined(AsyncResult.value(conversation.currentModel))
      : undefined;
    const draftSelected =
      conversationEntry?.target.kind === "new" ? conversationEntry.target.modelOverride : null;
    const draftCatalogModels = draftCatalog
      ? Option.getOrElse(AsyncResult.value(draftCatalog.models), () => [])
      : [];
    const draftSelectedInfo =
      draftSelected === null
        ? undefined
        : draftCatalogModels.find(
            (model) => model.provider === draftSelected.provider && model.id === draftSelected.id,
          );
    const label =
      conversationEntry?.target.kind === "new"
        ? draftSelectedInfo
          ? modelLabel(draftSelectedInfo)
          : draftSelected
            ? modelRefLabel(draftSelected)
            : "Workspace default"
        : current
          ? modelLabel(current)
          : "Choose model";
    const busy = creating || switching;
    const retry =
      available &&
      !busy &&
      !creationUnconfirmed &&
      !conversation?.models.waiting &&
      !conversation?.currentModel.waiting &&
      !draftCatalog?.models.waiting
        ? "enabled"
        : "disabled";
    const switched = conversation
      ? Option.getOrUndefined(AsyncResult.value(conversation.switching))
      : undefined;
    const warning =
      switched?.kind === "persistence-unconfirmed" &&
      current &&
      modelValue(current) === modelValue(switched.model)
        ? "Model changed for this chat. Saving was not confirmed; it may revert after restart."
        : null;
    const feedback: ModelPickerPresentation["feedback"] =
      conversation?.switching._tag === "Failure"
        ? { kind: "error", message: errorMessage(conversation.switching.cause), retry, warning }
        : conversation?.models._tag === "Failure"
          ? { kind: "error", message: errorMessage(conversation.models.cause), retry, warning }
          : conversation?.currentModel._tag === "Failure"
            ? {
                kind: "error",
                message: errorMessage(conversation.currentModel.cause),
                retry,
                warning,
              }
            : draftCatalog?.models._tag === "Failure"
              ? {
                  kind: "error",
                  message: errorMessage(draftCatalog.models.cause),
                  retry,
                  warning: null,
                }
              : conversationEntry?.target.kind === "new" &&
                  conversationEntry.submission.kind === "error"
                ? {
                    kind: "error",
                    message: conversationEntry.submission.message,
                    retry,
                    warning: null,
                  }
                : warning !== null
                  ? { kind: "warning", message: warning }
                  : { kind: "none" };
    if (!conversationEntry) {
      return { label, control: { kind: "disabled", reason: "Choose a chat first." }, feedback };
    }
    if (creationUnconfirmed) {
      return {
        label,
        control: { kind: "disabled", reason: "Chat creation was not confirmed." },
        feedback,
      };
    }
    if (!available || busy) {
      const reason = !available
        ? current
          ? "Disconnected. Showing the last known model."
          : "Connect to choose a model."
        : creating
          ? "Creating chat..."
          : "Switching model...";
      return { label, control: { kind: "disabled", reason }, feedback };
    }
    if (conversationEntry.target.kind === "new") {
      if (!draftCatalog || draftCatalog.models._tag === "Initial") {
        return { label, control: { kind: "disabled", reason: "Loading models..." }, feedback };
      }
      if (draftCatalogModels.length === 0) {
        return {
          label,
          control: {
            kind: "disabled",
            reason:
              draftCatalog.models._tag === "Failure"
                ? "Models unavailable."
                : "No models available.",
          },
          feedback,
        };
      }
      const selectedValue =
        conversationEntry.target.modelOverride === null
          ? workspaceDefaultModelValue
          : modelValue(conversationEntry.target.modelOverride);
      const options = [
        { value: workspaceDefaultModelValue, label: "Workspace default" },
        ...draftCatalogModels.map((model) => ({
          value: modelValue(model),
          label: `${modelLabel(model)} · ${model.id}`,
        })),
      ];
      return {
        label,
        control: {
          kind: "select",
          value: selectedValue,
          options,
        },
        feedback,
      };
    }
    if (
      !conversation ||
      conversation.models._tag === "Initial" ||
      conversation.currentModel._tag === "Initial"
    ) {
      return { label, control: { kind: "disabled", reason: "Loading models..." }, feedback };
    }
    const models = Option.getOrElse(AsyncResult.value(conversation.models), () => []);
    if (conversation.models.waiting || conversation.currentModel.waiting) {
      return { label, control: { kind: "disabled", reason: "Loading models..." }, feedback };
    }
    if (models.length === 0) {
      return {
        label,
        control: {
          kind: "disabled",
          reason:
            conversation.models._tag === "Failure" ? "Models unavailable." : "No models available.",
        },
        feedback,
      };
    }
    return {
      label,
      control: {
        kind: "select",
        value: current ? modelValue(current) : "",
        options: models.map((model) => ({
          value: modelValue(model),
          label: `${modelLabel(model)} · ${model.id}`,
        })),
      },
      feedback,
    };
  })();
  const historyItems = useMemo(
    () =>
      presentHistoryItems(historySnapshot, {
        revealAll: historyRevealAll,
        previewTargetId: selectedHistoryTargetId,
      }),
    [historySnapshot, historyRevealAll, selectedHistoryTargetId],
  );
  const navigateResult = conversation
    ? Option.getOrNull(AsyncResult.value(conversation.navigateHistory))
    : null;
  const historyConflictMessage =
    navigateResult?.kind === "conflict"
      ? navigateResult.reason === "version-mismatch"
        ? "History changed in another session. Refresh and pick a branch again."
        : navigateResult.reason === "busy"
          ? "Another history action is still running. Wait for it to finish and try again."
          : "The selected branch target is no longer available. Pick a different branch."
      : null;
  const historyError =
    conversation?.history._tag === "Failure"
      ? errorMessage(conversation.history.cause)
      : conversation?.previewHistory._tag === "Failure"
        ? errorMessage(conversation.previewHistory.cause)
        : conversation?.navigateHistory._tag === "Failure"
          ? errorMessage(conversation.navigateHistory.cause)
          : historyConflictMessage;
  const historyPreviewPresentation: HistoryPanelPresentation["preview"] = !historyOpen
    ? { kind: "idle", label: "Open history and branches to preview branch targets." }
    : selectedHistoryTargetId === null
      ? { kind: "idle", label: "Select a branch target to preview." }
      : conversation?.previewHistory._tag === "Failure"
        ? { kind: "error", label: errorMessage(conversation.previewHistory.cause) }
        : conversation?.previewHistory.waiting || historyPreview === null
          ? { kind: "loading", label: "Loading preview..." }
          : historyPreview.targetId !== selectedHistoryTargetId ||
              historyPreview.version !== historySnapshot?.version
            ? { kind: "loading", label: "Refreshing preview..." }
            : {
                kind: "ready",
                destinationLabel:
                  historySnapshot?.nodes.find((node) => node.entryId === historyPreview.targetId)
                    ?.kind === "user"
                    ? "Continue before this user message and recover its prompt as a draft."
                    : historyPreview.destinationLeafId === null
                      ? "Continue from the start of this conversation."
                      : "Continue after this entry. Earlier branches remain in history.",
                blocks: toPreviewBlocks(historyPreview.blocks),
              };
  const historyPanel: HistoryPanelPresentation | null =
    conversationEntry?.target.kind === "chat" && conversation
      ? {
          open: historyOpen,
          loading: conversation.history._tag === "Initial" || conversation.history.waiting,
          busy: historyPending,
          error: historyError,
          query: historyQuery,
          revealAll: historyRevealAll,
          canContinue:
            available &&
            !historyPending &&
            !running &&
            !sending &&
            !switching &&
            historySnapshot?.canContinue === true &&
            historyPreviewPresentation.kind === "ready" &&
            historyPreview?.version === historySnapshot.version,
          items: historyItems,
          activeTargetId: activeHistoryTargetId,
          previewTargetId: selectedHistoryTargetId,
          preview: historyPreviewPresentation,
          hasRecoveredDraft: conversationEntry.recoveredDraft !== null,
        }
      : null;

  const skillCompletion: SkillCompletionPresentation = (() => {
    if (!conversationEntry || !available || skillMenuResolved === null) return { kind: "closed" };
    const listboxId = menuListboxId(conversationEntry.key);
    if (skillMenuResolved.visibility === "ready") {
      const options = skillMenuResolved.options.map((option, index) => ({
        id: menuOptionId(conversationEntry.key, index),
        name: option.name,
        description: option.description,
        selected: index === skillMenuResolved.selectedIndex,
      }));
      const activeDescendantId =
        options[skillMenuResolved.selectedIndex]?.id ?? menuStatusId(conversationEntry.key);
      return {
        kind: "ready",
        listboxId,
        activeDescendantId,
        options,
      };
    }
    if (skillMenuResolved.visibility === "error") {
      return {
        kind: "error",
        listboxId,
        activeDescendantId: menuStatusId(conversationEntry.key),
        message:
          conversation?.skills?._tag === "Failure"
            ? errorMessage(conversation.skills.cause)
            : draftCatalog?.skills?._tag === "Failure"
              ? errorMessage(draftCatalog.skills.cause)
              : "Could not load skill commands.",
        retry:
          available &&
          (conversationEntry.target.kind === "chat"
            ? conversation?.skills?.waiting !== true
            : draftCatalog?.skills?.waiting !== true)
            ? "enabled"
            : "disabled",
      };
    }
    if (skillMenuResolved.visibility === "empty") {
      return {
        kind: "empty",
        listboxId,
        activeDescendantId: menuStatusId(conversationEntry.key),
        message: "No matching skill commands.",
      };
    }
    return {
      kind: "loading",
      listboxId,
      activeDescendantId: menuStatusId(conversationEntry.key),
      message: "Loading skill commands...",
    };
  })();
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
                  ? "Retry connection"
                  : content.recovery === "chats"
                    ? "Retry chats"
                    : "Retry workspaces",
        }
      : content.kind === "loading"
        ? { state: "loading", label: content.label }
        : content.kind === "ready" && !selected
          ? { state: "loading", label: "Opening chat..." }
          : conversation && conversationEntry
            ? presentTranscript(
                conversation.snapshot,
                conversation.live,
                conversationEntry.disclosures,
                connection,
                todo,
              )
            : conversationEntry
              ? {
                  state: "empty",
                  title: "What are you working on?",
                  description: `Start a conversation in ${conversationEntry.workspace.name}.`,
                }
              : workspaces._tag === "Failure"
                ? {
                    state: "error",
                    title: "Workspaces unavailable",
                    description: errorMessage(workspaces.cause),
                    retryLabel: unavailable ? "Retry connection" : "Retry workspaces",
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
    toolSelection.conversationKey === selectedConversationKey &&
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
        orphanDrafts={orphanDrafts.map((entry) => ({
          key: entry.key,
          label: `${entry.target.kind === "chat" ? `Chat ${entry.target.chat.id.slice(-8)}` : "New chat"} in ${entry.workspace.name}`,
          text: entry.value.text || (entry.value.images.length > 0 ? "[Image draft]" : ""),
        }))}
        onRetry={retryConnection}
      />
      {page.kind !== "schedules" &&
        conversation?.snapshot._tag === "Failure" &&
        transcript.state !== "error" && (
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel p-3 text-label">
            <p className="min-w-0 flex-1 text-danger" role="alert">
              {errorMessage(conversation.snapshot.cause)} Displayed history may be incomplete.
            </p>
            <Button onClick={retryTranscript} size="small" tone="secondary">
              {unavailable ? "Retry connection" : "Retry history"}
            </Button>
          </div>
        )}
      {page.kind !== "schedules" && selected?.submission.kind === "error" && (
        <p
          className="shrink-0 border-b border-border bg-panel p-3 text-label text-danger"
          role="alert"
        >
          {selected.submission.message}
        </p>
      )}
      {page.kind !== "schedules" && conversation?.stopping._tag === "Failure" && (
        <p
          className="shrink-0 border-b border-border bg-panel p-3 text-label text-danger"
          role="alert"
        >
          {errorMessage(conversation.stopping.cause)} Stop was not confirmed. Reconnect and check
          the run status before requesting Stop again.
        </p>
      )}
      {page.kind !== "schedules" &&
        available &&
        conversation?.live.run.kind === "unknown" &&
        !sending && (
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
          onOpenSchedules={openSchedules}
          schedulesHref={schedulesHref}
          returnToChatHref={returnToChatHref}
          view={
            page.kind !== "schedules"
              ? { kind: "chat" }
              : {
                  kind: "schedules",
                  page: {
                    list: scheduleList,
                    expandedId: expandedScheduleId,
                    refreshEnabled: available && !scheduleResult.waiting,
                    onRefresh: refreshSchedules,
                    onExpandedChange: (id, open) => {
                      const entry = scheduleSnapshot?.entries.find((item) => item.view.id === id);
                      if (!entry) return;
                      setExpandedScheduleId((current) =>
                        open ? entry.view.id : current === id ? null : current,
                      );
                    },
                  },
                }
          }
          onReturnToChat={returnToChat}
          closeChat={closePresentation}
          chatCloseDisabled={!available || closeFlow.kind !== "idle"}
          onChatClose={closeChat}
          onCloseChatConfirm={confirmCloseChat}
          onCloseChatDismiss={dismissCloseChat}
          onCloseChatRetry={retryCloseChat}
          composer={composer}
          skillCompletion={skillCompletion}
          composerCaretRequest={
            composerCaretRequest && composerCaretRequest.key === conversationEntry?.key
              ? {
                  revision: composerCaretRequest.revision,
                  selection: composerCaretRequest.selection,
                }
              : null
          }
          todo={presentTodo(todo, conversationEntry?.disclosures.get("todo-dock") ?? false)}
          shakeEnabled={available && page.kind === "chat" && selected?.target.kind === "chat"}
          onShake={shake}
          shakeFeedback={
            shakeFeedback?.visit === visit && shakeFeedback.key === selected?.key
              ? shakeFeedback.value
              : { kind: "idle" }
          }
          modelPicker={modelPicker}
          onModelPickerOpen={openModelPicker}
          onModelSelect={selectModel}
          onModelRetry={retryModel}
          contextUsage={presentContextUsage(conversation?.contextUsage, connection)}
          contextDetailsOpen={
            contextDetailsKey !== undefined && contextDetailsKey === (selected?.key ?? null)
          }
          onContextDetailsOpenChange={(open) => {
            setContextDetailsKey(open ? (selected?.key ?? null) : undefined);
            if (open && state && visibleChatId) {
              registry.set(state.contextUsage(visibleChatId), undefined);
            }
          }}
          contextLabel={
            conversationEntry
              ? `${conversationEntry.workspace.name} · ${conversationEntry.target.kind === "chat" ? conversationEntry.target.chat.cwd : conversationEntry.workspace.defaultCwd}`
              : "Your project conversations"
          }
          conversationKey={conversationEntry?.key ?? null}
          desktopCollapse={{ collapsed: sidebarCollapsed, onCollapsedChange: setSidebarCollapsed }}
          navigation={presentation}
          onChatSelect={selectChat}
          onChatMarkUnread={markChatUnread}
          onChatMarkRead={markChatRead}
          onChatsRetry={(id) => {
            const workspace = groups.find((group) => group.workspace.id === id)?.workspace;
            if (state && workspace) registry.refresh(state.chats(workspace.id));
          }}
          onComposerSubmit={submitDraft}
          onComposerValueChange={(text) => {
            if (!ownsVisit()) return;
            const entry = findPageEntry(page, navigationRef.current.entries);
            if (!entry) return;
            updateEntry(entry.key, (current) => ({
              ...current,
              value: { ...current.value, text },
            }));
            const tabState = readSkillMenuState(entry);
            const token = findSkillToken(text, tabState.caretStart, tabState.caretEnd);
            const tokenKey = token ? menuTokenKey(token) : null;
            updateSkillMenuState(entry.key, (current) => ({
              ...current,
              tokenKey,
              selectedIndex: current.tokenKey === tokenKey ? current.selectedIndex : 0,
            }));
          }}
          onComposerImageRemove={removeComposerImage}
          onComposerCaretChange={recordComposerCaret}
          onSkillCompletionCommit={() => applySkillCompletion()}
          onSkillCompletionMove={moveSkillCompletion}
          onSkillCompletionDismiss={dismissSkillCompletion}
          onSkillCompletionSelect={applySkillCompletion}
          onSkillCompletionRetry={retrySkillCatalog}
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
          onDeleteWorkspace={deleteWorkspace}
          workspaceDeleteDisabled={!available || workspaceSaving || deleteFlow.kind !== "idle"}
          deleteWorkspace={
            deleteFlow.kind === "idle"
              ? null
              : {
                  workspaceName: deleteFlow.target.name,
                  pending: deleteFlow.kind === "deleting",
                  error: deleteFlow.kind === "confirmation" ? deleteFlow.error : null,
                  canConfirm: available && deleteFlow.kind === "confirmation",
                }
          }
          onDeleteWorkspaceConfirm={confirmDeleteWorkspace}
          onDeleteWorkspaceDismiss={() => {
            if (deleteFlowRef.current.kind === "confirmation") updateDeleteFlow({ kind: "idle" });
          }}
          onNewChat={newChat}
          onSearchChange={changeSearch}
          onSidebarOpenChange={setSidebarOpen}
          onStop={stop}
          onTabClose={closeTab}
          onTabSelect={selectTab}
          onThemeChange={(next) => {
            applyThemePreference(next);
            setTheme(next);
          }}
          onConversationBottomChange={onConversationBottomChange}
          onHistoryPaneOpenChange={(open) => {
            if (!ownsVisit() || selectedConversationKey === null) return;
            setHistoryOpen(open);
            if (open) setToolSelection(null);
          }}
          onHistoryQueryChange={setHistoryQuery}
          onHistoryRevealAllChange={setHistoryRevealAll}
          onHistoryPreviewSelect={(targetId) => {
            if (!ownsVisit() || selectedConversationKey === null) return;
            setHistoryPreviewTarget({
              conversationKey: selectedConversationKey,
              targetId: targetId as NavigateChatHistoryRequest["targetId"],
            });
          }}
          onHistoryContinue={() => {
            void continueHistory();
          }}
          onHistoryRestoreDraft={restoreRecoveredDraft}
          onToolSelect={(id) => {
            if (!ownsVisit()) return;
            const key = findPageEntry(page, navigationRef.current.entries)?.key;
            if (key !== selectedConversationKey) return;
            if (id !== null) setHistoryOpen(false);
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
          tabs={tabs}
          theme={theme}
          title={chatId ? (titles.get(chatId) ?? `Chat ${chatId.slice(-8)}`) : "New chat"}
          toolPane={toolPane}
          historyPane={historyPanel}
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
