import { MoonIcon, PlusIcon, SidebarSimpleIcon, SunIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import type { Theme } from "../theme.ts";
import type { ComposerPresentation, TranscriptPresentation } from "./chat-model.ts";
import { Composer } from "./composer.tsx";
import { Transcript } from "./transcript.tsx";
import { WorkspaceSidebar, type WorkspaceSidebarProps } from "./workspace-sidebar.tsx";

export interface WorkspaceFormProps {
  readonly open: boolean;
  readonly available: boolean;
  readonly submission:
    | { readonly kind: "ready" }
    | { readonly kind: "pending" }
    | { readonly kind: "error"; readonly message: string };
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: { readonly name: string; readonly directory: string }) => void;
}

export interface ChatScreenProps extends Omit<WorkspaceSidebarProps, "onClose" | "onAddWorkspace"> {
  readonly conversationKey: string | null;
  readonly title: string;
  readonly contextLabel: string;
  readonly transcript: TranscriptPresentation;
  readonly composer: ComposerPresentation;
  readonly sidebarOpen: boolean;
  readonly theme: Theme;
  readonly workspaceForm?: WorkspaceFormProps | undefined;
  readonly onSidebarOpenChange: (open: boolean) => void;
  readonly onComposerValueChange: (value: string) => void;
  readonly onComposerSubmit: () => void;
  readonly onStop: () => void;
  readonly onTranscriptRetry: () => void;
  readonly onDisclosureToggle: (itemId: string) => void;
  readonly onThemeChange: (theme: Theme) => void;
}

export function ChatScreen({
  navigation,
  conversationKey,
  title,
  contextLabel,
  transcript,
  composer,
  sidebarOpen,
  theme,
  workspaceForm,
  onSidebarOpenChange,
  onWorkspaceToggle,
  onWorkspaceRetry,
  onChatsRetry,
  onChatSelect,
  onNewChat,
  onComposerValueChange,
  onComposerSubmit,
  onStop,
  onTranscriptRetry,
  onDisclosureToggle,
  onThemeChange,
}: ChatScreenProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scroll = useRef({ key: conversationKey, following: true });
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    if (scroll.current.key !== conversationKey) {
      scroll.current = { key: conversationKey, following: true };
      setShowJump(false);
    }
    if (scroll.current.following) element.scrollTop = element.scrollHeight;
  }, [conversationKey, transcript]);

  const jumpToLatest = () => {
    const element = transcriptRef.current;
    if (!element) return;
    scroll.current.following = true;
    element.scrollTop = element.scrollHeight;
    setShowJump(false);
    element.focus({ preventScroll: true });
  };
  const closeSidebar = () => onSidebarOpenChange(false);
  const sidebar = {
    navigation,
    onWorkspaceToggle,
    onWorkspaceRetry,
    onChatsRetry,
    onChatSelect: (workspaceId, chatId) => {
      onChatSelect(workspaceId, chatId);
      closeSidebar();
    },
    onNewChat: (workspaceId) => {
      onNewChat(workspaceId);
      closeSidebar();
    },
    onAddWorkspace: workspaceForm
      ? () => {
          closeSidebar();
          workspaceForm.onOpenChange(true);
        }
      : undefined,
    onClose: closeSidebar,
  } satisfies WorkspaceSidebarProps;
  const onboarding = navigation.status?.kind === "empty" && workspaceForm;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 bg-canvas text-foreground md:grid-cols-[16rem_minmax(0,1fr)]">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-border focus:bg-panel focus:px-4 focus:py-2"
        href="#conversation-history"
      >
        Skip to conversation
      </a>
      <div className="hidden min-h-0 md:block">
        <WorkspaceSidebar {...sidebar} />
      </div>
      <MobileSidebar {...sidebar} open={sidebarOpen} />

      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-canvas px-4 py-2 md:px-6">
          <Button
            aria-label="Open sidebar"
            className="md:hidden"
            onClick={() => onSidebarOpenChange(true)}
            size="icon"
            tone="ghost"
          >
            <SidebarSimpleIcon aria-hidden="true" size={19} />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-title font-semibold">{title}</h1>
            <p className="truncate text-meta text-muted" title={contextLabel}>
              {contextLabel}
            </p>
          </div>
          <Button
            aria-label="Dark theme"
            aria-pressed={theme === "dark"}
            className="ml-auto"
            onClick={() => onThemeChange(theme === "light" ? "dark" : "light")}
            size="icon"
            tone="ghost"
          >
            {theme === "light" ? (
              <MoonIcon aria-hidden="true" size={19} />
            ) : (
              <SunIcon aria-hidden="true" size={19} />
            )}
          </Button>
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            aria-label="Conversation history"
            className="transcript-scroll h-full overflow-y-auto"
            id="conversation-history"
            onScroll={(event) => {
              const element = event.currentTarget;
              const following =
                element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
              scroll.current.following = following;
              setShowJump(!following);
            }}
            ref={transcriptRef}
            role="region"
            tabIndex={0}
          >
            <Transcript
              onDisclosureToggle={onDisclosureToggle}
              onRetry={onTranscriptRetry}
              presentation={transcript}
            />
            {onboarding && (
              <div className="flex justify-center px-4 pb-8">
                <Button onClick={() => onboarding.onOpenChange(true)} tone="primary">
                  <PlusIcon aria-hidden="true" size={17} />
                  Add workspace
                </Button>
              </div>
            )}
          </div>
          {showJump && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <Button
                className="pointer-events-auto"
                onClick={jumpToLatest}
                size="small"
                tone="secondary"
              >
                Jump to latest
              </Button>
            </div>
          )}
        </div>

        <div className="shrink-0 bg-canvas px-3 pb-3 pt-2 md:px-8 md:pb-4">
          <div className="mx-auto max-w-3xl">
            <Composer
              onStop={onStop}
              onSubmit={onComposerSubmit}
              onValueChange={onComposerValueChange}
              presentation={composer}
            />
            <p className="mt-2 text-center text-meta text-subtle">
              Pico can make mistakes. Review changes before applying them.
            </p>
          </div>
        </div>
      </main>
      {workspaceForm && <WorkspaceDialog {...workspaceForm} />}
    </div>
  );
}

