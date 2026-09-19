import { GitBranchIcon, XIcon } from "@phosphor-icons/react";
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { HistoryPanelPresentation } from "./chat-model.ts";

interface HistoryPaneProps {
  readonly presentation: HistoryPanelPresentation;
  readonly onClose: () => void;
  readonly onQueryChange: (query: string) => void;
  readonly onRevealAllChange: (revealAll: boolean) => void;
  readonly onPreviewSelect: (targetId: string) => void;
  readonly onContinue: () => void;
  readonly onRestoreDraft: () => void;
}

export function HistoryPaneShell({
  presentation,
  onClose,
  onQueryChange,
  onRevealAllChange,
  onPreviewSelect,
  onContinue,
  onRestoreDraft,
  returnFocus,
  fallbackFocus,
}: HistoryPaneProps & {
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly fallbackFocus: RefObject<HTMLDivElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const desktop = window.matchMedia("(min-width: 64rem)");
    const present = () => {
      if (dialog.open) dialog.close();
      if (desktop.matches) dialog.show();
      else dialog.showModal();
      dialog.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    };
    present();
    desktop.addEventListener("change", present);
    return () => {
      desktop.removeEventListener("change", present);
      const restoreFocus = dialog.contains(document.activeElement);
      if (dialog.open) dialog.close();
      if (!restoreFocus) return;
      queueMicrotask(() => {
        if (dialog.isConnected && dialog.open) return;
        const origin = returnFocus.current;
        const target = [origin, fallbackFocus.current].find(
          (element) =>
            element?.isConnected &&
            element.getClientRects().length > 0 &&
            !element.closest("[inert]"),
        );
        target?.focus({ preventScroll: true });
      });
    };
  }, [returnFocus, fallbackFocus]);

  return (
    <dialog
      aria-label="History and branches"
      className="fixed inset-0 z-30 m-0 h-dvh max-h-none w-dvw max-w-none overflow-hidden border-0 bg-page p-0 text-foreground shadow-overlay backdrop:bg-overlay lg:static lg:z-auto lg:h-full lg:w-[420px] lg:shrink-0 lg:rounded-window lg:border lg:border-border lg:shadow-none"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (!window.matchMedia("(min-width: 64rem)").matches) return;
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <HistoryPane
        onClose={onClose}
        onContinue={onContinue}
        onPreviewSelect={onPreviewSelect}
        onQueryChange={onQueryChange}
        onRestoreDraft={onRestoreDraft}
        onRevealAllChange={onRevealAllChange}
        presentation={presentation}
      />
    </dialog>
  );
}

