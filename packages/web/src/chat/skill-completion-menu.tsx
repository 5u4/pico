import { useLayoutEffect, useRef } from "react";
import type { SkillCompletionPresentation } from "./chat-model.ts";

interface SkillCompletionMenuProps {
  readonly presentation: SkillCompletionPresentation;
  readonly onSelect: (name: string) => void;
  readonly onRetry: () => void;
}

export function SkillCompletionMenu({ presentation, onSelect, onRetry }: SkillCompletionMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const activeId = presentation.kind === "ready" ? presentation.activeDescendantId : null;
  const open = presentation.kind !== "closed";
  useLayoutEffect(() => {
    const element = menu.current;
    if (!open || !element) return;
    const measure = () => {
      let top = window.visualViewport?.offsetTop ?? 0;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/u.test(getComputedStyle(parent).overflowY)) {
          top = Math.max(top, parent.getBoundingClientRect().top);
        }
      }
      element.style.maxHeight = `${Math.max(0, element.getBoundingClientRect().bottom - top - 8)}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (let parent = element.parentElement?.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent);
    }
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("animationend", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("animationend", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [open, presentation]);
  useLayoutEffect(() => {
    if (activeId === null) return;
    const option = menu.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const list = option?.parentElement;
    if (!option || !list) return;
    const row = option.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }, [activeId]);

  return (
    <>
      <span aria-atomic="true" className="sr-only" role="status">
        {presentation.kind === "closed"
          ? ""
          : presentation.kind === "ready"
            ? `${presentation.options.length} skills available. Use arrow keys to choose, Enter to complete, Escape to dismiss.`
            : presentation.message}
      </span>
      {presentation.kind !== "closed" && (
        <div
          className="skill-completion flex flex-col overflow-hidden rounded-card border border-border bg-panel shadow-overlay"
          ref={menu}
        >
          <div className="shrink-0 px-3 pt-2 text-meta text-muted">Skills</div>
          <ul
            aria-label="Skill commands"
            className="min-h-0 max-h-56 overflow-y-auto overscroll-contain p-1"
            id={presentation.listboxId}
            role="listbox"
          >
            {presentation.kind === "ready" &&
              presentation.options.map((option) => (
                <li
                  aria-selected={option.selected}
                  className={
                    option.selected
                      ? "skill-completion-option skill-completion-option-active"
                      : "skill-completion-option"
                  }
                  id={option.id}
                  key={option.id}
                  role="option"
                >
                  <button
                    className="w-full text-left"
                    onClick={() => onSelect(option.name)}
                    onMouseDown={(event) => event.preventDefault()}
                    tabIndex={-1}
                    title={`/${option.name}\n${option.description}`}
                    type="button"
                  >
                    <span className="block break-words font-mono text-[12px] text-foreground">
                      /{option.name}
                    </span>
                    <span className="mt-0.5 block break-words text-[12px] text-muted">
                      {option.description}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          {presentation.kind !== "ready" && (
            <div className="skill-completion-status min-h-0 overflow-y-auto">
              <p
                className={
                  presentation.kind === "error"
                    ? "text-[12px] text-danger"
                    : "text-[12px] text-muted"
                }
              >
                {presentation.message}
              </p>
              {presentation.kind === "error" && (
                <button
                  className="mt-1.5 rounded-chip px-1.5 py-1 text-[12px] underline underline-offset-2 disabled:opacity-50"
                  disabled={presentation.retry === "disabled"}
                  onClick={onRetry}
                  onMouseDown={(event) => event.preventDefault()}
                  type="button"
                >
                  Retry skill catalog
                </button>
              )}
            </div>
          )}
          <p
            aria-hidden="true"
            className="shrink-0 border-t border-border px-3 py-1.5 text-meta text-muted"
          >
            ↑↓ Choose · Enter Complete · Esc Close
          </p>
        </div>
      )}
    </>
  );
}
