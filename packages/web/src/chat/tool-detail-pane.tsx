import { CheckIcon, CopyIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { ToolCallPresentation, ToolState } from "./chat-model.ts";

type CopyState =
  | { readonly kind: "idle" }
  | { readonly kind: "copying" | "copied" | "failed"; readonly text: string };

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
          <ToolPayload key={`${call.id}-arguments`} label="Arguments" value={call.arguments} />
          <ToolPayload key={`${call.id}-output`} label="Output" value={call.output} />
        </div>
      </div>
    </section>
  );
}

function ToolPayload({
  label,
  value,
}: {
  readonly label: "Arguments" | "Output";
  readonly value: string | undefined;
}) {
  const [copyState, setCopyState] = useState<CopyState>({ kind: "idle" });
  const current = copyState.kind !== "idle" && copyState.text === value ? copyState.kind : "idle";
  const copy = async () => {
    if (value === undefined || value === "" || copyState.kind === "copying") return;
    setCopyState({ kind: "copying", text: value });
    try {
      await navigator.clipboard.writeText(value);
      setCopyState({ kind: "copied", text: value });
    } catch {
      setCopyState({ kind: "failed", text: value });
    }
  };

  return (
    <section className="min-w-0 overflow-hidden rounded-card bg-panel shadow-card">
      <div className="flex min-h-11 items-center gap-2 border-b border-border px-3 text-[12.5px]">
        <h3 className="font-medium text-foreground">{label}</h3>
        {value !== undefined && value !== "" && (
          <button
            aria-label={`Copy ${label.toLowerCase()}`}
            className={`-mr-1 ml-auto flex min-h-6 items-center gap-1 rounded-chip px-1.5 text-[12px] font-medium transition-colors duration-100 hover:bg-surface-hover disabled:cursor-wait ${current === "copied" ? "text-success" : "text-subtle hover:text-foreground"}`}
            disabled={copyState.kind === "copying"}
            onClick={copy}
            type="button"
          >
            {current === "copied" ? (
              <CheckIcon aria-hidden="true" size={12} />
            ) : (
              <CopyIcon aria-hidden="true" size={12} />
            )}
            {current === "copying" ? "Copying" : current === "copied" ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {value === undefined ? (
        <p className="px-3 py-3 text-[12.5px] text-muted">{label} unavailable</p>
      ) : value === "" ? (
        <p className="px-3 py-3 text-[12.5px] text-muted">Empty {label.toLowerCase()}</p>
      ) : (
        <pre className="whitespace-pre-wrap px-3 py-3 font-mono text-[12.5px] leading-[1.65] text-muted [overflow-wrap:anywhere]">
          <code>{value}</code>
        </pre>
      )}
      <p aria-live="polite" className="sr-only">
        {current === "copied" ? `${label} copied` : ""}
      </p>
      {current === "failed" && (
        <p className="px-3 pb-3 text-[12px] text-danger" role="alert">
          Could not copy {label.toLowerCase()}. Select the text and copy it manually.
        </p>
      )}
    </section>
  );
}