function HistoryPane({
  presentation,
  onClose,
  onQueryChange,
  onRevealAllChange,
  onPreviewSelect,
  onContinue,
  onRestoreDraft,
}: HistoryPaneProps) {
  const continueLabel = presentation.busy ? "Continuing..." : "Continue from preview";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-title font-semibold">
          <GitBranchIcon aria-hidden="true" size={18} />
          History and branches
        </h2>
        <button
          aria-label="Close history and branches"
          className="grid size-8 place-items-center rounded-control text-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
          onClick={onClose}
          type="button"
        >
          <XIcon aria-hidden="true" size={14} weight="bold" />
        </button>
      </header>
      <div className="border-b border-border px-4 py-3">
        <label className="mb-1.5 block text-label text-muted" htmlFor="history-search">
          Search conversation history
        </label>
        <input
          className="block w-full rounded-control border border-border-strong bg-canvas px-3 py-2 text-base text-foreground placeholder:text-subtle"
          id="history-search"
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search messages and branches"
          spellCheck={false}
          type="text"
          value={presentation.query}
        />
        <button
          aria-pressed={presentation.revealAll}
          className="mt-2 inline-flex min-h-8 items-center rounded-control px-2 text-label text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          onClick={() => onRevealAllChange(!presentation.revealAll)}
          type="button"
        >
          {presentation.revealAll ? "Showing all entries" : "Showing messages and branch points"}
        </button>
      </div>
      {presentation.error && (
        <p className="border-b border-border px-4 py-3 text-label text-danger" role="alert">
          {presentation.error}
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="flex min-h-0 flex-col border-b border-border">
          <h3 className="shrink-0 px-4 pb-2 pt-3 text-label font-medium text-muted">Branches</h3>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
            {presentation.loading ? (
              <p className="px-2 py-4 text-label text-muted" role="status">
                Loading history...
              </p>
            ) : presentation.items.length === 0 ? (
              <p className="px-2 py-4 text-label text-muted">No matching history entries.</p>
            ) : (
              <ul className="space-y-1">
                {presentation.items.map((item) => (
                  <li key={item.id} style={{ paddingInlineStart: `${item.depth * 0.75}rem` }}>
                    <button
                      aria-current={item.active ? "true" : undefined}
                      className={`w-full rounded-control border px-3 py-2 text-left transition-colors ${item.preview ? "border-accent bg-surface-hover" : "border-transparent hover:bg-surface-hover"}`}
                      onClick={() => onPreviewSelect(item.targetId)}
                      type="button"
                    >
                      <p className="flex items-center gap-2 text-meta text-muted">
                        <span>{item.kindLabel}</span>
                        <span>{item.timestampLabel}</span>
                      </p>
                      <p className="mt-0.5 text-label font-medium text-foreground [overflow-wrap:anywhere]">
                        {item.label}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-meta text-muted [overflow-wrap:anywhere]">
                        {item.excerpt}
                      </p>
                      <p className="mt-1.5 flex flex-wrap gap-1 text-[11px] font-medium text-subtle">
                        {item.active && (
                          <span className="rounded-chip bg-field px-1.5 py-0.5">
                            Current target
                          </span>
                        )}
                        {item.preview && (
                          <span className="rounded-chip bg-field px-1.5 py-0.5">
                            Preview target
                          </span>
                        )}
                        {item.matched && (
                          <span className="rounded-chip bg-field px-1.5 py-0.5">Search match</span>
                        )}
                        {!item.visibleByDefault && (
                          <span className="rounded-chip bg-field px-1.5 py-0.5">
                            Hidden by default
                          </span>
                        )}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className="flex min-h-0 flex-col">
          <h3 className="px-4 pb-2 pt-3 text-label font-medium text-muted">Preview</h3>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
            {presentation.preview.kind === "idle" && (
              <p className="text-label text-muted" role="status">
                {presentation.preview.label}
              </p>
            )}
            {presentation.preview.kind === "loading" && (
              <p className="text-label text-muted" role="status">
                {presentation.preview.label}
              </p>
            )}
            {presentation.preview.kind === "error" && (
              <p className="text-label text-danger" role="alert">
                {presentation.preview.label}
              </p>
            )}
            {presentation.preview.kind === "ready" && (
              <>
                <p className="mb-2 text-meta text-muted">{presentation.preview.destinationLabel}</p>
                <div className="space-y-2">
                  {presentation.preview.blocks.map((block) => (
                    <article
                      className="rounded-card border border-border bg-panel p-3"
                      key={block.id}
                    >
                      <h4 className="text-meta font-medium text-muted">{block.label}</h4>
                      <p className="mt-1 whitespace-pre-wrap text-label text-foreground [overflow-wrap:anywhere]">
                        {block.text.length > 0 ? block.text : "(No text)"}
                      </p>
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="shrink-0 border-t border-border px-4 py-3">
            <p className="mb-2 text-meta text-muted">
              Conversation navigation does not undo files you changed or commands you already ran.
            </p>
            {presentation.hasRecoveredDraft && (
              <button
                className="mb-2 inline-flex min-h-8 items-center rounded-control border border-border px-2.5 text-label text-foreground transition-colors hover:bg-surface-hover"
                onClick={onRestoreDraft}
                type="button"
              >
                Replace draft with recovered draft
              </button>
            )}
            <button
              className="inline-flex min-h-9 w-full items-center justify-center rounded-control bg-accent px-3 text-label font-medium text-inverse transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={
                !presentation.canContinue ||
                presentation.busy ||
                presentation.previewTargetId === null
              }
              onClick={onContinue}
              type="button"
            >
              {continueLabel}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
