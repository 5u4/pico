import { MoonIcon, PlusIcon, SidebarSimpleIcon, SunIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import type { Theme } from "../theme.ts";
import type { ComposerPresentation, TranscriptPresentation } from "./chat-model.ts";
import { Composer } from "./composer.tsx";
import { MobileSidebar } from "./mobile-sidebar.tsx";
import { Transcript } from "./transcript.tsx";
import { WorkspaceDialog, type WorkspaceFormProps } from "./workspace-dialog.tsx";
import {
  WorkspaceSettingsDialog,
  type WorkspaceSettingsProps,
} from "./workspace-settings-dialog.tsx";
import { WorkspaceSidebar, type WorkspaceSidebarProps } from "./workspace-sidebar.tsx";

export interface ChatScreenProps
  extends Omit<WorkspaceSidebarProps, "onClose" | "onAddWorkspace" | "contextMenuContainer"> {
  readonly desktopCollapse: NonNullable<WorkspaceSidebarProps["desktopCollapse"]>;
  readonly conversationKey: string | null;
  readonly title: string;
  readonly contextLabel: string;
  readonly transcript: TranscriptPresentation;
  readonly composer: ComposerPresentation;
  readonly sidebarOpen: boolean;
  readonly theme: Theme;
  readonly workspaceForm: WorkspaceFormProps;
  readonly workspaceSettings?: WorkspaceSettingsProps | undefined;
  readonly onSidebarOpenChange: (open: boolean) => void;
  readonly onComposerValueChange: (value: string) => void;
  readonly onComposerSubmit: () => void;
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
  onComposerValueChange,
  onComposerSubmit,
  onStop,
  onTranscriptRetry,
  onDisclosuresChange,
  onThemeChange,
}: ChatScreenProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scroll = useRef({ key: conversationKey, following: true });
  const [showJump, setShowJump] = useState(false);
  const sidebarOpener = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    if (scroll.current.key !== conversationKey) {
      scroll.current = { key: conversationKey, following: true };
      setShowJump(false);
    }
    if (scroll.current.following) element.scrollTop = element.scrollHeight;
  }, [conversationKey, transcript]);

  const jumpToLatest = () => {
    const element = transcriptRef.current;
    if (!element) return;
    scroll.current.following = true;
    element.scrollTop = element.scrollHeight;
    setShowJump(false);
    element.focus({ preventScroll: true });
  };
  const closeSidebar = () => onSidebarOpenChange(false);
  const sidebar = {
    navigation,
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
  const onboarding = navigation.status?.kind === "empty";

  return (
    <div
      className="chat-screen grid h-full min-h-0 grid-cols-1 bg-canvas text-foreground"
      data-sidebar-collapsed={desktopCollapse.collapsed}
    >
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-border focus:bg-panel focus:px-4 focus:py-2"
        href="#conversation-history"
      >
        Skip to conversation
      </a>
      <div className="hidden min-h-0 md:block">
        <WorkspaceSidebar {...sidebar} desktopCollapse={desktopCollapse} />
      </div>
      <MobileSidebar {...sidebar} open={sidebarOpen} returnFocus={sidebarOpener} />

      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-canvas px-4 py-2 md:px-6">
          <Button
            aria-label="Open sidebar"
            className="md:hidden"
            onClick={(event) => {
              sidebarOpener.current = event.currentTarget;
              onSidebarOpenChange(true);
            }}
            size="icon"
            tone="ghost"
          >
            <SidebarSimpleIcon aria-hidden="true" size={19} />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-title font-semibold">{title}</h1>
            <p className="truncate text-meta text-muted" title={contextLabel}>
              {contextLabel}
            </p>
          </div>
          <Button
            aria-label="Dark theme"
            aria-pressed={theme === "dark"}
            className="ml-auto"
            onClick={() => onThemeChange(theme === "light" ? "dark" : "light")}
            size="icon"
            tone="ghost"
          >
            {theme === "light" ? (
              <MoonIcon aria-hidden="true" size={19} />
            ) : (
              <SunIcon aria-hidden="true" size={19} />
            )}
          </Button>
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            aria-label="Conversation history"
            className="transcript-scroll h-full overflow-y-auto"
            id="conversation-history"
            onScroll={(event) => {
              const element = event.currentTarget;
              const following =
                element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
              scroll.current.following = following;
              setShowJump(!following);
            }}
            ref={transcriptRef}
            role="region"
            tabIndex={0}
          >
            <Transcript
              onDisclosuresChange={onDisclosuresChange}
              onRetry={onTranscriptRetry}
              presentation={transcript}
            />
            {onboarding && (
              <div className="flex justify-center px-4 pb-8">
                <Button onClick={() => workspaceForm.onOpenChange(true)} tone="primary">
                  <PlusIcon aria-hidden="true" size={17} />
                  Add workspace
                </Button>
              </div>
            )}
          </div>
          {showJump && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <Button
                className="pointer-events-auto"
                onClick={jumpToLatest}
                size="small"
                tone="secondary"
              >
                Jump to latest
              </Button>
            </div>
          )}
        </div>

        <div className="shrink-0 bg-canvas px-3 pb-3 pt-2 md:px-8 md:pb-4">
          <div className="mx-auto max-w-3xl">
            <Composer
              onStop={onStop}
              onSubmit={onComposerSubmit}
              onValueChange={onComposerValueChange}
              presentation={composer}
            />
            <p className="mt-2 text-center text-meta text-subtle">
              Pico can make mistakes. Review changes before applying them.
            </p>
          </div>
        </div>
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
