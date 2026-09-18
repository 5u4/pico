import { CaretDown, CaretUp, Check } from "@phosphor-icons/react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { type ComponentProps, type ElementRef, forwardRef } from "react";

export function Select(props: ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentProps<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      className={[
        "inline-flex min-h-8 max-w-full min-w-0 items-center gap-1 rounded-control bg-transparent px-2 text-caption text-muted hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed",
        className,
      ].join(" ")}
      data-slot="select-trigger"
      ref={ref}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <SelectPrimitive.Icon asChild>
        <CaretDown aria-hidden="true" className="size-3.5 shrink-0" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

export function SelectContent({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        avoidCollisions={true}
        className={[
          "z-50 max-h-(--radix-select-content-available-height) max-w-(--radix-select-content-available-width) min-w-[min(var(--radix-select-trigger-width),var(--radix-select-content-available-width))] overflow-hidden overscroll-contain rounded-surface border border-border bg-panel text-foreground shadow-composer",
          className,
        ].join(" ")}
        collisionPadding={8}
        data-slot="select-content"
        position="popper"
        {...props}
      >
        <SelectPrimitive.ScrollUpButton
          className="flex h-7 items-center justify-center text-muted"
          data-slot="select-scroll-up"
        >
          <CaretUp aria-hidden="true" className="size-3.5" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport
          className="max-h-(--radix-select-content-available-height) w-full min-w-0 overflow-y-auto p-1"
          data-slot="select-viewport"
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton
          className="flex h-7 items-center justify-center text-muted"
          data-slot="select-scroll-down"
        >
          <CaretDown aria-hidden="true" className="size-3.5" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={[
        "relative flex min-h-10 cursor-default select-none items-center gap-2 rounded-control px-3 py-2 pr-8 text-label leading-relaxed data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      ].join(" ")}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="whitespace-normal [overflow-wrap:anywhere]">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        className="absolute right-2 inline-flex size-4 items-center justify-center"
        data-slot="select-item-indicator"
      >
        <Check aria-hidden="true" className="size-3.5" weight="bold" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
