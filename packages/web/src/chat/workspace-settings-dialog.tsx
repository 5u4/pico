import { CircleNotchIcon, XIcon } from "@phosphor-icons/react";
import type { WorkspaceBindingConfiguration } from "@pico/contract/application";
import type { WorkspaceBindingInvalidIssue } from "@pico/contract/errors";
import type { Workspace } from "@pico/contract/workspace-model";
import { useEffect, useId, useRef } from "react";
import { Button } from "../components/ui/button.tsx";

export interface WorkspaceSettingsEditor {
  readonly session: number;
  readonly workspace: Workspace;
  readonly configuration: WorkspaceBindingConfiguration;
  readonly origin: HTMLElement | null;
  readonly submission:
    | { readonly kind: "ready" }
    | { readonly kind: "pending" }
    | {
        readonly kind: "error";
        readonly message: string;
        readonly issue: WorkspaceBindingInvalidIssue | null;
      };
}

export interface WorkspaceSettingsProps {
  readonly editor: WorkspaceSettingsEditor;
  readonly available: boolean;
  readonly onChange: (configuration: WorkspaceBindingConfiguration) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}

export function WorkspaceSettingsDialog({
  editor,
  available,
  onChange,
  onClose,
  onSubmit,
}: WorkspaceSettingsProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLInputElement>(null);
  const prefixRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const origin = useRef(editor.origin);
  const worktreeSettings = useRef(editor.workspace.worktree ?? { branch: "", prefix: "" });
  const configuration = editor.configuration;
  const pending = editor.submission.kind === "pending";
  const error = editor.submission.kind === "error" ? editor.submission : null;
  const issue = error?.issue;
  const errorId = `${id}-error`;
  const pathHintId = `${id}-path-hint`;
  const errorMessage = issue ? describeIssue(issue) : error?.message;
  const pathInvalid = issue?.field === "cwd" || issue?.field === "repository";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    directoryRef.current?.focus();
    return () => {
      dialog.close();
      const target = origin.current;
      if (target?.isConnected && target.getClientRects().length > 0) {
        target.focus({ preventScroll: true });
      } else {
        document.getElementById("conversation-history")?.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (editor.submission.kind !== "error") return;
    const field = editor.submission.issue?.field;
    const input =
      field === "branch"
        ? branchRef.current
        : field === "prefix"
          ? prefixRef.current
          : field === "cwd" || field === "repository"
            ? directoryRef.current
            : errorRef.current;
    input?.focus();
  }, [editor.submission]);

  return (
    <dialog
      aria-describedby={`${id}-chat-hint`}
      aria-labelledby={`${id}-title`}
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto overscroll-contain rounded-surface border border-border bg-panel p-6 text-foreground shadow-composer backdrop:bg-overlay"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold" id={`${id}-title`}>
          Edit workspace
        </h2>
        <Button aria-label="Close workspace settings" onClick={onClose} size="icon" tone="ghost">
          <XIcon aria-hidden="true" size={18} />
        </Button>
      </div>
      <p className="mt-2 break-words text-label font-medium">{editor.workspace.name}</p>
      <p className="mt-2 text-label text-muted" id={`${id}-chat-hint`}>
        These settings choose the directory for new chats. Existing chats keep their directories.
      </p>
      <form
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && available) onSubmit();
        }}
      >
        <fieldset className="mt-5" disabled={pending}>
          <legend className="text-label font-medium">Directory mode</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-label ${configuration.kind === "direct" ? "border-border-strong bg-surface-hover font-medium" : "border-border text-muted"}`}
            >
              <input
                checked={configuration.kind === "direct"}
                name={`${id}-mode`}
                onChange={() => {
                  if (configuration.kind === "worktree") {
                    worktreeSettings.current = configuration.settings;
                    onChange({ kind: "direct", cwd: configuration.repository });
                  }
                }}
                type="radio"
                value="direct"
              />
              Regular
            </label>
            <label
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-label ${configuration.kind === "worktree" ? "border-border-strong bg-surface-hover font-medium" : "border-border text-muted"}`}
            >
              <input
                checked={configuration.kind === "worktree"}
                name={`${id}-mode`}
                onChange={() => {
                  if (configuration.kind === "direct") {
                    onChange({
                      kind: "worktree",
                      repository: configuration.cwd,
                      settings: worktreeSettings.current,
                    });
                  }
                }}
                type="radio"
                value="worktree"
              />
              Worktree
            </label>
          </div>
        </fieldset>
        <label className="mt-5 block text-label font-medium" htmlFor={`${id}-directory`}>
          {configuration.kind === "direct" ? "Project directory" : "Git repository"}
        </label>
        <p className="mt-1 text-meta text-muted" id={pathHintId}>
          Use an existing absolute path on the machine running pico.
        </p>
        <input
          aria-describedby={pathInvalid ? `${pathHintId} ${errorId}` : pathHintId}
          aria-invalid={pathInvalid || undefined}
          autoCapitalize="none"
          autoComplete="off"
          className="mt-2 block w-full rounded-control border border-border-strong bg-canvas px-3 py-2 text-base"
          disabled={pending}
          id={`${id}-directory`}
          name={configuration.kind === "direct" ? "cwd" : "repository"}
          onChange={(event) =>
            onChange(
              configuration.kind === "direct"
                ? { ...configuration, cwd: event.currentTarget.value }
                : { ...configuration, repository: event.currentTarget.value },
            )
          }
          ref={directoryRef}
          required
          spellCheck={false}
          type="text"
          value={configuration.kind === "direct" ? configuration.cwd : configuration.repository}
        />
        {configuration.kind === "worktree" && (
          <>
            <label className="mt-4 block text-label font-medium" htmlFor={`${id}-branch`}>
              Base branch
            </label>
            <p className="mt-1 text-meta text-muted" id={`${id}-branch-hint`}>
              New worktrees start from this branch or commit.
            </p>
            <input
              aria-describedby={
                issue?.field === "branch" ? `${id}-branch-hint ${errorId}` : `${id}-branch-hint`
              }
              aria-invalid={issue?.field === "branch" || undefined}
              autoCapitalize="none"
              autoComplete="off"
              className="mt-2 block w-full rounded-control border border-border-strong bg-canvas px-3 py-2 text-base"
              disabled={pending}
              id={`${id}-branch`}
              name="branch"
              onChange={(event) =>
                onChange({
                  ...configuration,
                  settings: { ...configuration.settings, branch: event.currentTarget.value },
                })
              }
              ref={branchRef}
              required
              spellCheck={false}
              type="text"
              value={configuration.settings.branch}
            />
            <label className="mt-4 block text-label font-medium" htmlFor={`${id}-prefix`}>
              Branch prefix
            </label>
            <p className="mt-1 text-meta text-muted" id={`${id}-prefix-hint`}>
              Prefix for branches created by pico.
            </p>
            <input
              aria-describedby={
                issue?.field === "prefix" ? `${id}-prefix-hint ${errorId}` : `${id}-prefix-hint`
              }
              aria-invalid={issue?.field === "prefix" || undefined}
              autoCapitalize="none"
              autoComplete="off"
              className="mt-2 block w-full rounded-control border border-border-strong bg-canvas px-3 py-2 text-base"
              disabled={pending}
              id={`${id}-prefix`}
              name="prefix"
              onChange={(event) =>
                onChange({
                  ...configuration,
                  settings: { ...configuration.settings, prefix: event.currentTarget.value },
                })
              }
              ref={prefixRef}
              required
              spellCheck={false}
              type="text"
              value={configuration.settings.prefix}
            />
          </>
        )}
        {errorMessage && (
          <p
            className="mt-3 text-label text-danger"
            id={errorId}
            ref={errorRef}
            role="alert"
            tabIndex={-1}
          >
            {errorMessage}
          </p>
        )}
        <p className="mt-3 text-label text-muted" role="status">
          {pending
            ? "Saving workspace settings..."
            : !available
              ? "Connect to pico to save changes."
              : ""}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose} tone="ghost">
            Cancel
          </Button>
          <Button disabled={pending || !available} tone="primary" type="submit">
            {pending && (
              <CircleNotchIcon aria-hidden="true" className="motion-safe:animate-spin" size={17} />
            )}
            Save changes
          </Button>
        </div>
      </form>
    </dialog>
  );
}

function describeIssue(issue: WorkspaceBindingInvalidIssue): string {
  const reason = issue.reason;
  switch (reason) {
    case "surrounding-whitespace":
      return "Remove spaces at the start or end of this value.";
    case "not-absolute":
      return "Use an absolute directory path.";
    case "not-found":
      return "This directory does not exist on the machine running pico.";
    case "not-directory":
      return "Choose a directory, not a file.";
    case "unreadable":
      return "Pico cannot read this directory. Check its permissions.";
    case "not-repository":
      return "Choose a Git repository.";
    case "not-commit":
      return "This branch or commit was not found in the repository.";
    case "invalid-ref":
      return "Use a valid Git branch prefix.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
