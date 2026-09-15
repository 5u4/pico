import { ArrowClockwiseIcon, WarningCircleIcon, WrenchIcon } from "@phosphor-icons/react";
import { Button } from "../components/ui/button.tsx";
import { AssistantMessage } from "./assistant-message.tsx";
import type { TranscriptItem, TranscriptPresentation } from "./chat-model.ts";
import { ToolGroup } from "./tool-group.tsx";

export interface TranscriptProps {
  readonly presentation: TranscriptPresentation;
  readonly onRetry: () => void;
  readonly onDisclosureToggle: (itemId: string) => void;
}

export function Transcript({ presentation, onRetry, onDisclosureToggle }: TranscriptProps) {
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
        <section
          aria-label="Conversation"
          className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8 md:py-12"
        >
          <p aria-live="polite" className="sr-only">
            {presentation.liveLabel}
          </p>
          <div className="space-y-7">
            {presentation.items.map((item) => (
              <TranscriptItemView
                item={item}
                key={item.id}
                onDisclosureToggle={onDisclosureToggle}
              />
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

function LoadingTranscript({ label }: { readonly label: string }) {
  return (
    <section
      aria-busy="true"
      aria-label={label}
      className="mx-auto w-full max-w-3xl px-4 py-10 md:px-8 md:py-14"
    >
      <div className="space-y-8">
        <div className="ml-auto w-3/5 rounded-bubble bg-surface p-4">
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
        <p className="mt-2 text-copy text-muted">{description}</p>
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
        <p className="mt-2 text-copy text-muted">{description}</p>
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
  onDisclosureToggle,
}: {
  readonly item: TranscriptItem;
  readonly onDisclosureToggle: (itemId: string) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <article className="ml-auto max-w-[82%] rounded-bubble bg-surface px-4 py-3 md:max-w-[72%]">
          <p className="whitespace-pre-wrap text-copy">{item.text}</p>
          <p className="mt-2 text-right text-meta text-muted">{item.timestampLabel}</p>
        </article>
      );
    case "assistant":
      return <AssistantMessage item={item} onDisclosureToggle={onDisclosureToggle} />;
    case "tool-group":
      return <ToolGroup item={item} onDisclosureToggle={onDisclosureToggle} />;
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
      <p className="mt-1 text-label">{item.text}</p>
    </aside>
  );
}
