import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  CalendarBlankIcon,
  CaretRightIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import type {
  ScheduleDraft,
  ScheduleEditorPresentation,
  ScheduleListPresentation,
  ScheduleRow,
  ScheduleSubmission,
} from "./chat-model.ts";

export interface ScheduleDialogProps {
  readonly open: boolean;
  readonly available: boolean;
  readonly connectionMessage: string | null;
  readonly workspaceId: string | null;
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
  readonly workspaceStatus: string | null;
  readonly list: ScheduleListPresentation;
  readonly editor: ScheduleEditorPresentation | null;
  readonly destinations: readonly {
    readonly kind: "workspace" | "chat";
    readonly id: string;
    readonly label: string;
  }[];
  readonly destinationStatus: string | null;
  readonly submission: ScheduleSubmission;
  readonly confirmation:
    | { readonly kind: "none" }
    | { readonly kind: "discard" }
    | { readonly kind: "delete"; readonly name: string };
  readonly onClose: () => void;
  readonly onClosed: () => void;
  readonly onWorkspaceChange: (id: string) => void;
  readonly onRefresh: () => void;
  readonly onAddWorkspace: () => void;
  readonly onSelect: (id: string) => void;
  readonly onBack: () => void;
  readonly onChange: (draft: ScheduleDraft) => void;
  readonly onSave: () => void;
  readonly onEnabledChange: (id: string, enabled: boolean) => void;
  readonly onDelete: (id: string) => void;
  readonly onAuthor: (id?: string) => void;
  readonly onConfirm: () => void;
  readonly onCancelConfirmation: () => void;
}

const fieldClass =
  "mt-2 block min-h-11 w-full min-w-0 rounded-control border border-border-strong bg-canvas px-3 py-2 text-base";
const actionClass = "min-h-11";

