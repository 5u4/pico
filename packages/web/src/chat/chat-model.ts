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

export interface DeleteWorkspacePresentation {
  readonly workspaceName: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly canConfirm: boolean;
}

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

export interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly platform: string;
  readonly definitionState: "enabled" | "disabled" | "invalid";
  readonly trigger: string;
  readonly timeZone: string;
  readonly nextTrigger: string;
  readonly lastRun: {
    readonly label: string;
    readonly timestamp: string | null;
    readonly revision: string | null;
    readonly tone: "neutral" | "danger";
  };
  readonly details: readonly { readonly label: string; readonly value: string }[];
}

export type ScheduleListPresentation =
  | { readonly kind: "loading"; readonly message: string }
  | { readonly kind: "disconnected" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "loaded";
      readonly rows: readonly ScheduleRow[];
      readonly observedAt: string;
      readonly freshness:
        | { readonly kind: "current" }
        | { readonly kind: "refreshing" }
        | { readonly kind: "stale"; readonly message: string };
    };

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

export interface TodoTaskPresentation {
  readonly content: string;
  readonly status: {
    readonly kind: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
    readonly label: string;
  };
  readonly blocker: string | null;
}

export interface TodoPresentation {
  readonly completed: number;
  readonly total: number;
  readonly summary: string;
  readonly open: boolean;
  readonly phases: readonly {
    readonly name: string;
    readonly tasks: readonly TodoTaskPresentation[];
  }[];
}

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

export interface SkillCompletionOptionPresentation {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly selected: boolean;
}

export type SkillCompletionPresentation =
  | { readonly kind: "closed" }
  | {
      readonly kind: "loading" | "empty";
      readonly listboxId: string;
      readonly activeDescendantId: string;
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly listboxId: string;
      readonly activeDescendantId: string;
      readonly message: string;
      readonly retry: "enabled" | "disabled";
    }
  | {
      readonly kind: "ready";
      readonly listboxId: string;
      readonly activeDescendantId: string;
      readonly options: readonly SkillCompletionOptionPresentation[];
    };

export interface ModelPickerPresentation {
  readonly label: string;
  readonly control:
    | { readonly kind: "draft" }
    | { readonly kind: "disabled"; readonly reason: string }
    | {
        readonly kind: "select";
        readonly value: string;
        readonly options: readonly { readonly value: string; readonly label: string }[];
      };
  readonly feedback:
    | { readonly kind: "none" }
    | {
        readonly kind: "error";
        readonly message: string;
        readonly warning: string | null;
        readonly retry: "enabled" | "disabled";
      }
    | { readonly kind: "warning"; readonly message: string };
}

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

export type ShakeFeedback =
  | { readonly kind: "idle" }
  | { readonly kind: "status" | "error"; readonly message: string };
