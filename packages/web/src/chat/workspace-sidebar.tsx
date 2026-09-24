import {
  ArchiveIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CaretRightIcon,
  CopyIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  MagnifyingGlassIcon,
  PencilSimpleLineIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SparkleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../components/ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.tsx";
import type { NavigationPresentation, SidebarSearchPresentation } from "./chat-model.ts";

export interface WorkspaceSidebarProps {
  readonly navigation: NavigationPresentation;
  readonly currentPage: "chat" | "schedules";
  readonly search: SidebarSearchPresentation;
  readonly onSearchChange: (search: SidebarSearchPresentation) => void;
  readonly desktopCollapse?: {
    readonly collapsed: boolean;
    readonly onCollapsedChange: (collapsed: boolean) => void;
  };
  readonly onWorkspaceToggle: (workspaceId: string) => void;
  readonly onWorkspaceRetry: () => void;
  readonly onChatsRetry: (workspaceId: string) => void;
  readonly onChatSelect: (workspaceId: string, chatId: string) => void;
  readonly onChatMarkUnread: (workspaceId: string, chatId: string) => void;
  readonly onChatMarkRead: (workspaceId: string, chatId: string) => void;
  readonly onChatClose: (workspaceId: string, chatId: string, origin: HTMLElement) => void;
  readonly chatCloseDisabled: boolean;
  readonly onNewChat: (workspaceId?: string) => void;
  readonly schedulesHref: string;
  readonly onOpenSchedules: (origin: HTMLElement) => void;
  readonly onAddWorkspace?: (() => void) | undefined;
  readonly onEditWorkspace?: ((workspaceId: string, origin: HTMLElement) => void) | undefined;
  readonly workspaceEditPending?: boolean | undefined;
  readonly onDeleteWorkspace?: ((workspaceId: string, origin: HTMLElement) => void) | undefined;
  readonly workspaceDeleteDisabled?: boolean | undefined;
  readonly contextMenuContainer?: HTMLElement | null | undefined;
  readonly onClose: () => void;
}

export function WorkspaceSidebar({
  navigation,
  currentPage,
  search,
  onSearchChange,
  desktopCollapse,
  onWorkspaceToggle,
  onWorkspaceRetry,
  onChatsRetry,
  onChatSelect,
  onChatMarkUnread,
  onChatMarkRead,
  onChatClose,
  chatCloseDisabled,
  onNewChat,
  schedulesHref,
  onOpenSchedules,
  onAddWorkspace,
  onEditWorkspace,
  workspaceEditPending,
  onDeleteWorkspace,
  workspaceDeleteDisabled,
  contextMenuContainer,
  onClose,
}: WorkspaceSidebarProps) {
  const id = useId();
  const collapsed = desktopCollapse?.collapsed ?? false;
  const searchOpen = search.kind === "open";
  const searchInput = useRef<HTMLInputElement>(null);
  const searchOpener = useRef<HTMLButtonElement>(null);
  const collapseControl = useRef<HTMLButtonElement>(null);
  const expandControl = useRef<HTMLButtonElement>(null);
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

  useLayoutEffect(() => {
    if (collapsed && document.activeElement === collapseControl.current) {
      expandControl.current?.focus({ preventScroll: true });
    } else if (!collapsed && document.activeElement === expandControl.current) {
      collapseControl.current?.focus({ preventScroll: true });
    }
  }, [collapsed]);

  useEffect(() => {
    const input = searchInput.current;
    if (searchOpen && !collapsed && input && input.getClientRects().length > 0) input.focus();
  }, [searchOpen, collapsed]);

  const closeSearch = () => {
    onSearchChange({ kind: "closed" });
    searchOpener.current?.focus({ preventScroll: true });
  };

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
    <aside
      aria-label="Workspace navigation"
      className="workspace-sidebar relative flex h-full min-h-0 w-full overflow-hidden bg-canvas"
      data-sidebar-collapsed={collapsed}
    >
      <div className="flex min-h-0 w-[224px] shrink-0 flex-col">
        <div className="relative mb-2.5 h-10 shrink-0">
          <div
            aria-hidden={collapsed}
            className="absolute left-2 top-1 flex h-8 w-[164px] items-center px-2"
          >
            <span className="sidebar-logo flex size-5 shrink-0 items-center justify-center">
              <SparkleIcon aria-hidden="true" size={18} weight="fill" />
            </span>
            <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-muted">
              pico
            </span>
          </div>
          {desktopCollapse ? (
            <>
              <button
                aria-controls={`${id}-workspaces`}
                aria-expanded={!collapsed}
                aria-hidden={collapsed}
                aria-label="Collapse sidebar"
                className="sidebar-collapse-control absolute right-2 top-1 flex size-8 items-center justify-center rounded-control text-subtle transition-colors hover:bg-surface-hover-strong hover:text-foreground"
                onClick={() => {
                  onSearchChange({ kind: "closed" });
                  desktopCollapse.onCollapsedChange(true);
                }}
                ref={collapseControl}
                tabIndex={collapsed ? -1 : 0}
                title="Collapse sidebar"
                type="button"
              >
                <SidebarSimpleIcon aria-hidden="true" size={18} />
              </button>
              <button
                aria-controls={`${id}-workspaces`}
                aria-expanded={!collapsed}
                aria-hidden={!collapsed}
                aria-label="Expand sidebar"
                className="sidebar-expand-control absolute left-2 top-0.5 flex size-9 items-center justify-center rounded-control text-subtle transition-colors hover:bg-surface-hover-strong hover:text-foreground"
                onClick={() => desktopCollapse.onCollapsedChange(false)}
                ref={expandControl}
                tabIndex={collapsed ? 0 : -1}
                title="Expand sidebar"
                type="button"
              >
                <SidebarSimpleIcon aria-hidden="true" className="rotate-180" size={18} />
              </button>
            </>
          ) : (
            <button
              aria-label="Close sidebar"
              className="absolute right-2 top-1 flex size-8 items-center justify-center rounded-control text-subtle hover:bg-surface-hover-strong hover:text-foreground"
              onClick={onClose}
              title="Close sidebar"
              type="button"
            >
              <XIcon aria-hidden="true" size={18} />
            </button>
          )}
        </div>

        <button
          aria-label="New chat"
          className="sidebar-control sidebar-rail-row relative mx-2 flex shrink-0 items-center rounded-control px-2 text-left text-muted transition-colors hover:bg-surface-hover-strong hover:text-foreground active:scale-[0.98] disabled:opacity-50"
          disabled={navigation.groups.length === 0 && !onAddWorkspace}
          onClick={() => onNewChat()}
          title="New chat"
          type="button"
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <PencilSimpleLineIcon aria-hidden="true" size={18} />
          </span>
          <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium">
            New chat
          </span>
        </button>
        <a
          aria-label="Schedules"
          aria-current={currentPage === "schedules" ? "page" : undefined}
          className={`sidebar-control sidebar-rail-row relative mx-2 flex shrink-0 items-center rounded-control px-2 text-left transition-colors hover:bg-surface-hover-strong hover:text-foreground ${currentPage === "schedules" ? "bg-surface-hover-strong text-foreground" : "text-muted"}`}
          href={schedulesHref}
          onClick={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.shiftKey ||
              (event.currentTarget.target && event.currentTarget.target !== "_self")
            )
              return;
            event.preventDefault();
            onOpenSchedules(event.currentTarget);
          }}
          title="Schedules"
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <CalendarBlankIcon aria-hidden="true" size={18} />
          </span>
          <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium">
            Schedules
          </span>
        </a>

        <nav
          aria-label={searchOpen ? "Chat search results" : "Workspaces"}
          className="sidebar-copy relative isolate mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4"
          id={`${id}-workspaces`}
          inert={collapsed}
          onPointerLeave={clearHover}
          onPointerMove={showHover}
          onScroll={clearHover}
          ref={navigationRef}
        >
          <div aria-hidden="true" className="sidebar-hover" ref={hoverRef} />
          <div className="relative mx-2 mb-1 h-8">
            <h2
              aria-hidden={searchOpen}
              className={`absolute inset-0 flex items-center gap-1.5 px-2 text-[12.5px] font-medium text-subtle transition-[opacity,transform] duration-180 ease-[cubic-bezier(.16,1,.3,1)] ${searchOpen ? "pointer-events-none -translate-x-1 opacity-0" : "translate-x-0 opacity-100"}`}
            >
              <CaretDownIcon aria-hidden="true" size={16} />
              Workspaces
            </h2>
            <button
              aria-expanded={searchOpen}
              aria-hidden={searchOpen}
              aria-label="Search chats"
              className={`absolute right-0 top-0 z-10 flex size-8 items-center justify-center rounded-control text-subtle transition-[opacity,background-color,color,transform] duration-180 hover:bg-surface-hover-strong hover:text-foreground active:scale-[0.96] ${searchOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
              onClick={() => onSearchChange({ kind: "open", query: "" })}
              ref={searchOpener}
              tabIndex={searchOpen ? -1 : 0}
              title="Search chats"
              type="button"
            >
              <MagnifyingGlassIcon aria-hidden="true" size={16} />
            </button>
            <div
              aria-hidden={!searchOpen}
              className={`absolute right-0 top-0 z-20 flex h-8 items-center overflow-hidden rounded-control bg-field text-subtle shadow-hairline transition-[width,opacity] duration-180 ease-[cubic-bezier(.16,1,.3,1)] focus-within:text-muted ${searchOpen ? "pointer-events-auto w-full opacity-100" : "pointer-events-none w-7 opacity-0"}`}
              inert={!searchOpen}
            >
              <MagnifyingGlassIcon aria-hidden="true" className="ml-2 shrink-0" size={15} />
              <input
                aria-label="Search chat history"
                className="ml-1.5 min-w-0 flex-1 bg-transparent text-base font-medium text-foreground outline-none placeholder:text-subtle md:text-[13px]"
                onChange={(event) => onSearchChange({ kind: "open", query: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeSearch();
                }}
                placeholder="Search chats"
                ref={searchInput}
                type="search"
                value={search.kind === "open" ? search.query : ""}
              />
              <button
                aria-label="Close chat search"
                className="flex size-8 shrink-0 items-center justify-center rounded-control text-subtle transition-colors duration-150 hover:bg-surface-hover-strong hover:text-foreground"
                onClick={closeSearch}
                title="Close chat search"
                type="button"
              >
                <XIcon aria-hidden="true" size={16} />
              </button>
            </div>
          </div>
          {navigation.status && (
            <div className="px-4 py-2 text-label text-muted">
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
          <ul className="mx-2 space-y-px">
            {navigation.groups.map(({ workspace, expanded, chats, status }) => {
              const active = workspace.id === navigation.activeWorkspaceId;
              const listId = `${id}-${workspace.id}`;
              const renderChat = (chat: (typeof chats)[number]) => {
                const selected = active && chat.id === navigation.activeChatId;
                return (
                  <li key={chat.id}>
                    <ChatRow
                      chat={chat}
                      chatCloseDisabled={chatCloseDisabled}
                      contextMenuContainer={contextMenuContainer}
                      onChatClose={onChatClose}
                      onChatMarkRead={onChatMarkRead}
                      onChatMarkUnread={onChatMarkUnread}
                      onChatSelect={onChatSelect}
                      selected={selected}
                      workspaceId={workspace.id}
                    />
                  </li>
                );
              };
              const activeChat =
                !expanded && active && navigation.activeChatId
                  ? chats.find((chat) => chat.id === navigation.activeChatId)
                  : undefined;
              return (
                <li key={workspace.id}>
                  <div className="sidebar-row flex items-center gap-0.5" data-sidebar-row="">
                    <WorkspaceToggle
                      active={active}
                      contextMenuContainer={contextMenuContainer}
                      expanded={expanded}
                      listId={listId}
                      onEditWorkspace={onEditWorkspace}
                      onDeleteWorkspace={onDeleteWorkspace}
                      workspaceDeleteDisabled={workspaceDeleteDisabled}
                      onWorkspaceToggle={onWorkspaceToggle}
                      searching={searchOpen}
                      workspace={workspace}
                      workspaceEditPending={workspaceEditPending}
                    />
                    {searchOpen && workspace.canEditConfiguration && onEditWorkspace && (
                      <button
                        aria-label={`Edit ${workspace.name}`}
                        className="sidebar-row sidebar-icon-button inline-flex shrink-0 items-center justify-center text-subtle hover:text-foreground"
                        disabled={workspaceEditPending}
                        onClick={(event) => onEditWorkspace(workspace.id, event.currentTarget)}
                        title={`Edit ${workspace.name}`}
                        type="button"
                      >
                        <PencilSimpleLineIcon aria-hidden="true" size={15} />
                      </button>
                    )}
                    <button
                      aria-label={`New chat in ${workspace.name}`}
                      className="sidebar-row sidebar-icon-button inline-flex shrink-0 items-center justify-center text-subtle hover:text-foreground"
                      onClick={() => onNewChat(workspace.id)}
                      title={`New chat in ${workspace.name}`}
                      type="button"
                    >
                      <PlusIcon aria-hidden="true" size={15} />
                    </button>
                  </div>
                  <div hidden={!expanded} id={listId}>
                    {expanded && status && (
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
                    {expanded && <ul className="space-y-px">{chats.map(renderChat)}</ul>}
                  </div>
                  {!expanded && activeChat && (
                    <ul className="space-y-px">{renderChat(activeChat)}</ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        {onAddWorkspace && (
          <div className="mx-2 mt-3 shrink-0 border-t border-border pt-3">
            <button
              aria-label="Add workspace"
              className="sidebar-control sidebar-rail-row flex items-center rounded-control px-2 text-left text-muted transition-colors hover:bg-surface-hover-strong hover:text-foreground"
              onClick={onAddWorkspace}
              title="Add workspace"
              type="button"
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                <PlusIcon aria-hidden="true" size={18} />
              </span>
              <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium">
                Add workspace
              </span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

type ClipboardStatus = "idle" | "copying" | "copied" | "failed";

function ChatRow({
  chat,
  workspaceId,
  selected,
  onChatSelect,
  onChatMarkUnread,
  onChatMarkRead,
  onChatClose,
  chatCloseDisabled,
  contextMenuContainer,
}: Pick<
  WorkspaceSidebarProps,
  | "onChatSelect"
  | "onChatMarkUnread"
  | "onChatMarkRead"
  | "onChatClose"
  | "chatCloseDisabled"
  | "contextMenuContainer"
> & {
  readonly chat: NavigationPresentation["groups"][number]["chats"][number];
  readonly workspaceId: string;
  readonly selected: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const pendingClose = useRef<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<ClipboardStatus>("idle");
  const openMenu = (origin: HTMLElement) => {
    const bounds = origin.getBoundingClientRect();
    trigger.current?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.bottom,
        button: 2,
      }),
    );
    menuOrigin.current = origin;
  };
  const copyChatId = async () => {
    if (copyStatus === "copying") return;
    setCopyStatus("copying");
    try {
      await navigator.clipboard.writeText(chat.id);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <div
        className={`sidebar-row flex items-center ${selected ? "bg-surface-hover-strong text-foreground" : "text-muted"}`}
        data-sidebar-row=""
      >
        <ContextMenuTrigger asChild>
          <button
            aria-current={selected ? "page" : undefined}
            className="sidebar-row flex min-w-0 flex-1 items-center py-1 pl-7 pr-1 text-left text-[14px] font-medium"
            onClick={() => onChatSelect(workspaceId, chat.id)}
            onContextMenu={(event) => {
              setCopyStatus((status) => (status === "copying" ? status : "idle"));
              menuOrigin.current = event.currentTarget;
              event.currentTarget.focus({ preventScroll: true });
            }}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              openMenu(event.currentTarget);
            }}
            ref={trigger}
            title={chat.title}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">{chat.title}</span>
            {chat.unread && (
              <span
                aria-hidden="true"
                className="ml-2 inline-flex size-2 shrink-0 rounded-full bg-accent"
              />
            )}
            <span className="sr-only">{chat.unread ? "Unread" : "Read"}</span>
          </button>
        </ContextMenuTrigger>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={`Chat actions for ${chat.title}`}
          className="sidebar-row sidebar-icon-button inline-flex shrink-0 items-center justify-center text-subtle hover:text-foreground"
          onClick={(event) => openMenu(event.currentTarget)}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            openMenu(event.currentTarget);
          }}
          title={`Chat actions for ${chat.title}`}
          type="button"
        >
          <DotsThreeIcon aria-hidden="true" size={18} weight="bold" />
        </button>
      </div>
      <ContextMenuContent
        container={contextMenuContainer}
        onCloseAutoFocus={(event) => {
          const origin = pendingClose.current;
          pendingClose.current = null;
          if (origin) {
            event.preventDefault();
            queueMicrotask(() => {
              origin.focus({ preventScroll: true });
              onChatClose(workspaceId, chat.id, origin);
            });
          } else if (document.activeElement === document.body && menuOrigin.current?.isConnected) {
            event.preventDefault();
            menuOrigin.current.focus({ preventScroll: true });
          }
        }}
      >
        <ContextMenuItem
          onSelect={() => {
            void copyChatId();
          }}
        >
          <CopyIcon aria-hidden="true" size={17} />
          Copy chat ID
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            if (chat.unread) onChatMarkRead(workspaceId, chat.id);
            else onChatMarkUnread(workspaceId, chat.id);
          }}
        >
          <span aria-hidden="true" className="inline-flex size-[17px] items-center justify-center">
            <span className="size-2 rounded-full bg-accent" />
          </span>
          {chat.unread ? "Mark as read" : "Mark as unread"}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={chatCloseDisabled}
          onSelect={() => {
            pendingClose.current = menuOrigin.current ?? trigger.current;
          }}
        >
          <ArchiveIcon aria-hidden="true" size={17} />
          Close chat
        </ContextMenuItem>
      </ContextMenuContent>
      <p aria-live="polite" className="sr-only">
        {copyStatus === "copied" ? "Chat ID copied" : ""}
      </p>
      {copyStatus === "failed" && (
        <p className="py-1 pl-7 pr-2 text-[12px] text-danger" role="alert">
          Could not copy chat ID.
        </p>
      )}
    </ContextMenu>
  );
}

function WorkspaceToggle({
  workspace,
  expanded,
  active,
  listId,
  searching,
  onWorkspaceToggle,
  onEditWorkspace,
  workspaceEditPending,
  onDeleteWorkspace,
  workspaceDeleteDisabled,
  contextMenuContainer,
}: Pick<
  WorkspaceSidebarProps,
  | "onWorkspaceToggle"
  | "onEditWorkspace"
  | "workspaceEditPending"
  | "contextMenuContainer"
  | "onDeleteWorkspace"
  | "workspaceDeleteDisabled"
> & {
  readonly workspace: NavigationPresentation["groups"][number]["workspace"];
  readonly expanded: boolean;
  readonly active: boolean;
  readonly listId: string;
  readonly searching: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pendingAction = useRef<"edit" | "delete" | null>(null);
  const [copyStatus, setCopyStatus] = useState<ClipboardStatus>("idle");
  const editable = workspace.canEditConfiguration && onEditWorkspace !== undefined;
  const deletable = onDeleteWorkspace !== undefined;
  const openMenu = (button: HTMLButtonElement) => {
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
  };
  const copyWorkspaceId = async () => {
    if (copyStatus === "copying") return;
    setCopyStatus("copying");
    try {
      await navigator.clipboard.writeText(workspace.id);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };
  const toggle = (
    <button
      aria-controls={searching ? undefined : listId}
      aria-expanded={searching ? undefined : expanded}
      aria-haspopup={searching ? "menu" : undefined}
      className={`sidebar-row flex min-w-0 flex-1 items-center gap-2 px-2 text-left text-label ${active ? "font-medium text-foreground" : "text-muted"}`}
      onClick={(event) => {
        if (searching) openMenu(event.currentTarget);
        else onWorkspaceToggle(workspace.id);
      }}
      onContextMenu={(event) => {
        setCopyStatus((status) => (status === "copying" ? status : "idle"));
        event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        openMenu(event.currentTarget);
      }}
      ref={trigger}
      title={workspace.contextLabel}
      type="button"
    >
      {!searching &&
        (expanded ? (
          <CaretDownIcon aria-hidden="true" className="shrink-0" size={12} />
        ) : (
          <CaretRightIcon aria-hidden="true" className="shrink-0" size={12} />
        ))}
      <FolderSimpleIcon aria-hidden="true" className="shrink-0" size={17} />
      <span className="truncate">{workspace.name}</span>
    </button>
  );
  return (
    <ContextMenu>
      <div className="flex min-w-0 flex-1 flex-col">
        <ContextMenuTrigger asChild>{toggle}</ContextMenuTrigger>
        <ContextMenuContent
          container={contextMenuContainer}
          onCloseAutoFocus={(event) => {
            const action = pendingAction.current;
            const origin = trigger.current;
            if (!action || !origin) return;
            pendingAction.current = null;
            event.preventDefault();
            // Radix must release its focus scope before the native dialog opens.
            queueMicrotask(() => {
              if (action === "edit") onEditWorkspace?.(workspace.id, origin);
              else onDeleteWorkspace?.(workspace.id, origin);
            });
          }}
        >
          <ContextMenuItem
            onSelect={() => {
              void copyWorkspaceId();
            }}
          >
            <CopyIcon aria-hidden="true" size={17} />
            Copy workspace ID
          </ContextMenuItem>
          {editable && (
            <ContextMenuItem
              disabled={workspaceEditPending ?? false}
              onSelect={() => {
                pendingAction.current = "edit";
              }}
            >
              <PencilSimpleLineIcon aria-hidden="true" size={17} />
              Edit workspace
            </ContextMenuItem>
          )}
          {deletable && (
            <ContextMenuItem
              disabled={workspaceDeleteDisabled ?? false}
              onSelect={() => {
                pendingAction.current = "delete";
              }}
            >
              <TrashIcon aria-hidden="true" size={17} />
              Delete workspace
            </ContextMenuItem>
          )}
        </ContextMenuContent>
        <p aria-live="polite" className="sr-only">
          {copyStatus === "copied" ? "Workspace ID copied" : ""}
        </p>
        {copyStatus === "failed" && (
          <p className="px-2 py-1 text-[12px] text-danger" role="alert">
            Could not copy workspace ID.
          </p>
        )}
      </div>
    </ContextMenu>
  );
}
