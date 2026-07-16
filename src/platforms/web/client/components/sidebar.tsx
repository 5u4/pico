import {
  ArchiveIcon,
  ChevronRightIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import type { ConversationSummary, WorkspaceSummary } from "../../protocol";
import { cn } from "../lib/utils";
import { PERSIST_KEYS, usePersisted } from "../persist";
import { useShell } from "../runtime";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button";
import { ModeToggle } from "./mode-toggle";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";

function ConversationRow({
  conversation,
  active,
  onSelect,
  onArchive,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onArchive: (conversationId: string) => void;
}) {
  return (
    <div
      className={cn(
        "group/convo mb-0.5 flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent/50",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(conversation.id)}
        className="min-w-0 flex-1 truncate px-3 py-1.5 text-left text-sm"
      >
        {conversation.title ?? "New chat"}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 opacity-0 group-hover/convo:opacity-100 focus-visible:opacity-100"
        onClick={() => onArchive(conversation.id)}
        aria-label="Archive conversation"
      >
        <ArchiveIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function WorkspaceItem({
  workspace,
  activeId,
  open,
  onOpenChange,
  onSelect,
  onCreate,
  onArchive,
  onRename,
}: {
  workspace: WorkspaceSummary;
  activeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onCreate: (workspaceId: string) => void;
  onArchive: (conversationId: string) => void;
  onRename: (workspaceId: string, label: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const activeConversation =
    activeId === null
      ? undefined
      : workspace.conversations.find((c) => c.id === activeId);
  const startRename = () => {
    setDraft(workspace.label ?? "");
    setRenaming(true);
  };
  const submitRename = () => {
    const label = draft.trim();
    if (label && label !== workspace.label) onRename(workspace.id, label);
    setRenaming(false);
  };
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="mb-1">
      {renaming ? (
        <div className="px-2 py-1">
          <input
            // biome-ignore lint/a11y/noAutofocus: focus the inline field on open
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={submitRename}
            aria-label="Rename workspace"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-accent/50">
              <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm">
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                />
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {workspace.label ?? "workspace"}
                </span>
              </CollapsibleTrigger>
              <TooltipIconButton
                tooltip="New Conversation"
                side="bottom"
                className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onCreate(workspace.id)}
                aria-label="New conversation"
              >
                <PlusIcon className="size-3.5" />
              </TooltipIconButton>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={startRename}>
              <PencilIcon />
              Rename
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {!open && activeConversation && (
        <div className="ml-4 border-l border-border pl-1">
          <ConversationRow
            conversation={activeConversation}
            active
            onSelect={onSelect}
            onArchive={onArchive}
          />
        </div>
      )}
      <CollapsibleContent className="ml-4 border-l border-border pl-1">
        {workspace.conversations.length === 0 ? (
          <div className="px-3 py-1.5 text-xs text-muted-foreground">
            No conversations
          </div>
        ) : (
          workspace.conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeId}
              onSelect={onSelect}
              onArchive={onArchive}
            />
          ))
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const {
    workspaces,
    activeId,
    select,
    create,
    createWorkspace,
    renameWorkspace,
    archive,
  } = useShell();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [collapsedIds, setCollapsedIds] = usePersisted(
    PERSIST_KEYS.workspacesCollapsed,
    z.array(z.string()),
    [],
  );
  const setWorkspaceOpen = (id: string, open: boolean) => {
    setCollapsedIds((ids) => {
      const has = ids.includes(id);
      if (open && has) return ids.filter((x) => x !== id);
      if (!open && !has) return [...ids, id];
      return ids;
    });
  };

  const submit = () => {
    const label = name.trim();
    if (label) createWorkspace(label);
    setName("");
    setNaming(false);
  };

  return (
    <aside
      className={cn(
        "h-dvh shrink-0 overflow-hidden transition-[margin] duration-200 ease-out",
        collapsed && "-ml-64",
      )}
    >
      <div
        inert={collapsed}
        aria-hidden={collapsed}
        className="flex h-full w-64 flex-col border-r border-border bg-muted/30"
      >
        <div className="flex items-center justify-between py-2 pr-3 pl-11">
          <span className="text-sm font-medium">Workspaces</span>
          <TooltipIconButton
            tooltip="New Workspace"
            side="bottom"
            className="size-7"
            onClick={() => setNaming((v) => !v)}
            aria-label="New workspace"
          >
            <PlusIcon className="size-4" />
          </TooltipIconButton>
        </div>
        {naming && (
          <div className="px-2 pb-2">
            <input
              // biome-ignore lint/a11y/noAutofocus: focus the inline field on open
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") {
                  setName("");
                  setNaming(false);
                }
              }}
              onBlur={submit}
              aria-label="Workspace name"
              placeholder="workspace name"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {workspaces.map((workspace) => (
            <WorkspaceItem
              key={workspace.id}
              workspace={workspace}
              activeId={activeId}
              open={!collapsedIds.includes(workspace.id)}
              onOpenChange={(open) => setWorkspaceOpen(workspace.id, open)}
              onSelect={select}
              onCreate={create}
              onArchive={archive}
              onRename={renameWorkspace}
            />
          ))}
        </nav>
        <div className="flex items-center justify-between border-t border-border p-2">
          <span className="px-2 text-xs text-muted-foreground">pico</span>
          <ModeToggle />
        </div>
      </div>
    </aside>
  );
}
