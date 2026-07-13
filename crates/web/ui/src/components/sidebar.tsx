import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useSession, type TreeChannel } from "../runtime";

export function Sidebar() {
  const { tree, threadId, isRunning, openThread, newThread, newChannel } = useSession();
  const [creating, setCreating] = useState(false);
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-background">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-semibold tracking-tight">Channels</span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={isRunning}
          aria-label="New channel"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>
      <div className={"min-h-0 flex-1 overflow-y-auto px-2 pb-2" + (isRunning ? " pointer-events-none opacity-50" : "")}>
        {creating && (
          <ChannelNameInput
            onSubmit={async (label) => {
              await newChannel(label);
              setCreating(false);
            }}
            onCancel={() => setCreating(false)}
          />
        )}
        {tree.length === 0 && !creating ? (
          <div className="px-2 py-4 text-xs text-muted-foreground">No channels yet.</div>
        ) : (
          tree.map((channel) => (
            <Channel
              key={channel.channel_id}
              channel={channel}
              activeThread={threadId}
              onOpen={openThread}
              onNewThread={newThread}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function ChannelNameInput({
  onSubmit,
  onCancel,
}: {
  onSubmit: (label: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  return (
    <input
      autoFocus
      value={value}
      disabled={submitted}
      placeholder="Channel name…"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (submitted) return;
          const label = value.trim();
          if (label) {
            setSubmitted(true);
            onSubmit(label);
          } else {
            onCancel();
          }
        } else if (e.key === "Escape") {
          onCancel();
        }
      }}
      onBlur={() => onCancel()}
      className="mb-1 w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
    />
  );
}

function Channel({
  channel,
  activeThread,
  onOpen,
  onNewThread,
}: {
  channel: TreeChannel;
  activeThread: string | null;
  onOpen: (id: string) => void;
  onNewThread: (channelId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const name = channel.label.split("/").filter(Boolean).pop() ?? channel.label;
  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-accent">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={channel.label}
          className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left text-sm text-foreground"
        >
          {open ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />}
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{name}</span>
        </button>
        <button
          type="button"
          onClick={() => onNewThread(channel.channel_id)}
          aria-label="New thread"
          title="New thread"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
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
