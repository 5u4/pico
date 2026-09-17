export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly contextLabel: string;
  readonly canEditConfiguration?: boolean | undefined;
}

export interface ChatSummary {
  readonly id: string;
  readonly title: string;
}

export interface ChatTabPresentation {
  readonly id: string;
  readonly title: string;
  readonly contextLabel: string;
}

export type CloseChatPresentation =
  | { readonly kind: "idle" }
  | {
      readonly kind: "closing";
      readonly title: string;
      readonly workspaceName: string;
    }
  | {
      readonly kind: "confirmation";
      readonly title: string;
      readonly workspaceName: string;
      readonly warning: string | null;
      readonly canConfirm: boolean;
    }
  | {
      readonly kind: "error";
      readonly title: string;
      readonly workspaceName: string;
      readonly message: string;
      readonly retry: { readonly enabled: boolean } | null;
    };

export interface PromptSuggestion {
  readonly label: string;
  readonly text: string;
  readonly kind: "explain" | "review" | "fix";
}

export type SidebarSearchPresentation =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly query: string };

export type ListStatus =
  | { readonly kind: "pending"; readonly label: string }
  | { readonly kind: "empty"; readonly label: string }
  | { readonly kind: "error"; readonly label: string };

export interface WorkspaceGroup {
  readonly workspace: WorkspaceSummary;
  readonly expanded: boolean;
  readonly chats: readonly ChatSummary[];
  readonly status?: ListStatus | undefined;
}

export interface NavigationPresentation {
  readonly groups: readonly WorkspaceGroup[];
  readonly status?: ListStatus | undefined;
  readonly activeWorkspaceId: string | null;
  readonly activeChatId: string | null;
}

export type ScheduleTriggerDraft =
  | { readonly kind: "once"; readonly utc: string }
  | { readonly kind: "cron"; readonly expression: string; readonly timeZone: string };

export interface ScheduleDraft {
  readonly name: string;
  readonly trigger: ScheduleTriggerDraft;
  readonly destination:
    | { readonly kind: "keep" }
    | { readonly kind: "workspace"; readonly id: string }
    | { readonly kind: "chat"; readonly id: string };
  readonly timeout:
    | { readonly kind: "default" }
    | { readonly kind: "custom"; readonly milliseconds: string };
}

export type ScheduleRow =
  | {
      readonly kind: "ready";
      readonly id: string;
      readonly name: string;
      readonly state: "enabled" | "disabled";
      readonly triggerLabel: string;
      readonly timing: string;
      readonly timeZone: string;
      readonly destination: string;
      readonly sourceDirectory: string;
    }
  | {
      readonly kind: "invalid";
      readonly id: string;
      readonly state: "enabled" | "disabled" | "conflicted";
      readonly error: string;
      readonly sourceDirectory: string | null;
    };

export type ScheduleListPresentation =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "loaded";
      readonly rows: readonly ScheduleRow[];
      readonly freshness:
        | { readonly kind: "current" }
        | { readonly kind: "refreshing" }
        | { readonly kind: "stale"; readonly message: string };
    };

export type ScheduleSubmission =
  | { readonly kind: "ready" }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly message: string };

export type ScheduleEditorPresentation =
  | {
      readonly kind: "ready";
      readonly row: Extract<ScheduleRow, { readonly kind: "ready" }>;
      readonly draft: ScheduleDraft;
      readonly dirty: boolean;
      readonly localPreview: string;
      readonly warning: string | null;
    }
  | { readonly kind: "invalid"; readonly row: Extract<ScheduleRow, { readonly kind: "invalid" }> }
  | { readonly kind: "missing" };

export type AssistantBlock =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "thinking";
      readonly id: string;
      readonly label: string;
      readonly text: string;
      readonly open: boolean;
    };

export type AssistantState =
  | { readonly kind: "complete" }
  | { readonly kind: "streaming"; readonly label: string }
  | { readonly kind: "unknown"; readonly label: string }
  | { readonly kind: "interrupted"; readonly label: string };

export type ToolState =
  | { readonly kind: "running"; readonly label: string }
  | { readonly kind: "succeeded"; readonly label: string }
  | { readonly kind: "failed"; readonly label: string }
  | { readonly kind: "unknown"; readonly label: string };

export interface ToolCallPresentation {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly arguments?: string | undefined;
  readonly open: boolean;
  readonly state: ToolState;
  readonly output?: string | undefined;
}

export type TranscriptItem =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly timestampLabel: string;
    }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly blocks: readonly AssistantBlock[];
      readonly state: AssistantState;
      readonly timestampLabel: string;
      readonly modelLabel: string;
    }
  | {
      readonly kind: "tool-group";
      readonly id: string;
      readonly title: string;
      readonly calls: readonly ToolCallPresentation[];
      readonly open: boolean;
    }
  | {
      readonly kind: "waiting";
      readonly id: string;
      readonly label: string;
    }
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly tone: "info" | "warning" | "error";
      readonly title: string;
      readonly text: string;
    };

export type TranscriptPresentation =
  | {
      readonly state: "loading";
      readonly label: string;
    }
  | {
      readonly state: "empty";
      readonly title: string;
      readonly description: string;
    }
  | {
      readonly state: "error";
      readonly title: string;
      readonly description: string;
      readonly retryLabel: string;
    }
  | {
      readonly state: "ready";
      readonly items: readonly TranscriptItem[];
      readonly liveLabel: string;
    };

export type ComposerPresentation =
  | {
      readonly mode: "send";
      readonly value: string;
      readonly placeholder: string;
      readonly editable: boolean;
      readonly canSubmit: boolean;
      readonly statusLabel: string;
    }
  | {
      readonly mode: "stop";
      readonly value: string;
      readonly placeholder: string;
      readonly editable: boolean;
      readonly canStop: boolean;
      readonly statusLabel: string;
    };

export type ContextUsagePresentation =
  | {
      readonly kind: "loading" | "unavailable" | "error";
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly kind: "available";
      readonly label: string;
      readonly percentage: string;
      readonly fraction: number;
      readonly used: string;
      readonly capacity: string;
      readonly remaining: string;
      readonly categories: readonly { readonly label: string; readonly tokens: string }[];
      readonly description: string;
    };
