import { useId, useLayoutEffect, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import type { DeleteWorkspacePresentation } from "./chat-model.ts";

export function DeleteWorkspaceDialog({
  confirmation,
  origin,
  onConfirm,
  onClose,
  onFocusFallback,
}: {
  readonly confirmation: DeleteWorkspacePresentation;
  readonly origin: HTMLElement | null;
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
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      const restoreFocus =
        dialog.contains(document.activeElement) || document.activeElement === document.body;
      dialog.close();
      if (!restoreFocus) return;
      queueMicrotask(() => {
        if (document.activeElement !== document.body && document.activeElement !== origin) return;
        if (origin?.isConnected && origin.getClientRects().length > 0) {
          origin.focus({ preventScroll: true });
        } else fallback.current();
      });
    };
  }, [origin]);

  return (
    <dialog
      aria-describedby={`${id}-description`}
      aria-labelledby={`${id}-title`}
      aria-busy={confirmation.pending}
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto overscroll-contain rounded-surface border border-border bg-panel p-6 text-foreground shadow-composer backdrop:bg-overlay"
      onCancel={(event) => {
        event.preventDefault();
        if (!confirmation.pending) onClose();
      }}
      ref={dialogRef}
    >
      <h2 className="text-title font-semibold" id={`${id}-title`}>
        Delete workspace?
      </h2>
      <p className="mt-2 break-words text-label font-medium">{confirmation.workspaceName}</p>
      <p className="mt-4 text-label text-muted" id={`${id}-description`}>
        This removes the workspace from pico. Chats, session history, worktrees, and project files
        stay on disk. There is no restore option in pico.
      </p>
      <p className="mt-3 text-label text-muted">
        All chats must be archived or empty and idle. Remove schedules targeting this workspace or
        its chats first, including disabled schedules.
      </p>
      {confirmation.error && (
        <p className="mt-3 text-label text-danger" role="alert">
          {confirmation.error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button disabled={confirmation.pending} onClick={onClose} tone="secondary">
          Cancel
        </Button>
        <Button disabled={!confirmation.canConfirm} onClick={onConfirm} tone="danger">
          {confirmation.pending ? "Deleting workspace..." : "Delete workspace"}
        </Button>
      </div>
    </dialog>
  );
}
