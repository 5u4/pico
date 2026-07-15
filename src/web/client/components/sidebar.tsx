import { ChevronRightIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { WorkspaceSummary } from "../../protocol";
import { cn } from "../lib/utils";
import { useShell } from "../runtime";
import { ModeToggle } from "./mode-toggle";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

function WorkspaceItem({
  workspace,
  activeId,
  onSelect,
  onCreate,
}: {
  workspace: WorkspaceSummary;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (workspaceId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-1">
      <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-accent/50">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-sm">
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{workspace.label ?? "workspace"}</span>
        </CollapsibleTrigger>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onCreate(workspace.id)}
          aria-label="New conversation"
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      <CollapsibleContent className="ml-4 border-l border-border pl-1">
        {workspace.conversations.length === 0 ? (
          <div className="px-3 py-1.5 text-xs text-muted-foreground">
            No conversations
          </div>
        ) : (
          workspace.conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => onSelect(conversation.id)}
              className={cn(
                "mb-0.5 w-full truncate rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                conversation.id === activeId &&
                  "bg-accent text-accent-foreground",
              )}
            >
              {conversation.title ?? "New chat"}
            </button>
          ))
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Sidebar() {
  const { workspaces, activeId, select, create, createWorkspace } = useShell();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const submit = () => {
    const label = name.trim();
    if (label) createWorkspace(label);
    setName("");
    setNaming(false);
  };

  return (
    <aside className="flex h-dvh w-64 shrink-0 flex-col border-r border-border bg-muted/30">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium">Workspaces</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setNaming((v) => !v)}
          aria-label="New workspace"
        >
          <PlusIcon className="size-4" />
        </Button>
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
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {workspaces.map((workspace) => (
          <WorkspaceItem
            key={workspace.id}
            workspace={workspace}
            activeId={activeId}
            onSelect={select}
            onCreate={create}
          />
        ))}
      </nav>
      <div className="flex items-center justify-between border-t border-border p-2">
        <span className="px-2 text-xs text-muted-foreground">pico</span>
        <ModeToggle />
      </div>
    </aside>
  );
}
