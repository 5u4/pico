import {
  ActionBarPrimitive,
  ComposerPrimitive,
  type EmptyMessagePartComponent,
  MessagePrimitive,
  type TextMessagePartComponent,
  ThreadPrimitive,
  type Unstable_SlashCommand,
  unstable_useSlashCommandAdapter,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  SlashIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { useShell, useThread } from "../runtime";
import { DotMatrix } from "./assistant-ui/dot-matrix";
import { MarkdownText } from "./assistant-ui/markdown-text";
import { Reasoning, ReasoningGroup } from "./assistant-ui/reasoning";
import { toolCardsByName } from "./assistant-ui/tool-cards";
import { ToolFallback } from "./assistant-ui/tool-fallback";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button";
import { ContextUsage } from "./context-usage";
import { Button } from "./ui/button";

function UserMessage() {
  const isPending = useAuiState((s) => s.message.id === "pending-user");
  return (
    <MessagePrimitive.Root className="flex justify-end data-[aui-top-anchor-user]:pt-4">
      <div
        className={cn(
          "max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-foreground transition-opacity",
          isPending && "opacity-60",
        )}
      >
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

const WorkingIndicator: EmptyMessagePartComponent = ({ status }) => {
  if (status.type !== "running") return null;
  return (
    <span className="inline-flex items-center gap-2 align-middle text-muted-foreground">
      <DotMatrix state="connecting" aria-hidden />
      <span className="text-sm">Working</span>
    </span>
  );
};

const AssistantText: TextMessagePartComponent = () => (
  <div className="[&:not(:first-child)]:mt-4">
    <MarkdownText />
  </div>
);

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-1">
      <div className="leading-relaxed text-foreground">
        <MessagePrimitive.Parts
          components={{
            Empty: WorkingIndicator,
            Text: AssistantText,
            Reasoning,
            ReasoningGroup,
            tools: { by_name: toolCardsByName, Fallback: ToolFallback },
          }}
        />
      </div>
      <AssistantActionBar />
    </MessagePrimitive.Root>
  );
}

function SystemMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-center">
      <div className="max-w-[80%] rounded-lg border border-border/50 bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantActionBar() {
  const hasText = useAuiState((s) =>
    s.message.parts.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    ),
  );
  if (!hasText) return null;

  return (
    <div className="flex min-h-6 items-center">
      <ActionBarPrimitive.Root
        hideWhenRunning
        className="flex gap-1 text-muted-foreground"
      >
        <ActionBarPrimitive.Copy asChild>
          <TooltipIconButton tooltip="Copy">
            <CopyIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </div>
  );
}

function Composer() {
  const { command } = useThread();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const slash = unstable_useSlashCommandAdapter({
    commands: SLASH_COMMANDS.map((cmd) => ({
      ...cmd,
      execute: () => {
        const raw = inputRef.current?.value ?? "";
        const match = raw.match(new RegExp(`^/${cmd.id}\\s+(.*)`));
        const text = match?.[1]?.trim();
        if (cmd.id === "ping") command("ping", text || undefined);
      },
    })),
    removeOnExecute: true,
    fallbackIcon: SlashIcon,
  });
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="relative flex items-center gap-2 rounded-(--composer-radius) border border-border/60 bg-(--composer-bg) p-(--composer-padding) transition-[border-color] focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30">
        <ComposerPrimitive.Input
          ref={inputRef}
          autoFocus
          rows={1}
          placeholder="Message pico… (/ for commands)"
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-base outline-none placeholder:text-muted-foreground"
        />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send asChild>
            <Button
              variant="secondary"
              size="icon"
              className="size-8 rounded-lg"
              aria-label="Send message"
            >
              <ArrowUpIcon className="size-4.5" />
            </Button>
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="secondary"
              size="icon"
              className="size-8 rounded-lg"
              aria-label="Stop generating"
            >
              <SquareIcon className="size-4 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
        <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={slash.adapter}
          className="absolute start-0 bottom-full z-50 mb-2 w-72 overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-lg"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => (
              <div className="flex flex-col py-1">
                {items.map((item, index) => (
                  <ComposerPrimitive.Unstable_TriggerPopoverItem
                    key={item.id}
                    item={item}
                    index={index}
                    className="flex flex-col items-start gap-0.5 px-3 py-2 text-start outline-none transition-colors hover:bg-accent data-[highlighted]:bg-accent"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <SlashIcon className="size-3.5 text-primary" />
                      {item.label}
                    </span>
                    {item.description && (
                      <span className="ms-5.5 text-xs leading-tight text-muted-foreground">
                        {item.description}
                      </span>
                    )}
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                ))}
                {items.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No matching commands
                  </div>
                )}
              </div>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

function ConversationLabel() {
  const { workspaces, activeId, draftWorkspaceId } = useShell();
  const workspace =
    activeId !== null
      ? workspaces.find((w) => w.conversations.some((c) => c.id === activeId))
      : draftWorkspaceId !== null
        ? workspaces.find((w) => w.id === draftWorkspaceId)
        : undefined;
  if (!workspace) return null;
  const conversation =
    activeId === null
      ? undefined
      : workspace.conversations.find((c) => c.id === activeId);
  const label = workspace.label ?? "workspace";
  const title = conversation?.title ?? "New chat";
  const cwd = conversation?.cwd ?? workspace.cwd;
  return (
    <span className="min-w-0 truncate text-xs text-muted-foreground">
      {label}/{title} · {cwd}
    </span>
  );
}
const SLASH_COMMANDS: readonly Unstable_SlashCommand[] = [
  {
    id: "ping",
    description: "Ping pico, optionally with text — e.g. /ping hello",
    execute: () => {},
  },
];

function ScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        className="absolute -top-12 z-10 size-9 self-center rounded-full bg-primary p-2 text-primary-foreground shadow-md transition-transform hover:scale-110 hover:bg-primary hover:text-primary-foreground disabled:invisible"
      >
        <ArrowDownIcon className="size-5" />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}