function MobileSidebar({ open, ...sidebar }: WorkspaceSidebarProps & { readonly open: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 48rem)");
    const closeOnDesktop = () => {
      if (desktop.matches && open) sidebar.onClose();
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [open, sidebar.onClose]);

  return (
    <dialog
      aria-label="Workspace navigation"
      className="fixed inset-y-0 left-0 z-30 m-0 h-dvh max-h-none w-[min(19rem,88vw)] max-w-none overscroll-contain border-0 bg-transparent p-0 backdrop:bg-overlay md:hidden"
      onCancel={(event) => {
        event.preventDefault();
        sidebar.onClose();
      }}
      ref={dialogRef}
    >
      <WorkspaceSidebar {...sidebar} />
    </dialog>
  );
}

function WorkspaceDialog({
  open,
  available,
  submission,
  onOpenChange,
  onSubmit,
}: WorkspaceFormProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const pending = submission.kind === "pending";
  const error = submission.kind === "error" ? submission.message : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setName("");
      setDirectory("");
      dialog.showModal();
      nameRef.current?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open && error) directoryRef.current?.focus();
  }, [open, error]);

  return (
    <dialog
      aria-labelledby="workspace-dialog-title"
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto overscroll-contain rounded-surface border border-border bg-panel p-6 text-foreground shadow-composer backdrop:bg-overlay"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      ref={dialogRef}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold" id="workspace-dialog-title">
          Add workspace
        </h2>
        <Button
          aria-label="Close add workspace"
          onClick={() => onOpenChange(false)}
          size="icon"
          tone="ghost"
        >
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
          <Button onClick={() => onOpenChange(false)} tone="ghost">
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
