import { ArrowClockwiseIcon, WarningCircleIcon, WrenchIcon } from "@phosphor-icons/react";
import { Button } from "../components/ui/button.tsx";
import { AssistantMessage } from "./assistant-message.tsx";
import type { TranscriptItem, TranscriptPresentation } from "./chat-model.ts";
import { LoadingDots } from "./loading-dots.tsx";
import { Markdown } from "./markdown.tsx";
import { ToolGroup } from "./tool-group.tsx";

export interface TranscriptProps {
  readonly presentation: TranscriptPresentation;
  readonly onRetry: () => void;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
  readonly onToolSelect: (id: string | null) => void;
}

export function Transcript({
  presentation,
  onRetry,
  onDisclosuresChange,
  onToolSelect,
}: TranscriptProps) {
  switch (presentation.state) {
    case "loading":
      return <LoadingTranscript label={presentation.label} />;
    case "empty":
      return <EmptyTranscript description={presentation.description} title={presentation.title} />;
    case "error":
      return (
        <ErrorTranscript
          description={presentation.description}
          onRetry={onRetry}
          retryLabel={presentation.retryLabel}
          title={presentation.title}
        />
      );
    case "ready":
      return (
        <section aria-label="Conversation" className="w-full px-4 pt-8 sm:px-8 lg:px-12">
          <p aria-live="polite" className="sr-only">
            {presentation.liveLabel}
          </p>
          <div className="transcript-flow mx-auto w-full max-w-[720px]">
            {presentation.items.map((item) => (
              <div
                className="min-w-0"
                data-transcript-end={transcriptBoundary(item, "end")}
                data-transcript-start={transcriptBoundary(item, "start")}
                key={item.id}
              >
                <TranscriptItemView
                  item={item}
                  onDisclosuresChange={onDisclosuresChange}
                  onToolSelect={onToolSelect}
                />
              </div>
            ))}
          </div>
        </section>
      );
    default: {
      const exhaustive: never = presentation;
      return exhaustive;
    }
  }
}

function transcriptBoundary(
  item: TranscriptItem,
  edge: "start" | "end",
): "conversation" | "activity" | "prose" {
  switch (item.kind) {
    case "user":
    case "notice":
      return "conversation";
    case "tool-group":
    case "waiting":
      return "activity";
    case "assistant":
      return item.blocks.at(edge === "start" ? 0 : -1)?.kind === "thinking" ? "activity" : "prose";
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function LoadingTranscript({ label }: { readonly label: string }) {
  return (
    <section
      aria-busy="true"
      aria-label={label}
      className="mx-auto w-full max-w-[816px] px-4 pt-8 sm:px-8 lg:px-12"
    >
      <div className="space-y-8">
        <div className="ml-auto w-3/5 rounded-xl bg-field px-3.5 py-2 shadow-hairline">
          <div className="loading-line w-full" />
          <div className="loading-line mt-3 w-4/5" />
        </div>
        <div className="w-full space-y-3">
          <div className="loading-line w-1/3" />
          <div className="loading-line w-full" />
          <div className="loading-line w-5/6" />
          <div className="loading-line w-2/3" />
        </div>
      </div>
    </section>
  );
}

function EmptyTranscript({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <section className="grid min-h-full place-items-center px-6 py-16 text-center">
      <div className="max-w-md">
        <span className="mx-auto grid size-11 place-items-center rounded-surface border border-border bg-panel text-accent">
          <WrenchIcon aria-hidden="true" size={21} />
        </span>
        <h2 className="mt-5 text-display font-semibold">{title}</h2>
        <Markdown className="mt-2 text-copy text-muted" text={description} />
      </div>
    </section>
  );
}

function ErrorTranscript({
  title,
  description,
  retryLabel,
  onRetry,
}: {
  readonly title: string;
  readonly description: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
}) {
  return (
    <section className="grid min-h-full place-items-center px-6 py-16 text-center" role="alert">
      <div className="max-w-md">
        <span className="mx-auto grid size-11 place-items-center rounded-surface bg-danger-soft text-danger">
          <WarningCircleIcon aria-hidden="true" size={22} />
        </span>
        <h2 className="mt-5 text-display font-semibold">{title}</h2>
        <Markdown className="mt-2 text-copy text-muted" text={description} />
        <Button className="mt-5" onClick={onRetry} size="small">
          <ArrowClockwiseIcon aria-hidden="true" size={16} />
          {retryLabel}
        </Button>
      </div>
    </section>
  );
}

function TranscriptItemView({
  item,
  onDisclosuresChange,
  onToolSelect,
}: {
  readonly item: TranscriptItem;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
  readonly onToolSelect: (id: string | null) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <article className="transcript-user-enter flex min-w-0 justify-end pl-10 sm:pl-24">
          <div className="min-w-0 max-w-full rounded-xl bg-field px-3.5 py-2 text-[13px] leading-relaxed text-foreground shadow-hairline">
            <Markdown text={item.text} />
            <p className="sr-only">{item.timestampLabel}</p>
          </div>
        </article>
      );
    case "assistant":
      return <AssistantMessage item={item} onDisclosuresChange={onDisclosuresChange} />;
    case "tool-group":
      return (
        <ToolGroup
          item={item}
          onDisclosuresChange={onDisclosuresChange}
          onToolSelect={onToolSelect}
        />
      );
    case "waiting":
      return (
        <div className="flex min-h-7 w-fit items-center gap-2.5" role="status">
          <LoadingDots />
          <span className="thinking-shimmer text-[13px] font-medium">{item.label}</span>
        </div>
      );
    case "notice":
      return <Notice item={item} />;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function Notice({ item }: { readonly item: Extract<TranscriptItem, { readonly kind: "notice" }> }) {
  const toneClasses = {
    info: "border-accent bg-accent-soft text-foreground",
    warning: "border-warning bg-warning-soft text-warning",
    error: "border-danger bg-danger-soft text-danger",
  } satisfies Record<typeof item.tone, string>;

  return (
    <aside className={`rounded-control border-l-2 px-4 py-3 ${toneClasses[item.tone]}`}>
      <p className="text-label font-semibold">{item.title}</p>
      <Markdown className="mt-1 text-label" text={item.text} />
    </aside>
  );
}