function ThreadWelcome() {
  return (
    <div className="mx-auto mb-6 flex w-full max-w-(--thread-max-width) flex-col items-center px-4 text-center">
      <h1 className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
        How can I help you today?
      </h1>
    </div>
  );
}

function useOlderLoader() {
  const { messages, hasMore, loadingOlder, loadOlder } = useThread();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const busyRef = useRef(false);
  const prevFirstIdRef = useRef<string | null>(null);

  const requestOlder = useCallback(() => {
    const el = viewportRef.current;
    if (!el || busyRef.current) return;
    busyRef.current = true;
    anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    loadOlder();
  }, [loadOlder]);

  useEffect(() => {
    const el = viewportRef.current;
    const sentinel = sentinelRef.current;
    if (!el || !sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) requestOlder();
      },
      { root: el, rootMargin: "300px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, requestOlder]);

  useLayoutEffect(() => {
    if (!busyRef.current || loadingOlder) return;
    const el = viewportRef.current;
    const anchor = anchorRef.current;
    const firstId = messages[0]?.id ?? null;
    if (
      el &&
      anchor &&
      firstId !== null &&
      firstId !== prevFirstIdRef.current
    ) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    }
    prevFirstIdRef.current = firstId;
    anchorRef.current = null;
    busyRef.current = false;
  }, [messages, loadingOlder]);

  useLayoutEffect(() => {
    if (busyRef.current) return;
    prevFirstIdRef.current = messages[0]?.id ?? null;
  }, [messages]);

  return { viewportRef, sentinelRef, hasMore, loadingOlder };
}

export function Thread() {
  const isEmpty = useAuiState((s) => s.thread.messages.length === 0);
  const { viewportRef, sentinelRef, hasMore, loadingOlder } = useOlderLoader();

  return (
    <ThreadPrimitive.Root
      className="@container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "56rem",
        ["--composer-bg" as string]: "var(--color-background)",
        ["--composer-radius" as string]: "1rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        turnAnchor="top"
        className={cn(
          "relative flex flex-1 flex-col overflow-y-scroll overscroll-contain scroll-smooth px-4 pt-4",
          isEmpty && "justify-center",
        )}
      >
        {hasMore && (
          <div
            ref={sentinelRef}
            className="flex h-6 shrink-0 items-center justify-center text-xs text-muted-foreground"
          >
            {loadingOlder ? "Loading earlier messages…" : ""}
          </div>
        )}
        <ThreadPrimitive.Empty>
          <ThreadWelcome />
        </ThreadPrimitive.Empty>

        <div className="mx-auto mb-14 flex w-full max-w-(--thread-max-width) flex-col gap-6 empty:hidden">
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage, SystemMessage }}
          />
        </div>

        <ThreadPrimitive.ViewportFooter
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-2 overflow-visible bg-background pb-2 md:pb-3",
            !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
          )}
        >
          <ScrollToBottom />
          <Composer />
          <div className="flex items-center justify-between gap-4 px-1">
            <ConversationLabel />
            <ContextUsage />
          </div>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
