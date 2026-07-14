import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { ArrowUpIcon, CopyIcon, SquareIcon } from "lucide-react";
import { Button } from "./ui/button";

const MessageText: TextMessagePartComponent = ({ text }) => {
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
};

const MessageReasoning: ReasoningMessagePartComponent = ({ text }) => {
  return (
    <p className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm text-muted-foreground italic">
      {text}
    </p>
  );
};

const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  args,
  result,
  isError,
}) => {
  return (
    <div className="my-1 rounded-lg border border-border bg-muted/40 text-sm">
      <div className="flex items-center gap-2 px-3 py-1.5 font-medium">
        <span className={isError ? "text-destructive" : "text-foreground"}>
          {toolName}
        </span>
      </div>
      <pre className="overflow-x-auto px-3 pb-1 text-xs text-muted-foreground">
        {JSON.stringify(args, null, 2)}
      </pre>
      {result !== undefined && (
        <pre className="overflow-x-auto border-t border-border px-3 py-1.5 text-xs whitespace-pre-wrap">
          {typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
};

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-foreground">
        <MessagePrimitive.Parts components={{ Text: MessageText }} />
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
            Text: MessageText,
            Reasoning: MessageReasoning,
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
          <Button variant="ghost" size="icon" className="size-7">
            <CopyIcon className="size-4" />
          </Button>
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
