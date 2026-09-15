import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentProps } from "react";

export function ContextMenu(props: ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

export function ContextMenuTrigger(props: ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

export function ContextMenuContent({
  className,
  container,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Content> & {
  readonly container?: ComponentProps<typeof ContextMenuPrimitive.Portal>["container"];
}) {
  return (
    <ContextMenuPrimitive.Portal container={container ?? null}>
      <ContextMenuPrimitive.Content
        className={[
          "z-50 max-h-(--radix-context-menu-content-available-height) min-w-44 overflow-x-hidden overflow-y-auto overscroll-contain rounded-surface border border-border bg-panel p-1 text-foreground shadow-composer",
          className,
        ].join(" ")}
        data-slot="context-menu-content"
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      className={[
        "relative flex min-h-10 cursor-default select-none items-center gap-2 rounded-control px-3 py-2 text-label data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      ].join(" ")}
      data-slot="context-menu-item"
      {...props}
    />
  );
}
