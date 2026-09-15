import { CaretDownIcon, CircleNotchIcon, SparkleIcon } from "@phosphor-icons/react";
import type { AssistantBlock, AssistantState, TranscriptItem } from "./chat-model.ts";

export function AssistantMessage({
  item,
  onDisclosuresChange,
}: {
  readonly item: Extract<TranscriptItem, { readonly kind: "assistant" }>;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
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
            onDisclosuresChange={onDisclosuresChange}
          />
        ))}
      </div>
      <AssistantStateView state={item.state} />
    </article>
  );
}

function AssistantBlockView({
  block,
  onDisclosuresChange,
}: {
  readonly block: AssistantBlock;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
}) {
  switch (block.kind) {
    case "text":
      return <p className="whitespace-pre-wrap text-copy text-foreground">{block.text}</p>;
    case "thinking": {
      const contentId = `${block.id}-content`;
      const triggerId = `${block.id}-trigger`;
      return (
        <div>
          <button
            aria-controls={contentId}
            aria-expanded={block.open}
            className="trace-disclosure flex max-w-full items-center gap-2 px-1.5 py-1 text-start text-label font-medium text-muted"
            id={triggerId}
            onClick={() => onDisclosuresChange([block.id], !block.open)}
            type="button"
          >
            <SparkleIcon aria-hidden="true" className="shrink-0 text-subtle" size={16} />
            <span className="min-w-0 break-words">{block.label}</span>
            <CaretDownIcon
              aria-hidden="true"
              className={`trace-caret ${block.open ? "disclosure-caret-open" : ""}`}
              size={14}
            />
          </button>
          <div
            aria-labelledby={triggerId}
            className="trace-body mt-1 whitespace-pre-wrap break-words py-1 text-label leading-relaxed text-muted"
            hidden={!block.open}
            id={contentId}
            role="region"
          >
            {block.text}
          </div>
        </div>
      );
    }
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
