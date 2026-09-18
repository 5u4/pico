import { CaretDown } from "@phosphor-icons/react";
import { useId, useLayoutEffect, useRef } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import type { ModelPickerPresentation } from "./chat-model.ts";

interface ModelPickerProps {
  readonly presentation: ModelPickerPresentation;
  readonly onOpen: () => void;
  readonly onSelect: (value: string) => void;
  readonly onRetry: () => void;
}

export function ModelPicker({ presentation, onOpen, onSelect, onRetry }: ModelPickerProps) {
  const id = useId();
  const select = useRef<HTMLButtonElement>(null);
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

  return (
    <div className="min-w-0 flex-1" ref={container}>
      {control.kind === "draft" ? (
        <button
          className="inline-flex min-h-8 max-w-full min-w-0 items-center gap-1 rounded-control bg-transparent px-2 text-caption text-muted hover:bg-surface-hover hover:text-foreground"
          onClick={() => {
            focusWhenReady.current = true;
            onOpen();
          }}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate text-left">{presentation.label}</span>
          <CaretDown aria-hidden="true" className="size-3.5 shrink-0" />
        </button>
      ) : (
        <>
          <label className="sr-only" htmlFor={id}>
            Model for this chat
          </label>
          <Select
            disabled={control.kind === "disabled"}
            key={control.kind}
            onValueChange={(value) => {
              focusWhenReady.current = true;
              onSelect(value);
            }}
            value={control.kind === "select" ? control.value : ""}
          >
            <SelectTrigger
              aria-describedby={`${id}-status`}
              aria-invalid={feedback.kind === "error" || undefined}
              id={id}
              ref={select}
              title={presentation.label}
            >
              <SelectValue placeholder={presentation.label}>
                {control.kind === "select" && control.value !== "" ? presentation.label : undefined}
              </SelectValue>
            </SelectTrigger>
            {control.kind === "select" && (
              <SelectContent align="start" side="top" sideOffset={4}>
                {control.value !== "" &&
                  !control.options.some((option) => option.value === control.value) && (
                    <SelectItem disabled value={control.value}>
                      {presentation.label}
                    </SelectItem>
                  )}
                {control.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            )}
          </Select>
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
