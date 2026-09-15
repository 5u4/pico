import {
  CaretDownIcon,
  CaretRightIcon,
  FolderSimpleIcon,
  PencilSimpleLineIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type PointerEvent, useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.tsx";
import type { NavigationPresentation } from "./chat-model.ts";

export interface WorkspaceSidebarProps {
  readonly navigation: NavigationPresentation;
  readonly desktopCollapse?: {
    readonly collapsed: boolean;
    readonly onCollapsedChange: (collapsed: boolean) => void;
  };
  readonly onWorkspaceToggle: (workspaceId: string) => void;
  readonly onWorkspaceRetry: () => void;
  readonly onChatsRetry: (workspaceId: string) => void;
  readonly onChatSelect: (workspaceId: string, chatId: string) => void;
  readonly onNewChat: (workspaceId?: string) => void;
  readonly onAddWorkspace?: (() => void) | undefined;
  readonly onEditWorkspace?: ((workspaceId: string, origin: HTMLElement) => void) | undefined;
  readonly workspaceEditPending?: boolean | undefined;
  readonly contextMenuContainer?: HTMLElement | null | undefined;
  readonly onClose: () => void;
}

export function WorkspaceSidebar({
  navigation,
  desktopCollapse,
  onWorkspaceToggle,
  onWorkspaceRetry,
  onChatsRetry,
  onChatSelect,
  onNewChat,
  onAddWorkspace,
  onEditWorkspace,
  workspaceEditPending,
  contextMenuContainer,
  onClose,
}: WorkspaceSidebarProps) {
  const id = useId();
  const collapsed = desktopCollapse?.collapsed ?? false;
  const navigationRef = useRef<HTMLElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const hoveredRow = useRef<{ readonly row: HTMLElement; x: number; y: number } | null>(null);
  const clearHover = useCallback(() => {
    if (hoverRef.current) hoverRef.current.style.opacity = "0";
    hoveredRow.current = null;
  }, []);

  const positionHover = useCallback(() => {
    const hovered = hoveredRow.current;
    if (!hovered) return;
    const container = navigationRef.current;
    const highlight = hoverRef.current;
    if (!container || !highlight || !hovered.row.isConnected) {
      clearHover();
      return;
    }
    const bounds = hovered.row.getBoundingClientRect();
    const origin = container.getBoundingClientRect();
    if (
      bounds.width === 0 ||
      bounds.height === 0 ||
      hovered.x < Math.max(bounds.left, origin.left) ||
      hovered.x >= Math.min(bounds.right, origin.right) ||
      hovered.y < Math.max(bounds.top, origin.top) ||
      hovered.y >= Math.min(bounds.bottom, origin.bottom)
    ) {
      clearHover();
      return;
    }
    highlight.style.width = `${bounds.width}px`;
    highlight.style.height = `${bounds.height}px`;
    highlight.style.transform = `translate(${bounds.left - origin.left + container.scrollLeft}px, ${bounds.top - origin.top + container.scrollTop}px)`;
    highlight.style.opacity = "1";
  }, [clearHover]);

  useLayoutEffect(() => {
    if (collapsed) clearHover();
    else positionHover();
  });

  useEffect(() => {
    window.addEventListener("resize", clearHover);
    return () => window.removeEventListener("resize", clearHover);
  }, [clearHover]);

  const showHover = (event: PointerEvent<HTMLElement>) => {
    const row = event.target instanceof Element ? event.target.closest("[data-sidebar-row]") : null;
    if (!(row instanceof HTMLElement) || event.pointerType === "touch") {
      clearHover();
      return;
    }
    const hovered = hoveredRow.current;
    if (hovered?.row === row) {
      hovered.x = event.clientX;
      hovered.y = event.clientY;
      return;
    }
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      clearHover();
      return;
    }
    hoveredRow.current = { row, x: event.clientX, y: event.clientY };
    positionHover();
  };

  return (
    <aside className="workspace-sidebar flex h-full min-h-0 w-full flex-col border-r border-border bg-sidebar">
      <div className="flex min-h-14 shrink-0 items-center justify-center gap-2 px-2 py-2">
        <div className={`${collapsed ? "hidden" : "flex"} min-w-0 flex-1 items-center gap-2 px-2`}>
          <SparkleIcon aria-hidden="true" className="shrink-0" size={20} weight="fill" />
          <span className="text-title font-semibold tracking-tight">pico</span>
        </div>
        {desktopCollapse ? (
          <Button
            aria-controls={`${id}-workspaces`}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="sidebar-control sidebar-icon-button"
            onClick={() => desktopCollapse.onCollapsedChange(!collapsed)}
            size="icon"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            tone="ghost"
          >
            <SidebarSimpleIcon aria-hidden="true" size={18} />
          </Button>
        ) : (
          <Button
            aria-label="Close sidebar"
            className="sidebar-control sidebar-icon-button md:hidden"
            onClick={onClose}
            size="icon"
            title="Close sidebar"
            tone="ghost"
          >
            <XIcon aria-hidden="true" size={18} />
          </Button>
        )}
      </div>

      <div className="flex shrink-0 justify-center px-2 pb-3">
        <Button
          aria-label="New chat"
          className={`sidebar-control ${collapsed ? "sidebar-icon-button px-0" : "w-full justify-start px-2"}`}
          disabled={navigation.groups.length === 0 && !onAddWorkspace}
          onClick={() => onNewChat()}
          title="New chat"
          tone="ghost"
        >
          <PencilSimpleLineIcon aria-hidden="true" className="shrink-0" size={18} />
          {!collapsed && <span>New chat</span>}
        </Button>
      </div>

      <nav
        aria-label="Workspaces"
        className="relative isolate min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
        hidden={collapsed}
        id={`${id}-workspaces`}
        inert={collapsed}
        onPointerLeave={clearHover}
        onPointerMove={showHover}
        onScroll={clearHover}
        ref={navigationRef}
      >
        <div aria-hidden="true" className="sidebar-hover" ref={hoverRef} />
        <div className="mb-1 flex min-h-8 items-center px-2">
          <h2 className="text-meta font-medium text-subtle">Workspaces</h2>
        </div>
        {navigation.status && (
          <div className="px-2 py-2 text-label text-muted">
            <p
              className="break-words"
              role={navigation.status.kind === "error" ? "alert" : "status"}
            >
              {navigation.status.label}
            </p>
            {navigation.status.kind === "error" && (
              <Button
                className="sidebar-control mt-2 max-w-full whitespace-normal"
                onClick={onWorkspaceRetry}
                size="small"
                tone="secondary"
              >
                Retry workspaces
              </Button>
            )}
          </div>
        )}
        <ul className="space-y-0.5">
          {navigation.groups.map(({ workspace, expanded, chats, status }) => {
            const active = workspace.id === navigation.activeWorkspaceId;
            const listId = `${id}-${workspace.id}`;
            return (
              <li key={workspace.id}>
                <div className="sidebar-row flex items-center gap-0.5" data-sidebar-row="">
                  <WorkspaceToggle
                    active={active}
                    contextMenuContainer={contextMenuContainer}
                    expanded={expanded}
                    listId={listId}
                    onEditWorkspace={onEditWorkspace}
                    onWorkspaceToggle={onWorkspaceToggle}
                    workspace={workspace}
                    workspaceEditPending={workspaceEditPending}
                  />
                  <button
                    aria-label={`New chat in ${workspace.name}`}
                    className="sidebar-row sidebar-icon-button inline-flex shrink-0 items-center justify-center text-muted"
                    onClick={() => onNewChat(workspace.id)}
                    title={`New chat in ${workspace.name}`}
                    type="button"
                  >
                    <PlusIcon aria-hidden="true" size={15} />
                  </button>
                </div>
                <div hidden={!expanded} id={listId}>
                  {status && (
                    <div className="py-2 pl-7 pr-2 text-meta text-muted">
                      <p
                        className="break-words"
                        role={status.kind === "error" ? "alert" : "status"}
                      >
                        {status.label}
                      </p>
                      {status.kind === "error" && (
                        <Button
                          className="sidebar-control mt-2 max-w-full whitespace-normal"
                          onClick={() => onChatsRetry(workspace.id)}
                          size="small"
                          tone="secondary"
                        >
                          Retry chats
                        </Button>
                      )}
                    </div>
                  )}
                  <ul className="space-y-0.5">
                    {chats.map((chat) => {
                      const selected = chat.id === navigation.activeChatId;
                      return (
                        <li key={chat.id}>
                          <button
                            aria-current={selected ? "page" : undefined}
                            className={`sidebar-row flex w-full items-center py-1 pl-7 pr-2 text-left text-label ${selected ? "bg-surface-hover font-medium text-foreground" : "text-muted"}`}
                            data-sidebar-row=""
                            onClick={() => onChatSelect(workspace.id, chat.id)}
                            title={chat.title}
                            type="button"
                          >
                            <span className="truncate">{chat.title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      </nav>
      {onAddWorkspace && (
        <div className="mt-auto flex shrink-0 justify-center border-t border-border p-2">
          <Button
            aria-label="Add workspace"
            className={`sidebar-control ${collapsed ? "sidebar-icon-button px-0" : "w-full justify-start px-2"}`}
            onClick={onAddWorkspace}
            title="Add workspace"
            tone="ghost"
          >
            <PlusIcon aria-hidden="true" className="shrink-0" size={18} />
            {!collapsed && <span>Add workspace</span>}
          </Button>
        </div>
      )}
    </aside>
  );
}

function WorkspaceToggle({
  workspace,
  expanded,
  active,
  listId,
  onWorkspaceToggle,
  onEditWorkspace,
  workspaceEditPending,
  contextMenuContainer,
}: Pick<
  WorkspaceSidebarProps,
  "onWorkspaceToggle" | "onEditWorkspace" | "workspaceEditPending" | "contextMenuContainer"
> & {
  readonly workspace: NavigationPresentation["groups"][number]["workspace"];
  readonly expanded: boolean;
  readonly active: boolean;
  readonly listId: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pendingEdit = useRef<HTMLElement | null>(null);
  const editable = workspace.canEditConfiguration && onEditWorkspace !== undefined;
  const toggle = (
    <button
      aria-controls={listId}
      aria-expanded={expanded}
      className={`sidebar-row flex min-w-0 flex-1 items-center gap-2 px-2 text-left text-label ${active ? "font-medium text-foreground" : "text-muted"}`}
      onClick={() => onWorkspaceToggle(workspace.id)}
      onContextMenu={
        editable ? (event) => event.currentTarget.focus({ preventScroll: true }) : undefined
      }
      onKeyDown={(event) => {
        if (!editable || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")))
          return;
        event.preventDefault();
        const button = event.currentTarget;
        const bounds = button.getBoundingClientRect();
        button.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + bounds.width / 2,
            clientY: bounds.bottom,
            button: 2,
          }),
        );
      }}
      ref={trigger}
      title={workspace.contextLabel}
      type="button"
    >
      {expanded ? (
        <CaretDownIcon aria-hidden="true" className="shrink-0" size={12} />
      ) : (
        <CaretRightIcon aria-hidden="true" className="shrink-0" size={12} />
      )}
      <FolderSimpleIcon aria-hidden="true" className="shrink-0" size={17} />
      <span className="truncate">{workspace.name}</span>
    </button>
  );
  if (!editable) return toggle;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{toggle}</ContextMenuTrigger>
      <ContextMenuContent
        container={contextMenuContainer}
        onCloseAutoFocus={(event) => {
          const origin = pendingEdit.current;
          if (!origin) return;
          pendingEdit.current = null;
          event.preventDefault();
          // Radix must release its focus scope before the native dialog opens.
          queueMicrotask(() => onEditWorkspace?.(workspace.id, origin));
        }}
      >
        <ContextMenuItem
          disabled={workspaceEditPending ?? false}
          onSelect={() => {
            pendingEdit.current = trigger.current;
          }}
        >
          <PencilSimpleLineIcon aria-hidden="true" size={17} />
          Edit workspace
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
