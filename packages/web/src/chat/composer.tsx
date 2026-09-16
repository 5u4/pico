import { ArrowUpIcon, FolderSimpleIcon, StopIcon } from "@phosphor-icons/react";
import { type FormEvent, type KeyboardEvent, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import type { ComposerPresentation } from "./chat-model.ts";

export interface ComposerProps {
  readonly presentation: ComposerPresentation;
  readonly contextLabel?: string;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
}

export function Composer({
  presentation,
  contextLabel,
  onValueChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  const composing = useRef(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (presentation.mode === "send" && presentation.canSubmit) {
      onSubmit();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      composing.current ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    event.preventDefault();
    if (presentation.mode === "send" && presentation.canSubmit) {
      onSubmit();
    }
  };

  return (
    <form
      className="composer relative isolate flex w-full flex-col gap-1.5 overflow-hidden border border-border bg-panel shadow-card"
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor="chat-composer">
        Message pico
      </label>
      <textarea
        aria-describedby="composer-status"
        className="composer-input block min-w-0 w-full resize-none bg-transparent px-2 py-2 text-base leading-5 text-foreground [overflow-wrap:anywhere] placeholder:text-subtle disabled:opacity-60 md:text-sm"
        disabled={!presentation.editable}
        id="chat-composer"
        name="message"
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onKeyDown={handleKeyDown}
        placeholder={presentation.placeholder}
        rows={1}
        value={presentation.value}
      />
      <div className="composer-toolbar flex min-h-7 items-center gap-1.5">
        {contextLabel && (
          <span
            className="flex min-w-0 max-w-[45%] items-center gap-1.5 px-1.5 text-meta text-muted"
            title={contextLabel}
          >
            <FolderSimpleIcon aria-hidden="true" className="shrink-0" size={14} />
            <span className="truncate">{contextLabel}</span>
          </span>
        )}
        <p
          aria-atomic="true"
          className="min-w-0 flex-1 truncate px-1.5 text-meta text-subtle"
          id="composer-status"
          role="status"
          title={presentation.statusLabel}
        >
          {presentation.statusLabel}
        </p>
        {presentation.mode === "send" ? (
          <Button
            aria-label="Send message"
            className="prompt-control prompt-send"
            disabled={!presentation.canSubmit}
            size="icon"
            tone="primary"
            type="submit"
          >
            <ArrowUpIcon aria-hidden="true" size={16} weight="bold" />
          </Button>
        ) : (
          <Button
            aria-label="Stop response"
            className="prompt-control"
            disabled={!presentation.canStop}
            onClick={onStop}
            size="icon"
            tone="danger"
            type="button"
          >
            <StopIcon aria-hidden="true" size={14} weight="fill" />
          </Button>
        )}
      </div>
    </form>
  );
}
