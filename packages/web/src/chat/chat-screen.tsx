import {
  ArrowClockwiseIcon,
  BookOpenIcon,
  BugIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SunIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type KeyboardEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import type { Theme } from "../theme.ts";
import type {
  ChatTabPresentation,
  ComposerPresentation,
  PromptSuggestion,
  ToolCallPresentation,
  TranscriptPresentation,
} from "./chat-model.ts";
import { Composer } from "./composer.tsx";
import { MobileSidebar } from "./mobile-sidebar.tsx";
import { ToolDetailPane } from "./tool-detail-pane.tsx";
import { Transcript } from "./transcript.tsx";
import { WorkspaceDialog, type WorkspaceFormProps } from "./workspace-dialog.tsx";
import {
  WorkspaceSettingsDialog,
  type WorkspaceSettingsProps,
} from "./workspace-settings-dialog.tsx";
import { WorkspaceSidebar, type WorkspaceSidebarProps } from "./workspace-sidebar.tsx";

const suggestionIcons = {
  explain: BookOpenIcon,
  review: MagnifyingGlassIcon,
  fix: BugIcon,
} satisfies Record<PromptSuggestion["kind"], typeof BookOpenIcon>;

export interface ChatScreenProps
  extends Omit<WorkspaceSidebarProps, "onClose" | "onAddWorkspace" | "contextMenuContainer"> {
  readonly desktopCollapse: NonNullable<WorkspaceSidebarProps["desktopCollapse"]>;
  readonly conversationKey: string | null;
  readonly title: string;
  readonly contextLabel: string;
  readonly tabs: readonly ChatTabPresentation[];
  readonly suggestions: readonly PromptSuggestion[];
  readonly toolPane: ToolCallPresentation | null;
  readonly transcript: TranscriptPresentation;
  readonly composer: ComposerPresentation;
  readonly sidebarOpen: boolean;
  readonly theme: Theme;
  readonly workspaceForm: WorkspaceFormProps;
  readonly workspaceSettings?: WorkspaceSettingsProps | undefined;
  readonly onSidebarOpenChange: (open: boolean) => void;
  readonly onTabSelect: (id: string) => void;
  readonly onTabClose: (id: string) => void;
  readonly onToolSelect: (id: string | null) => void;
  readonly onComposerValueChange: (value: string) => void;
  readonly onComposerSubmit: () => void;
  readonly onSuggestionSelect: (text: string) => void;
  readonly onSuggestionsShuffle: () => void;
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
  suggestions,
  search,
  toolPane,
  transcript,
  composer,
  sidebarOpen,
  theme,
  workspaceForm,
  workspaceSettings,
  onEditWorkspace,
  workspaceEditPending,
  onSidebarOpenChange,
  onWorkspaceToggle,
  onWorkspaceRetry,
  onChatsRetry,
  onChatSelect,
  onNewChat,
  onTabSelect,
  onTabClose,
  onSearchChange,
  onToolSelect,
  onComposerValueChange,
  onComposerSubmit,
  onSuggestionSelect,
  onSuggestionsShuffle,
  onStop,
  onTranscriptRetry,
  onDisclosuresChange,
  onThemeChange,
}: ChatScreenProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const scroll = useRef({ key: conversationKey, following: true });
  const [showJump, setShowJump] = useState(false);
  const [composerHeight, setComposerHeight] = useState(150);
  const sidebarOpener = useRef<HTMLButtonElement>(null);
  const toolOpener = useRef<HTMLElement | null>(null);
  const [tabButtons] = useState(() => new Map<string, HTMLButtonElement>());
  const newTabButton = useRef<HTMLButtonElement>(null);
  const restoreTabFocus = useRef(false);
  const welcome = transcript.state === "empty";
  const showSuggestions =
    welcome && conversationKey !== null && composer.editable && suggestions.length > 0;
  const onboarding =
    search.kind === "closed" &&
    navigation.groups.length === 0 &&
    navigation.status?.kind === "empty";

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    if (scroll.current.key !== conversationKey) {
      scroll.current = { key: conversationKey, following: true };
      setShowJump(false);
    }
    if (scroll.current.following) element.scrollTop = element.scrollHeight;
  }, [conversationKey, transcript, composerHeight]);

  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element || welcome) return;
    const measure = () => setComposerHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [welcome]);

  useLayoutEffect(() => {
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
  }, [welcome]);

  useLayoutEffect(() => {
    const active = conversationKey ? tabButtons.get(conversationKey) : undefined;
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!restoreTabFocus.current) return;
    restoreTabFocus.current = false;
    (active ?? newTabButton.current)?.focus({ preventScroll: true });
  }, [conversationKey, tabs.length, tabButtons]);

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
  const selectTool = (id: string | null) => {
    if (id !== null && document.activeElement instanceof HTMLElement) {
      toolOpener.current = document.activeElement;
    }
    onToolSelect(id);
  };
  const closeSidebar = () => onSidebarOpenChange(false);
  const sidebar = {
    navigation,
    search,
    onSearchChange,
    onWorkspaceToggle,
    onWorkspaceRetry,
    onChatsRetry,
    onEditWorkspace,
    workspaceEditPending,
    onChatSelect: (workspaceId, chatId) => {
      onChatSelect(workspaceId, chatId);
      closeSidebar();
    },
    onNewChat: (workspaceId) => {
      onNewChat(workspaceId);
      closeSidebar();
    },
    onAddWorkspace: () => {
      closeSidebar();
      workspaceForm.onOpenChange(true);
    },
    onClose: closeSidebar,
  } satisfies WorkspaceSidebarProps;

  return (
    <div
      className="chat-screen grid h-full min-h-0 grid-cols-1 bg-canvas p-2.5 text-foreground md:pl-0"
      data-sidebar-collapsed={desktopCollapse.collapsed}
    >
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-border focus:bg-panel focus:px-4 focus:py-2"
        href="#conversation-history"
      >
        Skip to conversation
      </a>
      <div className="hidden min-h-0 overflow-hidden md:block">
        <WorkspaceSidebar {...sidebar} desktopCollapse={desktopCollapse} />
      </div>
      <MobileSidebar {...sidebar} open={sidebarOpen} returnFocus={sidebarOpener} />

      <main className="flex min-h-0 min-w-0 gap-2.5">
        <section
          aria-label={title}
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
              className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                      className="min-w-0 flex-1 rounded-sm text-left"
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
                      <span className="block truncate">{tab.title}</span>
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

          <div className="relative min-h-0 flex-1">
            <div
              aria-label="Conversation history"
              className="transcript-scroll h-full overflow-y-auto overscroll-contain"
              hidden={welcome}
              id={welcome ? undefined : "conversation-history"}
              onScroll={(event) => {
                const element = event.currentTarget;
                const following =
                  element.scrollHeight - element.clientHeight - element.scrollTop < 120;
                scroll.current.following = following;
                setShowJump(!following);
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
                className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
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
                  ? "absolute inset-0 overflow-y-auto overscroll-contain"
                  : "absolute inset-x-0 bottom-0 px-4 pb-6 sm:px-8 lg:px-12"
              }
              id={welcome ? "conversation-history" : undefined}
              ref={composerRef}
              role={welcome ? "tabpanel" : undefined}
              tabIndex={welcome ? 0 : undefined}
            >
              <div
                className={
                  welcome
                    ? "mx-auto flex min-h-full max-w-[720px] flex-col justify-center px-4 py-10 sm:px-8"
                    : "mx-auto max-w-[720px]"
                }
              >
                {transcript.state === "empty" && (
                  <h1 className="text-[26px] font-normal tracking-[-0.02em]">
                    <span className="home-reveal home-reveal-hello block text-subtle">Hello</span>
                    <span className="home-reveal home-reveal-question block">
                      {transcript.title}
                    </span>
                  </h1>
                )}
                <div
                  className={welcome ? "home-reveal home-reveal-prompt relative mt-7" : "relative"}
                >
                  <Composer
                    contextLabel={contextLabel}
                    onStop={onStop}
                    onSubmit={onComposerSubmit}
                    onValueChange={onComposerValueChange}
                    presentation={composer}
                  />
                </div>
                {transcript.state === "empty" && (
                  <div className="home-reveal home-reveal-recommendations mt-6 flex flex-col text-subtle">
                    <p className={showSuggestions ? "sr-only" : "text-[13px]"}>
                      {transcript.description}
                    </p>
                    {showSuggestions && (
                      <>
                        {suggestions.map((suggestion) => {
                          const Icon = suggestionIcons[suggestion.kind];
                          return (
                            <button
                              className="-mx-2 flex h-[41px] items-center gap-3 rounded-control px-2 py-2.5 text-left text-[14px] text-foreground transition-colors duration-150 hover:bg-surface-hover active:bg-surface-hover-strong"
                              key={suggestion.text}
                              onClick={() => onSuggestionSelect(suggestion.text)}
                              type="button"
                            >
                              <Icon aria-hidden="true" className="shrink-0 text-subtle" size={15} />
                              <span className="min-w-0 truncate">{suggestion.label}</span>
                            </button>
                          );
                        })}
                        <div className="mt-1 flex items-center gap-5 pl-0.5 text-[13px] text-subtle">
                          <button
                            className="flex items-center gap-2 py-1 transition-colors duration-150 hover:text-foreground active:text-foreground"
                            onClick={onSuggestionsShuffle}
                            type="button"
                          >
                            <ArrowClockwiseIcon aria-hidden="true" size={14} />
                            Shuffle suggestions
                          </button>
                        </div>
                      </>
                    )}
                    {onboarding && (
                      <Button
                        className="mt-4"
                        onClick={() => workspaceForm.onOpenChange(true)}
                        tone="primary"
                      >
                        <PlusIcon aria-hidden="true" size={17} />
                        Add workspace
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
        {toolPane && (
          <ToolPaneShell
            call={toolPane}
            fallbackFocus={transcriptRef}
            onClose={() => onToolSelect(null)}
            returnFocus={toolOpener}
          />
        )}
      </main>
      <WorkspaceDialog {...workspaceForm} />
      {workspaceSettings?.editor.kind === "open" && (
        <WorkspaceSettingsDialog
          {...workspaceSettings}
          editor={workspaceSettings.editor}
          key={workspaceSettings.editor.session}
        />
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
          (origin?.isConnected ? origin : fallbackFocus.current)?.focus({ preventScroll: true });
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
