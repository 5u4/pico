import { useId, useLayoutEffect, useRef } from "react";
import type { ContextUsagePresentation } from "./chat-model.ts";

interface ContextUsageProps {
  readonly presentation: ContextUsagePresentation;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ContextUsage({ presentation, open, onOpenChange }: ContextUsageProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const position = () => {
    const button = trigger.current;
    const element = card.current;
    if (!button || !element) return;
    const bounds = button.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const width = Number.parseFloat(getComputedStyle(element).width);
    element.style.right = `${Math.max(12, Math.min(viewportWidth - bounds.right, viewportWidth - width - 12))}px`;
    element.style.bottom = `${window.innerHeight - bounds.top + 8}px`;
    element.style.maxHeight = `${Math.max(0, bounds.top - 20)}px`;
  };

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    if (open) {
      position();
      element.showPopover();
      window.addEventListener("resize", position);
      window.addEventListener("scroll", position, true);
      return () => {
        window.removeEventListener("resize", position);
        window.removeEventListener("scroll", position, true);
      };
    }
    element.hidePopover();
  }, [open]);

  return (
    <div className="mt-1 flex justify-end">
      <button
        aria-controls={id}
        aria-expanded={open}
        aria-label={presentation.label}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-control px-2 text-caption tabular-nums text-muted hover:bg-surface-hover hover:text-foreground"
        popoverTarget={id}
        ref={trigger}
        type="button"
      >
        <svg aria-hidden="true" className="size-4 shrink-0" viewBox="0 0 20 20">
          <circle
            className="text-border-strong"
            cx="10"
            cy="10"
            fill="none"
            r="7"
            stroke="currentColor"
            strokeWidth="2"
          />
          {presentation.kind === "available" && (
            <circle
              cx="10"
              cy="10"
              fill="none"
              pathLength="1"
              r="7"
              stroke="currentColor"
              strokeDasharray={`${presentation.fraction} 1`}
              strokeWidth="2"
              transform="rotate(-90 10 10)"
            />
          )}
        </svg>
        <span>
          {presentation.kind === "available"
            ? presentation.percentage
            : presentation.kind === "loading"
              ? "..."
              : "N/A"}
        </span>
      </button>
      <div
        aria-labelledby={`${id}-title`}
        className="fixed inset-auto m-0 w-[min(20rem,calc(100vw-24px))] overflow-y-auto overscroll-contain rounded-card border-0 bg-panel p-4 text-label text-foreground shadow-overlay"
        id={id}
        onBeforeToggle={(event) => {
          if (event.newState === "open") position();
          else if (card.current?.contains(document.activeElement)) trigger.current?.focus();
        }}
        onToggle={(event) => {
          const next = event.newState === "open";
          if (next !== open) onOpenChange(next);
        }}
        popover="auto"
        ref={card}
        role="region"
        tabIndex={0}
      >
        <h2 className="font-medium" id={`${id}-title`}>
          Context window
        </h2>
        {presentation.kind === "available" && (
          <>
            <p className="mt-3 tabular-nums">
              <span className="font-medium">{presentation.used}</span>
              <span className="text-muted"> / {presentation.capacity} tokens used</span>
            </p>
            <p className="mt-1 text-caption tabular-nums text-muted">
              {presentation.remaining} tokens remaining
            </p>
            <dl className="mt-4 space-y-2 border-t border-border-soft pt-3">
              {presentation.categories.map((category) => (
                <div className="flex justify-between gap-4" key={category.label}>
                  <dt className="text-muted">{category.label}</dt>
                  <dd className="tabular-nums">{category.tokens}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <p className="mt-3 text-caption leading-relaxed text-muted">{presentation.description}</p>
      </div>
    </div>
  );
}
