import { useId, useLayoutEffect, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import type { CloseChatPresentation } from "./chat-model.ts";

export function CloseChatDialog({
  confirmation,
  onConfirm,
  onClose,
  onFocusFallback,
}: {
  readonly confirmation: Extract<CloseChatPresentation, { readonly kind: "confirmation" }>;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly onFocusFallback: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fallback = useRef(onFocusFallback);
  fallback.current = onFocusFallback;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const origin = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      const restoreFocus =
        dialog.contains(document.activeElement) || document.activeElement === document.body;
      dialog.close();
      if (!restoreFocus) return;
      queueMicrotask(() => {
        if (document.activeElement !== document.body && document.activeElement !== origin) return;
        if (
          origin instanceof HTMLElement &&
          origin.isConnected &&
          origin.getClientRects().length > 0
        ) {
          origin.focus({ preventScroll: true });
        } else fallback.current();
      });
    };
  }, []);

  return (
    <dialog
      aria-describedby={`${id}-description ${id}-warning`}
      aria-labelledby={`${id}-title`}
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto overscroll-contain rounded-surface border border-border bg-panel p-6 text-foreground shadow-composer backdrop:bg-overlay"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <h2 className="text-title font-semibold" id={`${id}-title`}>
        Remove chat worktree?
      </h2>
      <p className="mt-2 break-words text-label font-medium">{confirmation.title}</p>
      <p className="break-words text-label text-muted">{confirmation.workspaceName}</p>
      <p className="mt-4 text-label text-muted" id={`${id}-description`}>
        Closing archives this chat and removes its managed worktree. The chat may already be
        archived. Keeping the worktree does not reopen it.
      </p>
      <p className="mt-3 text-label text-danger" id={`${id}-warning`}>
        Force removal can discard uncommitted changes and nested repositories. Local and remote
        branches are retained.
      </p>
      {confirmation.warning && (
        <p className="mt-3 text-label text-danger" role="alert">
          {confirmation.warning}
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button onClick={onClose} tone="secondary">
          Keep worktree
        </Button>
        <Button disabled={!confirmation.canConfirm} onClick={onConfirm} tone="danger">
          Remove worktree
        </Button>
      </div>
    </dialog>
  );
}
