import { ArrowUpIcon, StopIcon } from "@phosphor-icons/react";
import { type FormEvent, type KeyboardEvent, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import type { ComposerPresentation } from "./chat-model.ts";

export interface ComposerProps {
  readonly presentation: ComposerPresentation;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
}

export function Composer({ presentation, onValueChange, onSubmit, onStop }: ComposerProps) {
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
      className="composer rounded-surface border border-border-strong bg-panel shadow-composer"
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor="chat-composer">
        Message pico
      </label>
      <textarea
        aria-describedby="composer-status"
        className="composer-input block w-full resize-none bg-transparent px-4 pb-2 pt-3 text-base text-foreground placeholder:text-subtle disabled:opacity-60 md:text-copy"
        disabled={!presentation.editable}
        id="chat-composer"
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onKeyDown={handleKeyDown}
        placeholder={presentation.placeholder}
        value={presentation.value}
      />
      <div className="flex min-h-11 items-center gap-3 px-3 pb-3">
        <p className="min-w-0 flex-1 text-meta text-muted" id="composer-status">
          {presentation.statusLabel}
        </p>
        {presentation.mode === "send" ? (
          <Button
            aria-label="Send message"
            disabled={!presentation.canSubmit}
            size="icon"
            tone="primary"
            type="submit"
          >
            <ArrowUpIcon aria-hidden="true" size={18} weight="bold" />
          </Button>
        ) : (
          <Button
            aria-label="Stop response"
            disabled={!presentation.canStop}
            onClick={onStop}
            size="icon"
            tone="danger"
            type="button"
          >
            <StopIcon aria-hidden="true" size={17} weight="fill" />
          </Button>
        )}
      </div>
    </form>
  );
}
