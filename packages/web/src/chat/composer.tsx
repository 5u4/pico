import { ArrowUpIcon, FolderSimpleIcon, StopIcon } from "@phosphor-icons/react";
import { type FormEvent, type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import type { ComposerPresentation, SkillCompletionPresentation } from "./chat-model.ts";

interface CaretSelection {
  readonly start: number;
  readonly end: number;
}

export interface ComposerProps {
  readonly presentation: ComposerPresentation;
  readonly completion: SkillCompletionPresentation;
  readonly contextLabel?: string;
  readonly caretRequest: { readonly revision: number; readonly selection: CaretSelection } | null;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly onCompletionCommit: () => void;
  readonly onCompletionMove: (delta: -1 | 1) => void;
  readonly onCompletionDismiss: () => void;
  readonly onCaretChange: (selection: CaretSelection) => void;
}

export function Composer({
  presentation,
  completion,
  contextLabel,
  caretRequest,
  onValueChange,
  onSubmit,
  onStop,
  onCompletionCommit,
  onCompletionMove,
  onCompletionDismiss,
  onCaretChange,
}: ComposerProps) {
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const appliedCaretRequest = useRef<number>(-1);
  const completionOpen = completion.kind !== "closed";
  const statusLabel =
    completion.kind === "ready"
      ? "Enter to complete · Esc to close"
      : completionOpen
        ? "Esc to close"
        : presentation.statusLabel;

  useLayoutEffect(() => {
    if (caretRequest === null || appliedCaretRequest.current === caretRequest.revision) return;
    appliedCaretRequest.current = caretRequest.revision;
    const element = textarea.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(caretRequest.selection.start, caretRequest.selection.end);
    onCaretChange(caretRequest.selection);
  }, [caretRequest, onCaretChange]);

  const reportCaret = (element: HTMLTextAreaElement) => {
    onCaretChange({
      start: element.selectionStart,
      end: element.selectionEnd,
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!completionOpen && presentation.mode === "send" && presentation.canSubmit) {
      onSubmit();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composingEvent = composing.current || event.nativeEvent.isComposing;
    if (event.key === "Enter" && !event.shiftKey && !composingEvent && completionOpen) {
      event.preventDefault();
      onCompletionCommit();
      return;
    }

    if (!composingEvent && completionOpen && event.key === "ArrowDown") {
      event.preventDefault();
      onCompletionMove(1);
      return;
    }

    if (!composingEvent && completionOpen && event.key === "ArrowUp") {
      event.preventDefault();
      onCompletionMove(-1);
      return;
    }

    if (!composingEvent && completionOpen && event.key === "Escape") {
      event.preventDefault();
      onCompletionDismiss();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || composingEvent) {
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
        aria-activedescendant={
          completion.kind === "ready" ? completion.activeDescendantId : undefined
        }
        aria-autocomplete={completionOpen ? "list" : undefined}
        aria-controls={completionOpen ? completion.listboxId : undefined}
        aria-describedby="composer-status"
        className="composer-input block min-w-0 w-full resize-none bg-transparent px-2 py-2 text-base leading-5 text-foreground [overflow-wrap:anywhere] placeholder:text-subtle disabled:opacity-60 md:text-sm"
        disabled={!presentation.editable}
        id="chat-composer"
        name="message"
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
          reportCaret(event.currentTarget);
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onFocus={(event) => reportCaret(event.currentTarget)}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => reportCaret(event.currentTarget)}
        onSelect={(event) => reportCaret(event.currentTarget)}
        placeholder={presentation.placeholder}
        ref={textarea}
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
          title={statusLabel}
        >
          {statusLabel}
        </p>
        {presentation.mode === "send" ? (
          <Button
            aria-label="Send message"
            className="prompt-control prompt-send"
            disabled={completionOpen || !presentation.canSubmit}
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
