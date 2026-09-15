import {
  CaretDownIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ToolCallPresentation, ToolState, TranscriptItem } from "./chat-model.ts";

export function ToolGroup({
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
      <span className="mt-0.5 text-muted">
        <WrenchIcon aria-hidden="true" size={16} />
      </span>
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

function toolStateClass(state: ToolState): string {
  switch (state.kind) {
    case "running":
      return "text-accent";
    case "succeeded":
      return "text-success";
    case "failed":
      return "text-danger";
    case "unknown":
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
    case "unknown":
      return <WarningCircleIcon aria-hidden="true" size={14} />;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
