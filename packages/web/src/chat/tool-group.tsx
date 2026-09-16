import {
  CaretDownIcon,
  CheckIcon,
  CircleNotchIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ToolCallPresentation, ToolState, TranscriptItem } from "./chat-model.ts";
import { ToolPayload } from "./tool-payload.tsx";

type PreviewPosition = {
  readonly left: number;
  readonly edge: "top" | "bottom";
  readonly offset: number;
};

export function ToolGroup({
  item,
  onDisclosuresChange,
  onToolSelect,
}: {
  readonly item: Extract<TranscriptItem, { readonly kind: "tool-group" }>;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
  readonly onToolSelect: (id: string | null) => void;
}) {
  const contentId = `${item.id}-content`;
  const triggerId = `${item.id}-trigger`;
  const failed = item.calls.some((call) => call.state.kind === "failed");
  return (
    <section className="min-w-0 w-full max-w-80 pb-1">
      <button
        aria-controls={contentId}
        aria-expanded={item.open}
        className="-mx-1.5 flex min-h-7 max-w-full items-center gap-1.5 rounded-control px-1.5 py-1 text-start text-[12.5px] text-muted transition-colors duration-100 hover:bg-surface-hover"
        id={triggerId}
        onClick={() =>
          onDisclosuresChange(
            item.calls.map((call) => call.id),
            !item.open,
          )
        }
        type="button"
      >
        <CaretDownIcon
          aria-hidden="true"
          className="tool-caret shrink-0"
          data-open={item.open}
          size={12}
        />
        {failed && (
          <WarningCircleIcon aria-hidden="true" className="shrink-0 text-danger" size={14} />
        )}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="tabular-nums">
            {item.calls.length === 1 ? "1 tool call" : `${item.calls.length} tool calls`}
          </span>
          <span className="text-[11.5px] text-subtle">{item.title}</span>
        </span>
      </button>
      <div
        aria-hidden={!item.open}
        aria-labelledby={triggerId}
        className="tool-expansion"
        data-open={item.open}
        id={contentId}
        inert={!item.open}
        role="region"
      >
        <div className="-mx-1 min-h-0 overflow-hidden px-1.5 pb-1">
          <div className="mt-1.5 flex flex-col gap-1">
            {item.calls.map((call, index) => (
              <ToolCall
                call={call}
                index={index}
                key={call.id}
                onDisclosuresChange={onDisclosuresChange}
                onToolSelect={onToolSelect}
                visible={item.open}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ToolCall({
  call,
  index,
  onDisclosuresChange,
  onToolSelect,
  visible,
}: {
  readonly call: ToolCallPresentation;
  readonly index: number;
  readonly onDisclosuresChange: (ids: readonly string[], open: boolean) => void;
  readonly onToolSelect: (id: string | null) => void;
  readonly visible: boolean;
}) {
  const detailsId = `details-${call.id}`;
  const contentId = `${detailsId}-content`;
  const triggerId = `${detailsId}-trigger`;
  const chipRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<PreviewPosition | null>(null);

  useEffect(() => {
    if (!visible) setPreview(null);
  }, [visible]);

  useEffect(() => {
    if (!preview || !visible) return;
    const dismiss = () => setPreview(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [preview, visible]);

  const openPreview = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    const below = rect.bottom + 172 <= window.innerHeight - 12;
    setPreview({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      edge: below ? "top" : "bottom",
      offset: below ? rect.bottom : window.innerHeight - rect.top,
    });
  };
  const leavePreview = (target: EventTarget | null) => {
    if (
      target instanceof Node &&
      (chipRef.current?.contains(target) || previewRef.current?.contains(target))
    )
      return;
    if (document.activeElement !== chipRef.current) setPreview(null);
  };
  const previewText = call.output ?? call.arguments ?? "Arguments unavailable";

  return (
    <div className={`min-w-0 ${visible ? "transcript-tool-enter" : ""}`}>
      <div className="-mx-[3px] flex min-h-7 min-w-0 items-center gap-2 px-[3px]">
        <button
          aria-controls={contentId}
          aria-expanded={call.open}
          className="group/row -ml-[3px] flex min-h-7 min-w-0 shrink-0 items-center gap-2 rounded-control px-[3px] text-start transition-colors duration-100 hover:bg-surface-hover"
          id={triggerId}
          onClick={() => onDisclosuresChange([detailsId], !call.open)}
          type="button"
        >
          <span
            className={`relative flex size-4 shrink-0 items-center justify-center ${toolStateClass(call.state)}`}
          >
            <span
              className={`flex transition-opacity duration-100 group-hover/row:opacity-0 ${call.open ? "opacity-0" : ""}`}
            >
              {toolStateIcon(call.state, visible && !call.open)}
            </span>
            <CaretDownIcon
              aria-hidden="true"
              className={`tool-caret absolute text-subtle transition-opacity duration-150 group-hover/row:opacity-100 ${call.open ? "opacity-100" : "opacity-0"}`}
              data-open={call.open}
              size={12}
            />
          </span>
          <span className="max-w-32 truncate text-[12.5px] font-medium text-foreground">
            {call.label}
          </span>
          <span className="sr-only">{call.state.label}</span>
        </button>
        <button
          aria-label={`Open tool details for ${call.label}`}
          className="flex min-h-7 min-w-0 flex-1 items-center rounded-chip text-start"
          onBlur={() => setPreview(null)}
          onClick={() => {
            setPreview(null);
            onToolSelect(call.id);
          }}
          onFocus={(event) => openPreview(event.currentTarget)}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") openPreview(event.currentTarget);
          }}
          onPointerLeave={(event) => leavePreview(event.relatedTarget)}
          ref={chipRef}
          type="button"
        >
          <span
            className={`inline-flex min-h-5.5 w-full min-w-0 items-center rounded-chip bg-field px-1.5 font-mono text-[11.5px] text-muted shadow-hairline transition-colors duration-100 hover:bg-surface-hover ${visible ? "tool-chip-enter" : ""}`}
            style={{ animationDelay: `${index * 80}ms` }}
          >
            <span className="truncate">{call.summary}</span>
          </span>
        </button>
      </div>
      <div
        aria-hidden={!call.open}
        aria-labelledby={triggerId}
        className="tool-expansion"
        data-open={call.open}
        id={contentId}
        inert={!call.open}
        role="region"
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mb-1 ml-2 mt-0.5 space-y-2 border-l border-border py-0.5 pl-3.5 text-[11.5px] leading-[1.6]">
            <p className={toolStateClass(call.state)}>{call.state.label}</p>
            <ToolPayload label="Arguments" value={call.arguments} variant="inline" />
            <ToolPayload label="Output" value={call.output} variant="inline" />
          </div>
        </div>
      </div>
      {preview &&
        visible &&
        createPortal(
          <div
            aria-hidden="true"
            className={`fixed z-50 w-72 max-w-[calc(100vw-24px)] ${preview.edge === "top" ? "pt-1.5" : "pb-1.5"}`}
            onPointerLeave={(event) => leavePreview(event.relatedTarget)}
            ref={previewRef}
            style={{
              left: preview.left,
              top: preview.edge === "top" ? preview.offset : undefined,
              bottom: preview.edge === "bottom" ? preview.offset : undefined,
            }}
          >
            <div
              className="tool-preview-enter overflow-hidden rounded-card bg-panel shadow-overlay"
              style={{ transformOrigin: preview.edge === "top" ? "top left" : "bottom left" }}
            >
              <div className="flex items-center justify-between gap-3 border-b border-border px-2.5 py-1.5 text-[11px]">
                <span className="min-w-0 truncate font-mono text-muted">{call.label}</span>
                <span className={`shrink-0 ${toolStateClass(call.state)}`}>{call.state.label}</span>
              </div>
              <pre className="line-clamp-6 whitespace-pre-wrap px-2.5 py-1 font-mono text-[11px] leading-[1.8] text-muted [overflow-wrap:anywhere]">
                {previewText === ""
                  ? call.output === undefined
                    ? "Empty arguments"
                    : "Empty output"
                  : previewText.slice(0, 1200)}
              </pre>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function toolStateClass(state: ToolState): string {
  switch (state.kind) {
    case "running":
      return "text-muted";
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

function toolStateIcon(state: ToolState, visible: boolean): ReactNode {
  switch (state.kind) {
    case "running":
      return (
        <CircleNotchIcon
          aria-hidden="true"
          className={visible ? "motion-safe:animate-[spin_700ms_linear_infinite]" : undefined}
          size={14}
        />
      );
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
