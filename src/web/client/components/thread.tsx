import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { ArrowUpIcon, CopyIcon, SquareIcon } from "lucide-react";
import { MarkdownText } from "./assistant-ui/markdown-text";
import { ReasoningGroup } from "./assistant-ui/reasoning";
import { ToolFallback } from "./assistant-ui/tool-fallback";
import { ToolGroup } from "./assistant-ui/tool-group";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button";
import { Button } from "./ui/button";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-foreground">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group flex flex-col gap-1">
      <div className="leading-relaxed text-foreground">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            ReasoningGroup,
            ToolGroup,
            tools: { Fallback: ToolFallback },
          }}
        />
      </div>
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        className="flex gap-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
      >
        <ActionBarPrimitive.Copy asChild>
          <TooltipIconButton tooltip="Copy">
            <CopyIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border border-input bg-background p-2 shadow-xs focus-within:border-ring">
      <ComposerPrimitive.Input
        autoFocus
        rows={1}
        placeholder="Message pico…"
        className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground"
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild>
          <Button
            size="icon"
            className="size-9 rounded-full"
            aria-label="Send message"
          >
            <ArrowUpIcon className="size-5" />
          </Button>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel asChild>
          <Button
            size="icon"
            className="size-9 rounded-full"
            aria-label="Stop generating"
          >
            <SquareIcon className="size-4 fill-current" />
          </Button>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  );
}

export function Thread() {
  return (
    <ThreadPrimitive.Root className="flex h-dvh flex-col bg-background">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-6">
          <ThreadPrimitive.Empty>
            <div className="flex flex-1 items-center justify-center">
              <p className="text-lg font-medium text-muted-foreground">
                How can I help you today?
              </p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
          <div className="sticky bottom-0 mt-auto bg-background pb-4">
            <Composer />
          </div>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
