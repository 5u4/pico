import { ChatCircleIcon, PlusIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "../components/ui/button.tsx";
import type { ChatListStatus, ChatSummary, WorkspaceSummary } from "./chat-model.ts";

export interface WorkspaceSidebarProps {
  readonly workspace: WorkspaceSummary;
  readonly chats: readonly ChatSummary[];
  readonly activeChatId: string | null;
  readonly chatListStatus?: ChatListStatus | undefined;
  readonly newChatPending?: boolean | undefined;
  readonly onWorkspaceChange?: (() => void) | undefined;
  readonly onChatsRetry?: (() => void) | undefined;
  readonly onChatSelect: (chatId: string) => void;
  readonly onNewChat: () => void;
  readonly onClose: () => void;
}

const activityClasses = {
  idle: "bg-subtle",
  running: "bg-accent",
  failed: "bg-danger",
  unknown: "bg-subtle",
} satisfies Record<ChatSummary["activity"], string>;

const activityLabels = {
  idle: "Idle",
  running: "Running",
  failed: "Needs attention",
  unknown: "Status unknown",
} satisfies Record<ChatSummary["activity"], string>;

export function WorkspaceSidebar({
  workspace,
  chats,
  activeChatId,
  chatListStatus,
  newChatPending,
  onWorkspaceChange,
  onChatsRetry,
  onChatSelect,
  onNewChat,
  onClose,
}: WorkspaceSidebarProps) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-sidebar">
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <span className="grid size-8 place-items-center rounded-control bg-foreground text-panel">
          <SparkleIcon aria-hidden="true" size={17} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-title font-semibold">{workspace.name}</p>
          <p className="break-all text-meta text-muted">{workspace.contextLabel}</p>
        </div>
        <Button
          aria-label="Close sidebar"
          className="md:hidden"
          onClick={onClose}
          size="icon"
          tone="ghost"
        >
          <XIcon aria-hidden="true" size={18} />
        </Button>
      </div>

      <div className="px-3 py-3">
        <Button
          className="w-full"
          disabled={newChatPending}
          onClick={onNewChat}
          size="small"
          tone="secondary"
        >
          <PlusIcon aria-hidden="true" size={16} />
          New chat
        </Button>
        {onWorkspaceChange && (
          <Button className="mt-2 w-full" onClick={onWorkspaceChange} size="small" tone="ghost">
            Switch workspace
          </Button>
        )}
      </div>

      <nav aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <p className="px-2 pb-2 pt-1 text-meta font-semibold uppercase tracking-wide text-subtle">
          Recent
        </p>
        {chatListStatus && (
          <div className="px-2 pb-3 text-label text-muted">
            <p role={chatListStatus.kind === "error" ? "alert" : "status"}>
              {chatListStatus.label}
            </p>
            {chatListStatus.kind === "error" && onChatsRetry && (
              <Button className="mt-2" onClick={onChatsRetry} size="small" tone="secondary">
                Retry chats
              </Button>
            )}
          </div>
        )}
        <ul className="space-y-1">
          {chats.map((chat) => {
            const active = chat.id === activeChatId;
            return (
              <li key={chat.id}>
                <button
                  aria-current={active ? "page" : undefined}
                  className={`group flex w-full gap-3 rounded-control px-3 py-2.5 text-left transition-colors duration-feedback ease-feedback ${
                    active
                      ? "bg-panel text-foreground"
                      : "text-muted hover:bg-surface-hover hover:text-foreground"
                  }`}
                  onClick={() => onChatSelect(chat.id)}
                  type="button"
                >
                  <ChatCircleIcon aria-hidden="true" className="mt-0.5 shrink-0" size={17} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 break-words text-label font-medium">
                        {chat.title}
                      </span>
                      <span
                        aria-label={activityLabels[chat.activity]}
                        className={`size-1.5 shrink-0 rounded-round ${activityClasses[chat.activity]}`}
                        role="img"
                      />
                    </span>
                    <span className="mt-1 block break-all text-meta text-muted">
                      {chat.preview}
                    </span>
                    <span className="mt-1 block text-meta text-subtle">{chat.updatedLabel}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
