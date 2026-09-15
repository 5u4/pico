import { useEffect, useRef } from "react";
import { WorkspaceSidebar, type WorkspaceSidebarProps } from "./workspace-sidebar.tsx";

export function MobileSidebar({
  open,
  ...sidebar
}: WorkspaceSidebarProps & { readonly open: boolean }) {
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
