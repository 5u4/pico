import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  FileIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import type {
  AssistantBlock,
  AssistantState,
  ToolCallPresentation,
  ToolState,
  TranscriptItem,
  TranscriptPresentation,
} from "./chat-model.ts";

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

function AssistantMessage({
  item,
  onDisclosureToggle,
}: {
  readonly item: Extract<TranscriptItem, { readonly kind: "assistant" }>;
  readonly onDisclosureToggle: (itemId: string) => void;
}) {
  return (
    <article className="text-copy">
      <header className="mb-3 flex items-center gap-2 text-meta text-subtle">
        <span className="font-semibold text-muted">{item.modelLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{item.timestampLabel}</span>
      </header>
      <div className="space-y-4">
        {item.blocks.map((block) => (
          <AssistantBlockView
            block={block}
            key={block.id}
            onDisclosureToggle={onDisclosureToggle}
          />
        ))}
      </div>
      <AssistantStateView state={item.state} />
    </article>
  );
}

function AssistantBlockView({
  block,
  onDisclosureToggle,
}: {
  readonly block: AssistantBlock;
  readonly onDisclosureToggle: (itemId: string) => void;
}) {
  switch (block.kind) {
    case "text":
      return <p className="whitespace-pre-wrap text-copy text-foreground">{block.text}</p>;
    case "thinking": {
      const contentId = `${block.id}-content`;
      return (
        <div className="border-l-2 border-border pl-3">
          <button
            aria-controls={contentId}
            aria-expanded={block.open}
            className="flex items-center gap-2 text-label font-medium text-muted transition-colors duration-feedback hover:text-foreground"
            onClick={() => onDisclosureToggle(block.id)}
            type="button"
          >
            <CaretDownIcon
              aria-hidden="true"
              className={`transition-transform duration-feedback ${block.open ? "disclosure-caret-open" : ""}`}
              size={15}
            />
            {block.label}
            <span className={block.phase === "streaming" ? "text-accent" : "text-subtle"}>
              {block.phase === "streaming"
                ? "Working"
                : block.phase === "complete"
                  ? "Complete"
                  : "Status unknown"}
            </span>
          </button>
          <div
            aria-label={`${block.label} details`}
            className="pt-2 text-label leading-relaxed text-muted"
            hidden={!block.open}
            id={contentId}
            role="region"
          >
            {block.text}
          </div>
        </div>
      );
    }
    case "code":
      return (
        <figure className="overflow-hidden rounded-surface border border-border bg-surface">
          <figcaption className="border-b border-border px-4 py-2 text-meta font-medium text-muted">
            {block.languageLabel}
          </figcaption>
          <pre className="overflow-x-auto p-4 font-mono text-label leading-relaxed text-foreground">
            <code>{block.code}</code>
          </pre>
        </figure>
      );
    case "image":
      return (
        <figure className="overflow-hidden rounded-surface border border-border bg-panel">
          <img alt={block.alt} className="block h-auto w-full text-foreground" src={block.src} />
          <figcaption className="border-t border-border px-4 py-2 text-meta text-muted">
            {block.caption}
          </figcaption>
        </figure>
      );
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function AssistantStateView({ state }: { readonly state: AssistantState }) {
  switch (state.kind) {
    case "complete":
      return null;
    case "streaming":
      return (
        <p className="mt-3 flex items-center gap-2 text-meta font-medium text-accent">
          <CircleNotchIcon aria-hidden="true" size={14} />
          {state.label}
        </p>
      );
    case "unknown":
      return <p className="mt-3 text-meta text-muted">{state.label}</p>;
    case "interrupted":
      return (
        <p className="mt-4 border-l-2 border-warning pl-3 text-label text-warning">{state.label}</p>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function ToolGroup({
  item,
  onDisclosureToggle,
}: {
  readonly item: Extract<TranscriptItem, { readonly kind: "tool-group" }>;
  readonly onDisclosureToggle: (itemId: string) => void;
}) {
  const contentId = `${item.id}-content`;
  return (
    <section className="border-y border-border py-2">
      <button
        aria-controls={contentId}
        aria-expanded={item.open}
        className="flex w-full items-center gap-3 py-2 text-left text-label font-medium text-muted transition-colors duration-feedback hover:text-foreground"
        onClick={() => onDisclosureToggle(item.id)}
        type="button"
      >
        <WrenchIcon aria-hidden="true" size={16} />
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        <span className="text-meta text-subtle">
          {item.calls.length === 1 ? "1 action" : `${item.calls.length} actions`}
        </span>
        <CaretDownIcon
          aria-hidden="true"
          className={`transition-transform duration-feedback ${item.open ? "disclosure-caret-open" : ""}`}
          size={15}
        />
      </button>
      <div
        aria-label={`${item.title} details`}
        className="space-y-1 pb-2"
        hidden={!item.open}
        id={contentId}
        role="region"
      >
        {item.calls.map((call) => (
          <ToolCall call={call} key={call.id} />
        ))}
      </div>
    </section>
  );
}

function ToolCall({ call }: { readonly call: ToolCallPresentation }) {
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-control px-3 py-2 text-label hover:bg-surface">
      <span className="mt-0.5 text-muted">{toolIcon(call.icon)}</span>
      <span className="min-w-0 flex-1 basis-32">
        <span className="block font-medium text-foreground">{call.label}</span>
        <span className="block break-words text-meta text-muted">{call.summary}</span>
      </span>
      <span
        className={`flex shrink-0 items-center gap-1.5 text-meta ${toolStateClass(call.state)}`}
      >
        {toolStateIcon(call.state)}
        {call.state.label}
      </span>
      {call.output !== undefined && (
        <pre className="w-full whitespace-pre-wrap break-words rounded-control bg-canvas p-3 font-mono text-label text-foreground">
          {call.output}
        </pre>
      )}
    </div>
  );
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

function toolIcon(icon: ToolCallPresentation["icon"]): ReactNode {
  switch (icon) {
    case "file":
      return <FileIcon aria-hidden="true" size={16} />;
    case "search":
      return <MagnifyingGlassIcon aria-hidden="true" size={16} />;
    case "terminal":
      return <TerminalWindowIcon aria-hidden="true" size={16} />;
    case "edit":
      return <PencilSimpleIcon aria-hidden="true" size={16} />;
    case "network":
      return <GlobeIcon aria-hidden="true" size={16} />;
    case "generic":
      return <WrenchIcon aria-hidden="true" size={16} />;
    default: {
      const exhaustive: never = icon;
      return exhaustive;
    }
  }
}

function toolStateClass(state: ToolState): string {
  switch (state.kind) {
    case "running":
      return "text-accent";
    case "succeeded":
      return "text-success";
    case "failed":
      return "text-danger";
    case "unknown":
    case "canceled":
      return "text-muted";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function toolStateIcon(state: ToolState): ReactNode {
  switch (state.kind) {
    case "running":
      return <CircleNotchIcon aria-hidden="true" size={14} />;
    case "succeeded":
      return <CheckCircleIcon aria-hidden="true" size={14} weight="fill" />;
    case "failed":
      return <XCircleIcon aria-hidden="true" size={14} weight="fill" />;
    case "canceled":
      return <XCircleIcon aria-hidden="true" size={14} />;
    case "unknown":
      return <WarningCircleIcon aria-hidden="true" size={14} />;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
