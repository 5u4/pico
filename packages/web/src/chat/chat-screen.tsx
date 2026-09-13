import { MoonIcon, SidebarSimpleIcon, SunIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import type { Theme } from "../theme.ts";
import type {
  ChatListStatus,
  ChatSummary,
  ComposerPresentation,
  TranscriptPresentation,
  WorkspaceSummary,
} from "./chat-model.ts";
import { Composer } from "./composer.tsx";
import { Transcript } from "./transcript.tsx";
import { WorkspaceSidebar } from "./workspace-sidebar.tsx";

export interface ChatScreenProps {
  readonly workspace: WorkspaceSummary;
  readonly chats: readonly ChatSummary[];
  readonly activeChatId: string | null;
  readonly chatListStatus?: ChatListStatus | undefined;
  readonly newChatPending?: boolean | undefined;
  readonly onWorkspaceChange?: (() => void) | undefined;
  readonly onChatsRetry?: (() => void) | undefined;
  readonly transcript: TranscriptPresentation;
  readonly composer: ComposerPresentation;
  readonly sidebarOpen: boolean;
  readonly theme: Theme;
  readonly onSidebarOpenChange: (open: boolean) => void;
  readonly onChatSelect: (chatId: string) => void;
  readonly onNewChat: () => void;
  readonly onComposerValueChange: (value: string) => void;
  readonly onComposerSubmit: () => void;
  readonly onStop: () => void;
  readonly onTranscriptRetry: () => void;
  readonly onDisclosureToggle: (itemId: string) => void;
  readonly onThemeChange: (theme: Theme) => void;
}

export function ChatScreen({
  workspace,
  chats,
  activeChatId,
  chatListStatus,
  newChatPending,
  onWorkspaceChange,
  onChatsRetry,
  transcript,
  composer,
  sidebarOpen,
  theme,
  onSidebarOpenChange,
  onChatSelect,
  onNewChat,
  onComposerValueChange,
  onComposerSubmit,
  onStop,
  onTranscriptRetry,
  onDisclosureToggle,
  onThemeChange,
}: ChatScreenProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scroll = useRef({ chatId: activeChatId, following: true });
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    if (scroll.current.chatId !== activeChatId) {
      scroll.current = { chatId: activeChatId, following: true };
      setShowJump(false);
    }
    if (scroll.current.following) element.scrollTop = element.scrollHeight;
  }, [activeChatId, transcript]);

  const jumpToLatest = () => {
    const element = transcriptRef.current;
    if (!element) return;
    scroll.current.following = true;
    element.scrollTop = element.scrollHeight;
    setShowJump(false);
    element.focus({ preventScroll: true });
  };

  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const title = activeChat?.title ?? "New chat";
  const context = activeChat?.preview ?? "Start a focused conversation";
  const closeSidebar = () => onSidebarOpenChange(false);
  const selectChat = (chatId: string) => {
    onChatSelect(chatId);
    closeSidebar();
  };
  const createChat = () => {
    onNewChat();
    closeSidebar();
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 bg-canvas text-foreground md:grid-cols-[17rem_minmax(0,1fr)]">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-border focus:bg-panel focus:px-4 focus:py-2"
        href="#conversation-history"
      >
        Skip to conversation
      </a>
      <div className="hidden min-h-0 md:block">
        <WorkspaceSidebar
          activeChatId={activeChatId}
          chats={chats}
          chatListStatus={chatListStatus}
          newChatPending={newChatPending}
          onChatsRetry={onChatsRetry}
          onWorkspaceChange={onWorkspaceChange}
          onChatSelect={selectChat}
          onClose={closeSidebar}
          onNewChat={createChat}
          workspace={workspace}
        />
      </div>

      <MobileSidebar
        activeChatId={activeChatId}
        chats={chats}
        chatListStatus={chatListStatus}
        newChatPending={newChatPending}
        onChatsRetry={onChatsRetry}
        onWorkspaceChange={onWorkspaceChange}
        onChatSelect={selectChat}
        onClose={closeSidebar}
        onNewChat={createChat}
        open={sidebarOpen}
        workspace={workspace}
      />

      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-panel px-4 md:px-6">
          <Button
            aria-label="Open sidebar"
            className="md:hidden"
            onClick={() => onSidebarOpenChange(true)}
            size="icon"
            tone="ghost"
          >
            <SidebarSimpleIcon aria-hidden="true" size={19} />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-title font-semibold">{title}</h1>
            <p className="truncate text-meta text-muted">{context}</p>
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
              onDisclosureToggle={onDisclosureToggle}
              onRetry={onTranscriptRetry}
              presentation={transcript}
            />
          </div>
          {showJump && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <Button
                className="pointer-events-auto"
                onClick={jumpToLatest}
                size="small"
                tone="secondary"
                type="button"
              >
                Jump to latest
              </Button>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border bg-canvas px-3 py-3 md:px-8 md:py-4">
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
    </div>
  );
}

interface MobileSidebarProps {
  readonly workspace: WorkspaceSummary;
  readonly chats: readonly ChatSummary[];
  readonly activeChatId: string | null;
  readonly chatListStatus?: ChatListStatus | undefined;
  readonly newChatPending?: boolean | undefined;
  readonly onWorkspaceChange?: (() => void) | undefined;
  readonly onChatsRetry?: (() => void) | undefined;
  readonly open: boolean;
  readonly onChatSelect: (chatId: string) => void;
  readonly onNewChat: () => void;
  readonly onClose: () => void;
}

function MobileSidebar({
  workspace,
  chats,
  activeChatId,
  chatListStatus,
  newChatPending,
  onWorkspaceChange,
  onChatsRetry,
  open,
  onChatSelect,
  onNewChat,
  onClose,
}: MobileSidebarProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      aria-label="Workspace navigation"
      className="fixed inset-y-0 left-0 z-30 m-0 h-dvh max-h-none w-[min(19rem,88vw)] max-w-none border-0 bg-transparent p-0 backdrop:bg-overlay md:hidden"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <WorkspaceSidebar
        activeChatId={activeChatId}
        chats={chats}
        chatListStatus={chatListStatus}
        newChatPending={newChatPending}
        onChatsRetry={onChatsRetry}
        onWorkspaceChange={onWorkspaceChange}
        onChatSelect={onChatSelect}
        onClose={onClose}
        onNewChat={onNewChat}
        workspace={workspace}
      />
    </dialog>
  );
}
