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
