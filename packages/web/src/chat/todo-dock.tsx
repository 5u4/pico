import {
  CaretDownIcon,
  CheckCircleIcon,
  CircleHalfIcon,
  CircleIcon,
  ProhibitIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useId } from "react";
import type { TodoPresentation, TodoTaskPresentation } from "./chat-model.ts";

const statusIcons = {
  pending: CircleIcon,
  in_progress: CircleHalfIcon,
  completed: CheckCircleIcon,
  abandoned: ProhibitIcon,
  blocked: WarningCircleIcon,
} satisfies Record<TodoTaskPresentation["status"]["kind"], typeof CircleIcon>;

export function TodoDock({
  presentation,
  onOpenChange,
}: {
  readonly presentation: TodoPresentation;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  return (
    <section
      aria-label="Tasks"
      className="todo-dock mb-2 rounded-card border border-border bg-panel"
    >
      <button
        aria-controls={`${id}-tasks`}
        aria-expanded={presentation.open}
        className="todo-disclosure grid min-h-11 w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-card px-3 py-2 text-left text-label"
        onClick={() => onOpenChange(!presentation.open)}
        type="button"
      >
        <span className="font-medium" id={`${id}-title`}>
          Tasks
        </span>
        <span className="tabular-nums text-muted">
          {presentation.completed}/{presentation.total}
          <span className="sr-only"> completed</span>
        </span>
        <span className="col-span-3 row-start-2 min-w-0 break-words text-muted sm:col-span-1 sm:col-start-3 sm:row-start-1">
          <span className="line-clamp-2">{presentation.summary}</span>
        </span>
        <CaretDownIcon
          aria-hidden="true"
          className={`col-start-4 row-start-1 shrink-0 text-muted ${presentation.open ? "rotate-180" : ""}`}
          size={16}
        />
      </button>
      <div
        aria-labelledby={`${id}-title`}
        className="todo-tasks max-h-[min(18rem,30dvh)] overflow-y-auto overscroll-contain border-t border-border px-3 py-2"
        hidden={!presentation.open}
        id={`${id}-tasks`}
        role="region"
        tabIndex={0}
      >
        {presentation.phases.map((phase, phaseIndex) => (
          <div className="py-2 first:pt-0 last:pb-0" key={`${phaseIndex}:${phase.name}`}>
            <h3
              className="mb-1 break-words text-label font-medium"
              id={`${id}-phase-${phaseIndex}`}
            >
              {phase.name}
            </h3>
            <ul
              aria-labelledby={`${id}-phase-${phaseIndex}`}
              className="divide-y divide-border-soft"
            >
              {phase.tasks.map((task, taskIndex) => {
                const Icon = statusIcons[task.status.kind];
                return (
                  <li
                    className="flex items-start gap-2.5 py-2"
                    key={`${taskIndex}:${task.content}`}
                  >
                    <Icon aria-hidden="true" className="mt-0.5 shrink-0 text-muted" size={16} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <span className="min-w-0 flex-1 basis-40 whitespace-pre-wrap break-words text-label">
                          {task.content}
                        </span>
                        <span className="text-meta text-muted">{task.status.label}</span>
                      </div>
                      {task.blocker !== null && (
                        <p className="mt-1 whitespace-pre-wrap break-words text-label text-muted">
                          {task.blocker}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
