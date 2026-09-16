import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Markdown } from "./markdown.tsx";

type CopyState =
  | { readonly kind: "idle" }
  | { readonly kind: "copying" | "copied" | "failed"; readonly text: string };

export function ToolPayload({
  label,
  value,
  variant,
}: {
  readonly label: "Arguments" | "Output";
  readonly value: string | undefined;
  readonly variant: "inline" | "panel";
}) {
  const [format, setFormat] = useState<"source" | "markdown">("source");
  const [copyState, setCopyState] = useState<CopyState>({ kind: "idle" });
  const current = copyState.kind !== "idle" && copyState.text === value ? copyState.kind : "idle";
  const hasContent = value !== undefined && value !== "";
  const copy = async () => {
    if (!hasContent || copyState.kind === "copying") return;
    setCopyState({ kind: "copying", text: value });
    try {
      await navigator.clipboard.writeText(value);
      setCopyState({ kind: "copied", text: value });
    } catch {
      setCopyState({ kind: "failed", text: value });
    }
  };

  return (
    <section
      className={
        variant === "panel"
          ? "min-w-0 overflow-hidden rounded-card bg-panel text-[12.5px] leading-[1.65] shadow-card"
          : "min-w-0"
      }
    >
      <div
        className={`flex min-h-7 flex-wrap items-center gap-2 ${variant === "panel" ? "border-b border-border px-3 py-2" : ""}`}
      >
        <h3 className="mr-auto font-medium text-muted">{label}</h3>
        {hasContent && (
          <button
            aria-label={`Copy ${label.toLowerCase()}`}
            className={`flex min-h-7 items-center gap-1 rounded-chip px-1.5 text-[12px] font-medium transition-colors duration-100 hover:bg-surface-hover disabled:cursor-wait ${current === "copied" ? "text-success" : "text-muted hover:text-foreground"}`}
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
      <div className={variant === "panel" ? "p-3" : "pt-1"}>
        {label === "Output" && hasContent && (
          <div aria-label="Output format" className="mb-2 flex flex-wrap gap-1" role="group">
            <button
              aria-pressed={format === "source"}
              className={`min-h-7 rounded-chip px-2 text-[12px] font-medium transition-colors duration-100 hover:bg-surface-hover ${format === "source" ? "bg-field text-foreground shadow-hairline" : "text-muted"}`}
              onClick={() => setFormat("source")}
              type="button"
            >
              Source
            </button>
            <button
              aria-pressed={format === "markdown"}
              className={`min-h-7 rounded-chip px-2 text-[12px] font-medium transition-colors duration-100 hover:bg-surface-hover ${format === "markdown" ? "bg-field text-foreground shadow-hairline" : "text-muted"}`}
              onClick={() => setFormat("markdown")}
              type="button"
            >
              Markdown
            </button>
          </div>
        )}
        {value === undefined ? (
          <p className="text-muted">{label} unavailable</p>
        ) : value === "" ? (
          <p className="text-muted">Empty {label.toLowerCase()}</p>
        ) : (
          <div
            aria-label={label}
            className={
              variant === "inline" ? "max-h-64 overflow-auto overscroll-contain" : "min-w-0"
            }
            role="region"
            tabIndex={variant === "inline" ? 0 : undefined}
          >
            {label === "Output" && format === "markdown" ? (
              <Markdown className="text-foreground" text={value} />
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-muted [overflow-wrap:anywhere]">
                <code>{value}</code>
              </pre>
            )}
          </div>
        )}
        <p aria-live="polite" className="sr-only">
          {current === "copied" ? `${label} copied` : ""}
        </p>
        {current === "failed" && (
          <p className="mt-2 text-[12px] text-danger" role="alert">
            Could not copy {label.toLowerCase()}. Select the text and copy it manually.
          </p>
        )}
      </div>
    </section>
  );
}
