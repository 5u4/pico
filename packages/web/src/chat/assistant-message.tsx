import { CaretDownIcon, CircleNotchIcon } from "@phosphor-icons/react";
import type { AssistantBlock, AssistantState, TranscriptItem } from "./chat-model.ts";

export function AssistantMessage({
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
