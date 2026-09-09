import { ChatCircleIcon, PlusIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "../components/ui/button.tsx";
import type { ChatSummary, WorkspaceSummary } from "./chat-model.ts";

export interface WorkspaceSidebarProps {
  readonly workspace: WorkspaceSummary;
  readonly chats: readonly ChatSummary[];
  readonly activeChatId: string | null;
  readonly onChatSelect: (chatId: string) => void;
  readonly onNewChat: () => void;
  readonly onClose: () => void;
}

const activityClasses = {
  idle: "bg-subtle",
  running: "bg-accent",
  failed: "bg-danger",
} satisfies Record<ChatSummary["activity"], string>;

const activityLabels = {
  idle: "Idle",
  running: "Running",
  failed: "Needs attention",
} satisfies Record<ChatSummary["activity"], string>;

export function WorkspaceSidebar({
  workspace,
  chats,
  activeChatId,
  onChatSelect,
  onNewChat,
  onClose,
}: WorkspaceSidebarProps) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <span className="grid size-8 place-items-center rounded-control bg-foreground text-panel">
          <SparkleIcon aria-hidden="true" size={17} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-title font-semibold">{workspace.name}</p>
          <p className="truncate text-meta text-muted">{workspace.contextLabel}</p>
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
        <Button className="w-full" onClick={onNewChat} size="small" tone="secondary">
          <PlusIcon aria-hidden="true" size={16} />
          New chat
        </Button>
      </div>

      <nav aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <p className="px-2 pb-2 pt-1 text-meta font-semibold uppercase tracking-wide text-subtle">
          Recent
        </p>
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
                      <span className="min-w-0 flex-1 truncate text-label font-medium">
                        {chat.title}
                      </span>
                      <span
                        aria-label={activityLabels[chat.activity]}
                        className={`size-1.5 shrink-0 rounded-round ${activityClasses[chat.activity]}`}
                        role="img"
                      />
                    </span>
                    <span className="mt-1 block truncate text-meta text-subtle">
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
