import {
  CaretDownIcon,
  CheckIcon,
  CircleNotchIcon,
  WarningCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ToolCallPresentation, ToolState, TranscriptItem } from "./chat-model.ts";

export function ToolGroup({
  item,
  onDisclosuresChange,
}: {
  readonly item: Extract<TranscriptItem, { readonly kind: "tool-group" }>;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
}) {
  const contentId = `${item.id}-content`;
  const triggerId = `${item.id}-trigger`;
  const failed = item.calls.some((call) => call.state.kind === "failed");
  return (
    <section>
      <button
        aria-controls={contentId}
        aria-expanded={item.open}
        className="trace-disclosure flex max-w-full items-center gap-2 px-1.5 py-1 text-start text-label font-medium text-muted"
        id={triggerId}
        onClick={() =>
          onDisclosuresChange(
            item.calls.map((call) => call.id),
            !item.open,
          )
        }
        type="button"
      >
        {failed ? (
          <WarningCircleIcon aria-hidden="true" className="shrink-0 text-danger" size={16} />
        ) : (
          <WrenchIcon aria-hidden="true" className="shrink-0 text-subtle" size={16} />
        )}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span>{item.calls.length === 1 ? "1 tool call" : `${item.calls.length} tool calls`}</span>
          <span className="text-meta font-normal text-subtle">{item.title}</span>
        </span>
        <CaretDownIcon
          aria-hidden="true"
          className={`trace-caret ${item.open ? "disclosure-caret-open" : ""}`}
          size={14}
        />
      </button>
      <div
        aria-labelledby={triggerId}
        className="trace-body mt-1 space-y-0.5 py-1"
        hidden={!item.open}
        id={contentId}
        role="region"
      >
        {item.calls.map((call) => (
          <ToolCall call={call} key={call.id} onDisclosuresChange={onDisclosuresChange} />
        ))}
      </div>
    </section>
  );
}

function ToolCall({
  call,
  onDisclosuresChange,
}: {
  readonly call: ToolCallPresentation;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
}) {
  const detailsId = `details-${call.id}`;
  const contentId = `${detailsId}-content`;
  const triggerId = `${detailsId}-trigger`;
  return (
    <div className="min-w-0">
      <button
        aria-controls={contentId}
        aria-expanded={call.open}
        className="trace-disclosure grid w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto_0.875rem] items-start gap-x-2 px-1.5 py-1.5 text-start text-label"
        id={triggerId}
        onClick={() => onDisclosuresChange([detailsId], !call.open)}
        type="button"
      >
        <span className={`mt-0.5 ${toolStateClass(call.state)}`}>{toolStateIcon(call.state)}</span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="break-words font-medium text-foreground">{call.label}</span>
          <span className="min-w-0 max-w-full truncate text-muted">{call.summary}</span>
        </span>
        <span className={`pt-0.5 text-meta ${toolStateClass(call.state)}`}>{call.state.label}</span>
        <CaretDownIcon
          aria-hidden="true"
          className={`trace-caret mt-0.5 ${call.open ? "disclosure-caret-open" : ""}`}
          size={14}
        />
      </button>
      <div
        aria-labelledby={triggerId}
        className="ms-6 min-w-0 space-y-3 py-2 pe-1.5 text-label"
        hidden={!call.open}
        id={contentId}
        role="region"
      >
        <div>
          <p className="mb-1 text-meta font-medium text-subtle">Arguments</p>
          {call.arguments === undefined ? (
            <p className="text-muted">Arguments unavailable</p>
          ) : call.arguments === "" ? (
            <p className="text-muted">Empty arguments</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-label text-muted">
              {call.arguments}
            </pre>
          )}
        </div>
        <div>
          <p className="mb-1 text-meta font-medium text-subtle">Output</p>
          {call.output === undefined ? (
            <p className="text-muted">Output unavailable</p>
          ) : call.output === "" ? (
            <p className="text-muted">Empty output</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-label text-foreground">
              {call.output}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function toolStateClass(state: ToolState): string {
  switch (state.kind) {
    case "running":
      return "text-accent";
    case "succeeded":
      return "text-subtle";
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
      return <CheckIcon aria-hidden="true" size={14} />;
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
