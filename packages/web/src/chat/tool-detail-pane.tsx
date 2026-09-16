import { XIcon } from "@phosphor-icons/react";
import type { ToolCallPresentation, ToolState } from "./chat-model.ts";
import { ToolPayload } from "./tool-payload.tsx";

export function ToolDetailPane({
  call,
  onClose,
}: {
  readonly call: ToolCallPresentation;
  readonly onClose: () => void;
}) {
  const statusClass = {
    running: "text-muted",
    succeeded: "text-subtle",
    failed: "text-danger",
    unknown: "text-muted",
  } satisfies Record<ToolState["kind"], string>;

  return (
    <section
      aria-labelledby="tool-detail-title"
      className="flex h-full min-h-0 min-w-0 flex-col bg-page"
    >
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3 sm:pl-4">
        <h2
          className="min-w-0 truncate text-[13px] font-semibold text-foreground"
          id="tool-detail-title"
          title={call.label}
        >
          {call.label}
        </h2>
        <button
          aria-label="Close tool details"
          className="flex size-6 shrink-0 items-center justify-center rounded-chip text-subtle transition-colors duration-100 hover:bg-surface-hover hover:text-foreground"
          data-tool-detail-close
          onClick={onClose}
          type="button"
        >
          <XIcon aria-hidden="true" size={13} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <div className="mb-4 space-y-1.5">
          <p className={`text-[12px] font-medium ${statusClass[call.state.kind]}`} role="status">
            {call.state.label}
          </p>
          <p className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-muted [overflow-wrap:anywhere]">
            {call.summary}
          </p>
        </div>
        <div className="space-y-4">
          <ToolPayload
            key={`${call.id}-arguments`}
            label="Arguments"
            value={call.arguments}
            variant="panel"
          />
          <ToolPayload
            key={`${call.id}-output`}
            label="Output"
            value={call.output}
            variant="panel"
          />
        </div>
      </div>
    </section>
  );
}
