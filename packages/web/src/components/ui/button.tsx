import type { ComponentPropsWithoutRef } from "react";

export type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  readonly tone?: "primary" | "secondary" | "ghost" | "danger";
  readonly size?: "small" | "medium" | "icon";
};

const toneClasses = {
  primary: "bg-foreground text-canvas shadow-filled hover:opacity-90",
  secondary: "bg-panel text-foreground shadow-btn hover:bg-surface aria-expanded:bg-surface-hover",
  ghost: "text-muted hover:bg-surface-hover hover:text-foreground",
  danger: "bg-danger-soft text-danger hover:bg-surface-hover",
} satisfies Record<NonNullable<ButtonProps["tone"]>, string>;

const sizeClasses = {
  small: "h-8 px-3 text-label",
  medium: "h-10 px-4 text-label",
  icon: "size-9 p-0",
} satisfies Record<NonNullable<ButtonProps["size"]>, string>;

export function Button({
  tone = "secondary",
  size = "medium",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  const classes = [
    "press-feedback inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium transition-[transform,background-color,color,opacity] duration-feedback ease-feedback disabled:pointer-events-none disabled:opacity-50",
    toneClasses[tone],
    sizeClasses[size],
    className,
  ].join(" ");

  return <button className={classes} type={type} {...props} />;
}
