import { type RefObject, useEffect, useState } from "react";
import { WorkspaceSidebar, type WorkspaceSidebarProps } from "./workspace-sidebar.tsx";

export function MobileSidebar({
  open,
  returnFocus,
  ...sidebar
}: WorkspaceSidebarProps & {
  readonly open: boolean;
  readonly returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open, dialog]);

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
      ref={setDialog}
    >
      {open && (
        <WorkspaceSidebar
          {...sidebar}
          contextMenuContainer={dialog}
          onEditWorkspace={
            sidebar.onEditWorkspace
              ? (workspaceId, origin) => {
                  const edit = () =>
                    sidebar.onEditWorkspace?.(workspaceId, returnFocus.current ?? origin);
                  if (dialog?.open) {
                    dialog.addEventListener("close", edit, { once: true });
                    sidebar.onClose();
                  } else edit();
                }
              : undefined
          }
        />
      )}
    </dialog>
  );
}
