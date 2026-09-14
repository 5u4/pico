import {
  CaretDownIcon,
  CaretRightIcon,
  FolderSimpleIcon,
  PencilSimpleLineIcon,
  PlusIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useId } from "react";
import { Button } from "../components/ui/button.tsx";
import type { NavigationPresentation } from "./chat-model.ts";

export interface WorkspaceSidebarProps {
  readonly navigation: NavigationPresentation;
  readonly onWorkspaceToggle: (workspaceId: string) => void;
  readonly onWorkspaceRetry: () => void;
  readonly onChatsRetry: (workspaceId: string) => void;
  readonly onChatSelect: (workspaceId: string, chatId: string) => void;
  readonly onNewChat: (workspaceId?: string) => void;
  readonly onAddWorkspace?: (() => void) | undefined;
  readonly onClose: () => void;
}

export function WorkspaceSidebar({
  navigation,
  onWorkspaceToggle,
  onWorkspaceRetry,
  onChatsRetry,
  onChatSelect,
  onNewChat,
  onAddWorkspace,
  onClose,
}: WorkspaceSidebarProps) {
  const id = useId();
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-sidebar">
      <div className="flex min-h-14 shrink-0 items-center gap-2.5 px-4 py-2">
        <SparkleIcon aria-hidden="true" size={22} weight="fill" />
        <span className="flex-1 text-title font-semibold tracking-tight">pico</span>
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

      <div className="shrink-0 px-2 pb-5 pt-1">
        <Button
          className="w-full justify-start px-3"
          disabled={navigation.groups.length === 0 && !onAddWorkspace}
          onClick={() => onNewChat()}
          tone="ghost"
        >
          <PencilSimpleLineIcon aria-hidden="true" size={18} />
          New chat
        </Button>
      </div>

      <nav
        aria-label="Workspaces"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
      >
        <div className="mb-1 flex min-h-8 items-center gap-2 pl-3 pr-1">
          <h2 className="flex-1 text-meta font-medium text-subtle">Workspaces</h2>
          {onAddWorkspace && (
            <Button aria-label="Add workspace" onClick={onAddWorkspace} size="icon" tone="ghost">
              <PlusIcon aria-hidden="true" size={16} />
            </Button>
          )}
        </div>
        {navigation.status && (
          <div className="px-3 py-2 text-label text-muted">
            <p role={navigation.status.kind === "error" ? "alert" : "status"}>
              {navigation.status.label}
            </p>
            {navigation.status.kind === "error" && (
              <Button className="mt-2" onClick={onWorkspaceRetry} size="small" tone="secondary">
                Retry workspaces
              </Button>
            )}
          </div>
        )}
        <ul className="space-y-1">
          {navigation.groups.map(({ workspace, expanded, chats, status }) => {
            const active = workspace.id === navigation.activeWorkspaceId;
            const listId = `${id}-${workspace.id}`;
            return (
              <li key={workspace.id}>
                <div className="group flex items-center gap-0.5">
                  <button
                    aria-controls={listId}
                    aria-expanded={expanded}
                    className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left text-label hover:bg-surface-hover ${active ? "font-medium text-foreground" : "text-muted"}`}
                    onClick={() => onWorkspaceToggle(workspace.id)}
                    title={workspace.contextLabel}
                    type="button"
                  >
                    {expanded ? (
                      <CaretDownIcon aria-hidden="true" className="shrink-0" size={12} />
                    ) : (
                      <CaretRightIcon aria-hidden="true" className="shrink-0" size={12} />
                    )}
                    <FolderSimpleIcon aria-hidden="true" className="shrink-0" size={17} />
                    <span className="truncate">{workspace.name}</span>
                  </button>
                  <Button
                    aria-label={`New chat in ${workspace.name}`}
                    className="size-9"
                    onClick={() => onNewChat(workspace.id)}
                    size="icon"
                    tone="ghost"
                  >
                    <PlusIcon aria-hidden="true" size={15} />
                  </Button>
                </div>
                <div hidden={!expanded} id={listId}>
                  {status && (
                    <div className="py-2 pl-10 pr-3 text-meta text-muted">
                      <p role={status.kind === "error" ? "alert" : "status"}>{status.label}</p>
                      {status.kind === "error" && (
                        <Button
                          className="mt-2"
                          onClick={() => onChatsRetry(workspace.id)}
                          size="small"
                          tone="secondary"
                        >
                          Retry chats
                        </Button>
                      )}
                    </div>
                  )}
                  <ul className="space-y-0.5">
                    {chats.map((chat) => {
                      const selected = chat.id === navigation.activeChatId;
                      return (
                        <li key={chat.id}>
                          <button
                            aria-current={selected ? "page" : undefined}
                            className={`flex min-h-9 w-full items-center rounded-control py-1.5 pl-10 pr-3 text-left text-label ${selected ? "bg-surface-hover font-medium text-foreground" : "text-muted hover:bg-surface-hover hover:text-foreground"}`}
                            onClick={() => onChatSelect(workspace.id, chat.id)}
                            title={chat.title}
                            type="button"
                          >
                            <span className="truncate">{chat.title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