export function ScheduleDialog(props: ScheduleDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const cancel = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const editorKey =
    props.editor && "row" in props.editor ? props.editor.row.id : props.editor?.kind;
  const pending = props.submission.kind === "pending";
  const error = props.submission.kind === "error" ? props.submission.message : null;
  const confirming = props.confirmation.kind !== "none";

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (props.open && !element.open) {
      element.showModal();
      heading.current?.focus();
    } else if (!props.open && element.open) element.close();
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    if (confirming) cancel.current?.querySelector("button")?.focus();
    else (name.current ?? heading.current)?.focus();
  }, [props.open, editorKey, confirming]);

  useEffect(() => {
    if (props.open && error) errorRef.current?.focus();
  }, [props.open, error]);

  return (
    <dialog
      aria-labelledby="schedule-dialog-title"
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto overscroll-contain rounded-surface border border-border bg-panel p-4 text-foreground shadow-composer backdrop:bg-overlay sm:p-6"
      onCancel={(event) => {
        event.preventDefault();
        if (confirming) props.onCancelConfirmation();
        else props.onClose();
      }}
      onClose={props.onClosed}
      ref={dialog}
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          className="text-title font-semibold"
          id="schedule-dialog-title"
          ref={heading}
          tabIndex={-1}
        >
          Schedules
        </h2>
        <Button
          aria-label="Close schedules"
          className="min-h-11 min-w-11 shrink-0"
          onClick={props.onClose}
          size="icon"
          tone="ghost"
        >
          <XIcon aria-hidden="true" size={18} />
        </Button>
      </div>
      {confirming ? (
        <section aria-labelledby="schedule-confirm-title" className="mt-4">
          <h3 className="text-title font-medium" id="schedule-confirm-title">
            {props.confirmation.kind === "delete"
              ? "Delete this schedule?"
              : "Discard unsaved changes?"}
          </h3>
          <p className="mt-3 break-words text-label text-muted">
            {props.confirmation.kind === "delete"
              ? `Delete ${props.confirmation.name}? Future runs stop. Run history is kept, and a run already started may finish.`
              : "Changes not yet saved will be lost. A request already sent may still finish."}
          </p>
          {error && (
            <p className="mt-3 text-label text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2" ref={cancel}>
            <Button className={actionClass} onClick={props.onCancelConfirmation} tone="secondary">
              Cancel
            </Button>
            <Button
              className={actionClass}
              disabled={props.confirmation.kind === "delete" && (pending || !props.available)}
              onClick={props.onConfirm}
              tone="danger"
            >
              {props.confirmation.kind === "delete"
                ? pending
                  ? "Deleting..."
                  : "Delete schedule"
                : "Discard changes"}
            </Button>
          </div>
        </section>
      ) : (
        <>
          <p className="mt-1 text-label text-muted">
            Run tasks while pico is running. Schedules belong to a workspace.
          </p>
          <label className="mt-5 block text-label font-medium" htmlFor="schedule-workspace">
            Workspace
          </label>
          <select
            className={fieldClass}
            disabled={pending || props.workspaces.length === 0}
            id="schedule-workspace"
            onChange={(event) => props.onWorkspaceChange(event.currentTarget.value)}
            value={props.workspaceId ?? ""}
          >
            {props.workspaceId === null && <option value="">Choose a workspace</option>}
            {props.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          {props.workspaceStatus && (
            <p className="mt-2 text-label text-muted" role="status">
              {props.workspaceStatus}
            </p>
          )}
          {props.connectionMessage && (
            <p className="mt-3 text-label text-muted" role="status">
              {props.connectionMessage}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {props.editor && (
              <Button
                className={actionClass}
                disabled={pending}
                onClick={props.onBack}
                tone="ghost"
              >
                <ArrowLeftIcon aria-hidden="true" size={16} />
                Back to schedules
              </Button>
            )}
            <Button
              className={actionClass}
              disabled={!props.available || pending}
              onClick={props.onRefresh}
              tone="ghost"
            >
              <ArrowClockwiseIcon aria-hidden="true" size={16} />
              Refresh
            </Button>
            {!props.editor && props.workspaceId !== null && (
              <Button
                className={actionClass}
                disabled={pending}
                onClick={() => props.onAuthor()}
                tone="primary"
              >
                Draft schedule in chat
              </Button>
            )}
          </div>
          {props.workspaceId === null ? (
            props.workspaceStatus === null && (
              <div className="py-8">
                <p className="text-label text-muted">Add a workspace before drafting a schedule.</p>
                <Button
                  className="mt-4 min-h-11"
                  disabled={!props.available}
                  onClick={props.onAddWorkspace}
                  tone="primary"
                >
                  Add workspace
                </Button>
              </div>
            )
          ) : props.editor ? (
            props.editor.kind === "missing" ? (
              <p className="py-6 text-label text-muted" role="status">
                This schedule is no longer in this workspace. Go back to the list or refresh.
              </p>
            ) : (
              <section className="mt-5 border-t border-border pt-5">
                {props.editor.kind === "ready" ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      props.onSave();
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-meta text-muted">
                      <span>{props.editor.row.state === "enabled" ? "Enabled" : "Paused"}</span>
                      <span>·</span>
                      <span>{props.editor.row.triggerLabel}</span>
                    </div>
                    {props.editor.warning && (
                      <p className="mt-3 text-label text-muted" role="status">
                        {props.editor.warning}
                      </p>
                    )}
                    <fieldset className="min-w-0" disabled={pending}>
                      <label className="mt-4 block text-label font-medium" htmlFor="schedule-name">
                        Name
                      </label>
                      <input
                        aria-describedby={error ? "schedule-error" : undefined}
                        className={fieldClass}
                        id="schedule-name"
                        onChange={(event) => {
                          if (props.editor?.kind === "ready")
                            props.onChange({
                              ...props.editor.draft,
                              name: event.currentTarget.value,
                            });
                        }}
                        ref={name}
                        required
                        value={props.editor.draft.name}
                      />
                      <label
                        className="mt-4 block text-label font-medium"
                        htmlFor="schedule-trigger"
                      >
                        When to run
                      </label>
                      <select
                        className={fieldClass}
                        id="schedule-trigger"
                        onChange={(event) => {
                          if (props.editor?.kind === "ready")
                            props.onChange({
                              ...props.editor.draft,
                              trigger:
                                event.currentTarget.value === "once"
                                  ? { kind: "once", utc: "" }
                                  : { kind: "cron", expression: "0 9 * * *", timeZone: "UTC" },
                            });
                        }}
                        value={props.editor.draft.trigger.kind}
                      >
                        <option value="once">Once</option>
                        <option value="cron">Repeating</option>
                      </select>
                      {props.editor.draft.trigger.kind === "once" ? (
                        <>
                          <label
                            className="mt-4 block text-label font-medium"
                            htmlFor="schedule-once"
                          >
                            Date and time in UTC
                          </label>
                          <input
                            className={fieldClass}
                            id="schedule-once"
                            onChange={(event) => {
                              if (props.editor?.kind === "ready")
                                props.onChange({
                                  ...props.editor.draft,
                                  trigger: { kind: "once", utc: event.currentTarget.value },
                                });
                            }}
                            required
                            step="0.001"
                            type="datetime-local"
                            value={props.editor.draft.trigger.utc}
                          />
                          <p className="mt-2 text-meta text-muted" role="status">
                            {props.editor.localPreview}
                          </p>
                        </>
                      ) : (
                        <>
                          <label
                            className="mt-4 block text-label font-medium"
                            htmlFor="schedule-cron"
                          >
                            Cron expression
                          </label>
                          <p className="mt-1 text-meta text-muted" id="schedule-cron-hint">
                            Five fields. Minute, hour, day, month, weekday.
                          </p>
                          <input
                            aria-describedby="schedule-cron-hint"
                            autoCapitalize="none"
                            className={`${fieldClass} font-mono`}
                            id="schedule-cron"
                            onChange={(event) => {
                              if (
                                props.editor?.kind === "ready" &&
                                props.editor.draft.trigger.kind === "cron"
                              )
                                props.onChange({
                                  ...props.editor.draft,
                                  trigger: {
                                    ...props.editor.draft.trigger,
                                    expression: event.currentTarget.value,
                                  },
                                });
                            }}
                            required
                            spellCheck={false}
                            value={props.editor.draft.trigger.expression}
                          />
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              className={actionClass}
                              onClick={() => {
                                if (
                                  props.editor?.kind === "ready" &&
                                  props.editor.draft.trigger.kind === "cron"
                                )
                                  props.onChange({
                                    ...props.editor.draft,
                                    trigger: {
                                      ...props.editor.draft.trigger,
                                      expression: "0 9 * * *",
                                    },
                                  });
                              }}
                              size="small"
                              tone="ghost"
                            >
                              Daily at 09:00
                            </Button>
                            <Button
                              className={actionClass}
                              onClick={() => {
                                if (
                                  props.editor?.kind === "ready" &&
                                  props.editor.draft.trigger.kind === "cron"
                                )
                                  props.onChange({
                                    ...props.editor.draft,
                                    trigger: {
                                      ...props.editor.draft.trigger,
                                      expression: "0 9 * * 1",
                                    },
                                  });
                              }}
                              size="small"
                              tone="ghost"
                            >
                              Mondays at 09:00
                            </Button>
                          </div>
                          <label
                            className="mt-4 block text-label font-medium"
                            htmlFor="schedule-zone"
                          >
                            IANA timezone
                          </label>
                          <input
                            autoCapitalize="none"
                            className={fieldClass}
                            id="schedule-zone"
                            onChange={(event) => {
                              if (
                                props.editor?.kind === "ready" &&
                                props.editor.draft.trigger.kind === "cron"
                              )
                                props.onChange({
                                  ...props.editor.draft,
                                  trigger: {
                                    ...props.editor.draft.trigger,
                                    timeZone: event.currentTarget.value,
                                  },
                                });
                            }}
                            placeholder="America/New_York"
                            required
                            spellCheck={false}
                            value={props.editor.draft.trigger.timeZone}
                          />
                        </>
                      )}
                      <label
                        className="mt-4 block text-label font-medium"
                        htmlFor="schedule-destination"
                      >
                        Destination
                      </label>
                      <select
                        className={fieldClass}
                        id="schedule-destination"
                        onChange={(event) => {
                          if (props.editor?.kind !== "ready") return;
                          const destination = props.destinations.find(
                            (item) => `${item.kind}:${item.id}` === event.currentTarget.value,
                          );
                          props.onChange({
                            ...props.editor.draft,
                            destination: !destination
                              ? { kind: "keep" }
                              : destination.kind === "workspace"
                                ? { kind: "workspace", id: destination.id }
                                : { kind: "chat", id: destination.id },
                          });
                        }}
                        value={
                          props.editor.draft.destination.kind === "keep"
                            ? "keep"
                            : `${props.editor.draft.destination.kind}:${props.editor.draft.destination.id}`
                        }
                      >
                        <option value="keep">Keep current destination</option>
                        {props.destinations.map((item) => (
                          <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <p className="mt-2 break-words text-meta text-muted">
                        Current destination · {props.editor.row.destination}
                      </p>
                      {props.destinationStatus && (
                        <p className="mt-2 text-meta text-muted" role="status">
                          {props.destinationStatus}
                        </p>
                      )}
                      <details className="mt-5">
                        <summary className="min-h-11 cursor-pointer py-3 text-label font-medium">
                          Details and script timeout
                        </summary>
                        <label
                          className="mt-3 block text-label font-medium"
                          htmlFor="schedule-timeout-mode"
                        >
                          Script timeout
                        </label>
                        <select
                          className={fieldClass}
                          id="schedule-timeout-mode"
                          onChange={(event) => {
                            if (props.editor?.kind === "ready")
                              props.onChange({
                                ...props.editor.draft,
                                timeout:
                                  event.currentTarget.value === "default"
                                    ? { kind: "default" }
                                    : { kind: "custom", milliseconds: "60000" },
                              });
                          }}
                          value={props.editor.draft.timeout.kind}
                        >
                          <option value="default">Default</option>
                          <option value="custom">Custom milliseconds</option>
                        </select>
                        {props.editor.draft.timeout.kind === "custom" && (
                          <label className="mt-3 block text-label">
                            Milliseconds
                            <input
                              className={fieldClass}
                              min="1"
                              max="86400000"
                              onChange={(event) => {
                                if (props.editor?.kind === "ready")
                                  props.onChange({
                                    ...props.editor.draft,
                                    timeout: {
                                      kind: "custom",
                                      milliseconds: event.currentTarget.value,
                                    },
                                  });
                              }}
                              required
                              step="1"
                              type="number"
                              value={props.editor.draft.timeout.milliseconds}
                            />
                          </label>
                        )}
                        <p className="mt-2 text-meta text-muted">
                          Only limits script.js, not the agent run.
                        </p>
                        <SourceDirectory row={props.editor.row} />
                      </details>
                    </fieldset>
                    {error && (
                      <p
                        className="mt-3 text-label text-danger"
                        id="schedule-error"
                        ref={errorRef}
                        role="alert"
                        tabIndex={-1}
                      >
                        {error}
                      </p>
                    )}
                    <div className="mt-5 flex justify-end">
                      <Button
                        className={actionClass}
                        disabled={pending || !props.available || !props.editor.dirty}
                        tone="primary"
                        type="submit"
                      >
                        {pending ? "Saving..." : "Save changes"}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <h3 className="text-title font-medium">Invalid schedule</h3>
                    <p className="mt-2 break-all font-mono text-meta text-muted">
                      {props.editor.row.id}
                    </p>
                    <p className="mt-3 break-words text-label text-danger" role="alert">
                      {props.editor.row.error}
                    </p>
                    <p className="mt-2 text-label text-muted">
                      {props.editor.row.state === "conflicted"
                        ? "Multiple definitions exist. Repair them in chat before changing state or deleting."
                        : "Repair the schedule files before resuming."}
                    </p>
                    <SourceDirectory row={props.editor.row} />
                    {error && (
                      <p className="mt-3 text-label text-danger" role="alert">
                        {error}
                      </p>
                    )}
                  </>
                )}
                <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
                  <Button
                    className={actionClass}
                    disabled={pending}
                    onClick={() => {
                      if (props.editor && "row" in props.editor)
                        props.onAuthor(props.editor.row.id);
                    }}
                    tone="secondary"
                  >
                    Edit instructions in chat
                  </Button>
                  {props.editor.row.state !== "conflicted" &&
                    (props.editor.kind === "ready" || props.editor.row.state === "enabled") && (
                      <Button
                        className={actionClass}
                        disabled={
                          pending ||
                          !props.available ||
                          (props.editor.kind === "ready" && props.editor.dirty)
                        }
                        onClick={() => {
                          if (props.editor && "row" in props.editor)
                            props.onEnabledChange(
                              props.editor.row.id,
                              props.editor.row.state !== "enabled",
                            );
                        }}
                        tone="secondary"
                      >
                        {props.editor.row.state === "enabled" ? "Pause" : "Resume"}
                      </Button>
                    )}
                  {props.editor.row.state !== "conflicted" &&
                    props.editor.row.sourceDirectory !== null && (
                      <Button
                        className={actionClass}
                        disabled={pending || !props.available}
                        onClick={() => {
                          if (props.editor && "row" in props.editor)
                            props.onDelete(props.editor.row.id);
                        }}
                        tone="danger"
                      >
                        Delete
                      </Button>
                    )}
                </div>
                <p className="mt-3 text-meta text-muted">
                  Pausing does not stop a run already started. Save or discard metadata edits before
                  changing state.
                </p>
              </section>
            )
          ) : (
            <section aria-label="Workspace schedules" className="mt-5">
              {props.list.kind === "loading" ? (
                <p className="py-6 text-label text-muted" role="status">
                  Loading schedules...
                </p>
              ) : props.list.kind === "error" ? (
                <p className="py-6 text-label text-danger" role="alert">
                  {props.list.message} Use Refresh to try again.
                </p>
              ) : (
                <>
                  <p className="text-meta text-muted" role="status">
                    {props.list.freshness.kind === "refreshing"
                      ? "Refreshing schedules..."
                      : props.list.freshness.kind === "stale"
                        ? `Saved snapshot. ${props.list.freshness.message}`
                        : `${props.list.rows.length} schedules`}
                  </p>
                  {props.list.rows.length === 0 ? (
                    <div className="py-8">
                      <CalendarBlankIcon aria-hidden="true" className="mb-3 text-muted" size={24} />
                      <h3 className="text-title font-medium">No schedules yet</h3>
                      <p className="mt-2 text-label text-muted">
                        Draft a request in chat. Review it before sending, then refresh this list
                        after pico creates the schedule.
                      </p>
                    </div>
                  ) : (
                    <ul className="mt-3 divide-y divide-border border-y border-border">
                      {props.list.rows.map((row) => (
                        <li key={row.id}>
                          <button
                            className="flex w-full items-center gap-3 rounded-control py-4 text-left hover:bg-surface-hover-strong"
                            onClick={() => props.onSelect(row.id)}
                            type="button"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <span className="break-words text-label font-medium">
                                  {row.kind === "ready" ? row.name : "Invalid schedule"}
                                </span>
                                <span className="text-meta text-muted">
                                  {row.state === "enabled"
                                    ? "Enabled"
                                    : row.state === "disabled"
                                      ? "Paused"
                                      : "Conflicted"}
                                </span>
                              </div>
                              {row.kind === "ready" ? (
                                <>
                                  <p className="mt-1 break-words text-meta text-muted">
                                    {row.triggerLabel} · {row.timing} · {row.timeZone}
                                  </p>
                                  <p className="mt-1 break-words text-meta text-muted">
                                    {row.destination}
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className="mt-1 break-all font-mono text-meta text-muted">
                                    {row.id}
                                  </p>
                                  <p className="mt-1 break-words text-meta text-danger">
                                    {row.error}
                                  </p>
                                </>
                              )}
                            </div>
                            <CaretRightIcon
                              aria-hidden="true"
                              className="shrink-0 text-muted"
                              size={16}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </dialog>
  );
}

function SourceDirectory({ row }: { readonly row: ScheduleRow }) {
  if (row.sourceDirectory === null) return null;
  return (
    <label className="mt-4 block text-label font-medium">
      Managed source directory
      <textarea
        className={`${fieldClass} resize-y font-mono font-normal`}
        readOnly
        rows={3}
        value={row.sourceDirectory}
      />
      <span className="mt-2 block text-meta font-normal text-muted">
        Metadata saves keep these files unchanged. Use chat to edit instructions.
      </span>
    </label>
  );
}
