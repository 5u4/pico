import { ArrowUpIcon, FolderSimpleIcon, StopIcon, XIcon } from "@phosphor-icons/react";
import { type FormEvent, type KeyboardEvent, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import type { ComposerPresentation } from "./chat-model.ts";

export interface ComposerProps {
  readonly presentation: ComposerPresentation;
  readonly contextLabel?: string;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly onImageRemove: (id: string) => void;
}

export function Composer({
  presentation,
  contextLabel,
  onValueChange,
  onSubmit,
  onStop,
  onImageRemove,
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
      {presentation.images.length > 0 && (
        <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-2 pt-2">
          {presentation.images.map((image) => (
            <li className="group relative" key={image.id}>
              <img
                alt={image.name}
                className="size-14 rounded-control border border-border object-cover"
                src={`data:${image.mimeType};base64,${image.data}`}
              />
              <button
                aria-label={`Remove ${image.name}`}
                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-border bg-panel text-subtle transition-colors hover:text-foreground"
                disabled={!presentation.editable}
                onClick={() => onImageRemove(image.id)}
                type="button"
              >
                <XIcon aria-hidden="true" size={11} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      )}
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
