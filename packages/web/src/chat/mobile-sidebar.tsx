import { type RefObject, useEffect, useState } from "react";
import { WorkspaceSidebar, type WorkspaceSidebarProps } from "./workspace-sidebar.tsx";

export function MobileSidebar({
  open,
  returnFocus,
  onDialogOpenChange,
  ...sidebar
}: WorkspaceSidebarProps & {
  readonly open: boolean;
  readonly returnFocus: RefObject<HTMLButtonElement | null>;
  readonly onDialogOpenChange: (open: boolean) => void;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      onDialogOpenChange(true);
    } else if (!open && dialog.open) dialog.close();
  }, [open, dialog, onDialogOpenChange]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 48rem)");
    const closeOnDesktop = () => {
      if (desktop.matches && open) sidebar.onClose();
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [open, sidebar.onClose]);

  const afterClose = (action: () => void) => {
    if (dialog?.open) {
      dialog.addEventListener("close", action, { once: true });
      sidebar.onClose();
    } else action();
  };

  return (
    <dialog
      aria-label="Workspace navigation"
      className="fixed inset-y-2.5 left-2.5 z-30 m-0 h-[calc(100dvh-20px)] max-h-none w-[min(224px,calc(100vw-20px))] max-w-none overscroll-contain rounded-window border-0 bg-canvas px-0 py-2.5 shadow-overlay backdrop:bg-overlay md:hidden"
      onCancel={(event) => {
        event.preventDefault();
        sidebar.onClose();
      }}
      onClose={() => onDialogOpenChange(false)}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          sidebar.onClose();
        }
      }}
      ref={setDialog}
    >
      {open && (
        <WorkspaceSidebar
          {...sidebar}
          contextMenuContainer={dialog}
          onAddWorkspace={
            sidebar.onAddWorkspace ? () => afterClose(() => sidebar.onAddWorkspace?.()) : undefined
          }
          onChatClose={(workspaceId, chatId, origin) => {
            afterClose(() =>
              sidebar.onChatClose(workspaceId, chatId, returnFocus.current ?? origin),
            );
          }}
          onChatSelect={(workspaceId, chatId) =>
            afterClose(() => sidebar.onChatSelect(workspaceId, chatId))
          }
          onChatMarkUnread={(workspaceId, chatId) =>
            afterClose(() => sidebar.onChatMarkUnread(workspaceId, chatId))
          }
          onChatMarkRead={(workspaceId, chatId) =>
            afterClose(() => sidebar.onChatMarkRead(workspaceId, chatId))
          }
          onEditWorkspace={
            sidebar.onEditWorkspace
              ? (workspaceId, origin) => {
                  afterClose(() =>
                    sidebar.onEditWorkspace?.(workspaceId, returnFocus.current ?? origin),
                  );
                }
              : undefined
          }
          onDeleteWorkspace={
            sidebar.onDeleteWorkspace
              ? (workspaceId, origin) =>
                  afterClose(() =>
                    sidebar.onDeleteWorkspace?.(workspaceId, returnFocus.current ?? origin),
                  )
              : undefined
          }
          onNewChat={(workspaceId) => afterClose(() => sidebar.onNewChat(workspaceId))}
          onOpenSchedules={(origin) =>
            afterClose(() => sidebar.onOpenSchedules(returnFocus.current ?? origin))
          }
        />
      )}
    </dialog>
  );
}
