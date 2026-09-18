import { useId, useLayoutEffect, useRef } from "react";
import type { ModelPickerPresentation } from "./chat-model.ts";

interface ModelPickerProps {
  readonly presentation: ModelPickerPresentation;
  readonly onOpen: () => void;
  readonly onSelect: (value: string) => void;
  readonly onRetry: () => void;
}

export function ModelPicker({ presentation, onOpen, onSelect, onRetry }: ModelPickerProps) {
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const focusWhenReady = useRef(false);
  const { control, feedback } = presentation;

  useLayoutEffect(() => {
    if (focusWhenReady.current && control.kind === "select") {
      if (
        document.activeElement === document.body ||
        container.current?.contains(document.activeElement)
      ) {
        select.current?.focus();
      }
      focusWhenReady.current = false;
    }
  }, [control.kind]);

  const classes =
    "min-h-8 max-w-full rounded-control bg-transparent px-2 text-caption text-muted hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed";
  return (
    <div className="min-w-0 flex-1" ref={container}>
      {control.kind === "draft" ? (
        <button
          className={classes}
          onClick={() => {
            focusWhenReady.current = true;
            onOpen();
          }}
          type="button"
        >
          {presentation.label}
        </button>
      ) : (
        <>
          <label className="sr-only" htmlFor={id}>
            Model for this chat
          </label>
          <select
            aria-describedby={`${id}-status`}
            aria-invalid={feedback.kind === "error" || undefined}
            className={classes}
            disabled={control.kind === "disabled"}
            id={id}
            onChange={(event) => {
              focusWhenReady.current = true;
              onSelect(event.currentTarget.value);
            }}
            ref={select}
            title={presentation.label}
            value={control.kind === "select" ? control.value : ""}
          >
            {control.kind === "select" ? (
              <>
                {!control.options.some((option) => option.value === control.value) && (
                  <option disabled value={control.value}>
                    {presentation.label}
                  </option>
                )}
                {control.options.map((option) => (
                  <option
                    className="bg-panel text-foreground"
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </>
            ) : (
              <option value="">{presentation.label}</option>
            )}
          </select>
        </>
      )}
      <div className="px-2 text-caption" id={`${id}-status`} role="status">
        {control.kind === "disabled" && <p className="text-subtle">{control.reason}</p>}
        {feedback.kind === "warning" && <p className="text-warning">{feedback.message}</p>}
        {feedback.kind === "error" && (
          <div className="flex flex-wrap items-baseline gap-x-2 text-danger">
            <p>{feedback.message}</p>
            <button
              className="min-h-8 rounded-control px-1 underline underline-offset-2 disabled:opacity-50"
              disabled={feedback.retry === "disabled"}
              onClick={() => {
                focusWhenReady.current = true;
                onRetry();
              }}
              type="button"
            >
              Retry model selection
            </button>
            {feedback.warning !== null && <p className="w-full text-warning">{feedback.warning}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
