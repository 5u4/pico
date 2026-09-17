import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";

export interface WorkspaceFormProps {
  readonly session: number;
  readonly origin: HTMLElement | null;
  readonly available: boolean;
  readonly submission:
    | { readonly kind: "ready" }
    | { readonly kind: "pending" }
    | { readonly kind: "error"; readonly message: string };
  readonly onClose: () => void;
  readonly onSubmit: (input: { readonly name: string; readonly directory: string }) => void;
}

export function WorkspaceDialog({
  available,
  submission,
  origin,
  onClose,
  onSubmit,
}: WorkspaceFormProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(origin);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const pending = submission.kind === "pending";
  const error = submission.kind === "error" ? submission.message : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    nameRef.current?.focus();
    return () => {
      dialog.close();
      const target = returnFocus.current;
      if (target?.isConnected && target.getClientRects().length > 0) {
        target.focus({ preventScroll: true });
      } else {
        document.getElementById("conversation-history")?.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (error) directoryRef.current?.focus();
  }, [error]);

  return (
    <dialog
      aria-labelledby="workspace-dialog-title"
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto overscroll-contain rounded-surface border border-border bg-panel p-6 text-foreground shadow-composer backdrop:bg-overlay"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold" id="workspace-dialog-title">
          Add workspace
        </h2>
        <Button aria-label="Close add workspace" onClick={onClose} size="icon" tone="ghost">
          <XIcon aria-hidden="true" size={18} />
        </Button>
      </div>
      <p className="mt-2 text-label text-muted">Keep chats together in a project directory.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && available) onSubmit({ name, directory });
        }}
      >
        <label className="mt-5 block text-label font-medium" htmlFor="workspace-name">
          Workspace name
        </label>
        <input
          aria-describedby={error ? "workspace-error" : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          className="mt-2 block w-full rounded-control border border-border-strong bg-canvas px-3 py-2 text-base"
          disabled={pending}
          id="workspace-name"
          name="workspaceName"
          onChange={(event) => setName(event.currentTarget.value)}
          ref={nameRef}
          required
          type="text"
          value={name}
        />
        <label className="mt-4 block text-label font-medium" htmlFor="workspace-directory">
          Project directory
        </label>
        <p className="mt-1 text-meta text-muted" id="directory-hint">
          Use an existing absolute path on the machine running pico.
        </p>
        <input
          aria-describedby={error ? "directory-hint workspace-error" : "directory-hint"}
          aria-invalid={error ? true : undefined}
          autoCapitalize="none"
          autoComplete="off"
          className="mt-2 block w-full rounded-control border border-border-strong bg-canvas px-3 py-2 text-base"
          disabled={pending}
          id="workspace-directory"
          name="directory"
          onChange={(event) => setDirectory(event.currentTarget.value)}
          placeholder="/path/to/project"
          ref={directoryRef}
          required
          spellCheck={false}
          type="text"
          value={directory}
        />
        {error && (
          <p className="mt-3 text-label text-danger" id="workspace-error" role="alert">
            {error}
          </p>
        )}
        {!available && (
          <p className="mt-3 text-label text-muted" role="status">
            Connect to pico to add a workspace.
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose} tone="ghost">
            Cancel
          </Button>
          <Button disabled={pending || !available} tone="primary" type="submit">
            {pending ? "Adding workspace..." : "Add workspace"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
