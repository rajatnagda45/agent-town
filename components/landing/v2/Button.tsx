"use client";

import { type ButtonHTMLAttributes, type ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "icon" | "sm";
  asChild?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "default",
  size,
  asChild,
  className = "",
  children,
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 cursor-pointer font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const variants: Record<string, string> = {
    default: "bg-primary text-primary-foreground hover:opacity-90",
    outline: "border-2 border-border bg-transparent text-cream hover:border-gold hover:text-gold",
    ghost: "bg-transparent hover:bg-surface",
  };
  const sizes: Record<string, string> = {
    default: "h-10 px-4 text-sm",
    icon: "h-10 w-10",
    sm: "h-8 px-3 text-xs",
  };
  const cls = `${base} ${variants[variant] ?? ""} ${sizes[size ?? "default"] ?? ""} ${className}`;

  if (asChild && children) {
    const child = children as React.ReactElement<{ className?: string }>;
    const childCls = `${cls} ${child.props.className ?? ""}`.trim();
    return <child.type {...(child.props as object)} className={childCls} />;
  }

  return (
    <button className={cls} {...props}>
      {children}
    </button>
  );
}
