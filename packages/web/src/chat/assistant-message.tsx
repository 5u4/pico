import { CaretDownIcon, SparkleIcon } from "@phosphor-icons/react";
import type { AssistantBlock, AssistantState, TranscriptItem } from "./chat-model.ts";
import { LoadingDots } from "./loading-dots.tsx";
import { Markdown } from "./markdown.tsx";

export function AssistantMessage({
  item,
  onDisclosuresChange,
}: {
  readonly item: Extract<TranscriptItem, { readonly kind: "assistant" }>;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
}) {
  return (
    <article className="transcript-assistant-enter min-w-0">
      <header className="sr-only">
        {item.modelLabel} · {item.timestampLabel}
      </header>
      <div className="transcript-flow">
        {item.blocks.map((block, index) => (
          <AssistantBlockView
            block={block}
            key={block.id}
            live={item.state.kind === "streaming" && index === item.blocks.length - 1}
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
  live,
  onDisclosuresChange,
}: {
  readonly block: AssistantBlock;
  readonly live: boolean;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
}) {
  switch (block.kind) {
    case "text":
      return (
        <div data-transcript-end="prose" data-transcript-start="prose">
          <Markdown
            className="max-w-[620px] text-[13.5px] leading-[1.65] text-foreground"
            streaming={live}
            text={block.text}
          />
        </div>
      );
    case "thinking": {
      const contentId = `${block.id}-content`;
      const triggerId = `${block.id}-trigger`;
      return (
        <div
          className="w-full max-w-95"
          data-transcript-end="activity"
          data-transcript-start="activity"
        >
          <button
            aria-controls={contentId}
            aria-expanded={block.open}
            className="-mx-1.5 flex min-h-7 max-w-full items-center gap-2.5 rounded-control px-1.5 py-1 text-start transition-colors duration-100 hover:bg-surface-hover"
            id={triggerId}
            onClick={() => onDisclosuresChange([block.id], !block.open)}
            type="button"
          >
            {live ? (
              <LoadingDots />
            ) : (
              <SparkleIcon
                aria-hidden="true"
                className="shrink-0 text-subtle"
                size={16}
                weight="fill"
              />
            )}
            <span
              className={`min-w-0 break-words text-[13px] font-medium ${live ? "thinking-shimmer" : "text-muted"}`}
            >
              {block.label}
            </span>
            <CaretDownIcon
              aria-hidden="true"
              className="thinking-caret shrink-0 text-subtle"
              data-open={block.open}
              size={14}
            />
          </button>
          <div
            aria-hidden={!block.open}
            aria-labelledby={triggerId}
            className="thinking-expansion"
            data-open={block.open}
            id={contentId}
            inert={!block.open}
            role="region"
          >
            <div className="min-h-0 overflow-hidden">
              <div className="relative ml-[5px] mt-1 pl-4">
                <span
                  aria-hidden="true"
                  className="absolute -top-2 bottom-1 left-[3px] w-px bg-border"
                />
                <Markdown
                  className="py-1 text-[12.5px] leading-relaxed text-muted"
                  text={block.text}
                />
              </div>
            </div>
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
      return <p className="sr-only">{state.label}</p>;
    case "unknown":
      return <p className="mt-3 text-[12px] text-muted">{state.label}</p>;
    case "interrupted":
      return (
        <p className="mt-4 border-l-2 border-warning pl-3 text-[12.5px] text-warning">
          {state.label}
        </p>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
