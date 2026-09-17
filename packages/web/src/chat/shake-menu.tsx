import { VibrateIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.tsx";

const options = [
  { mode: "elide", description: "Tool results + large blocks" },
  { mode: "images", description: "Image blocks" },
  { mode: "thinking", description: "All thinking blocks" },
] as const;

export interface ShakeMenuProps {
  readonly enabled: boolean;
  readonly onSelect: (mode: (typeof options)[number]["mode"]) => void;
}

export function ShakeMenu({ enabled, onSelect }: ShakeMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const openMenu = (origin: HTMLButtonElement) => {
    const bounds = origin.getBoundingClientRect();
    origin.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.bottom,
        button: 2,
      }),
    );
  };

  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild disabled={!enabled}>
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Shake"
          className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-control text-muted hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          disabled={!enabled}
          onClick={(event) => openMenu(event.currentTarget)}
          onContextMenu={(event) => event.currentTarget.focus({ preventScroll: true })}
          onKeyDown={(event) => {
            if (
              event.key !== "ArrowDown" &&
              event.key !== "ContextMenu" &&
              !(event.shiftKey && event.key === "F10")
            )
              return;
            event.preventDefault();
            openMenu(event.currentTarget);
          }}
          ref={trigger}
          title="Shake"
          type="button"
        >
          <VibrateIcon aria-hidden="true" size={16} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          if (document.activeElement === document.body && trigger.current?.isConnected) {
            event.preventDefault();
            trigger.current.focus({ preventScroll: true });
          }
        }}
      >
        {options.map((option) => (
          <ContextMenuItem
            key={option.mode}
            onSelect={() => onSelect(option.mode)}
            textValue={option.mode}
          >
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2">
                {option.mode}
                {option.mode === "elide" && (
                  <span className="text-caption text-muted">Default</span>
                )}
              </span>
              <span className="text-caption text-muted">{option.description}</span>
            </span>
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
