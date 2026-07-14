import { PlusIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { usePico } from "../runtime";
import { ModeToggle } from "./mode-toggle";
import { Button } from "./ui/button";

export function Sidebar() {
  const { conversations, activeId, select, create } = usePico();
  return (
    <aside className="flex h-dvh w-64 shrink-0 flex-col border-r border-border bg-muted/30">
      <div className="p-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => create()}
        >
          <PlusIcon className="size-4" />
          New chat
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => select(conversation.id)}
            className={cn(
              "mb-0.5 w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
              conversation.id === activeId &&
                "bg-accent text-accent-foreground",
            )}
          >
            {conversation.title ?? "New chat"}
          </button>
        ))}
      </nav>
      <div className="flex items-center justify-between border-t border-border p-2">
        <span className="px-2 text-xs text-muted-foreground">pico</span>
        <ModeToggle />
      </div>
    </aside>
  );
}
