import {
  ArrowLeftIcon,
  GitBranchIcon,
  MoonIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SunIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../components/ui/button.tsx";
import type { Theme } from "../theme.ts";
import type {
  ChatTabPresentation,
  CloseChatPresentation,
  ComposerPresentation,
  ContextUsagePresentation,
  DeleteWorkspacePresentation,
  HistoryPanelPresentation,
  ModelPickerPresentation,
  ShakeFeedback,
  SkillCompletionPresentation,
  TodoPresentation,
  ToolCallPresentation,
  TranscriptPresentation,
} from "./chat-model.ts";
import { CloseChatDialog } from "./close-chat-dialog.tsx";
import { Composer } from "./composer.tsx";
import { ContextUsage } from "./context-usage.tsx";
import { DeleteWorkspaceDialog } from "./delete-workspace-dialog.tsx";
import { HistoryPaneShell } from "./history-pane.tsx";
import { MobileSidebar } from "./mobile-sidebar.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { SchedulePage, type SchedulePageProps } from "./schedule-page.tsx";
import { ShakeMenu, type ShakeMenuProps } from "./shake-menu.tsx";
import { SkillCompletionMenu } from "./skill-completion-menu.tsx";
import { TodoDock } from "./todo-dock.tsx";
import { ToolDetailPane } from "./tool-detail-pane.tsx";
import { Transcript } from "./transcript.tsx";
import { WorkspaceDialog, type WorkspaceFormProps } from "./workspace-dialog.tsx";
import {
  WorkspaceSettingsDialog,
  type WorkspaceSettingsProps,
} from "./workspace-settings-dialog.tsx";
import { WorkspaceSidebar, type WorkspaceSidebarProps } from "./workspace-sidebar.tsx";

export interface ChatScreenProps
  extends Omit<
    WorkspaceSidebarProps,
    "onClose" | "onAddWorkspace" | "contextMenuContainer" | "currentPage"
  > {
  readonly desktopCollapse: NonNullable<WorkspaceSidebarProps["desktopCollapse"]>;
  readonly conversationKey: string | null;
  readonly title: string;
  readonly contextLabel: string;
  readonly tabs: readonly ChatTabPresentation[];
  readonly toolPane: ToolCallPresentation | null;
  readonly historyPane: HistoryPanelPresentation | null;
  readonly transcript: TranscriptPresentation;
  readonly composer: ComposerPresentation;
  readonly todo: TodoPresentation | null;
  readonly skillCompletion: SkillCompletionPresentation;
  readonly composerCaretRequest: {
    readonly revision: number;
    readonly selection: { readonly start: number; readonly end: number };
  } | null;
  readonly modelPicker: ModelPickerPresentation;
  readonly onModelPickerOpen: () => void;
  readonly onModelSelect: (value: string) => void;
  readonly onModelRetry: () => void;
  readonly contextUsage: ContextUsagePresentation;
  readonly contextDetailsOpen: boolean;
  readonly onContextDetailsOpenChange: (open: boolean) => void;
  readonly shakeEnabled: boolean;
  readonly onShake: ShakeMenuProps["onSelect"];
  readonly shakeFeedback: ShakeFeedback;
  readonly sidebarOpen: boolean;
  readonly theme: Theme;
  readonly workspaceForm: WorkspaceFormProps | null;
  readonly workspaceSettings: WorkspaceSettingsProps | null;
  readonly onAddWorkspace: () => void;
  readonly view:
    | { readonly kind: "chat" }
    | { readonly kind: "schedules"; readonly page: SchedulePageProps };
  readonly onReturnToChat: () => void;
  readonly returnToChatHref: string;
  readonly closeChat: CloseChatPresentation;
  readonly onCloseChatConfirm: () => void;
  readonly onCloseChatDismiss: () => void;
  readonly onCloseChatRetry: () => void;
  readonly deleteWorkspace: DeleteWorkspacePresentation | null;
  readonly onDeleteWorkspaceConfirm: () => void;
  readonly onDeleteWorkspaceDismiss: () => void;
  readonly onSidebarOpenChange: (open: boolean) => void;
  readonly onTabSelect: (id: string) => void;
  readonly onTabClose: (id: string) => void;
  readonly onConversationBottomChange: (conversationKey: string | null, atBottom: boolean) => void;
  readonly onToolSelect: (id: string | null) => void;
  readonly onHistoryPaneOpenChange: (open: boolean) => void;
  readonly onHistoryQueryChange: (query: string) => void;
  readonly onHistoryRevealAllChange: (revealAll: boolean) => void;
  readonly onHistoryPreviewSelect: (targetId: string) => void;
  readonly onHistoryContinue: () => void;
  readonly onHistoryRestoreDraft: () => void;
  readonly onComposerValueChange: (value: string) => void;
  readonly onComposerImageRemove: (id: string) => void;
  readonly onComposerSubmit: () => void;
  readonly onComposerCaretChange: (selection: {
    readonly start: number;
    readonly end: number;
  }) => void;
  readonly onSkillCompletionCommit: () => void;
  readonly onSkillCompletionMove: (delta: -1 | 1) => void;
  readonly onSkillCompletionDismiss: () => void;
  readonly onSkillCompletionSelect: (name: string) => void;
  readonly onSkillCompletionRetry: () => void;
  readonly onStop: () => void;
  readonly onTranscriptRetry: () => void;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
  readonly onThemeChange: (theme: Theme) => void;
}

export function ChatScreen({
  navigation,
  desktopCollapse,
  conversationKey,
  title,
  contextLabel,
  tabs,
  search,
  toolPane,
  historyPane,
  transcript,
  composer,
  todo,
  skillCompletion,
  modelPicker,
  onModelPickerOpen,
  onModelSelect,
  onModelRetry,
  contextUsage,
  contextDetailsOpen,
  onContextDetailsOpenChange,
  shakeEnabled,
  onShake,
  shakeFeedback,
  sidebarOpen,
  theme,
  workspaceForm,
  workspaceSettings,
  onAddWorkspace,
  view,
  onReturnToChat,
  returnToChatHref,
  onEditWorkspace,
  workspaceEditPending,
  onDeleteWorkspace,
  workspaceDeleteDisabled,
  deleteWorkspace,
  onDeleteWorkspaceConfirm,
  onDeleteWorkspaceDismiss,
  closeChat,
  chatCloseDisabled,
  onChatClose,
  onCloseChatConfirm,
  onCloseChatDismiss,
  onCloseChatRetry,
  onSidebarOpenChange,
  onWorkspaceToggle,
  onWorkspaceRetry,
  onChatsRetry,
  onChatSelect,
  onChatMarkUnread,
  onChatMarkRead,
  onNewChat,
  schedulesHref,
  onOpenSchedules,
  onTabSelect,
  onTabClose,
  onConversationBottomChange,
  onSearchChange,
  onToolSelect,
  onHistoryPaneOpenChange,
  onHistoryQueryChange,
  onHistoryRevealAllChange,
  onHistoryPreviewSelect,
  onHistoryContinue,
  onHistoryRestoreDraft,
  onComposerValueChange,
  onComposerImageRemove,
  onComposerSubmit,
  composerCaretRequest,
  onComposerCaretChange,
  onSkillCompletionCommit,
  onSkillCompletionMove,
  onSkillCompletionDismiss,
  onSkillCompletionSelect,
  onSkillCompletionRetry,
  onStop,
  onTranscriptRetry,
  onDisclosuresChange,
  onThemeChange,
}: ChatScreenProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const scroll = useRef({ key: conversationKey, following: true });
  const [showJump, setShowJump] = useState(false);
  const [composerHeight, setComposerHeight] = useState(150);
  const sidebarOpener = useRef<HTMLButtonElement>(null);
  const toolOpener = useRef<HTMLElement | null>(null);
  const historyOpener = useRef<HTMLButtonElement>(null);
  const workspaceDeleteOrigin = useRef<HTMLElement | null>(null);
  const [tabButtons] = useState(() => new Map<string, HTMLButtonElement>());
  const newTabButton = useRef<HTMLButtonElement>(null);
  const restoreTabFocus = useRef(false);
  const closeOrigin = useRef<{
    readonly element: HTMLElement;
    readonly conversationKey: string | null;
  } | null>(null);
  const focusedElement = useRef<HTMLElement | null>(null);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const chatVisible = view.kind === "chat";
  const scheduleContent = useRef<HTMLDivElement>(null);
  const scheduleOrigin = useRef<HTMLElement | null>(null);
  const restoreScheduleFocus = useRef(false);
  const previousChatVisible = useRef<boolean | null>(null);

  useLayoutEffect(() => {
    if (previousChatVisible.current === chatVisible) return;
    previousChatVisible.current = chatVisible;
    if (!chatVisible) {
      scheduleContent.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
      return;
    }
    if (!restoreScheduleFocus.current) return;
    restoreScheduleFocus.current = false;
    const active = conversationKey ? tabButtons.get(conversationKey) : undefined;
    const target = [
      scheduleOrigin.current,
      sidebarOpener.current,
      active,
      newTabButton.current,
    ].find((element) => element?.isConnected && element.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
  }, [chatVisible, conversationKey, tabButtons]);
  const welcome = transcript.state === "empty" && todo === null;
  const onboarding =
    search.kind === "closed" &&
    navigation.groups.length === 0 &&
    navigation.status?.kind === "empty";

  useLayoutEffect(() => {
    if (!chatVisible) return;
    const element = transcriptRef.current;
    if (!element) return;
    if (scroll.current.key !== conversationKey) {
      scroll.current = { key: conversationKey, following: true };
      setShowJump(false);
    }
    if (scroll.current.following) element.scrollTop = element.scrollHeight;
  }, [chatVisible, conversationKey, transcript, composerHeight]);

  useLayoutEffect(() => {
    if (!chatVisible) return;
    const element = composerRef.current;
    if (!element || welcome) return;
    const measure = () => setComposerHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [chatVisible, welcome]);

  useLayoutEffect(() => {
    if (!chatVisible) return;
    const element = transcriptRef.current;
    const content = contentRef.current;
    if (!element || !content || welcome) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      if (!scroll.current.following) return;
      frame = requestAnimationFrame(() => {
        if (scroll.current.following) element.scrollTop = element.scrollHeight;
      });
    };
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [chatVisible, welcome]);
  const measureBottom = useCallback(() => {
    const root = transcriptRef.current;
    const sentinel = bottomSentinel.current;
    if (!chatVisible || welcome || !root || !sentinel) {
      onConversationBottomChange(conversationKey, false);
      return;
    }
    const viewport = root.getBoundingClientRect();
    const bottom = sentinel.getBoundingClientRect();
    const top = viewport.top + root.clientTop;
    const visibleBottom = Math.min(
      top + root.clientHeight,
      composerRef.current?.getBoundingClientRect().top ?? Infinity,
    );
    onConversationBottomChange(
      conversationKey,
      bottom.height > 0 && bottom.top >= top && bottom.bottom <= visibleBottom,
    );
  }, [chatVisible, welcome, conversationKey, onConversationBottomChange]);
  useLayoutEffect(() => {
    measureBottom();
  }, [measureBottom, transcript, composerHeight]);
  useLayoutEffect(() => {
    const root = transcriptRef.current;
    const sentinel = bottomSentinel.current;
    if (!chatVisible || welcome || !root || !sentinel) return;
    if (typeof IntersectionObserver !== "function") {
      onConversationBottomChange(conversationKey, false);
      return;
    }
    const observer = new IntersectionObserver(measureBottom, {
      root,
      rootMargin: `0px 0px -${composerHeight}px 0px`,
      threshold: 1,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    chatVisible,
    welcome,
    conversationKey,
    composerHeight,
    measureBottom,
    onConversationBottomChange,
  ]);

  useLayoutEffect(() => {
    if (!chatVisible) return;
    const active = conversationKey ? tabButtons.get(conversationKey) : undefined;
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!restoreTabFocus.current) return;
    restoreTabFocus.current = false;
    (active ?? newTabButton.current)?.focus({ preventScroll: true });
  }, [chatVisible, conversationKey, tabs.length, tabButtons]);

  useLayoutEffect(() => {
    if (!chatVisible) return;
    if (
      focusedElement.current &&
      !focusedElement.current.isConnected &&
      document.activeElement === document.body
    ) {
      const active = conversationKey ? tabButtons.get(conversationKey) : undefined;
      (active ?? newTabButton.current)?.focus({ preventScroll: true });
    }
    if (closeChat.kind === "idle") focusedElement.current = null;
  });

  useLayoutEffect(() => {
    if (!chatVisible) {
      setCloseDialogOpen(false);
      return;
    }
    if (closeOrigin.current?.conversationKey !== conversationKey) closeOrigin.current = null;
    if (closeChat.kind !== "confirmation") {
      setCloseDialogOpen(false);
      return;
    }
    if (document.activeElement === closeOrigin.current?.element) setCloseDialogOpen(true);
  }, [chatVisible, closeChat.kind, conversationKey]);

  useLayoutEffect(() => {
    if (chatVisible && closeChat.kind === "confirmation" && closeDialogOpen && sidebarOpen) {
      onSidebarOpenChange(false);
    }
  }, [chatVisible, closeChat.kind, closeDialogOpen, sidebarOpen, onSidebarOpenChange]);

  const closeTab = (id: string) => {
    restoreTabFocus.current = true;
    onTabClose(id);
  };
  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Delete") {
      event.preventDefault();
      const tab = tabs[index];
      if (tab) closeTab(tab.id);
      return;
    }
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onTabSelect(tab.id);
    tabButtons.get(tab.id)?.focus({ preventScroll: true });
  };
  const jumpToLatest = () => {
    const element = transcriptRef.current;
    if (!element) return;
    scroll.current.following = true;
    element.scrollTop = element.scrollHeight;
    setShowJump(false);
    element.focus({ preventScroll: true });
  };
  const historyOpen = chatVisible && historyPane?.open === true;
  const toolOpen = chatVisible && toolPane !== null;
  const selectTool = (id: string | null) => {
    if (id !== null && document.activeElement instanceof HTMLElement) {
      toolOpener.current = document.activeElement;
    }
    if (id !== null && historyOpen) onHistoryPaneOpenChange(false);
    onToolSelect(id);
  };
  const toggleHistoryPane = () => {
    if (!historyPane) return;
    const opening = !historyPane.open;
    if (opening && toolOpen) onToolSelect(null);
    onHistoryPaneOpenChange(opening);
  };
  const closeSidebar = () => onSidebarOpenChange(false);
  const sidebar = {
    navigation: chatVisible
      ? navigation
      : { ...navigation, activeWorkspaceId: null, activeChatId: null },
    currentPage: view.kind,
    search,
    onSearchChange,
    schedulesHref,
    onOpenSchedules: (origin) => {
      if (chatVisible) scheduleOrigin.current = origin;
      onOpenSchedules(origin);
      if (!chatVisible)
        scheduleContent.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    },
    onWorkspaceToggle,
    onWorkspaceRetry,
    onChatsRetry,
    onEditWorkspace,
    workspaceEditPending,
    onDeleteWorkspace: onDeleteWorkspace
      ? (workspaceId, origin) => {
          workspaceDeleteOrigin.current = origin;
          onDeleteWorkspace(workspaceId, origin);
        }
      : undefined,
    workspaceDeleteDisabled,
    chatCloseDisabled,
    onChatClose: (workspaceId, chatId, origin) => {
      if (chatCloseDisabled) return;
      closeOrigin.current = { element: origin, conversationKey };
      focusedElement.current = origin;
      onChatClose(workspaceId, chatId, origin);
    },
    onChatSelect: (workspaceId, chatId) => {
      onChatSelect(workspaceId, chatId);
      closeSidebar();
    },
    onChatMarkUnread: (workspaceId, chatId) => {
      onChatMarkUnread(workspaceId, chatId);
      closeSidebar();
    },
    onChatMarkRead: (workspaceId, chatId) => {
      onChatMarkRead(workspaceId, chatId);
      closeSidebar();
    },
    onNewChat: (workspaceId) => {
      onNewChat(workspaceId);
      closeSidebar();
    },
    onAddWorkspace: () => {
      closeSidebar();
      onAddWorkspace();
    },
    onClose: closeSidebar,
  } satisfies WorkspaceSidebarProps;

  return (
    <div
      className="chat-screen grid h-full min-h-0 grid-cols-1 bg-canvas p-2.5 text-foreground md:pl-0"
      data-sidebar-collapsed={desktopCollapse.collapsed}
      onFocusCapture={(event) => {
        if (chatVisible && closeChat.kind !== "idle" && event.target instanceof HTMLElement) {
          focusedElement.current = event.target;
        }
      }}
    >
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-border focus:bg-panel focus:px-4 focus:py-2"
        href={chatVisible ? "#conversation-history" : "#schedules-heading"}
      >
        {chatVisible ? "Skip to conversation" : "Skip to schedules"}
      </a>
      <div className="hidden min-h-0 overflow-hidden md:block">
        <WorkspaceSidebar {...sidebar} desktopCollapse={desktopCollapse} />
      </div>
      <MobileSidebar
        {...sidebar}
        onDialogOpenChange={setMobileSidebarOpen}
        open={sidebarOpen}
        returnFocus={sidebarOpener}
      />

      <main className="flex min-h-0 min-w-0 gap-2.5">
        <section
          aria-label={chatVisible ? title : "Schedules"}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-window border border-border bg-page"
        >
          <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
            <Button
              aria-label="Open sidebar"
              className="size-7 shrink-0 md:hidden"
              onClick={(event) => {
                sidebarOpener.current = event.currentTarget;
                onSidebarOpenChange(true);
              }}
              size="icon"
              title="Open sidebar"
              tone="ghost"
            >
              <SidebarSimpleIcon aria-hidden="true" size={18} />
            </Button>
            <div
              aria-label="Open chats"
              className={
                chatVisible
                  ? "flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  : "hidden"
              }
              hidden={!chatVisible}
              inert={!chatVisible}
              role="tablist"
            >
              {tabs.map((tab, index) => {
                const active = tab.id === conversationKey;
                return (
                  <div
                    className={`group/tab flex h-7 w-36 shrink-0 items-center gap-0.5 rounded-[7px] pl-2.5 pr-0.5 text-[12.5px] font-medium transition-colors duration-100 ${active ? "bg-surface-hover-strong text-foreground" : "text-muted hover:bg-surface-hover hover:text-foreground"}`}
                    key={tab.id}
                    role="presentation"
                  >
                    <button
                      aria-controls="conversation-history"
                      aria-selected={active}
                      className="flex min-w-0 flex-1 items-center rounded-sm text-left"
                      onClick={() => onTabSelect(tab.id)}
                      onKeyDown={(event) => moveTabFocus(event, index)}
                      ref={(element) => {
                        if (element) tabButtons.set(tab.id, element);
                        else tabButtons.delete(tab.id);
                      }}
                      role="tab"
                      tabIndex={active ? 0 : -1}
                      title={`${tab.title}\n${tab.contextLabel}`}
                      type="button"
                    >
                      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                      {tab.unread && (
                        <span
                          aria-hidden="true"
                          className="ml-1.5 inline-flex size-1.5 shrink-0 rounded-full bg-accent"
                        />
                      )}
                      <span className="sr-only">{tab.unread ? "Unread" : "Read"}</span>
                    </button>
                    <button
                      aria-label={`Close ${tab.title} in ${tab.contextLabel}`}
                      className="-my-1 flex size-6 shrink-0 items-center justify-center rounded-[5px] text-subtle transition-colors duration-100 hover:bg-surface-hover-strong hover:text-foreground"
                      onClick={() => closeTab(tab.id)}
                      title={`Close ${tab.title} in ${tab.contextLabel}`}
                      type="button"
                    >
                      <XIcon aria-hidden="true" size={11} weight="bold" />
                    </button>
                  </div>
                );
              })}
              <button
                aria-label="New chat"
                className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-[7px] text-subtle transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
                onClick={() => onNewChat()}
                ref={newTabButton}
                title="New chat"
                type="button"
              >
                <PlusIcon aria-hidden="true" size={15} />
              </button>
            </div>
            {!chatVisible && (
              <div className="min-w-0 flex-1">
                <a
                  className="press-feedback inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-control px-3 text-label font-medium text-muted transition-[transform,background-color,color,opacity] duration-feedback ease-feedback hover:bg-surface-hover hover:text-foreground"
                  href={returnToChatHref}
                  onClick={(event) => {
                    if (
                      event.defaultPrevented ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.altKey ||
                      event.shiftKey ||
                      (event.currentTarget.target && event.currentTarget.target !== "_self")
                    )
                      return;
                    event.preventDefault();
                    restoreScheduleFocus.current = true;
                    onReturnToChat();
                  }}
                >
                  <ArrowLeftIcon aria-hidden="true" size={16} />
                  Back to chats
                </a>
              </div>
            )}
            {chatVisible && historyPane && (
              <button
                aria-pressed={historyPane.open}
                className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-label font-medium transition-colors ${historyPane.open ? "bg-surface-hover-strong text-foreground" : "text-muted hover:bg-surface-hover hover:text-foreground"}`}
                onClick={(event) => {
                  historyOpener.current = event.currentTarget;
                  toggleHistoryPane();
                }}
                type="button"
              >
                <GitBranchIcon aria-hidden="true" size={14} />
                History and branches
              </button>
            )}
            <Button
              aria-label="Dark theme"
              aria-pressed={theme === "dark"}
              className="size-7 shrink-0"
              onClick={() => onThemeChange(theme === "light" ? "dark" : "light")}
              size="icon"
              title={theme === "light" ? "Use dark theme" : "Use light theme"}
              tone="ghost"
            >
              {theme === "light" ? (
                <MoonIcon aria-hidden="true" size={16} />
              ) : (
                <SunIcon aria-hidden="true" size={16} />
              )}
            </Button>
          </header>

          <div
            className={`${chatVisible ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}
            hidden={!chatVisible}
            inert={!chatVisible}
          >
            <p
              className={
                closeChat.kind === "closing"
                  ? "shrink-0 break-words border-b border-border bg-panel px-4 py-3 text-label text-muted"
                  : "sr-only"
              }
              role="status"
            >
              {closeChat.kind === "closing"
                ? `Closing ${closeChat.title} in ${closeChat.workspaceName}. You can keep working or use Stop if a response is running.`
                : ""}
            </p>
            {closeChat.kind === "error" && (
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-3 text-label">
                <p className="min-w-0 flex-1 break-words text-danger" role="alert">
                  {closeChat.title} in {closeChat.workspaceName}. {closeChat.message}
                </p>
                {closeChat.retry && (
                  <Button
                    disabled={!closeChat.retry.enabled}
                    onClick={onCloseChatRetry}
                    size="small"
                    tone="secondary"
                  >
                    Retry close
                  </Button>
                )}
                <Button onClick={onCloseChatDismiss} size="small" tone="ghost">
                  Dismiss
                </Button>
              </div>
            )}
            {closeChat.kind === "confirmation" && (
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-3 text-label">
                <p className="min-w-0 flex-1 break-words text-muted" role="status">
                  Worktree removal needs confirmation for {closeChat.title} in{" "}
                  {closeChat.workspaceName}. The chat may already be archived.
                </p>
                <Button onClick={() => setCloseDialogOpen(true)} size="small" tone="secondary">
                  Review close
                </Button>
                <Button onClick={onCloseChatDismiss} size="small" tone="ghost">
                  Not now
                </Button>
              </div>
            )}
            <p
              className={
                shakeFeedback.kind === "status"
                  ? "shrink-0 break-words border-b border-border bg-panel px-4 py-3 text-label text-muted"
                  : "sr-only"
              }
              role="status"
            >
              {shakeFeedback.kind === "status" ? shakeFeedback.message : ""}
            </p>
            <p
              className={
                shakeFeedback.kind === "error"
                  ? "shrink-0 break-words border-b border-border bg-panel px-4 py-3 text-label text-danger"
                  : "sr-only"
              }
              role="alert"
            >
              {shakeFeedback.kind === "error" ? shakeFeedback.message : ""}
            </p>
            <div className="chat-conversation relative min-h-0 flex-1">
              <div
                aria-label="Conversation history"
                className="transcript-scroll h-full overflow-y-auto overscroll-contain"
                hidden={welcome}
                id={welcome ? undefined : "conversation-history"}
                onScroll={(event) => {
                  if (!chatVisible) return;
                  const element = event.currentTarget;
                  const following =
                    element.scrollHeight - element.clientHeight - element.scrollTop < 120;
                  scroll.current.following = following;
                  setShowJump(!following);
                  measureBottom();
                }}
                ref={transcriptRef}
                role="tabpanel"
                tabIndex={0}
              >
                <div ref={contentRef} style={{ paddingBottom: composerHeight + 16 }}>
                  {!welcome && (
                    <Transcript
                      onDisclosuresChange={onDisclosuresChange}
                      onRetry={onTranscriptRetry}
                      onToolSelect={selectTool}
                      presentation={transcript}
                    />
                  )}
                  <div aria-hidden="true" className="h-px w-full" ref={bottomSentinel} />
                </div>
              </div>
              {!welcome && (
                <div
                  aria-hidden="true"
                  className="composer-fade pointer-events-none absolute inset-x-0 bottom-0"
                  style={{ height: composerHeight + 32 }}
                />
              )}
              {showJump && !welcome && (
                <div
                  className="composer-jump pointer-events-none absolute inset-x-0 z-10 flex justify-center"
                  style={{ bottom: composerHeight + 8 }}
                >
                  <Button
                    className="pointer-events-auto shadow-card"
                    onClick={jumpToLatest}
                    size="small"
                    tone="secondary"
                  >
                    Jump to latest
                  </Button>
                </div>
              )}
              <div
                aria-label={welcome ? "Conversation" : undefined}
                className={
                  welcome
                    ? "chat-composer-overlay absolute inset-0 overflow-y-auto overscroll-contain"
                    : "chat-composer-overlay absolute inset-x-0 bottom-0 px-4 pb-6 sm:px-8 lg:px-12"
                }
                id={welcome ? "conversation-history" : undefined}
                ref={composerRef}
                role={welcome ? "tabpanel" : undefined}
                tabIndex={welcome ? 0 : undefined}
              >
                <div
                  className={
                    welcome
                      ? "chat-composer-frame chat-composer-frame-welcome mx-auto flex min-h-full max-w-[960px] flex-col justify-center px-4 py-10 sm:px-8"
                      : "chat-composer-frame mx-auto max-w-[960px]"
                  }
                >
                  {welcome && transcript.state === "empty" && (
                    <h1 className="chat-home-heading text-[26px] font-normal tracking-[-0.02em]">
                      <span className="home-reveal home-reveal-hello block text-subtle">Hello</span>
                      <span className="home-reveal home-reveal-question block">
                        {transcript.title}
                      </span>
                    </h1>
                  )}
                  <div
                    className={
                      welcome
                        ? "chat-composer-stack home-reveal home-reveal-prompt relative mt-7"
                        : "chat-composer-stack relative"
                    }
                  >
                    {todo && (
                      <TodoDock
                        onOpenChange={(open) => onDisclosuresChange(["todo-dock"], open)}
                        presentation={todo}
                      />
                    )}
                    <div className="composer-shell relative">
                      <div className="composer-menu-anchor absolute inset-x-0 bottom-full z-20 mb-2">
                        <SkillCompletionMenu
                          onRetry={onSkillCompletionRetry}
                          onSelect={onSkillCompletionSelect}
                          presentation={skillCompletion}
                        />
                      </div>
                      <Composer
                        key={conversationKey}
                        caretRequest={composerCaretRequest}
                        completion={skillCompletion}
                        contextLabel={contextLabel}
                        onCaretChange={onComposerCaretChange}
                        onCompletionCommit={onSkillCompletionCommit}
                        onCompletionDismiss={onSkillCompletionDismiss}
                        onCompletionMove={onSkillCompletionMove}
                        onImageRemove={onComposerImageRemove}
                        onStop={onStop}
                        onSubmit={onComposerSubmit}
                        onValueChange={onComposerValueChange}
                        presentation={composer}
                      />
                    </div>
                    <div className="composer-settings mt-1 flex items-start justify-between gap-2">
                      <ModelPicker
                        key={conversationKey}
                        onOpen={onModelPickerOpen}
                        onRetry={onModelRetry}
                        onSelect={onModelSelect}
                        presentation={modelPicker}
                      />
                      <div className="flex shrink-0 items-center">
                        <ShakeMenu
                          enabled={shakeEnabled}
                          key={`${conversationKey}:${chatVisible}:${shakeEnabled}`}
                          onSelect={onShake}
                        />
                        <ContextUsage
                          onOpenChange={onContextDetailsOpenChange}
                          open={chatVisible && contextDetailsOpen}
                          presentation={contextUsage}
                        />
                      </div>
                    </div>
                  </div>
                  {welcome && transcript.state === "empty" && (
                    <div className="chat-home-recommendations home-reveal home-reveal-recommendations mt-6 flex flex-col text-subtle">
                      <p className="text-[13px]">{transcript.description}</p>
                      {onboarding && (
                        <Button className="mt-4" onClick={onAddWorkspace} tone="primary">
                          <PlusIcon aria-hidden="true" size={17} />
                          Add workspace
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          {view.kind === "schedules" && (
            <div className="flex min-h-0 flex-1 flex-col" ref={scheduleContent}>
              <SchedulePage {...view.page} />
            </div>
          )}
        </section>
        {chatVisible && historyPane?.open && (
          <HistoryPaneShell
            fallbackFocus={transcriptRef}
            onClose={() => onHistoryPaneOpenChange(false)}
            onContinue={onHistoryContinue}
            onPreviewSelect={onHistoryPreviewSelect}
            onQueryChange={onHistoryQueryChange}
            onRestoreDraft={onHistoryRestoreDraft}
            onRevealAllChange={onHistoryRevealAllChange}
            presentation={historyPane}
            returnFocus={historyOpener}
          />
        )}
        {chatVisible && toolPane && !historyPane?.open && (
          <ToolPaneShell
            call={toolPane}
            fallbackFocus={transcriptRef}
            onClose={() => onToolSelect(null)}
            returnFocus={toolOpener}
          />
        )}
      </main>
      {chatVisible &&
        closeChat.kind === "confirmation" &&
        closeDialogOpen &&
        !sidebarOpen &&
        !mobileSidebarOpen && (
          <CloseChatDialog
            confirmation={closeChat}
            onClose={onCloseChatDismiss}
            onConfirm={onCloseChatConfirm}
            onFocusFallback={() => {
              const active = conversationKey ? tabButtons.get(conversationKey) : undefined;
              (active ?? newTabButton.current)?.focus({ preventScroll: true });
            }}
          />
        )}
      {deleteWorkspace && !sidebarOpen && !mobileSidebarOpen && (
        <DeleteWorkspaceDialog
          confirmation={deleteWorkspace}
          origin={workspaceDeleteOrigin.current}
          onClose={onDeleteWorkspaceDismiss}
          onConfirm={onDeleteWorkspaceConfirm}
          onFocusFallback={() => {
            const active = conversationKey ? tabButtons.get(conversationKey) : undefined;
            (active ?? newTabButton.current ?? sidebarOpener.current)?.focus({
              preventScroll: true,
            });
          }}
        />
      )}
      {workspaceForm && <WorkspaceDialog {...workspaceForm} key={workspaceForm.session} />}
      {workspaceSettings && (
        <WorkspaceSettingsDialog {...workspaceSettings} key={workspaceSettings.editor.session} />
      )}
    </div>
  );
}

function ToolPaneShell({
  call,
  onClose,
  returnFocus,
  fallbackFocus,
}: {
  readonly call: ToolCallPresentation;
  readonly onClose: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly fallbackFocus: RefObject<HTMLDivElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const desktop = window.matchMedia("(min-width: 64rem)");
    const present = () => {
      if (dialog.open) dialog.close();
      if (desktop.matches) dialog.show();
      else dialog.showModal();
      dialog.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    };
    present();
    desktop.addEventListener("change", present);
    return () => {
      desktop.removeEventListener("change", present);
      const restoreFocus = dialog.contains(document.activeElement);
      if (dialog.open) dialog.close();
      if (restoreFocus) {
        queueMicrotask(() => {
          if (dialog.isConnected && dialog.open) return;
          const origin = returnFocus.current;
          const target = [origin, fallbackFocus.current].find(
            (element) =>
              element?.isConnected &&
              element.getClientRects().length > 0 &&
              !element.closest("[inert]"),
          );
          target?.focus({ preventScroll: true });
        });
      }
    };
  }, [returnFocus, fallbackFocus]);

  return (
    <dialog
      aria-label={`${call.label} details`}
      className="tool-pane fixed inset-y-2.5 left-auto right-2.5 z-30 m-0 h-[calc(100dvh-20px)] max-h-none w-[min(360px,calc(100vw-20px))] max-w-none overflow-hidden rounded-window border border-border bg-page p-0 text-foreground shadow-overlay backdrop:bg-overlay lg:static lg:z-auto lg:h-full lg:w-[360px] lg:shrink-0 lg:shadow-none"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <ToolDetailPane call={call} onClose={onClose} />
    </dialog>
  );
}
