import {
  ArchiveIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderInputIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { useRef, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type WorktreeFields = { defaultBranch: string; branchPrefix: string };

function DirectoryDialog({
  open,
  onOpenChange,
  initialCwd,
  initialWorktree,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialCwd: string;
  initialWorktree: WorktreeFields | null;
  onSubmit: (cwd: string, worktree: WorktreeFields | null) => void;
}) {
  const [cwd, setCwd] = useState(initialCwd);
  const [mode, setMode] = useState<"regular" | "worktree">(
    initialWorktree ? "worktree" : "regular",
  );
  const [defaultBranch, setDefaultBranch] = useState(
    initialWorktree?.defaultBranch ?? "HEAD",
  );
  const [branchPrefix, setBranchPrefix] = useState(
    initialWorktree?.branchPrefix ?? "",
  );
  const trimmedCwd = cwd.trim();
  const trimmedBranch = defaultBranch.trim();
  const trimmedPrefix = branchPrefix.trim();
  const valid =
    trimmedCwd.length > 0 &&
    (mode === "regular" ||
      (trimmedBranch.length > 0 && trimmedPrefix.length > 0));
  const submit = () => {
    if (!valid) return;
    onSubmit(
      trimmedCwd,
      mode === "worktree"
        ? { defaultBranch: trimmedBranch, branchPrefix: trimmedPrefix }
        : null,
    );
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Workspace directory</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground text-xs">Directory</span>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/repo"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </label>
          <div className="flex gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="workspace-mode"
                checked={mode === "regular"}
                onChange={() => setMode("regular")}
              />
              Regular
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="workspace-mode"
                checked={mode === "worktree"}
                onChange={() => setMode("worktree")}
              />
              Git worktree
            </label>
          </div>
          {mode === "worktree" && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  Default branch
                </span>
                <input
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  placeholder="main"
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  Branch prefix (required)
                </span>
                <input
                  value={branchPrefix}
                  onChange={(e) => setBranchPrefix(e.target.value)}
                  placeholder="feat"
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} onClick={submit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
        className="flex min-w-0 flex-1 flex-col px-3 py-1.5 text-left"
      >
        <span className="truncate text-sm">
          {conversation.title ?? "New chat"}
        </span>
        {conversation.branch && (
          <span className="truncate text-muted-foreground text-xs">
            {conversation.branch}
          </span>
        )}
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
  onUpdateCwd,
}: {
  workspace: WorkspaceSummary;
  activeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onCreate: (workspaceId: string) => void;
  onArchive: (conversationId: string) => void;
  onRename: (workspaceId: string, label: string) => void;
  onUpdateCwd: (
    workspaceId: string,
    cwd: string,
    worktree: WorktreeFields | null,
  ) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelEdit = useRef(false);
  const activeConversation =
    activeId === null
      ? undefined
      : workspace.conversations.find((c) => c.id === activeId);
  const startRename = () => {
    setDraft(workspace.label ?? "");
    setRenaming(true);
  };
  const submitRename = () => {
    setRenaming(false);
    if (cancelEdit.current) {
      cancelEdit.current = false;
      return;
    }
    const value = draft.trim();
    if (value && value !== workspace.label) onRename(workspace.id, value);
  };
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="mb-1">
      <DirectoryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialCwd={workspace.cwd}
        initialWorktree={
          workspace.worktree
            ? {
                defaultBranch: workspace.defaultBranch ?? "HEAD",
                branchPrefix: workspace.branchPrefix ?? "",
              }
            : null
        }
        onSubmit={(cwd, worktree) => onUpdateCwd(workspace.id, cwd, worktree)}
      />
      {renaming ? (
        <div className="px-2 py-1">
          <input
            // biome-ignore lint/a11y/noAutofocus: focus the inline field on open
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelEdit.current = true;
                e.currentTarget.blur();
              }
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
                {workspace.worktree ? (
                  <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
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
            <ContextMenuItem onSelect={() => setDialogOpen(true)}>
              <FolderInputIcon />
              Change directory
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
    updateWorkspaceCwd,
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
              onUpdateCwd={updateWorkspaceCwd}
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
