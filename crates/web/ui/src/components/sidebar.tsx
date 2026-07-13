import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useSession, type TreeChannel } from "../runtime";

export function Sidebar() {
  const { tree, threadId, isRunning, openThread, newThread } = useSession();
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-background">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-semibold tracking-tight">Chats</span>
        <button
          type="button"
          onClick={newThread}
          disabled={isRunning}
          aria-label="New chat"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
      <div className={"min-h-0 flex-1 overflow-y-auto px-2 pb-2" + (isRunning ? " pointer-events-none opacity-50" : "")}>
        {tree.length === 0 ? (
          <div className="px-2 py-4 text-xs text-muted-foreground">No chats yet.</div>
        ) : (
          tree.map((channel) => (
            <Channel
              key={channel.channel_id}
              channel={channel}
              activeThread={threadId}
              onOpen={openThread}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function Channel({
  channel,
  activeThread,
  onOpen,
}: {
  channel: TreeChannel;
  activeThread: string | null;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const name = channel.label.split("/").filter(Boolean).pop() ?? channel.label;
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={channel.label}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent"
      >
        {open ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />}
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{name}</span>
      </button>
      {open && (
        <div className="ml-3 border-l pl-1">
          {channel.threads.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">empty</div>
          ) : (
            channel.threads.map((thread) => (
              <button
                key={thread.thread_id}
                type="button"
                onClick={() => onOpen(thread.thread_id)}
                title={thread.title || thread.thread_id}
                className={
                  "block w-full truncate rounded-md px-2 py-1 text-left text-sm " +
                  (thread.thread_id === activeThread
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground")
                }
              >
                {thread.title || "Untitled"}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
