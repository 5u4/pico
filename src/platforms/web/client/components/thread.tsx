import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  type EmptyMessagePartComponent,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BugIcon,
  CompassIcon,
  CopyIcon,
  FlaskConicalIcon,
  GitPullRequestIcon,
  SquareIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "../lib/utils";
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
    <MessagePrimitive.Root className="flex justify-end">
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

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-1">
      <div className="leading-relaxed text-foreground">
        <MessagePrimitive.Parts
          components={{
            Empty: WorkingIndicator,
            Text: MarkdownText,
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
  return (
    <ComposerPrimitive.Root className="flex items-center gap-2 rounded-(--composer-radius) border border-border/60 bg-(--composer-bg) p-(--composer-padding) transition-[border-color] focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30">
      <ComposerPrimitive.Input
        autoFocus
        rows={1}
        placeholder="Message pico…"
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
    </ComposerPrimitive.Root>
  );
}

function ScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
      >
        <ArrowDownIcon />
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

type SuggestionGroup = {
  label: string;
  icon: ReactNode;
  options: { label: string; prompt: string }[];
};

const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    label: "Understand",
    icon: <CompassIcon />,
    options: [
      {
        label: "explain the architecture",
        prompt: "Explain the architecture of this codebase.",
      },
      {
        label: "walk me through the entry point",
        prompt: "Walk me through the main entry point of this project.",
      },
      {
        label: "what does this module do",
        prompt: "Pick a core module and explain what it does and why.",
      },
    ],
  },
  {
    label: "Fix",
    icon: <BugIcon />,
    options: [
      {
        label: "find and fix a bug",
        prompt: "Find a bug in the recent changes and fix it.",
      },
      {
        label: "why is this test failing",
        prompt: "Run the test suite and diagnose why a failing test fails.",
      },
    ],
  },
  {
    label: "Refactor",
    icon: <WandSparklesIcon />,
    options: [
      {
        label: "improve readability",
        prompt: "Refactor a file you consider hard to read, keeping behavior.",
      },
      {
        label: "find dead code",
        prompt: "Find dead or unused code that can be safely removed.",
      },
    ],
  },
  {
    label: "Test",
    icon: <FlaskConicalIcon />,
    options: [
      {
        label: "cover the last change",
        prompt: "Add tests covering the most recent change.",
      },
      {
        label: "what isn't covered",
        prompt: "Identify important code paths that lack test coverage.",
      },
    ],
  },
  {
    label: "Git",
    icon: <GitPullRequestIcon />,
    options: [
      {
        label: "summarize my changes",
        prompt: "Summarize my uncommitted changes.",
      },
      {
        label: "write a commit message",
        prompt: "Write a Conventional Commits message for the staged changes.",
      },
      {
        label: "draft a PR description",
        prompt: "Draft a pull request description for my current branch.",
      },
    ],
  },
];

const suggestionChipClass =
  "h-auto gap-1.5 rounded-full border border-border/60 px-3.5 py-1.5 text-sm font-normal whitespace-nowrap text-foreground transition-colors hover:bg-muted [&_svg]:size-4";

function ThreadSuggestions() {
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const expandedGroup = SUGGESTION_GROUPS.find(
    (group) => group.label === expandedLabel,
  );

  return (
    <div className="flex w-full flex-col gap-2 px-4">
      <div className="scrollbar-none w-full overflow-x-auto">
        <div className="mx-auto flex w-max items-center gap-2">
          {SUGGESTION_GROUPS.map((group) => (
            <Button
              key={group.label}
              variant="ghost"
              className={cn(
                suggestionChipClass,
                group.label === expandedLabel && "bg-muted",
              )}
              onClick={() =>
                setExpandedLabel(
                  group.label === expandedLabel ? null : group.label,
                )
              }
            >
              {group.icon}
              {group.label}
            </Button>
          ))}
        </div>
      </div>
      {expandedGroup && (
        <div
          key={expandedGroup.label}
          className="fade-in slide-in-from-top-1 animate-in scrollbar-none w-full overflow-x-auto duration-200"
        >
          <div className="mx-auto flex w-max items-center gap-2">
            {expandedGroup.options.map((option) => (
              <ThreadPrimitive.Suggestion
                key={option.label}
                prompt={option.prompt}
                send
                asChild
              >
                <Button variant="ghost" className={suggestionChipClass}>
                  {option.label}
                </Button>
              </ThreadPrimitive.Suggestion>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Thread() {
  const isEmpty = useAuiState((s) => s.thread.messages.length === 0);

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
        turnAnchor="top"
        className={cn(
          "relative flex flex-1 flex-col overflow-y-scroll overscroll-contain scroll-smooth px-4 pt-4",
          isEmpty && "justify-center",
        )}
      >
        <ThreadPrimitive.Empty>
          <ThreadWelcome />
        </ThreadPrimitive.Empty>

        <div className="mx-auto mb-14 flex w-full max-w-(--thread-max-width) flex-col gap-6 empty:hidden">
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </div>

        <ThreadPrimitive.ViewportFooter
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible bg-background pb-4 md:pb-6",
            !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
          )}
        >
          <ScrollToBottom />
          <Composer />
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-1" />
            <ContextUsage />
          </div>
          <ThreadPrimitive.Empty>
            <div className="min-h-19">
              <AuiIf condition={(s) => s.composer.isEmpty}>
                <ThreadSuggestions />
              </AuiIf>
            </div>
          </ThreadPrimitive.Empty>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
