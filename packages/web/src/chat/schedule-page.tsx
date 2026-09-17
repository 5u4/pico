import { ArrowClockwiseIcon, CaretRightIcon } from "@phosphor-icons/react";
import { Button } from "../components/ui/button.tsx";
import type { ScheduleListPresentation } from "./chat-model.ts";

export interface SchedulePageProps {
  readonly list: ScheduleListPresentation;
  readonly expandedId: string | null;
  readonly refreshEnabled: boolean;
  readonly onRefresh: () => void;
  readonly onExpandedChange: (id: string, open: boolean) => void;
}

export function SchedulePage({
  list,
  expandedId,
  refreshEnabled,
  onRefresh,
  onExpandedChange,
}: SchedulePageProps) {
  const status =
    list.kind === "loading"
      ? list.message
      : list.kind === "disconnected"
        ? "Schedules cannot be loaded while disconnected."
        : list.kind === "error"
          ? list.message
          : list.freshness.kind === "refreshing"
            ? `Refreshing schedules. Showing the snapshot from ${list.observedAt}.`
            : list.freshness.kind === "stale"
              ? `${list.freshness.message} Showing the snapshot from ${list.observedAt}.`
              : `Snapshot from ${list.observedAt}.`;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1120px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1
              className="text-[26px] font-normal tracking-[-0.02em]"
              id="schedules-heading"
              tabIndex={-1}
            >
              Schedules
            </h1>
            <p className="mt-2 text-label text-muted">
              All current schedules across all workspaces.
            </p>
          </div>
          <Button disabled={!refreshEnabled} onClick={onRefresh} size="small" tone="secondary">
            <ArrowClockwiseIcon aria-hidden="true" size={16} />
            {list.kind === "error" ? "Retry schedules" : "Refresh"}
          </Button>
        </div>
        <p
          className={`mt-5 text-label ${list.kind === "error" || (list.kind === "loaded" && list.freshness.kind === "stale") ? "text-danger" : "text-muted"}`}
          role="status"
        >
          {status}
        </p>
        <details className="mt-2 text-label text-muted">
          <summary className="w-fit cursor-pointer rounded-control">About these statuses</summary>
          <p className="mt-2 max-w-[760px]">
            Next trigger is a calendar time, not a promised start. Last recorded run shows saved
            status, not proof that a run is active now. Disabled definitions may include finished
            one-time schedules.
          </p>
        </details>
        {list.kind === "loaded" &&
          (list.rows.length === 0 ? (
            <div className="border-t border-border py-10 mt-6">
              <h2 className="text-lg font-medium">No schedules yet</h2>
              <p className="mt-2 text-label text-muted">
                This page lists existing schedules across all workspaces.
              </p>
            </div>
          ) : (
            <ul
              aria-label="Schedules"
              className="mt-6 divide-y divide-border border-y border-border"
            >
              {list.rows.map((row) => (
                <li key={row.id}>
                  <details
                    className="group/schedule"
                    open={expandedId === row.id}
                    onToggle={(event) => {
                      if (event.currentTarget.open !== (expandedId === row.id)) {
                        onExpandedChange(row.id, event.currentTarget.open);
                      }
                    }}
                  >
                    <summary className="grid cursor-pointer list-none grid-cols-[20px_minmax(0,1fr)] items-start gap-x-3 gap-y-3 rounded-control py-4 pr-2 [&::-webkit-details-marker]:hidden lg:grid-cols-[20px_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                      <CaretRightIcon
                        aria-hidden="true"
                        className="mt-1 text-muted group-open/schedule:rotate-90"
                        size={16}
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="break-words text-[15px] font-medium [overflow-wrap:anywhere]">
                            {row.name}
                          </span>
                          <span
                            className={`rounded-control bg-surface-hover px-2 py-0.5 text-meta ${row.definitionState === "invalid" ? "text-danger" : "text-muted"}`}
                          >
                            {row.definitionState === "enabled"
                              ? "Enabled"
                              : row.definitionState === "disabled"
                                ? "Disabled"
                                : "Invalid"}
                          </span>
                        </span>
                        <span className="mt-1 block break-words text-label text-muted">
                          {row.owner} · {row.platform}
                        </span>
                      </span>
                      <span className="col-start-2 min-w-0 lg:col-start-auto">
                        <span className="block text-label text-muted">Next trigger</span>
                        <span className="mt-1 block break-words text-label">{row.nextTrigger}</span>
                      </span>
                      <span className="col-start-2 min-w-0 lg:col-start-auto">
                        <span className="block text-label text-muted">Last recorded run</span>
                        <span
                          className={`mt-1 block text-label ${row.lastRun.tone === "danger" ? "text-danger" : "text-foreground"}`}
                        >
                          {row.lastRun.label}
                        </span>
                        {row.lastRun.timestamp && (
                          <span className="mt-1 block break-words text-label text-muted">
                            {row.lastRun.timestamp}
                          </span>
                        )}
                        {row.lastRun.revision && (
                          <span className="mt-1 block text-label text-muted">
                            {row.lastRun.revision}
                          </span>
                        )}
                      </span>
                    </summary>
                    <dl className="mb-5 ml-8 grid min-w-0 gap-x-6 gap-y-4 border-l border-border pl-4 sm:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="text-label text-muted">Trigger</dt>
                        <dd className="mt-1 break-words font-mono text-label">{row.trigger}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-label text-muted">Timezone</dt>
                        <dd className="mt-1 break-words text-label">{row.timeZone}</dd>
                      </div>
                      {row.details.map((detail) => (
                        <div className="min-w-0" key={detail.label}>
                          <dt className="text-label text-muted">{detail.label}</dt>
                          <dd className="mt-1 whitespace-pre-wrap break-words text-label [overflow-wrap:anywhere]">
                            {detail.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}
